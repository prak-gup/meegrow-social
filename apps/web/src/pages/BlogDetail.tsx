import { BlogSyncAction } from '../components/BlogSyncAction';
import { PublishWaitingNote } from '../components/PublishWaitingNote';
import { RemoteArticleEditor } from '../components/RemoteArticleEditor';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ConnectionView, PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import {
  blogChip,
  blogDate,
  blogDateLabel,
  blogOptions,
  blogSource,
  blogStatusLabel,
  blogTitle,
  isSiteArticle,
} from '../lib/blog';
import { safeExternalUrl } from '../lib/postList';
import { ArticlePreview } from '../components/ArticlePreview';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { StatusChip } from '../components/ui/StatusChip';

export function BlogDetail() {
  const { postId } = useParams();
  const [post, setPost] = useState<PostView | null>(null);
  const [site, setSite] = useState<ConnectionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stale = false;
    setPost(null);
    setSite(null);
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (!postId || !/^[0-9a-f-]{36}$/i.test(postId)) return;
        const [result, connections] = await Promise.all([
          api.getPost(postId),
          api.listConnections(),
        ]);
        if (stale) return;
        setPost(isSiteArticle(result.post) ? result.post : null);
        setSite(connections.connections.find((c) => c.id === result.post.connectionId) ?? null);
      } catch (e) {
        if (!stale) setError(e instanceof Error ? e.message : 'Please try again.');
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [postId, attempt]);
  const options = post ? blogOptions(post) : null;
  const remote = options?.remote;
  const url = safeExternalUrl(post?.releaseUrl);
  const image = safeExternalUrl(post?.media?.find((m) => m.kind === 'image')?.url);
  return (
    <div className="min-w-0 space-y-4">
      <Link to="/blog" className="inline-block text-sm underline">
        Back to Blog
      </Link>
      {loading ? (
        <p role="status" className="text-sm text-muted">
          Loading article…
        </p>
      ) : error ? (
        <ErrorState
          title="Couldn't load article"
          message={error}
          onRetry={() => setAttempt((a) => a + 1)}
        />
      ) : !post ? (
        <EmptyState
          title="Article unavailable"
          description="This article is not in this client's WordPress inventory. Return to Blog to choose another article."
        />
      ) : (
        <>
          <div className="mx-auto w-full max-w-[70ch]">
            <PageHeader
              title={
                <span className="break-words [overflow-wrap:anywhere]">{blogTitle(post)}</span>
              }
              subtitle={site?.displayName ?? 'Disconnected site'}
              actions={
                <BlogSyncAction
                  connections={site ? [site] : []}
                  onFinished={() => setAttempt((a) => a + 1)}
                />
              }
            />
          </div>
          <PublishWaitingNote posts={[post]} />
          {post.platformRemovedAt && (
            <p className="text-sm text-muted">
              Removed on the site. The stored copy remains here for reference.
            </p>
          )}
          {!remote && (
            <p className="text-sm text-muted">
              These are the settings sent when published here. Site metadata has not been stored;
              missing values are shown as —.
            </p>
          )}
          {remote?.bodyTruncated && (
            <p role="status" className="text-sm text-muted">
              Body truncated for storage. Body editing is unavailable because writing this copy
              would lose content on the site.
            </p>
          )}
          <article className="mx-auto w-full max-w-[70ch] space-y-6" aria-label="Article document">
            {image && (
              <img
                src={image}
                alt={`Featured image for ${blogTitle(post)}`}
                loading="lazy"
                className="max-h-96 w-full rounded-md object-contain"
              />
            )}
            <dl className="flex flex-wrap gap-x-5 gap-y-3 border-b border-hairline pb-4 text-sm">
              {[
                ['Status', blogStatusLabel(post)],
                ['Author', remote?.author || '—'],
                ['Published', blogDateLabel(blogDate(post, 'published'))],
                ['Modified', blogDateLabel(blogDate(post, 'modified'))],
                [
                  'Categories',
                  remote?.categories.join(', ') || options?.categories?.join(', ') || '—',
                ],
                ['Tags', remote?.tags.join(', ') || options?.tags?.join(', ') || '—'],
                ['Source', blogSource(post)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-caption text-muted">{label}</dt>
                  <dd className="break-words">
                    {label === 'Status' ? (
                      <StatusChip status={blogChip(post)} label={blogStatusLabel(post)} />
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              ))}
              {url && (
                <div>
                  <dt className="text-caption text-muted">Live article</dt>
                  <dd>
                    <a className="underline" href={url} target="_blank" rel="noopener noreferrer">
                      View on site
                    </a>
                  </dd>
                </div>
              )}
            </dl>
            <ArticlePreview body={post.caption} html={remote?.bodyFormat === 'html'} />
          </article>
          <RemoteArticleEditor key={post.id} post={post} onChange={setPost} />
        </>
      )}
    </div>
  );
}
