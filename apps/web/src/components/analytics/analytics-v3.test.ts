import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { analyticsReportView, type ReportAccount } from '@meegrow-social/contracts';
import {
  buildAnalyticsReport,
  resolvePeriod,
  type RawPost,
  type ReportInput,
} from '../../../../../packages/core/src/services/analytics-report';
import { Kpis, Delta } from './Kpis';
import {
  BestTimes,
  EngagementAccumulation,
  FollowerEvolution,
  FormatBreakdown,
  FrequencyVsEngagement,
  PublishTrend,
  PlatformSplit,
  Insights,
} from './Charts';
import { TopPosts, PlatformTable, RawMetrics } from './Tables';
import { formatNumber, formatRate } from '../../lib/analyticsReport';
import { friendlyDay } from './Plot';
vi.stubGlobal('React', React);
const now = new Date('2026-10-11T12:00:00Z');
const id = '00000000-0000-4000-8000-000000000001';
const account: ReportAccount = {
  id,
  workspaceId: id,
  workspaceName: 'Client',
  provider: 'instagram',
  displayName: 'Account',
  selected: true,
  needsReconnect: false,
};
const post: RawPost = {
  id,
  connectionId: id,
  provider: 'instagram',
  native: { reach: 100, views: 200, likes: 5 },
  caption: 'Evidence post',
  publishAt: new Date('2026-10-10T12:00:00Z'),
  releaseUrl: 'https://example.com/post',
  source: 'imported',
  format: 'image',
  thumbnailUrl: null,
  capturedAt: now,
};
const fixture = (patch: Partial<ReportInput> = {}) =>
  buildAnalyticsReport({
    now,
    period: resolvePeriod({ days: 30 }, now),
    timezone: 'UTC',
    accounts: [account],
    posts: [post],
    followerPoints: [],
    snapshots: [],
    undatedPosts: 0,
    ...patch,
  });
const render = (c: React.FunctionComponent<never>, props: unknown) =>
  renderToStaticMarkup(React.createElement(c, props as never));

