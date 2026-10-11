import { describe, expect, it } from 'vitest';
import type { PostView } from '@meegrow-social/contracts';
import {
  DASH,
  DEFAULT_DAYS,
  EMPTY_PERIOD_HINT,
  FOLLOWERS,
  bestPost,
  buildTiles,
  bulkEntries,
  bulkFailure,
  cadenceText,
  cadenceWord,
  chunk,
  connectionsFor,
  countUndated,
  dayKey,
  emptyPeriodNote,
  filtersToParams,
  followerSnapshot,
  followerTimeline,
  followersTile,
  formatValue,
  groupTotals,
  humanizeMetric,
  isClientRole,
  lastCaptureByConnection,
  loadProgress,
  metricCell,
  metricHistories,
  metricNames,
  needsReconnect,
  nextRefresh,
  parseFilters,
  parsePoints,
  percentChange,
  platformsOf,
  postCount,
  postTiles,
  resolveFilters,
  selectedConnections,
  splitPeriods,
  tableMetricColumns,
  uniqueLabels,
  windowDays,
  windowOf,
  windowPosts,
  windowsFor,
  type MetricPoint,
  type MetricsByPost,
  type PostMetrics,
} from './analytics';

const DAY = 86_400_000;
// Local noon, so day-bucket tests hold in any timezone.
const NOW = new Date(2026, 9, 10, 12).getTime();
const W30 = windowsFor(NOW, 30);

const FB = { id: 'c-fb', provider: 'facebook' } as const;
const IG = { id: 'c-ig', provider: 'instagram' } as const;
const IG2 = { id: 'c-ig2', provider: 'instagram' } as const;
const GMB = { id: 'c-gmb', provider: 'gmb' } as const;
const CONNECTIONS = [FB, IG, IG2, GMB];

let seq = 0;
const post = (over: Partial<PostView> = {}): PostView => ({
  id: `p-${++seq}`,
  groupId: 'g-1',
  provider: 'facebook',
  connectionId: FB.id,
  status: 'published',
  caption: 'Hello',
  options: null,
  publishAt: new Date(NOW - DAY),
  releaseUrl: null,
  error: null,
  queueId: null,
  createdAt: new Date(NOW - 2 * DAY),
  ...over,
});

const daysAgo = (n: number) => new Date(NOW - n * DAY);
const point = (value: number, at: number, metric = FOLLOWERS): MetricPoint => ({
  metric,
  value,
  at,
});
const ok = (latest: Record<string, number>, capturedAt: number | null = null): PostMetrics => ({
  status: 'ok',
  latest,
  capturedAt,
});
const failed: PostMetrics = { status: 'error', message: 'boom' };
const byPost = (entries: Array<[PostView, PostMetrics]>): MetricsByPost =>
  new Map(entries.map(([p, m]) => [p.id, m]));

