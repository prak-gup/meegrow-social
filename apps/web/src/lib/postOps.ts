import type { PostView } from '@meegrow-social/contracts';

export interface OpsResult {
  /** The variants the action went through for, as they are now. */
  done: PostView[];
  failed: Array<{ post: PostView; message: string }>;
}

/**
 * Run one API action on each variant of a group, in turn. A group action is N requests, one per
 * platform, and any of them can be refused on its own (a post that went out a second ago can no
 * longer be cancelled) — so one failure does not stop or hide the rest.
 */
export async function runOnPosts(
  posts: readonly PostView[],
  action: (post: PostView) => Promise<PostView>,
): Promise<OpsResult> {
  const result: OpsResult = { done: [], failed: [] };
  for (const post of posts) {
    try {
      result.done.push(await action(post));
    } catch (e) {
      result.failed.push({ post, message: e instanceof Error ? e.message : 'Request failed.' });
    }
  }
  return result;
}

/** "Saved for 1 of 3 accounts." plus what stopped each of the others, by account name. */
export function partialFailureText(
  result: OpsResult,
  verb: string,
  accountName: (post: PostView) => string,
): string {
  const total = result.done.length + result.failed.length;
  const reasons = result.failed.map((f) => `${accountName(f.post)}: ${f.message}`).join(' ');
  if (total === 1) return result.failed[0]?.message ?? '';
  const head =
    result.done.length === 0
      ? `Not ${verb} for any of the ${total} accounts.`
      : `${verb.charAt(0).toUpperCase()}${verb.slice(1)} for ${result.done.length} of ${total} accounts.`;
  return `${head} ${reasons}`;
}
