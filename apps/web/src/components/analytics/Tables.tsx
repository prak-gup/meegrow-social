import { useEffect, useMemo, useState } from 'react';
import type { MetricConcept, PostMetricsView, ReportPost } from '@meegrow-social/contracts';
import {
  CONCEPT_LABEL,
  basisText,
  formatRate,
  postsCsv,
  sortPosts,
  type PostSortKey,
  type Report,
} from '../../lib/analyticsReport';
import { api } from '../../lib/api';
import { ArrowSquareOut, DownloadSimple } from '../../lib/icons';
import { compactNumber, shortDateTime } from '../../lib/postGroups';
import { captionSnippet, safeExternalUrl } from '../../lib/postList';
import { platformMeta } from '../../lib/platforms';
import { PostThumb } from '../PostThumb';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Table, type TableColumn, type TableSort } from '../ui/Table';
import { Help, NoValue, PlatformName, Section, platformLabel } from './parts';

const number = (value: number | null, why: string) =>
  value === null ? (
    <NoValue why={why} />
  ) : (
    <span className="inline-flex items-center">
      <span>{compactNumber(value)}</span>
      <Help label="reported count" text={`Exact reported count: ${value.toLocaleString()}`} />
    </span>
  );

/** Engagement rate with what it was divided by beside it, so two bases never look alike. */
function Rate({ rate, basis }: { rate: number | null; basis: string | null }) {
  if (rate === null) return <NoValue why="No rate: no engagement count, or no reach or views" />;
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-semibold">{formatRate(rate)}</span>
      {basis && <span className="text-micro font-normal text-muted">{basis}</span>}
    </span>
  );
}

// --- Platform breakdown ---------------------------------------------------------------------------

type PlatformRow = Report['byPlatform'][number];

export function PlatformTable({
  report,
  concepts,
}: {
  report: Report;
  concepts: readonly MetricConcept[];
  absent?: readonly MetricConcept[];
}) {
  const columns: TableColumn<PlatformRow>[] = [
    {
      key: 'platform',
      header: 'Platform',
      className: 'sticky left-0 bg-canvas whitespace-nowrap',
      cell: (p) => <PlatformName provider={p.provider} className="font-semibold" />,
    },
    {
      key: 'posts',
      header: 'Posts',
      align: 'right',
      cell: (p) => p.posts.toLocaleString(),
    },
    ...concepts.map((concept): TableColumn<PlatformRow> => ({
      key: concept,
      header:
        concept === 'follows' &&
        report.mapping.length === 1 &&
        report.mapping[0]?.provider === 'youtube'
          ? 'Subscribers gained'
          : CONCEPT_LABEL[concept],
      align: 'right',
      cell: (p) =>
        number(
          p.totals[concept],
          `${platformLabel(p.provider)} reports no ${CONCEPT_LABEL[concept].toLowerCase()}`,
        ),
    })),
    {
      key: 'rate',
      header: 'Eng. rate',
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (p) => (
        <span>
          <Rate rate={p.engagementRate.rate} basis={basisText(p.engagementRate)} />{' '}
          <span className="text-caption text-muted">
            {p.engagementRate.postsCounted}/{p.engagementRate.posts}
          </span>
        </span>
      ),
    },
  ];
  return (
    <Section title="Platform breakdown" subtitle="Latest reported totals by platform">
      <Table
        caption="Totals per platform for the period"
        dense
        rows={report.byPlatform}
        rowKey={(p) => p.provider}
        columns={columns}
        empty={{ title: 'No platform in view' }}
      />
    </Section>
  );
}

// --- Top posts ------------------------------------------------------------------------------------

const PAGE = 10;