describe('URL filters', () => {
  it('defaults to all platforms, all profiles, 30 days', () => {
    expect(parseFilters(new URLSearchParams(''))).toEqual({
      platform: '',
      connection: '',
      days: DEFAULT_DAYS,
    });
  });

  it('reads platform, connection and days', () => {
    expect(parseFilters(new URLSearchParams('platform=instagram&connection=c-ig&days=90'))).toEqual(
      { platform: 'instagram', connection: 'c-ig', days: 90 },
    );
  });

  it.each(['14', '0', '-7', 'abc', '', '7.5'])('falls back to 30 for days=%s', (days) => {
    expect(parseFilters(new URLSearchParams({ days })).days).toBe(30);
  });

  it('leaves defaults out of the query string', () => {
    expect(filtersToParams({ platform: '', connection: '', days: 30 }).toString()).toBe('');
    expect(filtersToParams({ platform: 'facebook', connection: 'c-fb', days: 7 }).toString()).toBe(
      'platform=facebook&connection=c-fb&days=7',
    );
  });

  it('round-trips', () => {
    const f = { platform: 'instagram', connection: 'c-ig2', days: 90 } as const;
    expect(parseFilters(filtersToParams(f))).toEqual(f);
  });

  it('drops a platform or profile this workspace does not have', () => {
    expect(
      resolveFilters({ platform: 'tiktok', connection: 'c-gone', days: 7 }, CONNECTIONS),
    ).toEqual({ platform: '', connection: '', days: 7 });
  });

  it('drops a profile that does not belong to the chosen platform', () => {
    expect(
      resolveFilters({ platform: 'facebook', connection: 'c-ig', days: 30 }, CONNECTIONS),
    ).toEqual({ platform: 'facebook', connection: '', days: 30 });
  });

  it('keeps a profile chosen without a platform', () => {
    expect(resolveFilters({ platform: '', connection: 'c-ig', days: 30 }, CONNECTIONS)).toEqual({
      platform: '',
      connection: 'c-ig',
      days: 30,
    });
  });

  it('derives platform options from the connections, in first-seen order', () => {
    expect(platformsOf(CONNECTIONS)).toEqual(['facebook', 'instagram', 'gmb']);
    expect(platformsOf([])).toEqual([]);
  });

  it('narrows the profile options by platform', () => {
    expect(connectionsFor(CONNECTIONS, '')).toEqual(CONNECTIONS);
    expect(connectionsFor(CONNECTIONS, 'instagram')).toEqual([IG, IG2]);
  });

  it('selects the connections the filters cover', () => {
    expect(selectedConnections(CONNECTIONS, { platform: '', connection: '', days: 30 })).toEqual(
      CONNECTIONS,
    );
    expect(
      selectedConnections(CONNECTIONS, { platform: 'instagram', connection: '', days: 30 }),
    ).toEqual([IG, IG2]);
    expect(
      selectedConnections(CONNECTIONS, { platform: 'instagram', connection: 'c-ig2', days: 30 }),
    ).toEqual([IG2]);
  });
});

describe('windows', () => {
  it('ends now and is preceded by an equally long prior window', () => {
    expect(windowsFor(NOW, 7)).toEqual({
      priorStart: NOW - 14 * DAY,
      start: NOW - 7 * DAY,
      end: NOW,
    });
  });

  it('assigns each instant to at most one window', () => {
    expect(windowOf(NOW, W30)).toBe('current');
    expect(windowOf(W30.start + 1, W30)).toBe('current');
    expect(windowOf(W30.start, W30)).toBe('prior');
    expect(windowOf(W30.priorStart + 1, W30)).toBe('prior');
    expect(windowOf(W30.priorStart, W30)).toBeNull();
    expect(windowOf(NOW + 1, W30)).toBeNull();
  });
});

describe('windowPosts', () => {
  it('sorts newest first and tags the window', () => {
    const a = post({ publishAt: daysAgo(40) });
    const b = post({ publishAt: daysAgo(2) });
    const c = post({ publishAt: daysAgo(10) });
    expect(windowPosts([a, b, c], W30).map((p) => [p.post.id, p.window])).toEqual([
      [b.id, 'current'],
      [c.id, 'current'],
      [a.id, 'prior'],
    ]);
  });

  it('reads the ISO strings the API actually sends', () => {
    const p = post({ publishAt: daysAgo(3).toISOString() as unknown as Date });
    expect(windowPosts([p], W30)[0]?.at).toBe(NOW - 3 * DAY);
  });

  it('drops undated, placeholder-dated and out-of-range posts', () => {
    const posts = [
      post({ publishAt: null }),
      post({ publishAt: new Date(0) }),
      post({ publishAt: daysAgo(61) }),
      post({ publishAt: new Date(NOW + DAY) }),
    ];
    expect(windowPosts(posts, W30)).toEqual([]);
  });
});

describe('splitPeriods', () => {
  it('splits by period and keeps every post: nothing caps the view', () => {
    const windowed = windowPosts(
      [
        ...Array.from({ length: 450 }, (_, i) => post({ publishAt: new Date(NOW - i * 1000) })),
        ...Array.from({ length: 3 }, (_, i) => post({ publishAt: new Date(W30.start - i * 1000) })),
      ],
      W30,
    );
    const period = splitPeriods(windowed);
    expect(period.current).toHaveLength(450);
    expect(period.prior).toHaveLength(3);
    // Newest first, as windowPosts ordered them.
    expect(period.current[0]!.at).toBeGreaterThan(period.current[449]!.at);
  });
});

