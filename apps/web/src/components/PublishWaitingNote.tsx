import type { PostView } from '@meegrow-social/contracts';
import { publishWaitingTime } from '../lib/postList';
import { platformMeta } from '../lib/platforms';
import { Clock } from '../lib/icons';

export function PublishWaitingNote({
  posts,
}: {
  posts: readonly Pick<PostView, 'status' | 'error' | 'provider'>[];
}) {
  const waiting = posts.flatMap((post) => {
    const when = publishWaitingTime(post);
    if (!when) return [];
    const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
    return [
      `Waiting for ${platform.label} rate limit, retrying at ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
    ];
  });
  if (waiting.length === 0) return null;
  return (
    <p
      role="status"
      className="flex items-start gap-1 rounded-xs bg-surface-soft px-1.5 py-1 text-caption text-muted"
    >
      <Clock size={14} className="mt-0.5 flex-none" aria-hidden="true" />
      <span>{waiting.join(' ')}</span>
    </p>
  );
}
