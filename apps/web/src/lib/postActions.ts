import type { PostView } from '@meegrow-social/contracts';
import { api } from './api';

/**
 * The "Edit" action on a post: prompt for a new caption and save it. Resolves false when the
 * operator dismissed the prompt (nothing to reload), true once an update was attempted.
 */
export async function promptEditCaption(post: PostView): Promise<boolean> {
  const caption = window.prompt('Edit caption', post.caption);
  if (caption === null) return false;
  try {
    await api.updatePost(post.id, { caption });
  } catch {
    /* ignore */
  }
  return true;
}
