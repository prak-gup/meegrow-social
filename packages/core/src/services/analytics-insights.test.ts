import { describe, expect, it } from 'vitest';
import type { AnalyticsReportView } from '@meegrow-social/contracts';
import { buildAnalyticsReport, resolvePeriod } from './analytics-report.js';
import { analyticsDisplayFacts, slotLabel } from './analytics-insights.js';
import { EMPTY_CONCEPTS, engagementRate } from './metric-concepts.js';
const now = new Date('2026-10-12T12:00:00Z');
const base = (): AnalyticsReportView =>
  buildAnalyticsReport({
    now,
    period: resolvePeriod({ days: 30 }, now),
    timezone: 'UTC',
    accounts: [],
    posts: [],
    followerPoints: [],
    snapshots: [],
    undatedPosts: 0,
  });
const format = (
  kind: 'video' | 'image',
  n: number,
  likes: number,
  views = false,
): AnalyticsReportView['formats'][number] => ({
  format: kind,
  posts: n,
  engagementRate: engagementRate(
    Array.from({ length: n }, () => ({
      ...EMPTY_CONCEPTS,
      likes,
      ...(views ? { views: 100 } : { reach: 100 }),
    })),
  ),
  vsAveragePct: null,
  best: true,
});
const facts = (r: AnalyticsReportView) => analyticsDisplayFacts(r);
const finding = (r: AnalyticsReportView, kind: string) =>
  facts(r).insights!.find((i) => i.kind === kind);

describe('deterministic dashboard insights', () => {
  it('hides everything without evidence', () => {
    expect(facts(base())).toMatchObject({
      insights: [],
      formatWinner: null,
      bestSlots: [],
      platformShares: [],
      followerTrend: [],
    });
  });
  it.each([
    [4, 5, false],
    [5, 4, false],
    [5, 5, true],
    [6, 5, true],
  ])('format measured thresholds %i vs %i', (a, b, eligible) => {
    const r = base();
    r.formats = [format('video', a, 10), format('image', b, 5)];
    expect(Boolean(finding(r, 'format'))).toBe(eligible);
    expect(facts(r).formatWinner).toBe(eligible ? 'video' : null);
  });
  it('does not award equal rates, missing rates, mixed bases or incompatible components', () => {
    const r = base();
    r.formats = [format('video', 5, 5), format('image', 5, 5)];
    expect(finding(r, 'format')).toBeUndefined();
    r.formats = [format('video', 5, 10), format('image', 5, 5, true)];
    expect(finding(r, 'format')).toBeUndefined();
    r.formats[1]!.engagementRate.basis = 'mixed';
    expect(finding(r, 'format')).toBeUndefined();
    r.formats[1] = format('image', 5, 5);
    r.formats[1].engagementRate.components = ['likes', 'comments'];
    expect(finding(r, 'format')).toBeUndefined();
    r.formats[1] = format('image', 5, 5);
    r.formats[1].engagementRate.rate = null;
    expect(finding(r, 'format')).toBeUndefined();
  });
  it.each([2, 3, 4])('slot uses measured sample %i, not total posts', (n) => {
    const r = base();
    r.bestTimes.by = 'engagements';
    r.bestTimes.cells = [{ weekday: 5, hour: 9, posts: 50, postsCounted: n, average: 92 }];
    expect(Boolean(finding(r, 'time'))).toBe(n >= 3);
    expect(facts(r).bestSlots!.length).toBe(n >= 3 ? 1 : 0);
  });
  it('omits unknown, unmeasured and view-only slot findings; sorts ties and caps chips', () => {
    const r = base();
    r.bestTimes.by = 'engagements';
    r.bestTimes.cells = [
      { weekday: 0, hour: 0, posts: 5, average: 99 },
      { weekday: 1, hour: 1, posts: 5, postsCounted: 5, average: null },
    ];
    expect(finding(r, 'time')).toBeUndefined();
    r.bestTimes.cells = Array.from({ length: 4 }, (_, i) => ({
      weekday: 3 - i,
      hour: 9,
      posts: 3,
      postsCounted: 3,
      average: 9,
    }));
    expect(facts(r).bestSlots!.map((s) => s.weekday)).toEqual([0, 1, 2]);
    r.bestTimes.by = 'views';
    expect(finding(r, 'time')).toBeUndefined();
    expect(slotLabel(0, 0)).toBe('Mon 12am');
    expect(slotLabel(5, 12)).toBe('Sat 12pm');
  });
  it.each([4, 5])('top-post share requires five published posts (%i)', (n) => {
    const r = base();
    r.summary.posts.value = n;
    r.summary.engagementRate.engagements = 100;
    r.summary.bestPost = {
      by: 'engagements',
      value: 14,
      post: {
        id: 'p',
        provider: 'instagram',
        connectionId: 'a',
        caption: 'A  title',
        publishAt: now,
        releaseUrl: null,
        source: 'app',
        format: 'image',
        thumbnailUrl: null,
        metrics: EMPTY_CONCEPTS,
        engagements: 14,
        engagementRate: null,
        basis: null,
        capturedAt: now,
      },
    };
    expect(finding(r, 'post')?.title).toBe(n >= 5 ? 'Top post drove 14% of engagement' : undefined);
    r.summary.bestPost.by = 'views';
    expect(finding(r, 'post')).toBeUndefined();
    r.summary.bestPost.by = 'engagements';
    r.summary.engagementRate.engagements = 0;
    expect(finding(r, 'post')).toBeUndefined();
  });
  it('platform share requires two reported platforms and five leader posts; null stays unknown', () => {
    const r = base();
    r.summary.totals.reach.value = 100;
    r.byPlatform = [
      {
        provider: 'instagram',
        posts: 5,
        totals: { ...EMPTY_CONCEPTS, reach: 96 },
        engagementRate: engagementRate([]),
      },
      {
        provider: 'facebook',
        posts: 1,
        totals: { ...EMPTY_CONCEPTS, reach: 4 },
        engagementRate: engagementRate([]),
      },
    ];
    expect(finding(r, 'platform')?.title).toBe('Instagram delivers 96% of reach');
    r.byPlatform[0]!.posts = 4;
    expect(finding(r, 'platform')).toBeUndefined();
    r.byPlatform[0]!.posts = 5;
    r.byPlatform[1]!.totals.reach = null;
    expect(finding(r, 'platform')).toBeUndefined();
    expect(facts(r).platformShares![1]!.reachPct).toBeNull();
    r.summary.totals.reach.value = 0;
    expect(facts(r).platformShares!.every((p) => p.reachPct === null)).toBe(true);
  });
  it.each([null, 0])('delta excludes missing/zero prior %s', (prior) => {
    const r = base();
    r.summary.totals.reach = { value: 122, prior, deltaPct: 22 };
    expect(finding(r, 'delta')).toBeUndefined();
  });
  it('delta needs finite data and a change, and handles decreases', () => {
    const r = base();
    r.summary.totals.reach = { value: 122, prior: 100, deltaPct: 22 };
    expect(finding(r, 'delta')?.title).toBe('Reach up 22%');
    r.summary.totals.reach = { value: 78, prior: 100, deltaPct: -22 };
    expect(finding(r, 'delta')?.title).toBe('Reach down 22%');
    for (const d of [null, 0, Infinity]) {
      r.summary.totals.reach.deltaPct = d;
      expect(finding(r, 'delta')).toBeUndefined();
    }
    r.summary.totals.reach = { value: null, prior: 100, deltaPct: 22 };
    expect(finding(r, 'delta')).toBeUndefined();
  });
  it('sums each account’s latest weekly capture, keeping missing weeks null', () => {
    const r = base();
    r.accounts = ['a', 'b'].map((id) => ({
      id,
      workspaceId: 'w',
      workspaceName: 'w',
      provider: 'bluesky',
      displayName: id,
      needsReconnect: false,
      selected: true,
    }));
    r.mapping = [
      {
        provider: 'bluesky',
        concepts: Object.fromEntries(
          Object.keys(EMPTY_CONCEPTS).map((k) => [k, []]),
        ) as AnalyticsReportView['mapping'][number]['concepts'],
        followers: ['followers'],
      },
    ];
    r.followerSeries = [
      {
        connectionId: 'a',
        points: [
          { day: '2026-10-10', value: 0 },
          { day: '2026-10-12', value: 3 },
        ],
        dailyPoints: [
          { day: '2026-10-10', value: 0 },
          { day: '2026-10-11', value: null },
          { day: '2026-10-12', value: 3 },
        ],
      },
      { connectionId: 'b', points: [{ day: '2026-10-10', value: 2 }] },
    ];
    const trend = facts(r).followerTrend!;
    expect(trend.find((p) => p.day === '2026-10-05')?.value).toBe(2);
    expect(trend.find((p) => p.day === '2026-10-12')?.value).toBeNull();
    expect(trend.filter((p) => p.day < '2026-10-05').every((p) => p.value === null)).toBe(true);
  });
});

