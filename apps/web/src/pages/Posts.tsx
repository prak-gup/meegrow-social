import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PostView, ProviderView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { providerVisible } from '../lib/devProviders';
import { cn } from '../lib/cn';
import { platformMeta } from '../lib/platforms';
import { formatPublishAt, parsePublishAt } from '../lib/postDate';
import { POST_STATUSES, STATUS_LABEL, STATUS_VARIANT } from '../lib/postStatus';
import {
  NO_FILTERS,
  PAGE_SIZE,
  appendPage,
  captionSnippet,
  hasActiveFilters,
  matchesFilters,
  mayHaveMore,
  postActions,
  readViewMode,
  replacePost,
  whenLabel,
  writeViewMode,
  type PostFilters,
  type ViewMode,
} from '../lib/postList';
import { CancelPostModal } from '../components/CancelPostModal';
import { EditCaptionModal } from '../components/EditCaptionModal';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Label } from '../components/ui/Label';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { Table } from '../components/ui/Table';
import { ArrowSquareOut, Article } from '../lib/icons';

const VIEWS: { mode: ViewMode; label: string }[] = [
  { mode: 'grid', label: 'Grid' },
  { mode: 'list', label: 'List' },
];

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Please try again.');

/** Content: every post for the active client, filterable, with the actions valid for each status. */
export function Posts() {
  const [view, setView] = useState<ViewMode>(() => readViewMode());
  const [filters, setFilters] = useState<PostFilters>(NO_FILTERS);
  const [posts, setPosts] = useState<PostView[]>([]);
  // The list has no total: `served` counts rows the API returned (including any hidden dev posts)
  // and is the next offset; `more` is true while the last page came back full.
  const [served, setServed] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [accounts, setAccounts] = useState<ReadonlyMap<string, string>>(new Map());
  const [editing, setEditing] = useState<PostView | null>(null);
  const [cancelling, setCancelling] = useState<PostView | null>(null);
  const [notice, setNotice] = useState('');

  const { status, provider } = filters;
  // Which filter set (and retry) the loaded list belongs to, so a late "Load more" can be dropped.
  const listKey = useRef('');

  // First page, reloaded whenever a filter changes (or on retry). A slow response for filters the
  // operator already left must not overwrite the current list.
  useEffect(() => {
    let stale = false;
    listKey.current = `${status}|${provider}|${attempt}`;
    setLoading(true);
    setError(null);
    setMoreError(null);
    setNotice('');
    api
      .listPosts({
        status: status || undefined,
        provider: provider || undefined,
        limit: PAGE_SIZE,
        offset: 0,
      })
      .then((res) => {
        if (stale) return;
        // Dev/fake posts stay out of every view in production (lib/devProviders).
        setPosts(res.posts.filter((p) => providerVisible(p.provider)));
        setServed(res.posts.length);
        setMore(mayHaveMore(res.posts.length));
      })
      .catch((e: unknown) => {
        if (!stale) setError(errorText(e));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [status, provider, attempt]);

  const loadMore = async () => {
    const key = listKey.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await api.listPosts({
        status: status || undefined,
        provider: provider || undefined,
        limit: PAGE_SIZE,
        offset: served,
      });
      if (key !== listKey.current) return;
      setPosts((prev) =>
        appendPage(
          prev,
          res.posts.filter((p) => providerVisible(p.provider)),
        ),
      );
      setServed((n) => n + res.posts.length);
      setMore(mayHaveMore(res.posts.length));
    } catch (e) {
      if (key === listKey.current) setMoreError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  // Platform filter options: the providers registered in this environment (fakes stay dev-only).
  useEffect(() => {
    void api
      .listProviders()
      .then((res) => setProviders(res.providers.filter((p) => providerVisible(p.identifier))))
      .catch(() => setProviders([]));
  }, []);

  // Account names for the cards: one request, joined on connectionId. Without it the cards just
  // show the platform.
  useEffect(() => {
    void api
      .listConnections()
      .then((res) => setAccounts(new Map(res.connections.map((c) => [c.id, c.displayName]))))
      .catch(() => setAccounts(new Map()));
  }, []);

  const chooseView = (mode: ViewMode) => {
    setView(mode);
    writeViewMode(mode);
  };

  const closeEdit = useCallback(() => setEditing(null), []);
  const closeCancel = useCallback(() => setCancelling(null), []);

  const saved = useCallback((post: PostView) => {
    setPosts((prev) => replacePost(prev, post));
    setEditing(null);
    setNotice('Caption saved.');
  }, []);

  const cancelled = useCallback(
    (post: PostView) => {
      const next: PostView = { ...post, status: 'cancelled' };
      // Under a status filter the post no longer belongs; otherwise it stays, marked cancelled.
      setPosts((prev) =>
        matchesFilters(next, filters)
          ? replacePost(prev, next)
          : prev.filter((p) => p.id !== post.id),
      );
      setCancelling(null);
      setNotice('Post cancelled.');
    },
    [filters],
  );

  const actions = { onEdit: setEditing, onCancel: setCancelling };

  const filtered = hasActiveFilters(filters);
  const clearFilters = () => setFilters(NO_FILTERS);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Content"
        subtitle="Every post for this client, across platforms."
        className="mb-0"
        actions={
          <div role="group" aria-label="View" className="flex gap-1">
            {VIEWS.map(({ mode, label }) => (
              <Button
                key={mode}
                variant={view === mode ? 'default' : 'outline'}
                size="sm"
                aria-pressed={view === mode}
                onClick={() => chooseView(mode)}
              >
                {label}
              </Button>
            ))}
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="filter-status">Status</Label>
          <Select
            id="filter-status"
            value={status}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: e.target.value as PostFilters['status'] }))
            }
            className="w-40"
          >
            <option value="">All statuses</option>
            {POST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filter-platform">Platform</Label>
          <Select
            id="filter-platform"
            value={provider}
            onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value }))}
            className="w-48"
          >
            <option value="">All platforms</option>
            {providers.map((p) => (
              <option key={p.identifier} value={p.identifier}>
                {p.displayName}
              </option>
            ))}
          </Select>
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
        {!loading && !error && posts.length > 0 && (
          <p className="tnum pb-2.5 text-caption text-muted">
            {more ? `Showing the first ${posts.length} posts` : `${posts.length} posts`}
          </p>
        )}
      </div>

      {/* Announces results of actions and filter changes to screen readers. */}
      <p role="status" className="sr-only">
        {loading ? 'Loading posts' : notice || `${posts.length} posts shown`}
      </p>

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : error ? (
        <ErrorState
          title="Couldn't load posts"
          message={error}
          onRetry={() => setAttempt((a) => a + 1)}
        />
      ) : posts.length === 0 && !more ? (
        filtered ? (
          <EmptyState
            title="No posts match these filters"
            description="Try a different status or platform."
            icon={Article}
            action={
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="No posts yet"
            description="Posts you create or schedule for this client will show up here."
            icon={Article}
            action={
              <Button asChild>
                <Link to="/composer">Create post</Link>
              </Button>
            }
          />
        )
      ) : (
        <>
          {view === 'list' ? (
            <PostList posts={posts} accounts={accounts} {...actions} />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {posts.map((p) => (
                <li key={p.id} className="min-w-0">
                  <PostCard post={p} account={accounts.get(p.connectionId)} {...actions} />
                </li>
              ))}
            </ul>
          )}
          {moreError && (
            <p role="alert" className="text-sm text-error">
              Couldn’t load more posts: {moreError}
            </p>
          )}
          {more && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : moreError ? 'Try again' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}

      {editing && <EditCaptionModal post={editing} onSaved={saved} onClose={closeEdit} />}
      {cancelling && (
        <CancelPostModal post={cancelling} onCancelled={cancelled} onClose={closeCancel} />
      )}
    </div>
  );
}

