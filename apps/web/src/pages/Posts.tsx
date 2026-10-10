import { useCallback, useEffect, useState } from 'react';
import type { CalendarView, PostStatus, PostView, ProviderView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { providerVisible } from '../lib/devProviders';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { Table } from '../components/ui/Table';
import { Article } from '../lib/icons';

type View = 'grid' | 'list' | 'calendar';

const STATUS_VARIANT: Record<PostStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  draft: 'neutral',
  scheduled: 'info',
  publishing: 'info',
  published: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export function Posts() {
  const [view, setView] = useState<View>('grid');
  const [posts, setPosts] = useState<PostView[]>([]);
  const [calendar, setCalendar] = useState<CalendarView | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

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

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    try {
      const cal = await api.calendar(year, month, Intl.DateTimeFormat().resolvedOptions().timeZone);
      setCalendar({
        ...cal,
        days: cal.days
          .map((d) => ({ ...d, posts: d.posts.filter((p) => providerVisible(p.provider)) }))
          .filter((d) => d.posts.length > 0),
      });
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    if (view === 'calendar') void loadCalendar();
    else void loadList();
  }, [view, loadList, loadCalendar]);

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
    const caption = window.prompt('Edit caption', post.caption);
    if (caption === null) return;
    try {
      await api.updatePost(post.id, { caption });
    } catch {
      /* ignore */
    }
    void loadList();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Content"
        subtitle="Every post for this client, across platforms."
        className="mb-0"
        actions={
          <div className="flex gap-1">
            {(['grid', 'list', 'calendar'] as View[]).map((v) => (
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

      {view !== 'calendar' && (
        <div className="flex flex-wrap gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
            <option value="">All statuses</option>
            {(
              [
                'draft',
                'scheduled',
                'publishing',
                'published',
                'failed',
                'cancelled',
              ] as PostStatus[]
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
      )}

      {view === 'calendar' && (
        <div className="flex items-center gap-2">
          <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="w-28">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="w-24"
          />
        </div>
      )}

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : view === 'calendar' ? (
        <CalendarGrid calendar={calendar} />
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
        {post.publishAt && (
          <p className="tnum text-xs text-muted">{new Date(post.publishAt).toLocaleString()}</p>
        )}
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
          cell: (p) => (p.publishAt ? new Date(p.publishAt).toLocaleString() : '—'),
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

function CalendarGrid({ calendar }: { calendar: CalendarView | null }) {
  if (!calendar || calendar.days.length === 0) {
    return <p className="text-muted">No posts scheduled this month.</p>;
  }
  return (
    <div className="space-y-2">
      {calendar.days.map((day) => (
        <Card key={day.date}>
          <CardContent className="p-3">
            <div className="mb-1 text-xs font-medium text-muted">{day.date}</div>
            <div className="space-y-1">
              {day.posts.map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-sm">
                  <Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge>
                  <span className="flex-1 truncate">{p.caption || '(no caption)'}</span>
                  <span className="text-xs text-muted">{p.provider}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
