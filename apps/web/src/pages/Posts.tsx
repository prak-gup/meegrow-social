import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type {
  ConnectionView,
  PostGroupSummary,
  PostView,
  ProviderView,
} from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { providerVisible } from '../lib/devProviders';
import { platformMeta } from '../lib/platforms';
import {
  BULK_METRICS_MAX,
  GROUP_PAGE_SIZE,
  NO_GROUP_FILTERS,
  RANGES,
  appendGroups,
  applyPosts,
  compactNumber,
  groupCaption,
  groupError,
  groupMatchesStatus,
  groupMetric,
  groupQuery,
  groupThumb,
  groupWhen,
  hasGroupFilters,
  idChunks,
  metricsToLoad,
  topMetricNames,
  visibleGroup,
  type GroupFilters,
  type LatestByPost,
  type RangeKey,
} from '../lib/postGroups';
import { humanizeMetric } from '../lib/analytics';
import {
  captionSnippet,
  mayHaveMore,
  readViewMode,
  writeViewMode,
  type ViewMode,
} from '../lib/postList';
import { POST_STATUSES, STATUS_LABEL } from '../lib/postStatus';
import { PlatformIcons } from '../components/PostMarks';
import { usePostGroupActions, type PostChange } from '../components/PostGroupActions';
import { PostThumb } from '../components/PostThumb';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FilterBar, FilterSelect, ViewToggle } from '../components/ui/FilterBar';
import { PageHeader } from '../components/ui/PageHeader';
import { RowMenu, type RowMenuItem } from '../components/ui/RowMenu';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusChip } from '../components/ui/StatusChip';
import { Table, type TableColumn } from '../components/ui/Table';
import { Article, CalendarBlank, Rows, SquaresFour } from '../lib/icons';

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Please try again.');

/** Typing pauses this long before the caption search goes to the API. */
const SEARCH_DELAY_MS = 300;
const MENU_WIDTH = 232;

/**
 * Content: every post for the active client, one card per composed post however many platforms it
 * went to, with the actions valid for its variants.
 */