interface PostHandlers {
  onEdit: (post: PostView) => void;
  onCancel: (post: PostView) => void;
}

/** Brand-coloured platform mark. The platform is always named in text next to it. */
function PlatformTile({ provider }: { provider: string }) {
  const platform = platformMeta({ identifier: provider, displayName: provider });
  return (
    <span
      className={cn(
        'grid h-10 w-10 flex-none place-items-center rounded-sm text-white',
        platform.brand,
      )}
      aria-hidden="true"
    >
      <platform.Icon size={22} weight="fill" />
    </span>
  );
}

/** "Scheduled for <date>" and friends; nothing for drafts or when there is no honest date. */
function When({ post, className }: { post: PostView; className?: string }) {
  const label = whenLabel(post);
  if (!label) return null;
  const date = parsePublishAt(post.publishAt);
  return (
    <p className={cn('tnum text-caption text-muted', className)}>
      {label.prefix}
      {label.showDate && date && (
        <>
          {' '}
          <time dateTime={date.toISOString()}>{formatPublishAt(post.publishAt)}</time>
        </>
      )}
    </p>
  );
}

/** The provider's reason a post failed, set apart so it isn't read as caption text. */
function ProviderError({ message }: { message: string }) {
  return (
    <div className="rounded-sm border border-status-bad/30 bg-status-bad/5 p-3 text-caption">
      <p className="font-semibold text-status-bad">Provider error</p>
      <p className="mt-0.5 break-words text-body-ink">{message}</p>
    </div>
  );
}