describe('bulk metrics', () => {
  it('settles every id of a request, parsing the capture time', () => {
    expect(
      bulkEntries(['a', 'b'], {
        a: { latest: { views: 3 }, capturedAt: '2026-10-01T00:00:00.000Z' },
        b: { latest: {}, capturedAt: null },
      }),
    ).toEqual([
      ['a', { status: 'ok', latest: { views: 3 }, capturedAt: Date.UTC(2026, 9, 1) }],
      ['b', { status: 'ok', latest: {}, capturedAt: null }],
    ]);
  });

  it('reads an id the API left out as a post with nothing collected, not as an error', () => {
    expect(bulkEntries(['gone'], {})).toEqual([
      ['gone', { status: 'ok', latest: {}, capturedAt: null }],
    ]);
  });

  it('passes metric names through exactly as the API sent them', () => {
    const [[, entry]] = bulkEntries(['a'], {
      a: { latest: { LOCAL_POST_VIEWS_SEARCH: 1, post_media_view: 2 }, capturedAt: null },
    });
    expect(entry).toMatchObject({ latest: { LOCAL_POST_VIEWS_SEARCH: 1, post_media_view: 2 } });
  });

  it('marks every id of a failed request', () => {
    expect(bulkFailure(['a', 'b'], 'boom')).toEqual([
      ['a', failed],
      ['b', failed],
    ]);
  });
});

describe('countUndated', () => {
  it('counts posts with no publish time, the epoch placeholder included', () => {
    expect(
      countUndated([
        { publishAt: null },
        { publishAt: new Date(0) },
        { publishAt: '1970-01-01T00:00:00.000Z' as unknown as Date },
        { publishAt: new Date(NOW) },
      ]),
    ).toBe(3);
    expect(countUndated([])).toBe(0);
  });
});

describe('emptyPeriodNote', () => {
  it('keeps the generic hint when the check has not answered or found nothing', () => {
    expect(emptyPeriodNote(null)).toBe(EMPTY_PERIOD_HINT);
    expect(emptyPeriodNote({ count: 0, atLeast: false })).toBe(EMPTY_PERIOD_HINT);
    // A truncated list that showed none proves nothing either way.
    expect(emptyPeriodNote({ count: 0, atLeast: true })).toBe(EMPTY_PERIOD_HINT);
  });

  it('names the undated posts instead of suggesting a longer range', () => {
    expect(emptyPeriodNote({ count: 1, atLeast: false })).toBe(
      '1 published post has no recorded publish time and cannot be placed in a period.',
    );
    expect(emptyPeriodNote({ count: 12, atLeast: false })).toBe(
      '12 published posts have no recorded publish time and cannot be placed in a period.',
    );
  });

  it('says "at least" when the list it counted from was cut off', () => {
    expect(emptyPeriodNote({ count: 1, atLeast: true })).toBe(
      'At least 1 published post has no recorded publish time and cannot be placed in a period.',
    );
  });
});

describe('chunk', () => {
  it('splits into groups of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });
});

describe('parsePoints', () => {
  it('parses ISO capture times', () => {
    expect(
      parsePoints([{ metric: 'views', value: 5, capturedAt: '2026-10-01T10:00:00.000Z' }]),
    ).toEqual([{ metric: 'views', value: 5, at: Date.UTC(2026, 9, 1, 10) }]);
  });

  it('returns oldest first whether the series arrived newest first (followers) or oldest first (posts)', () => {
    const newestFirst = [
      { metric: FOLLOWERS, value: 3, capturedAt: '2026-10-03T00:00:00Z' },
      { metric: FOLLOWERS, value: 2, capturedAt: '2026-10-02T00:00:00Z' },
      { metric: FOLLOWERS, value: 1, capturedAt: '2026-10-01T00:00:00Z' },
    ];
    expect(parsePoints(newestFirst).map((p) => p.value)).toEqual([1, 2, 3]);
    expect(parsePoints([...newestFirst].reverse()).map((p) => p.value)).toEqual([1, 2, 3]);
  });

  it('accepts Date objects and drops unreadable times', () => {
    expect(
      parsePoints([
        { metric: 'a', value: 1, capturedAt: new Date(NOW) },
        { metric: 'a', value: 2, capturedAt: 'not a date' },
      ]),
    ).toEqual([{ metric: 'a', value: 1, at: NOW }]);
  });
});

describe('metricNames', () => {
  it('is the alphabetical union of whatever names came back', () => {
    expect(metricNames([{ views: 1, reach: 2 }, { post_clicks: 3, views: 4 }, {}])).toEqual([
      'post_clicks',
      'reach',
      'views',
    ]);
    expect(metricNames([])).toEqual([]);
  });

  it('passes unknown, renamed and oddly-cased names through verbatim', () => {
    expect(metricNames([{ LOCAL_POST_VIEWS_SEARCH: 1, some_future_metric: 2 }])).toEqual([
      'LOCAL_POST_VIEWS_SEARCH',
      'some_future_metric',
    ]);
  });
});

describe('percentChange', () => {
  it('is signed', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(100, 100)).toBe(0);
    expect(percentChange(0, 100)).toBe(-100);
  });

  it('is null without a prior value, or with a zero one', () => {
    expect(percentChange(10, null)).toBeNull();
    expect(percentChange(10, undefined)).toBeNull();
    expect(percentChange(10, 0)).toBeNull();
  });
});

