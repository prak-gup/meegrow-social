import type {
  ConnectionView,
  CreatePostInput,
  MediaRef,
  PostValidationIssue,
  PostView,
  QueueSlotsView,
  QueueView,
} from '@meegrow-social/contracts';
import { platformTextLimit } from '@meegrow-social/contracts/platform-text';
import { formatPublishAt, parsePublishAt } from './postDate';
import {
  ARTICLE_BODY_MAX,
  articleDirty,
  articleOptions,
  emptyArticle,
  isArticleProvider,
  validateArticle,
  type ArticleErrors,
  type ArticleForm,
} from './wordpress';

/**
 * Pure Composer logic: form state → `createPost` payload, validation and copy. Kept out of the page
 * so it is unit-testable in node (apps/web vitest has no DOM).
 */

export type ScheduleMode = 'draft' | 'now' | 'at' | 'queue';

export const SCHEDULE_MODES: readonly ScheduleMode[] = ['draft', 'now', 'at', 'queue'];

/**
 * Limits of `createPostInput` (packages/contracts/src/posts.ts). The contract does not export them
 * as constants; composer.test.ts parses against the real schema so these cannot drift unnoticed.
 */
export const CAPTION_MAX = 5000;
export const MEDIA_MAX = 10;

export interface ComposerForm {
  caption: string;
  media: MediaRef[];
  /** Selected connection ids, in any order — the payload follows the connection list's order. */
  connectionIds: string[];
  mode: ScheduleMode;
  /** `datetime-local` value (local time, no zone), e.g. "2026-10-12T09:30". */
  at: string;
  queueId: string;
  /** The article fields, used only when a WordPress account is selected (lib/wordpress). */
  article?: ArticleForm;
}

export interface FormErrors {
  accounts?: string;
  caption?: string;
  at?: string;
  queue?: string;
  /** Present only when an article account is selected and a field of the article is wrong. */
  article?: ArticleErrors;
}

/**
 * What the one text box is, given who it is going to. The same text is a caption on a social
 * account and the BODY of a WordPress article, so the box is named for what is selected — and may
 * only run to article length when every selected account takes an article.
 */
export interface CaptionRole {
  kind: 'caption' | 'article' | 'both';
  label: string;
  placeholder: string;
  hint: string | null;
  max: number;
}

export function captionRole(targets: readonly Pick<ConnectionView, 'provider'>[]): CaptionRole {
  const articles = targets.filter((t) => isArticleProvider(t.provider)).length;
  if (articles === 0) {
    return {
      kind: 'caption',
      label: 'Caption',
      placeholder: 'Write something…',
      hint: null,
      max: CAPTION_MAX,
    };
  }
  if (articles === targets.length) {
    return {
      kind: 'article',
      label: 'Article body',
      placeholder: 'Write the article…',
      hint: 'Markdown: # headings, **bold**, *italic*, - lists, [links](https://…), > quotes. HTML is shown as text.',
      max: ARTICLE_BODY_MAX,
    };
  }
  return {
    kind: 'both',
    label: 'Caption and article body',
    placeholder: 'Write something…',
    hint: 'This text is the caption on the social accounts and the body of the WordPress article. To write them separately, create two posts.',
    max: CAPTION_MAX,
  };
}

/**
 * Platforms where a post is a message dropped into a channel rather than a post on a profile. The
 * preview draws them as a message, and what they cannot do (no link back, no video) is said there.
 */
const MESSAGE_PROVIDERS: ReadonlySet<string> = new Set(['telegram', 'discord', 'slack']);

export const isMessageProvider = (provider: string): boolean => MESSAGE_PROVIDERS.has(provider);

export interface PlatformCount {
  provider: string;
  /** The caption's length as this platform counts it, of the text as it is sent. */
  length: number;
  max: number;
  over: boolean;
}

