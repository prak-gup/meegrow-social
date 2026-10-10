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
