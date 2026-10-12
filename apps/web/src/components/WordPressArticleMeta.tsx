import type { PostView } from '@meegrow-social/contracts';
import { Link } from 'react-router-dom';
import { isSiteArticle } from '../lib/blog';
import { safeExternalUrl } from '../lib/postList';

/** Text only: imported HTML is never rendered as executable page content. */
export function WordPressArticleMeta({
  posts,
  link = true,
}: {
  posts: readonly PostView[];
  link?: boolean;
}) {
  const post = posts.find((p) => p.provider === 'wordpress' && p.options?.kind === 'wordpress');
  if (!post || post.options?.kind !== 'wordpress') return null;
  const remote = post.options.remote;
  const url = safeExternalUrl(post.releaseUrl);
  return (
    <span className="block text-caption text-muted">
      {remote && (
        <span className="block">
          {[...remote.categories, ...remote.tags.map((t) => `#${t}`)].join(' · ')}
        </span>
      )}
      {remote?.bodyTruncated && (
        <span className="block">Body truncated for storage. Body editing is unavailable.</span>
      )}
      {link && isSiteArticle(post) && (
        <Link to={`/blog/${post.id}`} className="mr-3 inline-block underline">
          Article details
        </Link>
      )}
      {link && url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
          View article on site
        </a>
      )}
    </span>
  );
}
