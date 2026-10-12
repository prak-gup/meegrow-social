import type { PostView } from '@meegrow-social/contracts';

/** `createPostInput` / `updatePostInput` caption limit. */
export const CAPTION_MAX = 5000;

/**
 * The list endpoint returns a bare page (no total), so a full page is the only hint that more may
 * exist. Pass the RAW page length: posts hidden client-side (dev providers) still count as served.
 */
export function mayHaveMore(rawPageLength: number, limit: number): boolean {
  return rawPageLength >= limit;
}

/** Append a page, skipping ids already loaded (offset paging can repeat rows if the list shifts). */
export function appendPage(current: PostView[], incoming: PostView[]): PostView[] {
  const seen = new Set(current.map((p) => p.id));
  return [...current, ...incoming.filter((p) => !seen.has(p.id))];
}

/** Short, single-line caption excerpt for accessible names ("Edit post: Spring sale…"). */
export function captionSnippet(caption: string, max = 40): string {
  const flat = caption.replace(/\s+/g, ' ').trim();
  if (!flat) return 'no caption';
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
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

/** Read the user-facing portion of core's durable rate-limit waiting note. */
export function publishWaitingTime(post: { status: string; error: string | null }): Date | null {
  if (post.status !== 'scheduled') return null;
  const match = /^Waiting for .+ rate limit, retrying at (\S+)\. Pause \d+; deadline \S+\.$/.exec(
    post.error ?? '',
  );
  if (!match) return null;
  const when = new Date(match[1]!);
  return Number.isFinite(when.getTime()) ? when : null;
}