/**
 * Only the actions the API will accept for this status. Each name carries the caption so a screen
 * reader's button list isn't twenty identical "Edit"s.
 */
function PostActions({ post, onEdit, onCancel }: { post: PostView } & PostHandlers) {
  const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
  const snippet = captionSnippet(post.caption);
  const { edit, cancel, viewUrl } = postActions(post);
  return (
    <>
      {edit && (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Edit post: ${snippet}`}
          onClick={() => onEdit(post)}
        >
          Edit
        </Button>
      )}
      {/* Cancel is routine, so a ghost here; the confirm dialog carries the destructive button. */}
      {cancel && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Cancel post: ${snippet}`}
          onClick={() => onCancel(post)}
        >
          Cancel
        </Button>
      )}
      {viewUrl && (
        <Button asChild variant="outline" size="sm">
          <a
            href={viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View post on ${platform.label}: ${snippet} (opens in a new tab)`}
          >
            View post
            <ArrowSquareOut size={16} aria-hidden="true" />
          </a>
        </Button>
      )}
    </>
  );
}

function PostCard({
  post,
  account,
  onEdit,
  onCancel,
}: { post: PostView; account?: string } & PostHandlers) {
  const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
  const { edit, cancel, viewUrl } = postActions(post);
  return (
    <Card className={cn('h-full', post.status === 'cancelled' && 'bg-surface-soft')}>
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <PlatformTile provider={post.provider} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{platform.label}</p>
            {account && <p className="truncate text-caption text-muted">{account}</p>}
          </div>
          <Badge variant={STATUS_VARIANT[post.status]}>{STATUS_LABEL[post.status]}</Badge>
        </div>
        <When post={post} />
        <p className="line-clamp-4 whitespace-pre-line break-words text-body leading-snug text-ink">
          {post.caption || <span className="text-muted">(no caption)</span>}
        </p>
        {post.error && <ProviderError message={post.error} />}
        {(edit || cancel || viewUrl) && (
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <PostActions post={post} onEdit={onEdit} onCancel={onCancel} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PostList({
  posts,
  accounts,
  onEdit,
  onCancel,
}: { posts: PostView[]; accounts: ReadonlyMap<string, string> } & PostHandlers) {
  return (
    <Table
      caption="Posts"
      rows={posts}
      rowKey={(p) => p.id}
      columns={[
        {
          key: 'status',
          header: 'Status',
          className: 'hidden whitespace-nowrap md:table-cell',
          cell: (p) => <Badge variant={STATUS_VARIANT[p.status]}>{STATUS_LABEL[p.status]}</Badge>,
        },
        {
          key: 'platform',
          header: 'Platform',
          className: 'hidden md:table-cell',
          cell: (p) => <PlatformCell post={p} account={accounts.get(p.connectionId)} />,
        },
        {
          key: 'caption',
          header: 'Caption',
          className: 'w-full min-w-0',
          cell: (p) => (
            <div className="min-w-0 space-y-1.5">
              {/* Phones drop the Status, Platform and When columns, so the cell carries them. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden">
                <Badge variant={STATUS_VARIANT[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                <span className="text-caption font-medium text-ink">
                  {platformMeta({ identifier: p.provider, displayName: p.provider }).label}
                </span>
              </div>
              <p className="line-clamp-2 whitespace-pre-line break-words text-body-ink">
                {p.caption || <span className="text-muted">(no caption)</span>}
              </p>
              <When post={p} className="md:hidden" />
              {p.error && <ProviderError message={p.error} />}
            </div>
          ),
        },
        {
          key: 'when',
          header: 'When',
          className: 'hidden md:table-cell md:min-w-40',
          cell: (p) => <When post={p} />,
        },
      ]}
      rowActions={(p) => <PostActions post={p} onEdit={onEdit} onCancel={onCancel} />}
    />
  );
}

function PlatformCell({ post, account }: { post: PostView; account?: string }) {
  const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
  return (
    <div className="flex items-center gap-2.5">
      <PlatformTile provider={post.provider} />
      <div className="min-w-0">
        <p className="whitespace-nowrap font-medium text-ink">{platform.label}</p>
        {account && <p className="truncate text-caption text-muted">{account}</p>}
      </div>
    </div>
  );
}
