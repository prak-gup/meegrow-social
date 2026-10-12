import { PublishWaitingNote } from '../components/PublishWaitingNote';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ConnectionView, PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { Article } from '../lib/icons';
import {
  BLOG_PAGE_SIZE,
  BLOG_STATUSES,
  EMPTY_BLOG_FILTERS,
  blogChip,
  blogDate,
  blogDateLabel,
  blogOptions,
  blogSource,
  blogStatusLabel,
  blogTitle,
  blogTerms,
  filterBlog,
  loadBlogInventory,
  type BlogFilters,
} from '../lib/blog';
import { importingNote, importSummary } from '../lib/postImport';
import { safeExternalUrl } from '../lib/postList';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FilterBar, FilterSelect } from '../components/ui/FilterBar';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusChip } from '../components/ui/StatusChip';
import { Table, type TableColumn } from '../components/ui/Table';

export function Blog() {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<PostView[]>([]);
  const [sites, setSites] = useState<ConnectionView[]>([]);
  const [filters, setFilters] = useState<BlogFilters>(EMPTY_BLOG_FILTERS);
  const [shown, setShown] = useState(BLOG_PAGE_SIZE);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const connections = await api.listConnections();
        if (stale) return;
        setSites(connections.connections.filter((c) => c.provider === 'wordpress'));
        const inventory = await loadBlogInventory(api.listPosts, () => stale);
        if (inventory !== null && !stale) setPosts(inventory);
      } catch (e) {
        if (!stale) setError(e instanceof Error ? e.message : 'Please try again.');
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [attempt]);
  const rows = useMemo(() => filterBlog(posts, filters), [posts, filters]);
  const categories = useMemo(
    () => [...new Set(posts.flatMap((p) => blogTerms(p, 'categories')))].sort(),
    [posts],
  );
  const accounts = useMemo(() => new Map(sites.map((s) => [s.id, s.displayName])), [sites]);
  const importing = importingNote(sites);
  const set = (patch: Partial<BlogFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setShown(BLOG_PAGE_SIZE);
  };
  const columns: TableColumn<PostView>[] = [
    {
      key: 'title',
      header: 'Title',
      sortKey: 'title',
      className: 'min-w-60 max-w-80',
      cell: (p) => (
        <>
          <Link className="block break-words font-medium underline" to={`/blog/${p.id}`}>
            {blogTitle(p)}
          </Link>
          <PublishWaitingNote posts={[p]} />
        </>
      ),
    },
    {
      key: 'status',
      header: 'Site status',
      className: 'whitespace-nowrap',
      cell: (p) => <StatusChip status={blogChip(p)} label={blogStatusLabel(p)} />,
    },
    {
      key: 'site',
      header: 'Site',
      className: 'min-w-32 max-w-48 break-words',
      cell: (p) => accounts.get(p.connectionId) ?? 'Disconnected site',
    },
    {
      key: 'author',
      header: 'Author',
      className: 'min-w-28 max-w-48 break-words',
      cell: (p) => blogOptions(p)?.remote?.author || '—',
    },
    {
      key: 'categories',
      header: 'Categories',
      className: 'min-w-32 max-w-48 break-words',
      cell: (p) => blogTerms(p, 'categories').join(', ') || '—',
    },
    {
      key: 'tags',
      header: 'Tags',
      className: 'min-w-32 max-w-48 break-words',
      cell: (p) => blogTerms(p, 'tags').join(', ') || '—',
    },
    {
      key: 'published',
      header: 'Published date',
      sortKey: 'published',
      className: 'whitespace-nowrap',
      cell: (p) => blogDateLabel(blogDate(p, 'published')),
    },
    {
      key: 'modified',
      header: 'Modified date',
      sortKey: 'modified',
      className: 'whitespace-nowrap',
      cell: (p) => blogDateLabel(blogDate(p, 'modified')),
    },
    { key: 'source', header: 'Source', className: 'whitespace-nowrap', cell: blogSource },
    {
      key: 'link',
      header: 'Live article',
      className: 'whitespace-nowrap',
      cell: (p) => {
        const url = safeExternalUrl(p.releaseUrl);
        return url ? (
          <a
            href={url}
            onClick={(e) => e.stopPropagation()}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View on site
          </a>
        ) : (
          '—'
        );
      },
    },
  ];
  return (
    <div className="min-w-0">
      <PageHeader
        title="Blog"
        subtitle="WordPress articles for this client. Refresh to see the latest stored import."
        actions={
          <Button variant="outline" onClick={() => setAttempt((a) => a + 1)} disabled={loading}>
            Refresh
          </Button>
        }
      />
      {loading ? (
        <p role="status" className="text-sm text-muted">
          Loading article inventory…
        </p>
      ) : error ? (
        <ErrorState
          title="Couldn't load articles"
          message={error}
          onRetry={() => setAttempt((a) => a + 1)}
        />
      ) : (
        <>
          {importing && (
            <p role="status" className="mb-3 text-sm text-muted">
              {importing} Refresh to see newly imported articles.
            </p>
          )}
          {sites.map((site) => {
            const summary = importSummary(site.import);
            return summary.message ? (
              <p key={site.id} className="mb-2 break-words text-sm text-muted">
                {site.displayName}: {summary.message}
              </p>
            ) : null;
          })}
          {sites.length === 0 && posts.length === 0 ? (
            <EmptyState
              icon={Article}
              title="No WordPress site connected"
              description="Connect this client's site to import its articles."
              action={
                <Button asChild>
                  <Link to="/connections">Connections</Link>
                </Button>
              }
            />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={Article}
              title={importing ? 'Importing articles…' : 'No articles yet'}
              description={
                importing ??
                'Import articles from Connections, or publish an article for this client.'
              }
              action={
                <Button asChild variant="outline">
                  <Link to="/connections">Connections</Link>
                </Button>
              }
            />
          ) : (
            <>
              <FilterBar
                search={{
                  value: filters.search,
                  onChange: (search) => set({ search }),
                  placeholder: 'Search titles…',
                  label: 'Search article titles',
                }}
                filters={
                  <>
                    <FilterSelect
                      label="Site status"
                      value={filters.status}
                      onChange={(status) => set({ status })}
                      options={[{ value: '', label: 'All statuses' }, ...BLOG_STATUSES]}
                    />
                    <FilterSelect
                      label="Category"
                      value={filters.category}
                      onChange={(category) => set({ category })}
                      options={[
                        { value: '', label: 'All categories' },
                        ...categories.map((c) => ({ value: c, label: c })),
                      ]}
                    />
                    {sites.length > 1 && (
                      <FilterSelect
                        label="Site"
                        value={filters.site}
                        onChange={(site) => set({ site })}
                        options={[
                          { value: '', label: 'All sites' },
                          ...sites.map((s) => ({ value: s.id, label: s.displayName })),
                        ]}
                      />
                    )}
                    <FilterSelect
                      label="Sort"
                      value={`${filters.sort}:${filters.dir}`}
                      onChange={(value) => {
                        const [sort, dir] = value.split(':');
                        set({ sort: sort as BlogFilters['sort'], dir: dir as BlogFilters['dir'] });
                      }}
                      options={[
                        { value: 'published:desc', label: 'Newest published' },
                        { value: 'published:asc', label: 'Oldest published' },
                        { value: 'modified:desc', label: 'Recently modified' },
                        { value: 'modified:asc', label: 'Oldest modified' },
                        { value: 'title:asc', label: 'Title A–Z' },
                        { value: 'title:desc', label: 'Title Z–A' },
                      ]}
                    />
                    <Button variant="ghost" size="sm" onClick={() => set(EMPTY_BLOG_FILTERS)}>
                      Clear filters
                    </Button>
                  </>
                }
              />
              <p role="status" className="mb-2 text-caption text-muted">
                {Math.min(shown, rows.length)} of {rows.length} matching articles
              </p>
              {rows.some((p) => !blogOptions(p)?.remote) && (
                <p className="mb-2 text-caption text-muted">
                  Some articles published here have no stored site metadata. Their original
                  publishing settings are shown; missing dates and authors appear as —.
                </p>
              )}
              <Table
                caption="WordPress articles"
                dense
                columns={columns}
                rows={rows.slice(0, shown)}
                rowKey={(p) => p.id}
                onRowClick={(p) => navigate(`/blog/${p.id}`)}
                sort={{ key: filters.sort, dir: filters.dir }}
                onSort={(key) =>
                  set({
                    sort: key as BlogFilters['sort'],
                    dir: filters.sort === key && filters.dir === 'asc' ? 'desc' : 'asc',
                  })
                }
                empty={{
                  title: 'No articles match these filters',
                  description: 'Try another title, status, category or site.',
                  icon: Article,
                }}
              />
              {shown < rows.length && (
                <div className="mt-3 flex justify-center">
                  <Button variant="outline" onClick={() => setShown((n) => n + BLOG_PAGE_SIZE)}>
                    Show more
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
