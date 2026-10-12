import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  analyticsReportView,
  type MetricConcept,
  type ReportAccount,
} from '@meegrow-social/contracts';
import {
  buildAnalyticsReport,
  resolvePeriod,
  type ReportInput,
  type RawPost,
} from '../../../../../packages/core/src/services/analytics-report';
import { Kpis } from './Kpis';
import {
  BestTimes,
  EngagementAccumulation,
  FollowerEvolution,
  FormatBreakdown,
  FrequencyVsEngagement,
  PublishTrend,
} from './Charts';
import { RawMetrics, TopPosts } from './Tables';
import { formatNumber, formatRate } from '../../lib/analyticsReport';

// Node-only markup fixtures: no browser, backend, database, Redis or API reads.
vi.stubGlobal('React', React);
const now = new Date('2026-10-11T12:00:00Z');
const id = '00000000-0000-4000-8000-000000000001';
const account = (provider: string): ReportAccount => ({
  id,
  workspaceId: id,
  workspaceName: 'Client',
  provider,
  displayName: 'Account',
  selected: true,
  needsReconnect: false,
});
const post = (provider: string, native: Record<string, number>): RawPost => ({
  id,
  connectionId: id,
  provider,
  native,
  caption: 'Evidence post',
  publishAt: new Date('2026-10-10T12:00:00Z'),
  releaseUrl: 'https://example.com/post',
  source: 'app',
  format: 'image',
  thumbnailUrl: null,
  capturedAt: now,
});
const fixture = (
  provider = 'instagram',
  native: Record<string, number> = {},
  patch: Partial<ReportInput> = {},
) =>
  buildAnalyticsReport({
    now,
    period: resolvePeriod({ days: 30 }, now),
    timezone: 'UTC',
    accounts: [account(provider)],
    posts: [post(provider, native)],
    followerPoints: [],
    snapshots: [],
    undatedPosts: 0,
    ...patch,
  });
const render = (component: React.FunctionComponent<never>, props: unknown) =>
  renderToStaticMarkup(React.createElement(component, props as never));
const kpis = (report: ReturnType<typeof fixture>) =>
  render(Kpis as React.FunctionComponent<never>, {
    report,
    onMetric: () => {},
    onFollowers: () => {},
    onRate: () => {},
  });

