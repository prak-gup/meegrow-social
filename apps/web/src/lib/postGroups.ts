import type {
  PostGroupSummary,
  PostMediaView,
  PostStatus,
  PostView,
} from '@meegrow-social/contracts';
import { groupDisplayStatus } from '@meegrow-social/contracts/group-status';
import { TIME_NOT_RECORDED, parsePublishAt } from './postDate';
import { safeExternalUrl } from './postList';
import { postHeadline } from './wordpress';
import { canCancelPost, canEditPost } from './postStatus';

/**
 * Pure logic for showing one card per post GROUP (one composed post, N per-platform variants) on
 * Content and Calendar. The headline status always comes from the shared `groupDisplayStatus` rule
 * in contracts — recomputed here only after a local change, never re-derived by another rule.
 */

/** What a card or calendar entry needs of a group. The API's list item satisfies it. */
export type PostGroup = Pick<PostGroupSummary, 'id' | 'caption' | 'media' | 'status' | 'posts'>;

/** Divisible by every column count the grid uses (1, 2, 3, 4, 6), so a full page ends on a full row. */
export const GROUP_PAGE_SIZE = 48;

// --- Filters ---

export const RANGES = [
  { value: '', label: 'Any date' },
  { value: 'next7', label: 'Next 7 days' },
  { value: 'next30', label: 'Next 30 days' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
] as const;
export type RangeKey = (typeof RANGES)[number]['value'];

/** Where a post came from: made here, or found on the platform by an import. '' = both. */
export type SourceKey = '' | 'app' | 'imported';

export const SOURCES: ReadonlyArray<{ value: SourceKey; label: string }> = [
  { value: '', label: 'All sources' },
  { value: 'app', label: 'Published here' },
  { value: 'imported', label: 'Imported' },
];

export interface GroupFilters {
  /** Caption search. */
  q: string;
  status: PostStatus | '';
  source: SourceKey;
  provider: string;
  connectionId: string;
  range: RangeKey;
  order: 'desc' | 'asc';
}

export const NO_GROUP_FILTERS: GroupFilters = {
  q: '',
  status: '',
  source: '',
  provider: '',
  connectionId: '',
  range: '',
  order: 'desc',
};

/** The order is a way of reading the list, not a filter on it. */
export const hasGroupFilters = (f: GroupFilters): boolean =>
  f.q.trim() !== '' ||
  f.status !== '' ||
  f.source !== '' ||
  f.provider !== '' ||
  f.connectionId !== '' ||
  f.range !== '';

const DAY_MS = 86_400_000;

/** A range preset as ISO bounds on `publishAt`. A post with no publish time is in no range. */
export function rangeBounds(range: RangeKey, now: number): { from?: string; to?: string } {
  const match = /^(next|last)(\d+)$/.exec(range);
  if (!match) return {};
  const span = Number(match[2]) * DAY_MS;
  const iso = (t: number) => new Date(t).toISOString();
  return match[1] === 'next'
    ? { from: iso(now), to: iso(now + span) }
    : { from: iso(now - span), to: iso(now) };
}

/** The `GET /v1/post-groups` query for a filter set and page. Empty filters are left out. */
export function groupQuery(f: GroupFilters, now: number, offset: number, limit = GROUP_PAGE_SIZE) {
  return {
    q: f.q.trim() || undefined,
    status: f.status || undefined,
    source: f.source || undefined,
    provider: f.provider || undefined,
    connectionId: f.connectionId || undefined,
    ...rangeBounds(f.range, now),
    order: f.order,
    limit,
    offset,
  };
}

// --- Visibility and local updates ---

/**
 * A group as this viewer may see it: variants on hidden providers (the dev fakes) are dropped, and
 * a group left with none is null. The status is recomputed over what remains.
 */
export function visibleGroup<G extends PostGroup>(
  group: G,
  isVisible: (provider: string) => boolean,
): G | null {
  const posts = group.posts.filter((p) => isVisible(p.provider));
  if (posts.length === group.posts.length) return group;
  if (posts.length === 0) return null;
  return { ...group, posts, status: groupDisplayStatus(posts.map((p) => p.status)) };
}

/** Append a page of groups, skipping ids already loaded (offset paging can repeat a row). */
export function appendGroups<G extends PostGroup>(current: G[], incoming: G[]): G[] {
  const seen = new Set(current.map((g) => g.id));
  return [...current, ...incoming.filter((g) => !seen.has(g.id))];
}

/**
 * Swap updated variants into a list of posts, keeping positions. A variant keeps the media it had
 * if the update came back without any (an action that only knows the new status).
 */
export function mergePosts(posts: readonly PostView[], updated: readonly PostView[]): PostView[] {
  const byId = new Map(updated.map((p) => [p.id, p]));
  return posts.map((p) => {
    const next = byId.get(p.id);
    return next ? { ...next, media: next.media ?? p.media } : p;
  });
}

/** Swap updated variants into their group and recompute its status by the shared rule. */
export function applyPosts<G extends PostGroup>(group: G, updated: readonly PostView[]): G {
  const ids = new Set(updated.map((p) => p.id));
  if (!group.posts.some((p) => ids.has(p.id))) return group;
  const posts = mergePosts(group.posts, updated);
  return { ...group, posts, status: groupDisplayStatus(posts.map((p) => p.status)) };
}

/** Does the group still belong under a status filter? The filter is on variants: any match keeps it. */
export function groupMatchesStatus(group: PostGroup, status: PostStatus | ''): boolean {
  return status === '' || group.posts.some((p) => p.status === status);
}

// --- Imported posts ---

type Sourced = Pick<PostView, 'source' | 'platformRemovedAt'>;

/** Found on the platform by an import, not published here. An older payload has no `source`. */
export const isImported = (post: Pick<PostView, 'source'>): boolean => post.source === 'imported';

/**
 * A group that is an imported post. Imports never pair platforms, so such a group has one variant;
 * "every variant" keeps a mixed group — which nothing creates — on the side of normal actions.
 */
export function isImportedGroup(group: { posts: readonly Pick<PostView, 'source'>[] }): boolean {
  return group.posts.length > 0 && group.posts.every(isImported);
}

/** The platform no longer has this post (it was deleted there). Its status is still `published`. */
export const isRemoved = (post: Pick<PostView, 'platformRemovedAt'>): boolean =>
  post.platformRemovedAt != null;

/**
 * How many of a group's variants are gone from their platform, and whether that is all of the
 * ones that went out. `all` is what replaces the "Published" chip; `some` is a note beside it.
 */
export function groupRemoval(posts: readonly (Sourced & Pick<PostView, 'status'>)[]): {
  count: number;
  all: boolean;
} {
  const published = posts.filter((p) => p.status === 'published');
  const count = published.filter(isRemoved).length;
  return { count, all: count > 0 && count === published.length };
}

/**
 * What a group's chip says: its status, except that a group whose published variants are ALL gone
 * from their platform reads "Removed on platform" rather than "Published".
 */
export function groupChip(
  group: Pick<PostGroup, 'status' | 'posts'>,
): PostGroup['status'] | 'removed' {
  return group.status === 'published' && groupRemoval(group.posts).all ? 'removed' : group.status;
}

/** A day's or a page's posts under the source filter. '' keeps everything. */
export function filterBySource<P extends Pick<PostView, 'source'>>(
  posts: readonly P[],
  source: SourceKey,
): P[] {
  if (source === '') return [...posts];
  return posts.filter((p) => (isImported(p) ? 'imported' : 'app') === source);
}

// --- Thumbnail ---

export interface Thumb {
  kind: 'image' | 'video';
  /** A picture to draw, or null when there is none to show (a video without a cover, a bad url). */
  src: string | null;
  /** Media items on the post; more than one is a carousel. */
  count: number;
}

const firstUrl = (...urls: Array<string | null | undefined>): string | null => {
  for (const url of urls) {
    const safe = safeExternalUrl(url);
    if (safe) return safe;
  }
  return null;
};

/** The picture for a list of media: the first image, or the first video's cover when it has one. */
export function mediaThumb(media: readonly PostMediaView[] | undefined): Thumb | null {
  const first = media?.[0];
  if (!first) return null;
  return {
    kind: first.kind,
    src: first.kind === 'image' ? firstUrl(first.url) : firstUrl(first.thumbnailUrl),
    count: media.length,
  };
}

/**
 * A group's thumbnail, or null for a text-only post. What the variants carry comes first — that is
 * what is published, and it can be edited after the group was made — with the group's shared media
 * as the fallback. A cover belongs to a variant (its options), so a video's still is looked up
 * across the variants.
 */
export function groupThumb(group: PostGroup): Thumb | null {
  const fromVariants = group.posts.map((p) => mediaThumb(p.media)).filter((t) => t !== null);
  const thumb = fromVariants[0] ?? mediaThumb(group.media);
  if (!thumb || thumb.src || thumb.kind !== 'video') return thumb;
  const cover = fromVariants.find((t) => t.kind === 'video' && t.src)?.src ?? null;
  return { ...thumb, src: cover };
}

/**
 * The caption a card shows: the first variant's, because that is the text that goes out and the
 * one an edit changes. The group's own caption is only what it was created with. For an article
 * (WordPress) that is its title — its caption is the whole body.
 */
export function groupCaption(group: Pick<PostGroup, 'caption' | 'posts'>): string {
  return group.posts[0] ? postHeadline(group.posts[0]) : group.caption;
}

// --- Dates ---

/** "4 Oct, 19:07" — the year only when it is not this one. Locale-formatted. */
export function shortDateTime(date: Date, now: Date = new Date()): string {
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The earliest real publish time among the variants, or null. */
export function groupTime(posts: readonly Pick<PostView, 'publishAt'>[]): Date | null {
  let earliest: Date | null = null;
  for (const p of posts) {
    const at = parsePublishAt(p.publishAt);
    if (at && (!earliest || at < earliest)) earliest = at;
  }
  return earliest;
}

/**
 * The one short line of time a card shows: its earliest publish time, or — when it has none — what
 * that means for its status. A published post with no stored time says so rather than staying
 * blank (legacy posts, not being backfilled); a draft has no time to show.
 */
export function groupWhen(
  group: Pick<PostGroup, 'status' | 'posts'>,
  now: Date = new Date(),
): { text: string; date: Date | null } {
  const date = groupTime(group.posts);
  if (date) return { text: shortDateTime(date, now), date };
  const statuses = new Set(group.posts.map((p) => p.status));
  if (statuses.has('published')) return { text: TIME_NOT_RECORDED, date: null };
  if (statuses.has('scheduled') || statuses.has('publishing')) {
    return { text: 'Sending as soon as possible', date: null };
  }
  return { text: group.status === 'draft' ? 'Not scheduled' : 'No time', date: null };
}

// --- Actions ---

export interface GroupActions {
  /**
   * Every variant is an imported post: it was not published here, so nothing here can change it.
   * Only "view" and "duplicate" are offered, and the duplicate carries the caption alone.
   */
  imported: boolean;
  /** Variants the API accepts a caption edit or a new time for (draft, scheduled). */
  editable: PostView[];
  /** Variants that can still be cancelled. */
  cancelable: PostView[];
  /** Variants that failed and can be retried. */
  failed: PostView[];
  /** Published variants with a link safe to open. */
  links: Array<{ post: PostView; url: string }>;
}

/** What can be done to a group, per variant. Mirrors what the API accepts for each status. */
export function groupActions(posts: readonly PostView[]): GroupActions {
  const links: GroupActions['links'] = [];
  for (const post of posts) {
    // A post deleted on the platform has a link that no longer opens anything.
    const url = isRemoved(post) ? null : safeExternalUrl(post.releaseUrl);
    if (url) links.push({ post, url });
  }
  // An imported post is refused by edit, reschedule, cancel and retry whatever its status reads,
  // so none of them is ever offered for one.
  const ours = posts.filter((p) => !isImported(p));
  return {
    imported: isImportedGroup({ posts }),
    editable: ours.filter((p) => canEditPost(p.status)),
    cancelable: ours.filter((p) => canCancelPost(p.status)),
    failed: ours.filter((p) => p.status === 'failed'),
    links,
  };
}

/** Distinct captions among some variants, in first-seen order. More than one means they were tailored. */
export function distinctCaptions(posts: readonly Pick<PostView, 'caption'>[]): string[] {
  return [...new Set(posts.map((p) => p.caption))];
}

/** The first provider error among the variants, with how many variants carry one. */
export function groupError(
  posts: readonly Pick<PostView, 'status' | 'error' | 'provider'>[],
): { message: string; provider: string; count: number } | null {
  const failed = posts.filter((p) => p.status === 'failed');
  const first = failed.find((p) => p.error) ?? failed[0];
  if (!first) return null;
  return {
    message: first.error ?? 'Publishing failed.',
    provider: first.provider,
    count: failed.length,
  };
}

// --- Calendar ---

export interface CalendarEntry extends PostGroup {
  /** Earliest publish time of the entry's variants, epoch ms. */
  at: number;
}

/**
 * One calendar day's posts as entries: one per group. Grouping here is safe where it is not on the
 * paged list — the calendar returns a whole month at once, so a group is never cut by a page. A
 * group whose variants were moved to different days appears on each day with that day's variants.
 * Posts without a real time are dropped; entries are ordered by time.
 */
export function dayEntries(posts: readonly PostView[]): CalendarEntry[] {
  const byGroup = new Map<string, PostView[]>();
  for (const post of posts) {
    if (parsePublishAt(post.publishAt) === null) continue;
    byGroup.set(post.groupId, [...(byGroup.get(post.groupId) ?? []), post]);
  }
  return [...byGroup]
    .map(([id, variants]) => ({
      id,
      caption: postHeadline(variants[0]),
      media: [],
      status: groupDisplayStatus(variants.map((p) => p.status)),
      posts: variants,
      at: groupTime(variants)!.getTime(),
    }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

// --- Metrics on cards ---

/** Newest value per metric name, per post id. A post with no entry has not been asked for yet. */
export type LatestByPost = ReadonlyMap<string, Record<string, number>>;

/** Ids of published variants whose metrics are not loaded yet. Only published posts have any. */
export function metricsToLoad(groups: readonly PostGroup[], loaded: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const g of groups) {
    for (const p of g.posts) if (p.status === 'published' && !loaded.has(p.id)) ids.push(p.id);
  }
  return ids;
}

/**
 * Which metric names the page's cards show: the names carried by the most groups on the page, the
 * larger total first among equals (so the headline number leads), then alphabetical. Chosen from
 * the data — no name is ever spelled out here.
 */
export function topMetricNames(
  groups: readonly PostGroup[],
  latest: LatestByPost,
  max = 3,
): string[] {
  const stats = new Map<string, { groups: number; total: number }>();
  for (const g of groups) {
    const seen = new Set<string>();
    for (const p of g.posts) {
      for (const [name, value] of Object.entries(latest.get(p.id) ?? {})) {
        const stat = stats.get(name) ?? { groups: 0, total: 0 };
        if (!seen.has(name)) stat.groups += 1;
        seen.add(name);
        stat.total += value;
        stats.set(name, stat);
      }
    }
  }
  return [...stats]
    .sort(([a, x], [b, y]) => y.groups - x.groups || y.total - x.total || a.localeCompare(b))
    .slice(0, max)
    .map(([name]) => name);
}

/**
 * One metric for a group: the sum over the variants that report it, or null when none does —
 * shown as "—", never as 0.
 */
export function groupMetric(
  posts: readonly Pick<PostView, 'id'>[],
  latest: LatestByPost,
  name: string,
): number | null {
  let total: number | null = null;
  for (const p of posts) {
    const value = latest.get(p.id)?.[name];
    if (value !== undefined) total = (total ?? 0) + value;
  }
  return total;
}

/** 4,231 → "4.2K". For a card, where the exact figure is one hover away. */
export function compactNumber(value: number): string {
  return value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}

/**
 * Most post ids one `POST /v1/posts/metrics/latest` takes — `BULK_METRICS_MAX_POSTS` in contracts,
 * repeated here because the contracts root is not imported at runtime (it would bundle the zod
 * schemas). postGroups.test.ts holds the two equal.
 */
export const BULK_METRICS_MAX = 200;

/** Split ids into requests of at most `size`. */
export function idChunks(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
