import { PublishWaitingNote } from '../components/PublishWaitingNote';
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
import { Button } from '../components/ui/Button';
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
          <PageHeader
            title={<span className="break-words [overflow-wrap:anywhere]">{blogTitle(post)}</span>}
            subtitle={site?.displayName ?? 'Disconnected site'}
            actions={
              <>
                <StatusChip status={blogChip(post)} label={blogStatusLabel(post)} />
                {url && (
                  <Button asChild variant="outline">
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      View on site
                    </a>
                  </Button>
                )}
              </>
            }
          />
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
          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <ArticlePreview body={post.caption} html={remote?.bodyFormat === 'html'} />
            <aside className="min-w-0 space-y-4" aria-label="Article settings">
              <h2 className="text-body font-semibold">Article settings</h2>
              <dl className="space-y-3 text-sm">
                {[
                  ['Site', site?.externalId ?? '—'],
                  ['Site status', blogStatusLabel(post)],
                  ['Author', remote?.author || '—'],
                  [
                    'Categories',
                    remote
                      ? remote.categories.join(', ') || '—'
                      : options?.categories?.join(', ') || '—',
                  ],
                  [
                    'Tags',
                    remote ? remote.tags.join(', ') || '—' : options?.tags?.join(', ') || '—',
                  ],
                  ['Published date', blogDateLabel(blogDate(post, 'published'))],
                  ['Modified date', blogDateLabel(blogDate(post, 'modified'))],
                  ['Source', blogSource(post)],
                  ['Slug', remote?.slug ?? options?.slug ?? '—'],
                  ['Excerpt', remote ? remote.excerpt || '—' : options?.excerpt || '—'],
                  [
                    'Body format',
                    remote?.bodyFormat === 'html' ? 'HTML from site' : 'Markdown published here',
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-caption text-muted">{label}</dt>
                    <dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <section aria-label="Featured image" className="space-y-2">
                <h3 className="text-sm font-semibold">Featured image</h3>
                {image ? (
                  <img
                    src={image}
                    alt={`Featured image for ${blogTitle(post)}`}
                    loading="lazy"
                    className="max-h-80 w-full rounded-md object-contain"
                  />
                ) : (
                  <p className="text-caption text-muted">No featured image stored.</p>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