describe('postTiles', () => {
  const cur1 = post({ publishAt: daysAgo(1) });
  const cur2 = post({ publishAt: daysAgo(5), provider: 'instagram', connectionId: IG.id });
  const old1 = post({ publishAt: daysAgo(35) });
  const capped = splitPeriods(windowPosts([cur1, cur2, old1], W30));

  it('sums latest values for posts published in the period, against the prior period', () => {
    const tiles = postTiles(
      capped,
      byPost([
        [cur1, ok({ views: 100, post_clicks: 4 })],
        [cur2, ok({ views: 50, saved: 7 })],
        [old1, ok({ views: 100, post_clicks: 8 })],
      ]),
    );
    expect(tiles).toEqual([
      { name: 'post_clicks', value: 4, delta: -50 },
      // No prior post reported `saved`: no comparison, not "+∞%" and not 0.
      { name: 'saved', value: 7, delta: null },
      { name: 'views', value: 150, delta: 50 },
    ]);
  });

  it('shows no tile for a name only prior-period posts reported', () => {
    const tiles = postTiles(
      capped,
      byPost([
        [cur1, ok({ views: 1 })],
        [cur2, ok({ views: 1 })],
        [old1, ok({ views: 1, retired_metric: 9 })],
      ]),
    );
    expect(tiles.map((t) => t.name)).toEqual(['views']);
  });

  it('keeps a real zero as 0, not as missing', () => {
    const tiles = postTiles(
      capped,
      byPost([
        [cur1, ok({ views: 0 })],
        [cur2, ok({})],
        [old1, ok({ views: 10 })],
      ]),
    );
    expect(tiles).toEqual([{ name: 'views', value: 0, delta: -100 }]);
  });

  it('withholds the comparison when a post failed, on either side', () => {
    for (const bad of [cur2, old1]) {
      const entries: Array<[PostView, PostMetrics]> = [cur1, cur2, old1].map((p) => [
        p,
        p === bad ? failed : ok({ views: 10 }),
      ]);
      expect(postTiles(capped, byPost(entries)).every((t) => t.delta === null)).toBe(true);
    }
  });

  it('withholds the comparison while posts are still loading', () => {
    const tiles = postTiles(capped, byPost([[cur1, ok({ views: 10 })]]));
    expect(tiles).toEqual([{ name: 'views', value: 10, delta: null }]);
  });

  it('withholds the comparison when the post list was cut short', () => {
    const tiles = postTiles(
      capped,
      byPost([
        [cur1, ok({ views: 10 })],
        [cur2, ok({ views: 10 })],
        [old1, ok({ views: 10 })],
      ]),
      false,
    );
    expect(tiles).toEqual([{ name: 'views', value: 20, delta: null }]);
  });

  it('has no tiles when nothing was reported', () => {
    expect(postTiles(splitPeriods([]), new Map())).toEqual([]);
  });
});

describe('postCount', () => {
  const posts = [
    post({ publishAt: daysAgo(1) }),
    post({ publishAt: daysAgo(2) }),
    post({ publishAt: daysAgo(3) }),
    post({ publishAt: daysAgo(40) }),
    post({ publishAt: daysAgo(41) }),
  ];

  it('counts the period against the one before', () => {
    expect(postCount(splitPeriods(windowPosts(posts, W30)))).toEqual({ value: 3, delta: 50 });
  });

  it('has no comparison when nothing was published before, or the list was cut short', () => {
    const onlyNow = splitPeriods(windowPosts(posts.slice(0, 3), W30));
    expect(postCount(onlyNow)).toEqual({ value: 3, delta: null });
    expect(postCount(splitPeriods(windowPosts(posts, W30)), false)).toEqual({
      value: 3,
      delta: null,
    });
  });

  it('is zero, not missing, for an empty period', () => {
    expect(postCount(splitPeriods([])).value).toBe(0);
  });
});