/**
 * The caption measured the way each selected platform measures it — one entry per platform that
 * has a rule of its own (Bluesky counts graphemes; Discord and Slack count the escaped text;
 * Telegram allows a quarter as much beside media). The same function the providers enforce with
 * (`platformTextLimit`), so the count shown and the limit applied cannot drift apart. Informative
 * only: the per-account warnings (`accountWarnings`) are what say a post will be refused.
 */
export function platformCounts(
  targets: readonly Pick<ConnectionView, 'provider'>[],
  caption: string,
  mediaCount: number,
): PlatformCount[] {
  const counts: PlatformCount[] = [];
  for (const provider of new Set(targets.map((t) => t.provider))) {
    const limit = platformTextLimit(provider, caption, mediaCount > 0);
    if (!limit) continue;
    counts.push({ provider, length: limit.length, max: limit.max, over: limit.length > limit.max });
  }
  return counts;
}

/** What a reader of the preview should know about how this platform shows the post, or null. */
export function previewNote(provider: string): string | null {
  switch (provider) {
    case 'bluesky':
      return 'Links, #tags and @handles become clickable. Bluesky counts characters as a reader sees them, so an emoji is one.';
    case 'telegram':
      return 'Sent as plain text: nothing you type turns into formatting. Telegram links addresses itself.';
    case 'discord':
      return 'Sent as plain text: Markdown characters are escaped and nobody is pinged, including by @everyone.';
    case 'slack':
      return 'Sent as a plain message. Slack still shows *bold* and _italic_ if you type them, and gives back no link to the message after posting.';
    default:
      return null;
  }
}

/**
 * The media a WordPress variant carries: the first image, as its featured image. An article takes
 * one image and no video, so a carousel picked for the social accounts must not travel with it.
 */
export function featuredImage(media: readonly MediaRef[]): MediaRef[] {
  const first = media.find((m) => m.kind === 'image');
  return first ? [first] : [];
}

type Variant = CreatePostInput['variants'][number];

/**
 * One account's variant. A WordPress one carries the article options and, where the shared values
 * do not fit an article, its own: the featured image instead of the full media list, and the body
 * itself once it is longer than a group caption may be.
 */
function variantFor(
  c: Pick<ConnectionView, 'id' | 'provider'>,
  form: Pick<ComposerForm, 'caption' | 'media' | 'article'>,
  article: ArticleForm,
): Variant {
  const long = form.caption.length > CAPTION_MAX;
  if (!isArticleProvider(c.provider)) {
    // With a body too long to share, each variant states its own text (and a social one is then
    // refused for it, per account, rather than the whole request for its group caption).
    return { connectionId: c.id, provider: c.provider, ...(long ? { caption: form.caption } : {}) };
  }
  const featured = featuredImage(form.media);
  const sameMedia =
    featured.length === form.media.length && featured[0]?.mediaId === form.media[0]?.mediaId;
  return {
    connectionId: c.id,
    provider: c.provider,
    options: articleOptions(article),
    ...(long ? { caption: form.caption } : {}),
    ...(sameMedia ? {} : { media: featured }),
  };
}

const MODE_LABEL: Record<ScheduleMode, string> = {
  draft: 'Save draft',
  now: 'Publish now',
  at: 'Schedule',
  queue: 'Add to queue',
};