/** Saves a text file from the browser; nothing is sent anywhere. */
function download(filename: string, text: string) {
  // The BOM makes a spreadsheet read the file as UTF-8 (captions are often not ASCII).
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function TopPosts({
  report,
  concepts,
}: {
  report: Report;
  concepts: readonly MetricConcept[];
  absent?: readonly MetricConcept[];
}) {
  const [sort, setSort] = useState<TableSort>({ key: 'engagements', dir: 'desc' });
  const [shown, setShown] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const sorted = useMemo(
    () => sortPosts(report.topPosts, sort.key as PostSortKey, sort.dir),
    [report.topPosts, sort],
  );
  const rows = sorted.slice(0, shown);
  const accounts = new Map(report.accounts.map((a) => [a.id, a]));
  const manyClients = new Set(report.accounts.map((a) => a.workspaceId)).size > 1;
  const onSort = (key: string) =>
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));

  const columns: TableColumn<ReportPost>[] = [
    {
      key: 'post',
      header: 'Post',
      sortKey: 'publishAt',
      className: 'sticky left-0 z-10 w-full min-w-48 max-w-64 bg-canvas',
      cell: (post) => {
        const url = safeExternalUrl(post.releaseUrl);
        const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
        const account = accounts.get(post.connectionId);
        const text = captionSnippet(post.caption, 70);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <PostThumb
              thumb={
                post.format === 'text'
                  ? null
                  : { kind: post.format, src: safeExternalUrl(post.thumbnailUrl), count: 1 }
              }
              caption={post.caption}
              size="sm"
            />
            <span className="min-w-0">
              <button
                type="button"
                aria-expanded={expanded === post.id}
                aria-label={`Metrics and history: ${text}`}
                onClick={() => setExpanded((prev) => (prev === post.id ? null : post.id))}
                className="min-h-11 rounded-sm text-caption font-medium text-ink underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
              >
                {expanded === post.id ? 'Hide history' : 'Metrics and history'}
              </button>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-baseline gap-1 text-body-ink underline"
                >
                  <span className="line-clamp-1">{text}</span>
                  <ArrowSquareOut size={12} aria-hidden="true" className="flex-none self-center" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : (
                <span className="line-clamp-1 text-body-ink">{text}</span>
              )}
              <span className="flex min-w-0 items-center gap-1.5 text-micro text-muted">
                <platform.Icon size={12} aria-hidden="true" className="flex-none" />
                <span className="sr-only">{platform.label}</span>
                <span className="truncate">
                  {account?.displayName ?? platform.label}
                  {manyClients && account && ` · ${account.workspaceName}`}
                </span>
                <span aria-hidden="true">·</span>
                <time dateTime={new Date(post.publishAt).toISOString()} className="tnum flex-none">
                  {shortDateTime(new Date(post.publishAt))}
                </time>
                {post.source === 'imported' && (
                  <span className="flex-none" title="Found on the platform, not published here">
                    · imported
                  </span>
                )}
              </span>
            </span>
          </span>
        );
      },
    },
    ...concepts.map((concept): TableColumn<ReportPost> => ({
      key: concept,
      header:
        concept === 'follows' &&
        report.mapping.length === 1 &&
        report.mapping[0]?.provider === 'youtube'
          ? 'Subscribers gained'
          : CONCEPT_LABEL[concept],
      sortKey: concept,
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (post) =>
        number(post.metrics[concept], `No ${CONCEPT_LABEL[concept].toLowerCase()} reported`),
    })),
    {
      key: 'engagements',
      header: (
        <span title="Likes + comments + shares + saves, over the ones reported">Engagements</span>
      ),
      sortKey: 'engagements',
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (post) => number(post.engagements, 'No engagement count reported'),
    },
    {
      key: 'rate',
      header: 'Eng. rate',
      sortKey: 'engagementRate',
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (post) => (
        <Rate rate={post.engagementRate} basis={post.basis ? `÷ ${post.basis}` : null} />
      ),
    },
  ];

  const exportCsv = () =>
    download(
      `top-posts-${new Date(report.period.start).toISOString().slice(0, 10)}-to-${new Date(report.period.end).toISOString().slice(0, 10)}.csv`,
      postsCsv(sorted, report.accounts, concepts, platformLabel),
    );

  return (
    <Section
      title="Top posts"
      subtitle={`Sorted by ${sort.key === 'publishAt' ? 'publication date' : sort.key === 'engagementRate' ? 'engagement rate' : sort.key} · ${sort.dir === 'desc' ? 'descending' : 'ascending'}`}
      actions={
        report.topPosts.length > 0 && (
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <DownloadSimple size={14} aria-hidden="true" />
            Export CSV
          </Button>
        )
      }
    >
      <Table
        className="[&_th_button]:min-h-11 [&_th_button]:focus-visible:outline [&_th_button]:focus-visible:outline-2 [&_th_button]:focus-visible:outline-ink"
        caption="Posts published in the period with their metrics"
        dense
        rows={rows}
        renderExpanded={(post) =>
          expanded === post.id ? <PostHistory key={post.id} id={post.id} /> : null
        }
        rowKey={(post) => post.id}
        columns={columns}
        sort={sort}
        onSort={onSort}
        empty={{
          title: 'No posts published in this period',
          description: 'A longer period may have some.',
        }}
      />
      {report.postsOmitted > 0 && (
        <p role="status" className="mt-2 text-caption font-medium text-ink">
          {report.postsOmitted.toLocaleString()} posts omitted. Summary and chart cover all posts;
          sorting and CSV cover only returned rows (up to 1,000).
        </p>
      )}
      {rows.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="tnum text-caption text-muted">
            Showing {rows.length.toLocaleString()} of {sorted.length.toLocaleString()} returned
            posts
          </p>
          <div className="flex gap-2">
            {shown < sorted.length && (
              <Button variant="outline" size="sm" onClick={() => setShown((n) => n + 25)}>
                Show more
              </Button>
            )}
            {shown > PAGE && (
              <Button variant="ghost" size="sm" onClick={() => setShown(PAGE)}>
                Show fewer
              </Button>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// --- Raw metrics and the mapping ------------------------------------------------------------------

type RawRow = Report['rawMetrics'][number];

/**
 * Nothing collected is hidden by the columns above: every native metric name of the period's
 * posts, as stored, and which column (if any) it feeds on its platform.
 */
export function RawMetrics({ report }: { report: Report }) {
  const { rawMetrics, mapping } = report;
  const unmapped = rawMetrics.filter((r) => r.concept === null).length;
  const columns: TableColumn<RawRow>[] = [
    {
      key: 'platform',
      header: 'Platform',
      className: 'whitespace-nowrap',
      cell: (r) => <PlatformName provider={r.provider} />,
    },
    {
      key: 'metric',
      header: 'Metric, as the platform names it',
      className: 'w-full',
      cell: (r) => <code className="break-all text-caption">{r.metric}</code>,
    },
    {
      key: 'concept',
      header: 'Shown as',
      className: 'whitespace-nowrap',
      cell: (r) =>
        r.concept ? CONCEPT_LABEL[r.concept] : <Badge variant="neutral">only here</Badge>,
    },
    { key: 'posts', header: 'Posts', align: 'right', cell: (r) => r.posts.toLocaleString() },
    {
      key: 'total',
      header: 'Sum of latest values',
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (r) => r.total.toLocaleString(undefined, { maximumFractionDigits: 2 }),
    },
  ];
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-ink">
        Platform metrics, as collected
      </summary>
      <Section
        title="Platform metrics, as collected"
        subtitle={`${rawMetrics.length.toLocaleString()} metric ${rawMetrics.length === 1 ? 'name' : 'names'} across the posts of the period${unmapped > 0 ? `, ${unmapped} of them shown only here` : ''}`}
        note="Numbers are stored under each platform’s own metric name and only read as the columns above. A name that feeds no column is still collected and listed here; a sum of a metric that is itself an average or a rate is not meaningful and is shown only as collected."
      >
        <Table
          caption="Every native metric of the period’s posts"
          dense
          rows={rawMetrics}
          rowKey={(r) => `${r.provider}:${r.metric}`}
          columns={columns}
          empty={{ title: 'No metrics collected for posts published in this period' }}
        />
        {mapping.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-caption font-semibold text-ink">
              How each column is read from each platform
            </summary>
            <Table
              className="mt-2"
              caption="The platform metric behind each column, per platform"
              dense
              rows={[
                ...(Object.keys(CONCEPT_LABEL) as MetricConcept[]).map((concept) => ({
                  label: CONCEPT_LABEL[concept],
                  sources: (m: Mapping) => m.concepts[concept],
                })),
                { label: 'Followers (account)', sources: (m: Mapping) => m.followers },
              ]}
              rowKey={(row) => row.label}
              columns={[
                {
                  key: 'column',
                  header: 'Column',
                  className: 'whitespace-nowrap font-medium',
                  cell: (row) => row.label,
                },
                ...mapping.map((m) => ({
                  key: m.provider,
                  header: <PlatformName provider={m.provider} />,
                  cell: (row: { sources: (m: Mapping) => readonly string[] }) => (
                    <Sources names={row.sources(m)} />
                  ),
                })),
              ]}
            />
            <p className="mt-1.5 text-caption text-muted">
              “—” = the platform has no equivalent, or it is not collected. Where two names are
              listed, the first one a post carries is used.
            </p>
          </details>
        )}
      </Section>
    </details>
  );
}

type Mapping = Report['mapping'][number];

function Sources({ names }: { names: readonly string[] }) {
  if (names.length === 0) return <NoValue why="No equivalent on this platform" />;
  return <code className="break-all text-caption text-body-ink">{names.join(', then ')}</code>;
}

/** Read post-native values lazily; no provider or report arithmetic in the app. */
function PostHistory({ id }: { id: string }) {
  const [load, setLoad] = useState<{ data: PostMetricsView } | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stale = false;
    api
      .postMetrics(id)
      .then((data) => {
        if (!stale) setLoad({ data });
      })
      .catch(() => {
        if (!stale) setLoad({ error: 'Could not load metrics history' });
      });
    return () => {
      stale = true;
    };
  }, [id, attempt]);
  if (!load)
    return (
      <p role="status" className="text-caption text-muted">
        Loading metrics history
      </p>
    );
  if ('error' in load)
    return (
      <div role="alert">
        <p>{load.error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoad(null);
            setAttempt((n) => n + 1);
          }}
        >
          Retry history
        </Button>
      </div>
    );
  return (
    <div className="space-y-2">
      <Table
        caption="Latest native values for this post"
        dense
        rows={Object.entries(load.data.latest).map(([metric, value]) => ({ metric, value }))}
        rowKey={(r) => r.metric}
        columns={[
          { key: 'metric', header: 'Native metric', cell: (r) => <code>{r.metric}</code> },
          {
            key: 'value',
            header: 'Latest value',
            align: 'right',
            cell: (r) => r.value.toLocaleString(),
          },
        ]}
        empty={{ title: 'No metrics collected' }}
      />
      <Table
        caption="Native capture history for this post"
        dense
        rows={load.data.series}
        rowKey={(r, i) => `${r.metric}:${i}`}
        columns={[
          { key: 'at', header: 'Capture', cell: (r) => new Date(r.capturedAt).toLocaleString() },
          { key: 'metric', header: 'Native metric', cell: (r) => <code>{r.metric}</code> },
          { key: 'value', header: 'Value', align: 'right', cell: (r) => r.value.toLocaleString() },
        ]}
        empty={{ title: 'No capture history' }}
      />
    </div>
  );
}