describe('bestPost', () => {
  const a = post({ publishAt: daysAgo(3) });
  const b = post({ publishAt: daysAgo(2) });
  const c = post({ publishAt: daysAgo(1) });
  const rows = windowPosts([a, b, c], W30);

  it('is the post with the highest value of the chosen metric', () => {
    const metrics = byPost([
      [a, ok({ views: 10, saved: 9 })],
      [b, ok({ views: 30 })],
      [c, ok({ views: 20 })],
    ]);
    expect(bestPost(rows, metrics, 'views')).toEqual({ post: b, value: 30 });
    expect(bestPost(rows, metrics, 'saved')).toEqual({ post: a, value: 9 });
  });

  it('takes the newest of a tie', () => {
    const metrics = byPost([
      [a, ok({ views: 5 })],
      [c, ok({ views: 5 })],
    ]);
    expect(bestPost(rows, metrics, 'views')?.post).toBe(c);
  });

  it('skips posts that failed, are loading, or do not report the metric', () => {
    const metrics = byPost([
      [a, failed],
      [b, ok({ reach: 99 })],
    ]);
    expect(bestPost(rows, metrics, 'views')).toBeNull();
    expect(bestPost(rows, new Map(), 'views')).toBeNull();
  });

  it('counts a real zero as a value', () => {
    expect(bestPost(rows, byPost([[a, ok({ views: 0 })]]), 'views')).toEqual({ post: a, value: 0 });
  });
});

describe('followers', () => {
  const series = [
    point(90, W30.start - 5 * DAY),
    point(100, W30.start - DAY),
    point(110, W30.start + DAY),
    point(120, NOW - DAY),
  ];

  it('picks the newest point in the window and the newest at or before its start', () => {
    const snap = followerSnapshot(series, W30);
    expect(snap.current?.value).toBe(120);
    expect(snap.baseline?.value).toBe(100);
  });

  it('treats a point exactly at the window start as the baseline', () => {
    const snap = followerSnapshot([point(7, W30.start)], W30);
    expect(snap).toEqual({ current: null, baseline: point(7, W30.start) });
  });

  it('ignores points after the window', () => {
    expect(followerSnapshot([point(5, NOW + DAY)], W30)).toEqual({ current: null, baseline: null });
  });

  it('sums the selected connections and compares against their summed baseline', () => {
    const other = [point(50, W30.start - DAY), point(40, NOW - 2 * DAY)];
    const tile = followersTile([series, other], W30);
    expect(tile?.name).toBe(FOLLOWERS);
    expect(tile?.value).toBe(160);
    expect(tile?.delta).toBeCloseTo(((160 - 150) / 150) * 100);
  });

  it('has no delta when a counted connection has no point before the window', () => {
    const fresh = [point(30, NOW - DAY)];
    expect(followersTile([series, fresh], W30)).toEqual({
      name: FOLLOWERS,
      value: 150,
      delta: null,
    });
  });

  it('skips connections with no follower series (a platform without followers)', () => {
    expect(followersTile([series, []], W30)).toEqual({
      name: FOLLOWERS,
      value: 120,
      delta: 20,
    });
  });

  it('has no tile at all when no connection has a follower series', () => {
    expect(followersTile([[], []], W30)).toBeNull();
    expect(followersTile([], W30)).toBeNull();
  });

  it('shows the tile with no value when captures exist but none fall in the window', () => {
    expect(followersTile([[point(100, W30.start - DAY)]], W30)).toEqual({
      name: FOLLOWERS,
      value: null,
      delta: null,
    });
  });
});

