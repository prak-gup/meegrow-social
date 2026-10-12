import type { PostView } from '@meegrow-social/contracts';
import { safeExternalUrl } from '../lib/postList';

/** Requested visibility is never presented as YouTube's confirmed result. */
export function YouTubeVideoMeta({
  posts,
  link = true,
  compact = false,
}: {
  posts: readonly PostView[];
  link?: boolean;
  compact?: boolean;
}) {
  const post = posts.find((p) => p.provider === 'youtube' && p.options?.kind === 'youtube');
  if (!post || post.options?.kind !== 'youtube') return null;
  const options = post.options;
  const visibility = options.remote?.privacyStatus;
  const url = safeExternalUrl(post.releaseUrl);
  return (
    <span
      className={
        compact
          ? 'flex-none text-micro text-muted'
          : 'flex flex-wrap items-center gap-2 text-caption text-muted'
      }
    >
      <span className="rounded-full border border-hairline px-2 py-0.5">
        {visibility
          ? visibility[0]!.toUpperCase() + visibility.slice(1)
          : post.status === 'published'
            ? 'Visibility unconfirmed'
            : `Requested ${options.privacyStatus}`}
      </span>
      {!compact && options.durationSeconds !== undefined && (
        <span>
          {Math.floor(options.durationSeconds / 60)}:
          {String(options.durationSeconds % 60).padStart(2, '0')}
        </span>
      )}
      {!compact && options.shortsHint && <span>Shorts tag · classification unconfirmed</span>}
      {link && url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
          View on YouTube
        </a>
      )}
    </span>
  );
}