it('orders findings and caps the list at four without mutating report inputs', () => {
  const r = base();
  r.formats = [format('video', 5, 10), format('image', 5, 5)];
  r.bestTimes.by = 'engagements';
  r.bestTimes.cells = [{ weekday: 5, hour: 9, posts: 3, postsCounted: 3, average: 92 }];
  r.summary.posts.value = 10;
  r.summary.engagementRate.engagements = 100;
  r.summary.bestPost = {
    by: 'engagements',
    value: 14,
    post: {
      id: 'p',
      provider: 'instagram',
      connectionId: 'a',
      caption: 'A title',
      publishAt: now,
      releaseUrl: null,
      source: 'app',
      format: 'image',
      thumbnailUrl: null,
      metrics: EMPTY_CONCEPTS,
      engagements: 14,
      engagementRate: null,
      basis: null,
      capturedAt: now,
    },
  };
  r.summary.totals.reach = { value: 100, prior: 50, deltaPct: 100 };
  r.byPlatform = [
    {
      provider: 'instagram',
      posts: 5,
      totals: { ...EMPTY_CONCEPTS, reach: 96 },
      engagementRate: engagementRate([]),
    },
    {
      provider: 'facebook',
      posts: 5,
      totals: { ...EMPTY_CONCEPTS, reach: 4 },
      engagementRate: engagementRate([]),
    },
  ];
  const before = structuredClone(r);
  expect(facts(r).insights!.map((i) => i.kind)).toEqual(['format', 'time', 'post', 'platform']);
  expect(r).toEqual(before);
  r.formats.reverse();
  r.byPlatform.reverse();
  expect(facts(r).insights!.map((i) => i.kind)).toEqual(['format', 'time', 'post', 'platform']);
});
