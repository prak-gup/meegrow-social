import type { PostStatus } from './posts.js';

/**
 * Kept free of runtime imports (types only) and exported on its own subpath,
 * `@meegrow-social/contracts/group-status`, so the dashboard can share this rule without pulling
 * the zod schemas into its bundle. The package root re-exports it for everyone else.
 */

/** A group's headline status: a post status, or `partly_failed`. `postGroupStatus` is its schema. */
export type PostGroupStatus = PostStatus | 'partly_failed';

/** Least advanced first: what is still owed on a group that has not fully gone out. */
const PENDING_ORDER: readonly PostStatus[] = ['draft', 'scheduled', 'publishing'];

/**
 * The ONE rule for a group's status, shared by the API (`GET /v1/post-groups`) and the dashboard's
 * calendar, which groups a day's posts itself. Each variant keeps its own status; this is only the
 * headline:
 *
 * 1. Cancelled variants are set aside — unless every variant is cancelled, then `cancelled`.
 * 2. Of the rest: all failed → `failed`; some failed → `partly_failed`. A failure outranks
 *    everything else, because it is the one state that needs a person.
 * 3. All published → `published`.
 * 4. Otherwise the least advanced pending state present: `draft`, then `scheduled`, then
 *    `publishing` — a group is only as far along as its slowest variant.
 *
 * An empty list reads `draft`; a group cannot be created without a variant, so that is a fallback.
 */
export function groupDisplayStatus(statuses: readonly PostStatus[]): PostGroupStatus {
  const live: readonly PostStatus[] = statuses.filter((s) => s !== 'cancelled');
  if (live.length === 0) return statuses.length > 0 ? 'cancelled' : 'draft';
  const failed = live.filter((s) => s === 'failed').length;
  if (failed === live.length) return 'failed';
  if (failed > 0) return 'partly_failed';
  if (live.every((s) => s === 'published')) return 'published';
  return PENDING_ORDER.find((s) => live.includes(s)) ?? 'published';
}
