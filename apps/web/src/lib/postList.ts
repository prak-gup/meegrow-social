import type { PostStatus, PostView } from '@meegrow-social/contracts';
import { parsePublishAt } from './postDate';
import { canCancelPost, canEditPost } from './postStatus';

/** `listPostsQuery` default; the API caps `limit` at 100. */
export const PAGE_SIZE = 50;

/** `createPostInput` / `updatePostInput` caption limit. */
export const CAPTION_MAX = 5000;

export interface PostFilters {
  status: PostStatus | '';
  provider: string;
}

export const NO_FILTERS: PostFilters = { status: '', provider: '' };

export const hasActiveFilters = (f: PostFilters): boolean => f.status !== '' || f.provider !== '';

/**
 * The list endpoint returns a bare page (no total), so a full page is the only hint that more may
 * exist. Pass the RAW page length: posts hidden client-side (dev providers) still count as served.
 */
export function mayHaveMore(rawPageLength: number, limit: number = PAGE_SIZE): boolean {
  return rawPageLength >= limit;
}

/** Append a page, skipping ids already loaded (offset paging can repeat rows if the list shifts). */
export function appendPage(current: PostView[], incoming: PostView[]): PostView[] {
  const seen = new Set(current.map((p) => p.id));
  return [...current, ...incoming.filter((p) => !seen.has(p.id))];
}

/** Swap in an updated post, keeping its position. */
export function replacePost(posts: PostView[], next: PostView): PostView[] {
  return posts.map((p) => (p.id === next.id ? next : p));
}

/** Does this post still belong under the active filters? (After a local status change.) */
export function matchesFilters(post: PostView, f: PostFilters): boolean {
  return (
    (f.status === '' || post.status === f.status) &&
    (f.provider === '' || post.provider === f.provider)
  );
}

/**
 * How to introduce a post's date, or null when there is nothing honest to show. `publishAt` is the
 * scheduled time until a post is sent and the send time after, so the wording follows the status.
 * Drafts carry no date; a scheduled post with no date was created as "post now" (core statusFor)
 * and is waiting on the worker, not on a time. The status badge already says what the post is, so
 * the prefix only says which date this is.
 */
export function whenLabel(
  post: Pick<PostView, 'status' | 'publishAt'>,
): { prefix: string; showDate: boolean } | null {
  const hasDate = parsePublishAt(post.publishAt) !== null;
  switch (post.status) {
    case 'draft':
      return null;
    case 'scheduled':
      return hasDate
        ? { prefix: 'Scheduled for', showDate: true }
        : { prefix: 'Sending as soon as possible', showDate: false };
    case 'publishing':
      return hasDate ? { prefix: 'Scheduled for', showDate: true } : null;
    case 'published':
      return hasDate ? { prefix: 'Published', showDate: true } : null;
    case 'failed':
    case 'cancelled':
      return hasDate ? { prefix: 'Was scheduled for', showDate: true } : null;
  }
}

/** Short, single-line caption excerpt for accessible names ("Edit post: Spring sale…"). */
export function captionSnippet(caption: string, max = 40): string {
  const flat = caption.replace(/\s+/g, ' ').trim();
  if (!flat) return 'no caption';
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Actions valid for a post, in display order. `view` needs a safe release URL. */
export function postActions(post: Pick<PostView, 'status' | 'releaseUrl'>): {
  edit: boolean;
  cancel: boolean;
  viewUrl: string | null;
} {
  return {
    edit: canEditPost(post.status),
    cancel: canCancelPost(post.status),
    viewUrl: safeExternalUrl(post.releaseUrl),
  };
}

/** Provider-supplied links are only followed when they are plain http(s). */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export type ViewMode = 'grid' | 'list';
export const VIEW_STORAGE_KEY = 'meegrow.content.view';

const isViewMode = (v: unknown): v is ViewMode => v === 'grid' || v === 'list';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The remembered Grid/List choice. Storage can be missing, blocked or hold junk: default to grid. */
export function readViewMode(getStorage: () => StorageLike = () => window.localStorage): ViewMode {
  try {
    const raw = getStorage().getItem(VIEW_STORAGE_KEY);
    return isViewMode(raw) ? raw : 'grid';
  } catch {
    return 'grid';
  }
}

export function writeViewMode(
  mode: ViewMode,
  getStorage: () => StorageLike = () => window.localStorage,
): void {
  try {
    getStorage().setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    /* a per-viewer convenience: the page works without it */
  }
}
