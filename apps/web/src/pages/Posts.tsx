import { useCallback, useEffect, useState } from 'react';
import type { CalendarView, PostStatus, PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';

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
      setPosts(res.posts);
    } finally {
      setLoading(false);
    }
  }, [status, provider]);

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    try {
      setCalendar(
        await api.calendar(year, month, Intl.DateTimeFormat().resolvedOptions().timeZone),
      );
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    if (view === 'calendar') void loadCalendar();
    else void loadList();
  }, [view, loadList, loadCalendar]);

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Posts</h1>
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
      </div>

      {view !== 'calendar' && (
        <div className="flex gap-2">
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
          <Input
            placeholder="Provider filter (e.g. fake)"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-56"
          />
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
        <p className="text-muted-foreground">Loading…</p>
      ) : view === 'calendar' ? (
        <CalendarGrid calendar={calendar} />
      ) : posts.length === 0 ? (
        <p className="text-muted-foreground">No posts match.</p>
      ) : view === 'list' ? (
        <PostList posts={posts} onCancel={cancel} onEdit={editCaption} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <Badge variant={STATUS_VARIANT[post.status]}>{post.status}</Badge>
          <span className="text-xs text-muted-foreground">{post.provider}</span>
        </div>
        <p className="line-clamp-3 text-sm">
          {post.caption || <span className="text-muted-foreground">(no caption)</span>}
        </p>
        {post.publishAt && (
          <p className="text-xs text-muted-foreground">
            {new Date(post.publishAt).toLocaleString()}
          </p>
        )}
        {post.error && <p className="text-xs text-destructive">{post.error}</p>}
        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => onEdit(post)}>
            Edit
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onCancel(post.id)}>
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
    <Card>
      <CardContent className="divide-y p-0">
        {posts.map((p) => (
          <div key={p.id} className="flex items-center gap-3 p-3 text-sm">
            <Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge>
            <span className="font-medium">{p.provider}</span>
            <span className="flex-1 truncate text-muted-foreground">
              {p.caption || '(no caption)'}
            </span>
            {p.error && <span className="truncate text-destructive">{p.error}</span>}
            <Button variant="outline" size="sm" onClick={() => onEdit(p)}>
              Edit
            </Button>
            <Button variant="destructive" size="sm" onClick={() => onCancel(p.id)}>
              Cancel
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CalendarGrid({ calendar }: { calendar: CalendarView | null }) {
  if (!calendar || calendar.days.length === 0) {
    return <p className="text-muted-foreground">No posts scheduled this month.</p>;
  }
  return (
    <div className="space-y-2">
      {calendar.days.map((day) => (
        <Card key={day.date}>
          <CardContent className="p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">{day.date}</div>
            <div className="space-y-1">
              {day.posts.map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-sm">
                  <Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge>
                  <span className="flex-1 truncate">{p.caption || '(no caption)'}</span>
                  <span className="text-xs text-muted-foreground">{p.provider}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