describe('buildTiles', () => {
  const p = post({ publishAt: daysAgo(1) });
  const capped = splitPeriods(windowPosts([p], W30));

  it('puts followers first, then the per-post names', () => {
    const tiles = buildTiles(
      capped,
      byPost([[p, ok({ views: 5 })]]),
      [[point(10, NOW - DAY)]],
      W30,
    );
    expect(tiles.map((t) => t.name)).toEqual([FOLLOWERS, 'views']);
  });

  it('omits followers when no connection has the series', () => {
    const tiles = buildTiles(capped, byPost([[p, ok({ views: 5 })]]), [[]], W30);
    expect(tiles.map((t) => t.name)).toEqual(['views']);
  });

  it('never shows the name twice', () => {
    const tiles = buildTiles(
      capped,
      byPost([[p, ok({ [FOLLOWERS]: 3, views: 5 })]]),
      [[point(10, NOW - DAY)]],
      W30,
    );
    expect(tiles).toEqual([
      { name: FOLLOWERS, value: 10, delta: null },
      { name: 'views', value: 5, delta: null },
    ]);
  });
});

describe('groupTotals', () => {
  const fb = post({ provider: 'facebook', connectionId: FB.id });
  const ig = post({ provider: 'instagram', connectionId: IG.id });
  const ig2 = post({ provider: 'instagram', connectionId: IG2.id });
  const posts = windowPosts([fb, ig, ig2], W30);
  const metrics = byPost([
    [fb, ok({ post_clicks: 3 })],
    [ig, ok({ views: 10, saved: 1 })],
    [ig2, ok({ views: 5 })],
  ]);
  const followers = new Map([
    [FB.id, [point(100, NOW - DAY)]],
    [IG.id, [point(20, NOW - DAY)]],
    [IG2.id, [point(5, NOW - DAY)]],
    [GMB.id, []],
  ]);
  const base = { posts, metrics, followers, windows: W30 };

  it('totals per platform, with null where a platform has no such metric', () => {
    expect(
      groupTotals({ ...base, metric: 'views', groupBy: 'platform', connections: CONNECTIONS }),
    ).toEqual([
      { key: 'facebook', value: null },
      { key: 'instagram', value: 15 },
      { key: 'gmb', value: null },
    ]);
  });

  it('totals per profile once a platform is chosen', () => {
    expect(
      groupTotals({ ...base, metric: 'saved', groupBy: 'connection', connections: [IG, IG2] }),
    ).toEqual([
      { key: IG.id, value: 1 },
      { key: IG2.id, value: null },
    ]);
  });

  it('uses the account series for followers, null for a platform without one', () => {
    expect(
      groupTotals({ ...base, metric: FOLLOWERS, groupBy: 'platform', connections: CONNECTIONS }),
    ).toEqual([
      { key: 'facebook', value: 100 },
      { key: 'instagram', value: 25 },
      { key: 'gmb', value: null },
    ]);
  });

  it('ignores failed and pending posts rather than counting them as zero', () => {
    const partial = byPost([[fb, failed]]);
    expect(
      groupTotals({
        ...base,
        metrics: partial,
        metric: 'post_clicks',
        groupBy: 'platform',
        connections: [FB],
      }),
    ).toEqual([{ key: 'facebook', value: null }]);
  });

  it('ignores posts from connections outside the selection', () => {
    expect(
      groupTotals({ ...base, metric: 'views', groupBy: 'connection', connections: [IG] }),
    ).toEqual([{ key: IG.id, value: 10 }]);
  });
});

