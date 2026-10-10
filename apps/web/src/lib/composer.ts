import type {
  ConnectionView,
  CreatePostInput,
  MediaRef,
  PostView,
  QueueView,
} from '@meegrow-social/contracts';

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
}

export interface FormErrors {
  accounts?: string;
  caption?: string;
  at?: string;
  queue?: string;
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
): FormErrors {
  const errors: FormErrors = {};
  if (form.connectionIds.length === 0) errors.accounts = 'Select at least one account.';
  if (form.caption.length > CAPTION_MAX) {
    errors.caption = `Caption is ${form.caption.length - CAPTION_MAX} over the ${CAPTION_MAX} character limit.`;
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

  return {
    caption: form.caption,
    media: form.media,
    variants: targets.map((c) => ({ connectionId: c.id, provider: c.provider })),
    schedule,
  };
}

/** The "when" half of the preview and the success message. */
export function scheduleSummary(
  mode: ScheduleMode,
  at: string,
  queueName: string | undefined,
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
      return queueName ? `Next free slot in ${queueName}.` : 'Pick a queue.';
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