describe('analytics revision 2 markup', () => {
  it('shows five KPI cards, deltas and accessible sparkline values', () => {
    const report = fixture();
    const html = render(Kpis as React.FunctionComponent<never>, { report });
    for (const label of ['Engagement rate', 'Reach', 'Views', 'Followers', 'Posts published'])
      expect(html).toContain(label);
    expect(html.match(/<article /g)).toHaveLength(5);
    expect(html).toContain('5.00%');
    expect(html).toContain('by publish week');
    expect(html).not.toContain('Partial rate coverage');
    expect(html).not.toContain('counted 1/1');
    expect(html).not.toContain('About totals');
  });
  it('renders a documentation-built YouTube-only report with subscribers and a views-based rate', () => {
    const report = fixture({
      accounts: [{ ...account, provider: 'youtube' }],
      posts: [
        {
          ...post,
          provider: 'youtube',
          native: {
            viewCount: 1000,
            likeCount: 20,
            commentCount: 5,
            shares: 5,
            subscribersGained: 2,
          },
          format: 'video',
        },
      ],
    });
    const kpis = render(Kpis as React.FunctionComponent<never>, { report });
    expect(kpis.match(/<article /g)).toHaveLength(4);
    expect(kpis).toContain('Engagement rate · views');
    expect(kpis).toContain('Subscribers');
    expect(kpis).not.toContain('>Reach<');
    const table = render(PlatformTable as React.FunctionComponent<never>, {
      report,
      concepts: ['views', 'likes', 'comments', 'shares', 'follows'],
    });
    expect(table).toContain('YouTube');
    expect(table).toContain('Subscribers gained');
    expect(table).toContain('>÷ views<');
    expect(table).toContain('3.00%');
  });
  it('keeps missing values as a dash and actual zero as zero', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(0)).toBe('0');
    expect(formatRate(null)).toBe('—');
    const html = render(Kpis as React.FunctionComponent<never>, {
      report: fixture({ posts: [{ ...post, native: { views: 0 } }] }),
    });
    expect(html).toContain('>0</p>');
    expect(html).toContain('—');
  });
  it.each([null, Infinity, -Infinity])('renders an unavailable delta %s as dash', (value) => {
    const html = render(Delta as React.FunctionComponent<never>, { value });
    expect(html).toContain('—');
    expect(html).not.toContain('Infinity');
  });
  it('shows signed finite comparisons and follower net changes', () => {
    expect(render(Delta as React.FunctionComponent<never>, { value: 22 })).toContain('↑');
    expect(render(Delta as React.FunctionComponent<never>, { value: -22 })).toContain('↓');
    const report = fixture();
    report.summary.followers.change = 60;
    expect(render(Kpis as React.FunctionComponent<never>, { report })).toContain('+60 net');
  });
  it('renders all six supporting cards with designed insufficient states', () => {
    const report = fixture({ posts: [] });
    for (const c of [
      PlatformSplit,
      FormatBreakdown,
      BestTimes,
      FollowerEvolution,
      FrequencyVsEngagement,
      EngagementAccumulation,
    ]) {
      const html = render(c as React.FunctionComponent<never>, { report });
      expect(html).toContain('<section');
      expect(html).toContain('◇');
    }
    expect(render(EngagementAccumulation as React.FunctionComponent<never>, { report })).toContain(
      'More early snapshots',
    );
  });
  it('ignores old best flags and under-qualified slots', () => {
    const report = fixture();
    report.formats[0]!.best = true;
    report.bestTimes.top = [{ weekday: 0, hour: 9, posts: 1, average: 9 }];
    const html = render(FormatBreakdown as React.FunctionComponent<never>, { report });
    expect(html).not.toContain('>Best<');
    expect(render(BestTimes as React.FunctionComponent<never>, { report })).not.toContain('9 avg');
  });
  it('hides an empty insight row and shows server-owned findings', () => {
    const report = fixture();
    expect(
      render(Insights as React.FunctionComponent<never>, { report: { ...report, insights: [] } }),
    ).toBe('');
    report.insights = [
      { kind: 'time', title: 'Best slot: Sat 9am', detail: '92 avg engagements across 6 posts' },
    ];
    const html = render(Insights as React.FunctionComponent<never>, { report });
    expect(html).toContain('Sat 9am');
    expect(html).toContain('92 avg');
  });
  it('uses friendly dates, metric chips and platform text alternatives', () => {
    expect(friendlyDay('2026-09-14')).toBe('14 Sep');
    const report = fixture();
    const html = render(PublishTrend as React.FunctionComponent<never>, {
      report,
      metric: 'reach',
      onMetric: () => {},
    });
    expect(html).toContain('By publish week');
    expect(html).toContain('Instagram');
    expect(html).toContain('Trend metric');
    expect(html).not.toContain('2026-10-05');
  });
  it('keeps sorting, CSV and pagination, removes expansion and cell info icons', () => {
    const report = fixture();
    report.topPosts = Array.from({ length: 35 }, (_, i) => ({
      ...report.topPosts[0]!,
      id: `row-${i}`,
    }));
    report.postsOmitted = 22;
    const html = render(TopPosts as React.FunctionComponent<never>, {
      report,
      concepts: ['views', 'reach', 'likes'],
    });
    expect(html).toContain('Showing 10');
    expect(html).toContain('35 returned');
    expect(html).toContain('22 omitted');
    expect(html).toContain('Export CSV');
    expect(html).toContain('Show more');
    expect(html).toContain('aria-sort="descending"');
    expect(html).not.toContain('Metrics and history');
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).toContain('Imported');
    const tbody = html.split('<tbody>')[1]!;
    expect(tbody).not.toContain('About reported count');
    expect(tbody).not.toContain('ⓘ');
    expect(tbody).toContain('title="÷ reach"');
  });
  it('places definitions in column headers, rates show no coverage or visible basis', () => {
    const html = render(PlatformTable as React.FunctionComponent<never>, {
      report: fixture(),
      concepts: ['views', 'reach'],
    });
    expect(html).toContain('About Views');
    expect(html).not.toContain('1/1');
    expect(html).not.toContain('>÷ reach<');
  });
  it('accepts older payloads without additive presentation fields', () => {
    const report = fixture();
    delete report.insights;
    delete report.formatWinner;
    delete report.platformShares;
    delete report.followerTrend;
    delete report.bestSlots;
    delete report.weeklySeries;
    for (const b of report.overTime) for (const p of b.byPlatform) delete p.engagementRate;
    expect(analyticsReportView.safeParse(report).success).toBe(true);
    expect(render(RawMetrics as React.FunctionComponent<never>, { report })).toContain(
      'Platform metrics, as collected',
    );
  });
});