describe('followerTimeline', () => {
  const W7 = windowsFor(NOW, 7);
  const noon = (n: number) => new Date(2026, 9, 10 - n, 12).getTime();

  it('covers every local day the window touches', () => {
    const days = windowDays(W7);
    expect(days).toHaveLength(8);
    expect(dayKey(days[0]!)).toBe('2026-10-03');
    expect(dayKey(days[7]!)).toBe('2026-10-10');
  });

  it('buckets by day, keeps the last capture of a day, and leaves gaps null', () => {
    const { rows, coverage, sparse } = followerTimeline(
      [
        {
          id: 'a',
          points: [
            point(10, noon(3) - 3_600_000),
            point(11, noon(3)),
            point(12, noon(1)),
            point(13, noon(0) - 60_000),
          ],
        },
      ],
      W7,
      dayKey,
    );
    expect(rows.map((r) => [r.day, r.a])).toEqual([
      ['2026-10-03', null],
      ['2026-10-04', null],
      ['2026-10-05', null],
      ['2026-10-06', null],
      ['2026-10-07', 11],
      ['2026-10-08', null],
      ['2026-10-09', 12],
      ['2026-10-10', 13],
    ]);
    expect(coverage.get('a')).toBe('charted');
    expect(sparse).toBe(false);
  });

  it('excludes points outside the window', () => {
    const { rows } = followerTimeline(
      [{ id: 'a', points: [point(1, W7.start - 1), point(2, noon(1))] }],
      W7,
      dayKey,
    );
    expect(rows.filter((r) => r.a !== null).map((r) => r.a)).toEqual([2]);
  });

  it('tells a connection with no series from one with nothing in the window', () => {
    const { rows, coverage } = followerTimeline(
      [
        { id: 'a', points: [point(5, noon(2)), point(6, noon(1))] },
        { id: 'stale', points: [point(9, W7.start - DAY)] },
        { id: 'gmb', points: [] },
      ],
      W7,
      dayKey,
    );
    expect([...coverage]).toEqual([
      ['a', 'charted'],
      ['stale', 'outside'],
      ['gmb', 'none'],
    ]);
    // Uncharted connections get no column at all — not a flat zero line.
    expect(Object.keys(rows[0]!)).toEqual(['day', 'a']);
  });

  it('flags a series with a single day of data, which a line cannot draw', () => {
    expect(followerTimeline([{ id: 'a', points: [point(5, noon(1))] }], W7, dayKey).sparse).toBe(
      true,
    );
  });
});

describe('table', () => {
  const a = post();
  const b = post({ provider: 'instagram', connectionId: IG.id });
  const c = post();
  const rows = windowPosts([a, b, c], W30);

  it('has one column per name in the union of the loaded rows, alphabetical', () => {
    const metrics = byPost([
      [a, ok({ post_clicks: 1, post_video_views: 2 })],
      [b, ok({ views: 3, saved: 4 })],
      [c, failed],
    ]);
    expect(tableMetricColumns(rows, metrics)).toEqual([
      'post_clicks',
      'post_video_views',
      'saved',
      'views',
    ]);
  });

  it('has no metric columns before anything has loaded', () => {
    expect(tableMetricColumns(rows, new Map())).toEqual([]);
  });

  it('distinguishes pending, failed, missing and present values', () => {
    expect(metricCell(undefined, 'views')).toEqual({ kind: 'pending' });
    expect(metricCell(failed, 'views')).toEqual({ kind: 'error', message: 'boom' });
    expect(metricCell(ok({ saved: 1 }), 'views')).toEqual({ kind: 'missing' });
    expect(metricCell(ok({ views: 0 }), 'views')).toEqual({ kind: 'value', value: 0 });
  });

  it('splits a series per metric for the expanded row', () => {
    const histories = metricHistories([
      point(1, 100, 'views'),
      point(5, 150, 'reach'),
      point(2, 200, 'views'),
      point(3, 300, 'views'),
    ]);
    expect(histories).toEqual([
      { name: 'reach', points: [point(5, 150, 'reach')], last: 150 },
      {
        name: 'views',
        points: [point(1, 100, 'views'), point(2, 200, 'views'), point(3, 300, 'views')],
        last: 300,
      },
    ]);
    expect(metricHistories([])).toEqual([]);
  });
});

describe('loadProgress', () => {
  it('counts settled and failed posts', () => {
    const a = post();
    const b = post();
    const c = post();
    const rows = windowPosts([a, b, c], W30);
    expect(
      loadProgress(
        rows,
        byPost([
          [a, ok({})],
          [b, failed],
        ]),
      ),
    ).toEqual({ total: 3, done: 2, failed: 1 });
  });
});