const MODE_BUSY_LABEL: Record<ScheduleMode, string> = {
  draft: 'Saving…',
  now: 'Publishing…',
  at: 'Scheduling…',
  queue: 'Adding…',
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Primary button label: the mode, plus the account count once there is more than one. */
export function submitLabel(mode: ScheduleMode, accountCount: number): string {
  return accountCount > 1 ? `${MODE_LABEL[mode]} to ${accountCount} accounts` : MODE_LABEL[mode];
}

export const busyLabel = (mode: ScheduleMode): string => MODE_BUSY_LABEL[mode];

/** `Date` → the value format of `<input type="datetime-local">` (local time, minute precision). */
export function toLocalInputValue(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Error for the "schedule at" value, or null when it is a real time in the future. */
export function validateScheduleAt(at: string, now: Date): string | null {
  if (!at) return 'Pick a date and time.';
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return 'Enter a valid date and time.';
  if (when.getTime() <= now.getTime()) return 'Pick a time in the future.';
  return null;
}

export function validateForm(
  form: ComposerForm,
  queues: readonly QueueView[],
  now: Date,
  connections: readonly ConnectionView[] = [],
): FormErrors {
  const errors: FormErrors = {};
  if (form.connectionIds.length === 0) errors.accounts = 'Select at least one account.';
  // Without the connection list the form cannot know an account is WordPress; callers that select
  // one pass `connections` (the Composer always does).
  const targets = selectedConnections(connections, form.connectionIds);
  const role = captionRole(targets);
  if (form.caption.length > role.max) {
    const over = (form.caption.length - role.max).toLocaleString('en-US');
    const limit = role.max.toLocaleString('en-US').replace(/,/g, '');
    errors.caption =
      role.kind === 'both'
        ? `The text is ${over} over the ${limit} character limit of the social accounts. Shorten it, or post the article on its own.`
        : role.kind === 'article'
          ? `The article is ${over} over the ${limit} character limit.`
          : `Caption is ${over} over the ${limit} character limit.`;
  } else if (role.kind !== 'caption' && form.caption.trim() === '') {
    errors.caption = 'An article needs a body.';
  }
  if (role.kind !== 'caption') {
    const article = validateArticle(form.article ?? emptyArticle());
    if (Object.keys(article).length > 0) errors.article = article;
  }
  if (form.mode === 'at') {
    const at = validateScheduleAt(form.at, now);
    if (at) errors.at = at;
  }
  if (form.mode === 'queue' && !queues.some((q) => q.id === form.queueId)) {
    errors.queue = 'Pick a queue.';
  }
  return errors;
}

export const hasErrors = (errors: FormErrors): boolean => Object.keys(errors).length > 0;

/** The connections a form targets, in the connection list's order (so the preview/payload are stable). */
export function selectedConnections(
  connections: readonly ConnectionView[],
  connectionIds: readonly string[],
): ConnectionView[] {
  const picked = new Set(connectionIds);
  return connections.filter((c) => picked.has(c.id));
}

/** One variant per selected account. Call `validateForm` first; this throws on a form it cannot send. */
export function buildCreatePostInput(
  form: ComposerForm,
  connections: readonly ConnectionView[],
): CreatePostInput {
  const targets = selectedConnections(connections, form.connectionIds);
  if (targets.length === 0) throw new Error('Select at least one account.');

  let schedule: CreatePostInput['schedule'];
  switch (form.mode) {
    case 'draft':
      schedule = { type: 'draft' };
      break;
    case 'now':
      schedule = { type: 'now' };
      break;
    case 'at': {
      const publishAt = new Date(form.at);
      if (Number.isNaN(publishAt.getTime())) throw new Error('Enter a valid date and time.');
      schedule = { type: 'at', publishAt };
      break;
    }
    case 'queue':
      if (!form.queueId) throw new Error('Pick a queue.');
      schedule = { type: 'queue', queueId: form.queueId };
      break;
  }

  const article = form.article ?? emptyArticle();
  return {
    // A body longer than a shared caption may be travels on the article's own variant instead.
    caption: form.caption.length > CAPTION_MAX ? '' : form.caption,
    media: form.media,
    variants: targets.map((c) => variantFor(c, form, article)),
    schedule,
  };
}

/**
 * The next slot the chosen queue would hand out (`GET /v1/queues/:id/slots?count=1`). A preview
 * only: nothing is reserved, so none of these states stops a post being added to the queue.
 */
export type NextSlot =
  | { state: 'loading' }
  | { state: 'ready'; publishAt: Date }
  /** The queue has no free slot inside its 90-day look-ahead. */
  | { state: 'none' }
  | { state: 'error'; message: string };

/** The first slot of a response; an empty list (or an unusable date) is "no free slot". */
export function nextSlotFromView(view: Pick<QueueSlotsView, 'slots'>): NextSlot {
  const publishAt = parsePublishAt(view.slots[0]?.publishAt);
  return publishAt ? { state: 'ready', publishAt } : { state: 'none' };
}

/** Why the slot could not be previewed, from the HTTP status (400 = inactive, 404 = unknown). */
export function nextSlotError(status: number | undefined): string {
  if (status === 400) return 'This queue is paused, so it has no next slot.';
  if (status === 404) return 'This queue no longer exists. Reload to see the current queues.';
  return 'Could not check the next slot.';
}

/** The line under the queue picker. */
export function nextSlotText(slot: NextSlot): string {
  switch (slot.state) {
    case 'loading':
      return 'Checking the next slot…';
    case 'ready':
      return `Next slot: ${formatPublishAt(slot.publishAt)}`;
    case 'none':
      return 'No free slot in the next 90 days.';
    case 'error':
      return slot.message;
  }
}

/** The "when" half of the preview and the success message. */
export function scheduleSummary(
  mode: ScheduleMode,
  at: string,
  queueName: string | undefined,
  nextSlot?: NextSlot | null,
): string {
  switch (mode) {
    case 'draft':
      return 'Saved as a draft. Nothing is sent.';
    case 'now':
      return 'Publishes immediately.';
    case 'at': {
      const when = at ? new Date(at) : null;
      return when && !Number.isNaN(when.getTime())
        ? `Scheduled for ${when.toLocaleString()}.`
        : 'Pick a date and time.';
    }
    case 'queue':
      if (!queueName) return 'Pick a queue.';
      if (nextSlot?.state === 'ready') {
        return `Next free slot in ${queueName}: ${formatPublishAt(nextSlot.publishAt)}.`;
      }
      if (nextSlot?.state === 'none') return `${queueName} has no free slot in the next 90 days.`;
      return `Next free slot in ${queueName}.`;
  }
}

/** What happened after a successful create, in words. */
export function outcomeMessage(
  mode: ScheduleMode,
  accountCount: number,
  detail: { at?: string; queueName?: string },
): string {
  const accounts = plural(accountCount, 'account');
  switch (mode) {
    case 'draft':
      return `Saved as a draft for ${accounts}.`;
    case 'now':
      return `Publishing now to ${accounts}.`;
    case 'at': {
      const when = detail.at ? new Date(detail.at).toLocaleString() : 'the chosen time';
      return `Scheduled for ${when} on ${accounts}.`;
    }
    case 'queue':
      return `Added to ${detail.queueName ?? 'the queue'} for ${accounts}.`;
  }
}

/** "2 scheduled" / "1 published, 1 failed" — the statuses the API reports back for the new posts. */
export function postStatusSummary(posts: readonly Pick<PostView, 'status'>[]): string {
  const counts = new Map<string, number>();
  for (const p of posts) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${n} ${status}`).join(', ');
}

// --- Account picker ---

export interface AccountGroup {
  provider: string;
  accounts: ConnectionView[];
}

/** Accounts under their platform, platforms in first-seen order, accounts in list order. */
export function groupAccounts(connections: readonly ConnectionView[]): AccountGroup[] {
  const groups = new Map<string, ConnectionView[]>();
  for (const c of connections) groups.set(c.provider, [...(groups.get(c.provider) ?? []), c]);
  return [...groups].map(([provider, accounts]) => ({ provider, accounts }));
}

/**
 * Accounts matching a search: every word must appear in the account's name or its platform's label
 * (so "insta acme" finds Acme's Instagram). An empty search matches everything.
 */
export function matchAccounts(
  connections: readonly ConnectionView[],
  query: string,
  platformLabel: (provider: string) => string,
): ConnectionView[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...connections];
  return connections.filter((c) => {
    const haystack = `${c.displayName} ${platformLabel(c.provider)}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/** How much of a group is selected — what its select-all checkbox shows. */
export function groupSelection(
  accountIds: readonly string[],
  selected: readonly string[],
): 'all' | 'some' | 'none' {
  const picked = new Set(selected);
  const count = accountIds.filter((id) => picked.has(id)).length;
  return count === 0 ? 'none' : count === accountIds.length ? 'all' : 'some';
}

/** Select or clear a whole group, leaving every other selection as it was. */
export function setGroupSelected(
  selected: readonly string[],
  accountIds: readonly string[],
  on: boolean,
): string[] {
  const group = new Set(accountIds);
  const rest = selected.filter((id) => !group.has(id));
  return on ? [...rest, ...accountIds] : rest;
}

/**
 * The body of a dry run that asks about EVERY account, selected or not, so an account that cannot
 * take this post is marked before it is picked. Always a draft: a dry run must not depend on a
 * time or a queue.
 */
export function buildValidationInput(
  form: Pick<ComposerForm, 'caption' | 'media' | 'article'>,
  connections: readonly ConnectionView[],
): CreatePostInput {
  // A missing title is the form's own error, shown on the field once a WordPress account is
  // picked; a stand-in keeps it from also flagging every WordPress account before one is.
  const typed = form.article ?? emptyArticle();
  const article = typed.title.trim() === '' ? { ...typed, title: 'Untitled' } : typed;
  return {
    caption: form.caption.length > CAPTION_MAX ? '' : form.caption,
    media: form.media,
    variants: connections.map((c) => variantFor(c, form, article)),
    schedule: { type: 'draft' },
  };
}

export interface AccountWarning {
  /** `reconnect`: the account itself is broken. `post`: it cannot take this post as written. */
  kind: 'reconnect' | 'post';
  reason: string;
}

/** A contract issue arrives as "variants.3.options: …": the path means nothing to an operator. */
const withoutPath = (message: string): string => message.replace(/^[\w.[\]]+:\s+/, '');

/**
 * Why an account should not be posted to as things stand, per connection id. An account that needs
 * reconnecting says so (its posts fail until it is reconnected); otherwise the first thing the dry
 * run (`POST /v1/posts/validate`) reported for it, in the API's own words. The rules themselves
 * live in each provider on the server — none is restated here.
 */
export function accountWarnings(
  connections: readonly ConnectionView[],
  issues: readonly PostValidationIssue[],
): Map<string, AccountWarning> {
  const out = new Map<string, AccountWarning>();
  for (const c of connections) {
    if (c.needsReconnect || c.health === 'needs_reconnect') {
      out.set(c.id, { kind: 'reconnect', reason: 'Needs reconnecting: posts to it will fail.' });
    }
  }
  for (const issue of issues) {
    if (!issue.connectionId || out.has(issue.connectionId)) continue;
    out.set(issue.connectionId, { kind: 'post', reason: withoutPath(issue.message) });
  }
  return out;
}

/**
 * Connection ids a dry run rejected at the contract, before any other check ran. The validator
 * stops there, so the remaining accounts are asked about again without these.
 */
export function contractRejected(issues: readonly PostValidationIssue[]): string[] {
  return [
    ...new Set(
      issues
        .filter((i) => i.code === 'invalid_request' && i.connectionId)
        .map((i) => i.connectionId!),
    ),
  ];
}

/** Has the operator put anything in that closing would throw away? */
export function isDirty(form: Pick<ComposerForm, 'caption' | 'media' | 'article'>): boolean {
  return form.caption.trim() !== '' || form.media.length > 0 || articleDirty(form.article);
}

/**
 * Where the composer panel sits over, and returns to when closed: the page it was opened from
 * (carried in router state as `background`), or Content for a direct link to /composer. Only an
 * in-app path is accepted, and never the composer itself.
 */
export function composerBackground(state: unknown): string {
  const background = (state as { background?: unknown } | null)?.background;
  if (
    typeof background === 'string' &&
    background.startsWith('/') &&
    !background.startsWith('//') &&
    !background.startsWith('/composer')
  ) {
    return background;
  }
  return '/content';
}