export function Posts() {
  const navigate = useNavigate();
  const [view, setView] = useState<ViewMode>(() => readViewMode());
  const [filters, setFilters] = useState<GroupFilters>(NO_GROUP_FILTERS);
  // What is in the search box; it becomes `filters.q` once typing pauses.
  const [search, setSearch] = useState('');
  const [groups, setGroups] = useState<PostGroupSummary[]>([]);
  // The list has no total: `served` counts groups the API returned (including any hidden dev
  // posts) and is the next offset; `more` is true while the last page came back full.
  const [served, setServed] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [latest, setLatest] = useState<LatestByPost>(new Map());
  const [metricsFailed, setMetricsFailed] = useState(false);

  const { q, status, provider, connectionId, range, order } = filters;
  // Which filter set (and retry) the loaded list belongs to, so a late "Load more" can be dropped,
  // and the instant its date range was resolved at, so every page uses the same bounds.
  const listKey = useRef('');
  const loadedAt = useRef(Date.now());
  const asked = useRef(new Set<string>());

  useEffect(() => {
    const t = window.setTimeout(
      () => setFilters((f) => (f.q === search ? f : { ...f, q: search })),
      SEARCH_DELAY_MS,
    );
    return () => window.clearTimeout(t);
  }, [search]);

  const visible = (page: PostGroupSummary[]) =>
    // Dev/fake posts stay out of every view in production (lib/devProviders).
    page.map((g) => visibleGroup(g, providerVisible)).filter((g) => g !== null);

  // First page, reloaded whenever a filter changes (or on retry). A slow response for filters the
  // operator already left must not overwrite the current list.
  useEffect(() => {
    let stale = false;
    const current: GroupFilters = { q, status, provider, connectionId, range, order };
    listKey.current = `${JSON.stringify(current)}|${attempt}`;
    loadedAt.current = Date.now();
    setLoading(true);
    setError(null);
    setMoreError(null);
    api
      .listPostGroups(groupQuery(current, loadedAt.current, 0))
      .then((res) => {
        if (stale) return;
        setGroups(visible(res.groups));
        setServed(res.groups.length);
        setMore(mayHaveMore(res.groups.length, GROUP_PAGE_SIZE));
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
  }, [q, status, provider, connectionId, range, order, attempt]);

  const loadMore = async () => {
    const key = listKey.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await api.listPostGroups(groupQuery(filters, loadedAt.current, served));
      if (key !== listKey.current) return;
      setGroups((prev) => appendGroups(prev, visible(res.groups)));
      setServed((n) => n + res.groups.length);
      setMore(mayHaveMore(res.groups.length, GROUP_PAGE_SIZE));
    } catch (e) {
      if (key === listKey.current) setMoreError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  // Numbers for the cards: one bulk read per page of groups, for the published variants only.
  // A failed read leaves "—" on those cards and says so once; it never fails the list.
  useEffect(() => {
    const ids = metricsToLoad(groups, asked.current);
    if (ids.length === 0) return;
    for (const id of ids) asked.current.add(id);
    for (const chunk of idChunks(ids, BULK_METRICS_MAX)) {
      api
        .latestPostMetrics(chunk)
        .then((res) =>
          setLatest((prev) => {
            const next = new Map(prev);
            for (const [id, entry] of Object.entries(res.metrics)) next.set(id, entry.latest);
            return next;
          }),
        )
        .catch(() => setMetricsFailed(true));
    }
  }, [groups]);

  // The composer panel sits over this page without unmounting it; when it closes after creating a
  // post it says so in router state, and the list is read again.
  const refreshed = (useLocation().state as { refreshed?: number } | null)?.refreshed;
  useEffect(() => {
    if (refreshed) setAttempt((a) => a + 1);
  }, [refreshed]);

  // Platform filter options: the providers registered in this environment (fakes stay dev-only).
  useEffect(() => {
    void api
      .listProviders()
      .then((res) => setProviders(res.providers.filter((p) => providerVisible(p.identifier))))
      .catch(() => setProviders([]));
  }, []);

  // Accounts for the filter and the cards: one request, joined on connectionId. Without it the
  // cards just show the platform.
  useEffect(() => {
    void api
      .listConnections()
      .then((res) => setConnections(res.connections.filter((c) => providerVisible(c.provider))))
      .catch(() => setConnections([]));
  }, []);
  const accounts = useMemo(
    () => new Map(connections.map((c) => [c.id, c.displayName])),
    [connections],
  );

  const onChanged = useCallback(
    (posts: PostView[], change: PostChange) => {
      setGroups((prev) =>
        prev
          .map((g) => applyPosts(g, posts))
          // Under a status filter a group whose variants no longer match leaves the list; a new
          // time can also move a post out of a date range, which only a reload can tell.
          .filter((g) => groupMatchesStatus(g, status)),
      );
      if (change === 'time' && range !== '') setAttempt((a) => a + 1);
    },
    [status, range],
  );
  // A copy is a new draft, placed by its creation time — among today's posts, after anything still
  // to come — so the list is reloaded and the notice offers the way straight to the drafts.
  const onDuplicated = useCallback(() => setAttempt((a) => a + 1), []);
  const actions = usePostGroupActions({ accounts, onChanged, onDuplicated });

  const chooseView = (mode: string) => {
    if (mode === 'calendar') {
      navigate('/calendar');
      return;
    }
    setView(mode as ViewMode);
    writeViewMode(mode as ViewMode);
  };

  const set = (patch: Partial<GroupFilters>) => {
    actions.clearMessages();
    setFilters((f) => ({ ...f, ...patch }));
  };
  const filtered = hasGroupFilters(filters) || search.trim() !== '';
  const clearFilters = () => {
    setSearch('');
    set({ ...NO_GROUP_FILTERS, order });
  };

  const names = useMemo(() => topMetricNames(groups, latest), [groups, latest]);
  const count = more ? `First ${groups.length} posts` : `${groups.length} posts`;

  return (
    <div>
      <PageHeader title="Content" subtitle="Every post for this client, across platforms." />

      <FilterBar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search captions…',
          label: 'Search captions',
        }}
        filters={
          <>
            <FilterSelect
              label="Status"
              value={status}
              onChange={(v) => set({ status: v as GroupFilters['status'] })}
              options={[
                { value: '', label: 'All statuses' },
                ...POST_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
              ]}
            />
            <FilterSelect
              label="Platform"
              value={provider}
              onChange={(v) => set({ provider: v })}
              options={[
                { value: '', label: 'All platforms' },
                ...providers.map((p) => ({
                  value: p.identifier,
                  label: platformMeta(p).label,
                })),
              ]}
            />
            <FilterSelect
              label="Account"
              value={connectionId}
              onChange={(v) => set({ connectionId: v })}
              options={[
                { value: '', label: 'All accounts' },
                ...connections.map((c) => ({
                  value: c.id,
                  label: `${c.displayName} · ${platformMeta({ identifier: c.provider, displayName: c.provider }).label}`,
                })),
              ]}
            />
            <FilterSelect
              label="Date"
              value={range}
              onChange={(v) => set({ range: v as RangeKey })}
              options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            />
            <FilterSelect
              label="Sort"
              value={order}
              onChange={(v) => set({ order: v as GroupFilters['order'] })}
              options={[
                { value: 'desc', label: 'Newest first' },
                { value: 'asc', label: 'Oldest first' },
              ]}
            />
            {filtered && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </>
        }
        actions={
          <>
            {!loading && !error && groups.length > 0 && (
              <p className="tnum text-caption text-muted">
                {count}
                {metricsFailed && ' · some numbers could not be loaded'}
              </p>
            )}
            <ViewToggle
              label="View"
              value={view}
              onChange={chooseView}
              options={[
                { value: 'grid', label: 'Grid', icon: <SquaresFour size={16} /> },
                { value: 'list', label: 'List', icon: <Rows size={16} /> },
                { value: 'calendar', label: 'Calendar', icon: <CalendarBlank size={16} /> },
              ]}
            />
          </>
        }
      />

      {/* Results of actions are shown, not only announced: a duplicate can land off-screen. */}
      <p
        role="status"
        className={cn('text-caption text-muted', actions.notice ? 'mb-2' : 'sr-only')}
      >
        {loading ? 'Loading posts' : actions.notice || `${groups.length} posts shown`}
        {!loading && actions.notice.startsWith('Duplicated') && status !== 'draft' && (
          <>
            {' '}
            <button
              type="button"
              className="font-semibold text-ink underline"
              onClick={() => setFilters((f) => ({ ...f, status: 'draft' }))}
            >
              Show drafts
            </button>
          </>
        )}
      </p>
      {actions.error && (
        <p role="alert" className="mb-2 text-sm text-error">
          {actions.error}
        </p>
      )}

      {loading ? (
        <GridSkeleton />
      ) : error ? (
        <ErrorState
          title="Couldn't load posts"
          message={error}
          onRetry={() => setAttempt((a) => a + 1)}
        />
      ) : groups.length === 0 && !more ? (
        filtered ? (
          <EmptyState
            title="No posts match these filters"
            description="Try a different search, status, platform or date."
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
        <div className="space-y-3">
          {view === 'list' ? (
            <GroupTable
              groups={groups}
              accounts={accounts}
              names={names}
              latest={latest}
              items={actions.items}
            />
          ) : (
            <ul className="grid grid-cols-posts gap-3">
              {groups.map((g) => (
                <li key={g.id} className="min-w-0">
                  <GroupCard
                    group={g}
                    accounts={accounts}
                    names={names}
                    latest={latest}
                    items={actions.items(g)}
                  />
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
        </div>
      )}

      {actions.dialogs}
    </div>
  );
}

/** Same card geometry as the loaded grid, so nothing jumps when the posts arrive. */
function GridSkeleton() {
  return (
    <ul className="grid grid-cols-posts gap-3" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <li key={i} className="rounded-md border border-hairline p-3">
          <Skeleton className="h-5 w-24" />
          <div className="mt-2 flex gap-3">
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <Skeleton className="h-16 w-16" />
          </div>
          <Skeleton className="mt-2 h-5 w-32" />
        </li>
      ))}
    </ul>
  );
}

interface GroupViewProps {
  accounts: ReadonlyMap<string, string>;
  /** Metric names shown on this page, most common first. */
  names: string[];
  latest: LatestByPost;
}

/** "Empower and Shine NDIS +2": who the post is for, by account name where it is known. */
function accountLine(group: PostGroupSummary, accounts: ReadonlyMap<string, string>): string {
  const first = group.posts[0];
  if (!first) return '';
  const name =
    accounts.get(first.connectionId) ??
    platformMeta({ identifier: first.provider, displayName: first.provider }).label;
  return group.posts.length > 1 ? `${name} +${group.posts.length - 1}` : name;
}

/** When the post goes or went out. A real date is a <time>; a stand-in is plain words. */
function When({ group, className }: { group: PostGroupSummary; className?: string }) {
  const when = groupWhen(group);
  return when.date ? (
    <time dateTime={when.date.toISOString()} className={cn('tnum', className)}>
      {when.text}
    </time>
  ) : (
    <span className={className}>{when.text}</span>
  );
}

/** One metric of a group: a number, or a dash that says why for screen readers. Never a 0 stand-in. */
function MetricValue({ value, name }: { value: number | null; name: string }) {
  return value === null ? (
    <>
      <span aria-hidden="true" className="font-normal text-muted">
        —
      </span>
      <span className="sr-only">No {humanizeMetric(name)}</span>
    </>
  ) : (
    <span title={value.toLocaleString()}>{compactNumber(value)}</span>
  );
}

/** The provider's reason a variant failed, kept on the card: a failure has to be seen. */
function FailureLine({ group }: { group: PostGroupSummary }) {
  const failure = groupError(group.posts);
  if (!failure) return null;
  const platform = platformMeta({ identifier: failure.provider, displayName: failure.provider });
  const text = `${platform.label}: ${failure.message}`;
  return (
    // Clamped, not `truncate`: nowrap text in a table cell would force the column to its full width.
    <p className="line-clamp-1 break-words text-caption text-status-bad" title={text}>
      {text}
      {failure.count > 1 && ` (+${failure.count - 1} more)`}
    </p>
  );
}

function GroupCard({
  group,
  accounts,
  names,
  latest,
  items,
}: GroupViewProps & { group: PostGroupSummary; items: RowMenuItem[] }) {
  const published = group.posts.some((p) => p.status === 'published');
  const failed = groupError(group.posts) !== null;
  return (
    <article
      className={cn(
        'flex h-full flex-col rounded-md border border-hairline bg-canvas',
        group.status === 'cancelled' && 'bg-surface-soft',
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <PlatformIcons posts={group.posts} accounts={accounts} />
        <When group={group} className="ml-auto truncate text-caption text-muted" />
        <RowMenu
          label={`Actions for post: ${captionSnippet(groupCaption(group))}`}
          items={items}
          width={MENU_WIDTH}
          className="-mr-1.5"
        />
      </div>
      <div className="flex flex-1 items-start gap-3 px-3 pb-2.5 pt-1">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="line-clamp-2 min-h-10 whitespace-pre-line break-words text-sm text-ink">
            {groupCaption(group) || <span className="text-muted">(no caption)</span>}
          </p>
          <div className="flex min-w-0 items-center gap-2">
            <StatusChip status={group.status} />
            {!failed && (
              <span className="min-w-0 truncate text-caption text-muted">
                {accountLine(group, accounts)}
              </span>
            )}
          </div>
          {failed && <FailureLine group={group} />}
        </div>
        <PostThumb thumb={groupThumb(group)} caption={groupCaption(group)} />
      </div>
      {published && names.length > 0 && (
        <dl className="mt-auto flex gap-3 border-t border-hairline-soft px-3 py-1.5">
          {names.map((name) => (
            <div key={name} className="min-w-0 flex-1">
              <dt className="truncate text-micro text-muted" title={name}>
                {humanizeMetric(name)}
              </dt>
              <dd className="tnum text-sm font-semibold text-ink">
                <MetricValue value={groupMetric(group.posts, latest, name)} name={name} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function GroupTable({
  groups,
  accounts,
  names,
  latest,
  items,
}: GroupViewProps & {
  groups: PostGroupSummary[];
  items: (group: PostGroupSummary) => RowMenuItem[];
}) {
  const columns: TableColumn<PostGroupSummary>[] = [
    {
      key: 'post',
      header: 'Post',
      className: 'w-full min-w-0',
      cell: (g) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <PostThumb thumb={groupThumb(g)} caption={groupCaption(g)} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-1 break-words text-ink">
              {groupCaption(g) || <span className="text-muted">(no caption)</span>}
            </p>
            {/* Phones drop the Platforms, Status and When columns, so the cell carries them. */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden">
              <StatusChip status={g.status} />
              <PlatformIcons posts={g.posts} accounts={accounts} />
              <When group={g} className="text-caption text-muted" />
            </div>
            <FailureLine group={g} />
          </div>
        </div>
      ),
    },
    {
      key: 'platforms',
      header: 'Platforms',
      className: 'hidden whitespace-nowrap md:table-cell',
      cell: (g) => (
        <span className="flex items-center gap-2">
          <PlatformIcons posts={g.posts} accounts={accounts} />
          <span className="hidden max-w-44 truncate text-caption text-muted xl:inline">
            {accountLine(g, accounts)}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'hidden whitespace-nowrap md:table-cell',
      cell: (g) => <StatusChip status={g.status} />,
    },
    {
      key: 'when',
      header: 'When',
      className: 'hidden whitespace-nowrap md:table-cell',
      cell: (g) => <When group={g} className="text-caption text-muted" />,
    },
    ...names.map((name): TableColumn<PostGroupSummary> => ({
      key: `metric:${name}`,
      header: <span title={name}>{humanizeMetric(name)}</span>,
      align: 'right',
      className: 'hidden whitespace-nowrap lg:table-cell',
      cell: (g) => <MetricValue value={groupMetric(g.posts, latest, name)} name={name} />,
    })),
  ];
  return (
    <Table
      caption="Posts"
      dense
      rows={groups}
      rowKey={(g) => g.id}
      columns={columns}
      rowActions={(g) => (
        <RowMenu
          label={`Actions for post: ${captionSnippet(groupCaption(g))}`}
          items={items(g)}
          width={MENU_WIDTH}
        />
      )}
    />
  );
}