describe('sync line', () => {
  it('finds the newest capture per connection across followers and post metrics', () => {
    const p = post({ connectionId: FB.id });
    const q = post({ connectionId: IG.id });
    const last = lastCaptureByConnection(
      windowPosts([p, q], W30),
      byPost([
        [p, ok({ views: 1 }, 900)],
        [q, failed],
      ]),
      new Map([
        [FB.id, [point(10, 700)]],
        [GMB.id, []],
      ]),
    );
    expect([...last]).toEqual([[FB.id, 900]]);
  });

  it('ignores a post with nothing collected', () => {
    const p = post({ connectionId: FB.id });
    const last = lastCaptureByConnection(windowPosts([p], W30), byPost([[p, ok({})]]), new Map());
    expect([...last]).toEqual([]);
  });

  it('words the cadence from what the API reports, not from fixed text', () => {
    const HOUR = 3_600_000;
    expect(cadenceWord(HOUR)).toBe('hourly');
    expect(cadenceWord(24 * HOUR)).toBe('daily');
    expect(cadenceWord(6 * HOUR)).toBe('every 6 hours');
    expect(cadenceWord(HOUR / 2)).toBe('every 30 minutes');
    const cadence = {
      sweepIntervalMs: HOUR,
      freshPostWindowMs: 48 * HOUR,
      freshPostIntervalMs: HOUR,
      postIntervalMs: 24 * HOUR,
      accountIntervalMs: 24 * HOUR,
    };
    expect(cadenceText(cadence)).toBe(
      'posts refresh hourly for 48 h, then daily · followers daily',
    );
    expect(
      cadenceText({ ...cadence, freshPostWindowMs: 72 * HOUR, postIntervalMs: 12 * HOUR }),
    ).toBe('posts refresh hourly for 72 h, then every 12 hours · followers daily');
  });

  it('says that old posts are refreshed less often, when the API reports it', () => {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const cadence = {
      sweepIntervalMs: HOUR,
      freshPostWindowMs: 48 * HOUR,
      freshPostIntervalMs: HOUR,
      postIntervalMs: DAY,
      accountIntervalMs: DAY,
      olderPosts: [
        { afterMs: 30 * DAY, intervalMs: 7 * DAY },
        { afterMs: 90 * DAY, intervalMs: 28 * DAY },
      ],
    };
    expect(cadenceText(cadence)).toBe(
      'posts refresh hourly for 48 h, then daily, weekly after 30 days, every 28 days after 90 days · followers daily',
    );
    expect(cadenceWord(7 * DAY)).toBe('weekly');
    expect(cadenceWord(3 * DAY)).toBe('every 3 days');
  });

  it('says when the next collection falls due: never, already, or at a time', () => {
    const at = (d: Date | null) => nextRefresh({ nextDueAt: d }, NOW);
    expect(at(null)).toEqual({ kind: 'none' });
    expect(at(new Date(NOW - 1))).toEqual({ kind: 'due' });
    expect(at(new Date(NOW))).toEqual({ kind: 'due' });
    expect(at(new Date(NOW + 60_000))).toEqual({ kind: 'at', at: NOW + 60_000 });
    // The API client hands dates over as ISO strings.
    expect(
      nextRefresh({ nextDueAt: new Date(NOW + 5).toISOString() as unknown as Date }, NOW),
    ).toEqual({ kind: 'at', at: NOW + 5 });
  });

  it('flags a connection that needs reconnecting by either field', () => {
    expect(needsReconnect({ needsReconnect: true, health: 'healthy' })).toBe(true);
    expect(needsReconnect({ needsReconnect: false, health: 'needs_reconnect' })).toBe(true);
    expect(needsReconnect({ needsReconnect: false, health: 'expiring' })).toBe(false);
  });
});

describe('formatting', () => {
  it('humanises a metric name cosmetically, without renaming it', () => {
    expect(humanizeMetric('post_video_views')).toBe('Post video views');
    expect(humanizeMetric('views')).toBe('Views');
    expect(humanizeMetric('LOCAL_POST_VIEWS_SEARCH')).toBe('LOCAL POST VIEWS SEARCH');
    expect(humanizeMetric('')).toBe('');
  });

  it('formats values, with a dash for a missing one and 0 for a real zero', () => {
    expect(formatValue(null)).toBe(DASH);
    expect(formatValue(undefined)).toBe(DASH);
    expect(formatValue(0)).toBe('0');
    expect(formatValue(1234)).toBe((1234).toLocaleString());
  });

  it('disambiguates repeated labels', () => {
    expect(uniqueLabels(['Acme', 'Bolt', 'Acme', 'Acme'])).toEqual([
      'Acme',
      'Bolt',
      'Acme (2)',
      'Acme (3)',
    ]);
  });
});

describe('isClientRole', () => {
  it('is true for client, and for viewer until the roles matrix lands', () => {
    expect(isClientRole('client')).toBe(true);
    expect(isClientRole('viewer')).toBe(true);
  });

  it.each(['owner', 'admin', 'member', '', null, undefined])('is false for %s', (role) => {
    expect(isClientRole(role)).toBe(false);
  });
});
