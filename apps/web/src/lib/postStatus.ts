import type { PostStatus } from '@meegrow-social/contracts';

/** Badge colour per post status, shared by Content and Calendar. */
export const STATUS_VARIANT: Record<PostStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  draft: 'neutral',
  scheduled: 'info',
  publishing: 'info',
  published: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/** Display order for filters; also the full set of statuses the API can return. */
export const POST_STATUSES: readonly PostStatus[] = [
  'draft',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancelled',
];

/** Status as words — the badge text, so status never rests on colour alone. */
export const STATUS_LABEL: Record<PostStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * What the API will accept. Mirrors core/services/posts.ts (EDITABLE_STATUSES and
 * CANCELABLE_STATUSES, both draft + scheduled): any other status is rejected with a 409.
 */
const EDITABLE: ReadonlySet<PostStatus> = new Set(['draft', 'scheduled']);
const CANCELABLE: ReadonlySet<PostStatus> = new Set(['draft', 'scheduled']);

export const canEditPost = (status: PostStatus): boolean => EDITABLE.has(status);
export const canCancelPost = (status: PostStatus): boolean => CANCELABLE.has(status);