describe('analytics v3 render facts', () => {
  it('renders missing as a dash and observed zero as zero', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatRate(null)).toBe('—');
    expect(formatNumber(0)).toBe('0');
    expect(formatRate(0)).toBe('0.00%');
    const missing = kpis(fixture());
    expect(missing).toContain('—');
    expect(missing).toContain('No metrics collected');
    const zero = kpis(fixture('instagram', { views: 0, reach: 0, likes: 0 }));
    expect(zero).toContain('>0</button>');
    expect(zero).toContain('Small sample');
    expect(zero).not.toContain('vs prior</');
    expect(zero).not.toContain('Best post');
  });

  it('uses YouTube vocabulary and never renders unsupported reach', () => {
    const report = fixture('youtube', { viewCount: 100, likeCount: 0, subscribersGained: 3 });
    const html = kpis(report);
    expect(html).toContain('Subscribers');
    expect(html).toContain('Post engagement rate');
    expect(html).not.toContain('Post reach');
    expect(
      render(TopPosts as React.FunctionComponent<never>, {
        report,
        concepts: ['views', 'follows'],
      }),
    ).toContain('Subscribers gained');
  });

  it('keeps mixed and partial rate coverage visible without a rate delta', () => {
    const report = fixture('instagram', { reach: 100, likes: 4 });
    report.summary.engagementRate = {
      ...report.summary.engagementRate,
      basis: 'mixed',
      posts: 12,
      postsCounted: 4,
      byReach: 2,
      byViews: 2,
    };
    report.summary.engagementRateDeltaPct = 900;
    const html = kpis(report);
    expect(html).toContain('Mixed basis');
    expect(html).toContain('counted 4/12');
    expect(html).toContain('Small sample');
    expect(html).not.toContain('900');
  });

  it('keeps GBP hero limited to views and CTA clicks and Bluesky unmapped', () => {
    const gbp = kpis(
      fixture('gmb', { LOCAL_POST_VIEWS_SEARCH: 0, LOCAL_POST_ACTIONS_CALL_TO_ACTION: 2 }),
    );
    expect(gbp).toContain('CTA clicks');
    expect(gbp).not.toContain('Engagement rate');
    expect(gbp).not.toContain('Followers');
    const bluesky = kpis(fixture('bluesky', { likes: 10 }));
    expect(bluesky).toContain('Published:');
    expect(bluesky).not.toContain('>Views<');
    expect(bluesky).not.toContain('>Followers<');
  });

  it('ignores best flags and threshold crossings without comparison evidence', () => {
    const report = fixture('instagram', { views: 100, likes: 8 });
    report.formats[0]!.best = true;
    report.accumulation.halfByHours = 6;
    report.accumulation.eightyByHours = 12;
    report.accumulation.displayPoints = [];
    const html = [FormatBreakdown, BestTimes, FrequencyVsEngagement, EngagementAccumulation]
      .map((c) => render(c as React.FunctionComponent<never>, { report }))
      .join('');
    expect(html).not.toMatch(/Best time|Best<|Optimal|Half of|80% by|vs avg/);
    expect(html).toContain('Needs 10 posts with early captures');
    expect(html).toContain('Published');
  });

  it('keeps follower-only captures and leaves gaps in the exact data', () => {
    const report = fixture(
      'youtube',
      {},
      { posts: [], followerPoints: [{ connectionId: id, value: 0, capturedAt: now }] },
    );
    const html = render(FollowerEvolution as React.FunctionComponent<never>, { report });
    expect(html).toContain('Subscribers');
    expect(html).toContain('Capture data');
    expect(html).toContain('—');
    expect(html).toContain('>0</td>');
    expect(
      render(PublishTrend as React.FunctionComponent<never>, {
        report,
        concepts: ['views'],
        metric: 'views',
        onMetric: () => {},
      }),
    ).toBe('');
  });

  it('supports older report payloads with no display facts and keeps raw metrics collapsed', () => {
    const report = fixture('instagram', { views: 0 });
    for (const b of report.overTime) delete b.window;
    for (const c of report.bestTimes.cells) delete c.level;
    for (const s of report.followerSeries) delete s.dailyPoints;
    delete report.accumulation.displayPoints;
    expect(analyticsReportView.safeParse(report).success).toBe(true);
    const html = render(RawMetrics as React.FunctionComponent<never>, { report });
    expect(html).toContain('Platform metrics, as collected');
    expect(html).not.toContain('<details open');
    expect(
      render(PublishTrend as React.FunctionComponent<never>, {
        report,
        concepts: ['views'] satisfies MetricConcept[],
        metric: 'views',
        onMetric: () => {},
      }),
    ).toContain('Not supplied');
  });

  it('labels capped results and preserves CSV and first-ten pagination', () => {
    const report = fixture('instagram', { views: 10, likes: 1 });
    report.topPosts = Array.from({ length: 35 }, (_, i) => ({
      ...report.topPosts[0]!,
      id: `row-${i}`,
    }));
    report.postsOmitted = 22;
    const html = render(TopPosts as React.FunctionComponent<never>, {
      report,
      concepts: ['views', 'likes'],
    });
    expect(html).toContain('Showing 10');
    expect(html).toContain('35 returned posts');
    expect(html).toContain('22 posts omitted');
    expect(html).toContain('Export CSV');
    expect(html).toContain('Show more');
    expect(html).toContain('Metrics and history');
    expect(html).toContain('aria-sort="descending"');
  });
});
