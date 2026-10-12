import type { PostOptions } from '@meegrow-social/contracts';
/**
 * Reading back what an account already has on the platform — the optional half of the provider
 * contract behind "import past posts" (`services/post-import.ts`). Kept out of `types.ts` so that
 * file's edit stays two optional methods.
 */

export interface PublishedPostQuery {
  /** Oldest publish time wanted. A provider may return older items; the caller drops them. */
  since: Date;
  /** Newest publish time wanted. Absent = up to now. */
  until?: Date;
  /** `nextCursor` of the previous page, within one run. Social cursors are never stored; WordPress numeric page/offset may resume a run. */
  cursor?: string;
  /** Items per page. Kept modest by the caller; the provider clamps it to the platform's maximum. */
  limit: number;
}

/** One post as the platform lists it, normalised. Nothing here is a metric (invariant 7). */
export interface PublishedPostItem {
  /** The id per-post analytics are polled by — the same id `post()` returns for a new post. */
  externalPostId: string;
  /**
   * Other ids the same post is known by. `post()` does not always return the listing's id — a
   * Facebook video upload answers with the video's id, the listing with the feed story's — so a
   * post this app published is recognised by any of them.
   */
  alternateIds: string[];
  /**
   * Links `post()` may have recorded as `releaseUrl` for this post, other than `permalink` — how a
   * post stored before the platform's id was kept is still recognised. Compared whole, never parsed.
   */
  knownUrls: string[];
  caption: string;
  /** Article metadata, retained on the existing options JSON column. */
  options?: PostOptions;
  /** The platform's own publish time. */
  publishedAt: Date;
  permalink: string | null;
  /** What the first media item is; null for a text-only post. */
  mediaKind: 'image' | 'video' | null;
  /** How many media items the post carries (a carousel or album has more than one). */
  mediaCount: number;
  /**
   * A still of the first media item on the platform's CDN. SHORT-LIVED: these urls stop working
   * (RESEARCH meta.md §7.2), so the importer copies the bytes and never stores the url.
   */
  thumbnailUrl: string | null;
}

/**
 * How much of the platform's rate limit this app has used, as the platform reports it on the
 * response. `percent` is the highest of the figures it gives (calls, CPU time, total time).
 */
export interface ProviderUsage {
  percent: number;
  /** Minutes until calls are accepted again, when the platform says it is throttling. */
  regainAccessMinutes: number | null;
}

export interface PublishedPostPage {
  items: PublishedPostItem[];
  /** Null on the last page. */
  nextCursor: string | null;
  /** Null when the response carried no usage figures (a platform sends them only under load). */
  usage: ProviderUsage | null;
}

/**
 * Whether the platform still has a post. `unknown` whenever the answer is not certain — a refused
 * or failed read must never be taken for a deletion.
 */
export type PublishedPostPresence = 'present' | 'gone' | 'unknown';
