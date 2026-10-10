import { useCallback, useEffect, useState } from 'react';
import type { PostStatus, PostView, ProviderView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { providerVisible } from '../lib/devProviders';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { Select } from '../components/ui/Select';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { Table } from '../components/ui/Table';
import { Article } from '../lib/icons';
import { STATUS_VARIANT } from '../lib/postStatus';
import { formatPublishAt } from '../lib/postDate';
import { promptEditCaption } from '../lib/postActions';

type View = 'grid' | 'list';

export function Posts() {
  const [view, setView] = useState<View>('grid');
  const [posts, setPosts] = useState<PostView[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listPosts({
        status: status || undefined,
        provider: provider || undefined,
      });
      // Dev/fake posts stay out of every view in production (lib/devProviders).
      setPosts(res.posts.filter((p) => providerVisible(p.provider)));
    } finally {
      setLoading(false);
    }
  }, [status, provider]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Platform filter options: the providers registered in this environment (fakes stay dev-only).
  useEffect(() => {
    void api
      .listProviders()
      .then((res) => setProviders(res.providers.filter((p) => providerVisible(p.identifier))))
      .catch(() => setProviders([]));
  }, []);

  const cancel = async (id: string) => {
    try {
      await api.cancelPost(id);
    } catch {
      /* keep simple */
    }
    void loadList();
  };
  const editCaption = async (post: PostView) => {
    if (await promptEditCaption(post)) void loadList();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Content"
        subtitle="Every post for this client, across platforms."
        className="mb-0"
        actions={
          <div className="flex gap-1">
            {(['grid', 'list'] as View[]).map((v) => (
              <Button
                key={v}
                variant={view === v ? 'default' : 'outline'}
                size="sm"
                onClick={() => setView(v)}
              >
                {v[0]?.toUpperCase()}
                {v.slice(1)}
              </Button>
            ))}
          </div>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="">All statuses</option>
          {(
            ['draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'] as PostStatus[]
          ).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select value={provider} onChange={(e) => setProvider(e.target.value)} className="w-40">
          <option value="">All platforms</option>
          {providers.map((p) => (
            <option key={p.identifier} value={p.identifier}>
              {p.displayName}
            </option>
          ))}
        </Select>
        <Button variant="outline" size="sm" onClick={() => void loadList()}>
          Apply
        </Button>
      </div>

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : posts.length === 0 ? (
        <EmptyState
          title="No posts match"
          description="Try a different status or provider."
          icon={Article}
        />
      ) : view === 'list' ? (
        <PostList posts={posts} onCancel={cancel} onEdit={editCaption} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} onCancel={cancel} onEdit={editCaption} />
          ))}
        </div>
      )}
    </div>
  );
}

function PostCard({
  post,
  onCancel,
  onEdit,
}: {
  post: PostView;
  onCancel: (id: string) => void;
  onEdit: (post: PostView) => void;
}) {
  // Cancelled posts recede rather than turning the grid into a wall of grey (the old "graveyard").
  const receded = post.status === 'cancelled';
  return (
    <Card className={receded ? 'opacity-60' : ''}>
      <CardContent className="space-y-2 p-4">
        <p className="line-clamp-3 text-body leading-snug">
          {post.caption || <span className="text-muted">(no caption)</span>}
        </p>
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted">{post.provider}</span>
          <Badge variant={STATUS_VARIANT[post.status]}>{post.status}</Badge>
        </div>
        <p className="tnum text-xs text-muted">{formatPublishAt(post.publishAt)}</p>
        {post.error && <p className="text-xs text-error">{post.error}</p>}
        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => onEdit(post)}>
            Edit
          </Button>
          {/* Cancel is a routine action — a ghost, not alarm-red. Red stays for genuine failures. */}
          <Button variant="ghost" size="sm" onClick={() => onCancel(post.id)}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PostList({
  posts,
  onCancel,
  onEdit,
}: {
  posts: PostView[];
  onCancel: (id: string) => void;
  onEdit: (post: PostView) => void;
}) {
  return (
    <Table
      caption="Posts"
      rows={posts}
      rowKey={(p) => p.id}
      columns={[
        {
          key: 'status',
          header: 'Status',
          cell: (p) => <Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge>,
        },
        {
          key: 'provider',
          header: 'Platform',
          cell: (p) => <span className="font-medium">{p.provider}</span>,
        },
        {
          key: 'caption',
          header: 'Caption',
          className: 'w-full max-w-0 truncate',
          cell: (p) => (
            <>
              <span className="text-muted">{p.caption || '(no caption)'}</span>
              {p.error && <span className="ml-3 text-error">{p.error}</span>}
            </>
          ),
        },
        {
          key: 'when',
          header: 'When',
          className: 'hidden whitespace-nowrap text-muted md:table-cell',
          cell: (p) => formatPublishAt(p.publishAt),
        },
      ]}
      rowActions={(p) => (
        <>
          <Button variant="outline" size="sm" onClick={() => onEdit(p)}>
            Edit
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onCancel(p.id)}>
            Cancel
          </Button>
        </>
      )}
    />
  );
}
