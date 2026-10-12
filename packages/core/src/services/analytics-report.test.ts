import { describe, expect, it } from 'vitest';
import type { ReportAccount } from '@meegrow-social/contracts';
import {
  ACCUMULATION_RULES,
  accumulationCandidates,
  accumulationSection,
  bestTimes,
  bucketKey,
  bucketUnit,
  buildAnalyticsReport,
  sortReportPosts,
  engagementHistory,
  followerSection,
  followerCalendar,
  publicationWindow,
  engagementAgeDisplayPoints,
  formatSection,
  frequencySection,
  publishSlot,
  publicationIntensity,
  rawMetricRows,
  resolvePeriod,
  timeBuckets,
  type RawPost,
  type RawSnapshot,
  type ReportInput,
  type ReportPeriod,
} from './analytics-report.js';
import { EMPTY_CONCEPTS, toConcepts } from './metric-concepts.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A Sunday, 12:00 UTC. */
const NOW = new Date('2026-10-11T12:00:00Z');
const at = (iso: string): Date => new Date(iso);
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const period30 = resolvePeriod({ days: 30 }, NOW);

let seq = 0;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IG = uuid(1);
const FB = uuid(2);

function post(patch: Partial<RawPost> & Pick<RawPost, 'publishAt'>): RawPost {
  seq += 1;
  return {
    id: uuid(1000 + seq),
    connectionId: IG,
    provider: 'instagram',
    caption: `post ${seq}`,
    releaseUrl: null,
    source: 'app',
    format: 'image',
    thumbnailUrl: null,
    native: {},
    capturedAt: null,
    ...patch,
  };
}

const account = (id: string, provider: string): ReportAccount => ({
  id,
  workspaceId: uuid(900),
  workspaceName: 'Client',
  provider,
  displayName: provider,
  needsReconnect: false,
  selected: true,
});

const input = (patch: Partial<ReportInput>): ReportInput => ({
  now: NOW,
  period: period30,
  timezone: 'UTC',
  accounts: [account(IG, 'instagram'), account(FB, 'facebook')],
  posts: [],
  followerPoints: [],
  snapshots: [],
  undatedPosts: 0,
  ...patch,
});

describe('resolvePeriod', () => {
  it('`days` ends now, with an equally long period before it', () => {
    expect(resolvePeriod({ days: 7 }, NOW)).toEqual({
      priorStart: ago(14 * DAY),
      start: ago(7 * DAY),
      end: NOW,
    });
  });

  it('defaults to 30 days', () => {
    expect(resolvePeriod({}, NOW).start).toEqual(ago(30 * DAY));
  });

  it('takes an explicit range as given', () => {
    const p = resolvePeriod(
      { from: at('2026-09-01T00:00:00Z'), to: at('2026-09-11T00:00:00Z') },
      NOW,
    );
    expect(p).toEqual({
      priorStart: at('2026-08-22T00:00:00Z'),
      start: at('2026-09-01T00:00:00Z'),
      end: at('2026-09-11T00:00:00Z'),
    });
  });
});

describe('time buckets', () => {
  it('a week starts on Monday in the viewer’s zone', () => {
    // Sunday 20:00 UTC is already Monday 01:30 in Kolkata and still Sunday in New York.
    const instant = at('2026-10-04T20:00:00Z');
    expect(bucketKey(instant, 'UTC', 'week')).toBe('2026-09-28');
    expect(bucketKey(instant, 'Asia/Kolkata', 'week')).toBe('2026-10-05');
    expect(bucketKey(instant, 'America/New_York', 'week')).toBe('2026-09-28');
  });

  it('a day is the local calendar day', () => {
    const instant = at('2026-10-04T20:00:00Z');
    expect(bucketKey(instant, 'UTC', 'day')).toBe('2026-10-04');
    expect(bucketKey(instant, 'Asia/Kolkata', 'day')).toBe('2026-10-05');
    expect(bucketKey(at('2026-10-04T02:00:00Z'), 'America/Los_Angeles', 'day')).toBe('2026-10-03');
  });

  it('charts a short period per day and a longer one per week', () => {
    expect(bucketUnit(resolvePeriod({ days: 7 }, NOW))).toBe('day');
    expect(bucketUnit(resolvePeriod({ days: 14 }, NOW))).toBe('day');
    expect(bucketUnit(period30)).toBe('week');
  });

  it('lists every week the period touches, oldest first, empty ones included', () => {
    const weeks = timeBuckets(period30, 'UTC', 'week');
    // 11 Sep 12:00 → 11 Oct 12:00: the weeks of 7, 14, 21, 28 Sep and 5 Oct.
    expect(weeks.map((w) => w.key)).toEqual([
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
    ]);
    expect(weeks[1]).toMatchObject({
      start: at('2026-09-14T00:00:00Z'),
      end: at('2026-09-21T00:00:00Z'),
    });
  });

  it('cuts the same period on different midnights in another zone', () => {
    const weeks = timeBuckets(period30, 'Asia/Kolkata', 'week');
    expect(weeks[0]!.start).toEqual(at('2026-09-06T18:30:00Z')); // Monday 00:00 IST
    // 11 Oct 12:00 UTC is Sunday 17:30 IST — still the week of 5 Oct.
    expect(weeks.at(-1)!.key).toBe('2026-10-05');
  });

  it('keeps a week 7 local days long across a DST change', () => {
    // Europe/London leaves summer time on Sunday 25 Oct 2026: that week is 169 hours long.
    const p: ReportPeriod = {
      priorStart: at('2026-09-01T00:00:00Z'),
      start: at('2026-10-18T23:00:00Z'), // Monday 19 Oct 00:00 BST
      end: at('2026-11-02T00:00:00Z'),
    };
    const weeks = timeBuckets(p, 'Europe/London', 'week');
    expect(weeks.map((w) => w.key)).toEqual(['2026-10-19', '2026-10-26', '2026-11-02']);
    expect(weeks[0]!.end.getTime() - weeks[0]!.start.getTime()).toBe(7 * DAY + HOUR);
    expect(bucketKey(at('2026-10-25T23:30:00Z'), 'Europe/London', 'week')).toBe('2026-10-19');
  });

  it('seven days ending now are eight local days, the first and last partial', () => {
    const days = timeBuckets(resolvePeriod({ days: 7 }, NOW), 'UTC', 'day');
    expect(days).toHaveLength(8);
    expect(days[0]!.key).toBe('2026-10-04');
    expect(days.at(-1)!.key).toBe('2026-10-11');
  });
});

describe('best time to post', () => {
  it('places a post in the weekday and hour of the viewer’s zone', () => {
    const friday = at('2026-10-09T03:45:00Z');
    expect(publishSlot(friday, 'UTC')).toEqual({ weekday: 4, hour: 3 });
    expect(publishSlot(friday, 'Asia/Kolkata')).toEqual({ weekday: 4, hour: 9 });
    expect(publishSlot(friday, 'America/Los_Angeles')).toEqual({ weekday: 3, hour: 20 });
  });

  it('scores a slot by the mean over its posts and names the top three', () => {
    const fri9 = at('2026-10-09T09:10:00Z');
    const out = bestTimes(
      [
        { publishAt: fri9, value: 100 },
        { publishAt: at('2026-10-02T09:50:00Z'), value: 50 }, // also Friday 09
        { publishAt: at('2026-10-08T05:00:00Z'), value: 60 }, // Thursday 05
        { publishAt: at('2026-10-07T13:00:00Z'), value: 15 }, // Wednesday 13
        { publishAt: at('2026-10-05T07:00:00Z'), value: 5 }, // Monday 07
        { publishAt: at('2026-10-06T07:00:00Z'), value: 0 }, // Tuesday 07: nothing happened
        { publishAt: at('2026-10-10T07:00:00Z'), value: null }, // Saturday 07: not reported
      ],
      'UTC',
    );
    expect(out.top).toEqual([
      { weekday: 4, hour: 9, posts: 2, average: 75 },
      { weekday: 3, hour: 5, posts: 1, average: 60 },
      { weekday: 2, hour: 13, posts: 1, average: 15 },
    ]);
    expect(out.postsCounted).toBe(6);
    expect(out.cells).toHaveLength(6);
    // A slot whose only post reports nothing is listed without a score — not as 0.
    expect(out.cells.find((c) => c.weekday === 5)).toEqual({
      weekday: 5,
      hour: 7,
      posts: 1,
      postsCounted: 0,
      average: null,
      level: null,
    });
  });

  it('names no top slot when nothing scored above zero', () => {
    expect(bestTimes([{ publishAt: NOW, value: 0 }], 'UTC').top).toEqual([]);
    expect(bestTimes([], 'UTC')).toEqual({ cells: [], top: [], postsCounted: 0 });
  });
});

describe('followers', () => {
  const accounts = [{ id: IG }, { id: FB }];

  it('sums the newest capture inside the period and the change from the period before', () => {
    const out = followerSection(
      accounts,
      [
        { connectionId: IG, value: 1000, capturedAt: ago(40 * DAY) },
        { connectionId: IG, value: 1100, capturedAt: ago(2 * DAY) },
        { connectionId: IG, value: 1090, capturedAt: ago(10 * DAY) },
        { connectionId: FB, value: 500, capturedAt: ago(35 * DAY) },
        { connectionId: FB, value: 520, capturedAt: ago(DAY) },
      ],
      period30,
      'UTC',
    );
    expect(out.summary).toEqual({
      value: 1620,
      change: 120,
      deltaPct: 8,
      accounts: 2,
      accountsCounted: 2,
    });
    expect(out.followerSeries.find((s) => s.connectionId === IG)!.points).toEqual([
      { day: '2026-10-01', value: 1090 },
      { day: '2026-10-09', value: 1100 },
    ]);
  });

  it('states no change when a counted account has no capture from the period before', () => {
    const out = followerSection(
      accounts,
      [
        { connectionId: IG, value: 1000, capturedAt: ago(40 * DAY) },
        { connectionId: IG, value: 1100, capturedAt: ago(2 * DAY) },
        { connectionId: FB, value: 520, capturedAt: ago(DAY) }, // history starts in the period
      ],
      period30,
      'UTC',
    );
    expect(out.summary).toMatchObject({ value: 1620, change: null, deltaPct: null });
  });

  it('counts only accounts captured inside the period, and is null when none was', () => {
    const one = followerSection(
      accounts,
      [{ connectionId: IG, value: 1100, capturedAt: ago(2 * DAY) }],
      period30,
      'UTC',
    );
    expect(one.summary).toMatchObject({ value: 1100, accounts: 2, accountsCounted: 1 });
    const none = followerSection(
      accounts,
      [{ connectionId: IG, value: 1000, capturedAt: ago(40 * DAY) }],
      period30,
      'UTC',
    );
    expect(none.summary).toMatchObject({ value: null, change: null, accountsCounted: 0 });
    expect(none.followerSeries).toEqual([]);
  });

  it('keeps the last capture of a local day', () => {
    const out = followerSection(
      [{ id: IG }],
      [
        { connectionId: IG, value: 10, capturedAt: at('2026-10-09T19:00:00Z') }, // 10 Oct 00:30 IST
        { connectionId: IG, value: 12, capturedAt: at('2026-10-10T17:00:00Z') }, // 10 Oct 22:30 IST
      ],
      period30,
      'Asia/Kolkata',
    );
    expect(out.followerSeries[0]!.points).toEqual([{ day: '2026-10-10', value: 12 }]);
  });
});

describe('content formats', () => {
  const ig = (native: Record<string, number>) => toConcepts('instagram', native);

  it('rates each format, against the overall rate, and marks the best', () => {
    const rows = formatSection([
      { format: 'video', values: ig({ likes: 60, reach: 1000 }) },
      { format: 'image', values: ig({ likes: 20, reach: 1000 }) },
      { format: 'image', values: ig({ likes: 10, comments: 10, reach: 1000 }) },
    ]);
    // Overall: 100 ÷ 3000 = 3.33%. Video 6%, image 40 ÷ 2000 = 2%.
    expect(rows.map((r) => [r.format, r.posts, r.engagementRate.rate, r.best])).toEqual([
      ['video', 1, 6, true],
      ['image', 2, 2, false],
    ]);
    expect(rows[0]!.vsAveragePct).toBeCloseTo(80, 6);
    expect(rows[1]!.vsAveragePct).toBeCloseTo(-40, 6);
  });

  it('marks no best with a single format, or when only one has a rate', () => {
    expect(
      formatSection([{ format: 'image', values: ig({ likes: 5, reach: 100 }) }])[0]!.best,
    ).toBe(false);
    const rows = formatSection([
      { format: 'image', values: ig({ likes: 5, reach: 100 }) },
      { format: 'text', values: EMPTY_CONCEPTS },
    ]);
    expect(rows.map((r) => r.best)).toEqual([false, false]);
    expect(rows[1]).toMatchObject({ format: 'text', posts: 1, vsAveragePct: null });
    expect(rows[1]!.engagementRate.rate).toBeNull();
  });
});

describe('posting frequency', () => {
  // 30 days ending Sun 11 Oct 12:00 UTC: the full weeks are 14, 21 and 28 Sep (the week of 7 Sep
  // starts before the period, the week of 5 Oct ends after it).
  const ig = (publishAt: string, likes: number) => ({
    provider: 'instagram',
    publishAt: at(publishAt),
    values: toConcepts('instagram', { likes, reach: 100 }),
  });

  it('groups full weeks by posts per week and rates each band', () => {
    const out = frequencySection(
      [
        ig('2026-09-15T10:00:00Z', 10), // week of 14 Sep: 1 post → 1–2 band
        ig('2026-09-22T10:00:00Z', 4), // week of 21 Sep: 3 posts → 3–5 band
        ig('2026-09-23T10:00:00Z', 4),
        ig('2026-09-24T10:00:00Z', 4),
        ig('2026-09-29T10:00:00Z', 6), // week of 28 Sep: 2 posts → 1–2 band
        ig('2026-09-30T10:00:00Z', 8),
        ig('2026-10-06T10:00:00Z', 99), // partial week: left out
        ig('2026-09-12T10:00:00Z', 99), // partial week: left out
      ],
      period30,
      'UTC',
    );
    expect(out.fullWeeks).toBe(3);
    expect(out.platforms).toEqual([
      {
        provider: 'instagram',
        bands: [
          { min: 1, max: 2, weeks: 2, posts: 3, engagementRate: 8 }, // 24 ÷ 300
          { min: 3, max: 5, weeks: 1, posts: 3, engagementRate: 4 }, // 12 ÷ 300
        ],
        best: 0,
      },
    ]);
  });

  it('names no best cadence from a single band', () => {
    const out = frequencySection([ig('2026-09-15T10:00:00Z', 10)], period30, 'UTC');
    expect(out.platforms[0]!.best).toBeNull();
  });

  it('has no full week in a 7-day period that starts mid-week', () => {
    const out = frequencySection(
      [ig('2026-10-08T10:00:00Z', 10)],
      resolvePeriod({ days: 7 }, NOW),
      'UTC',
    );
    expect(out).toEqual({ fullWeeks: 0, platforms: [] });
  });
});

describe('engagement accumulation', () => {
  const snap = (postId: string, publishAt: Date, hours: number, likes: number): RawSnapshot => ({
    postId,
    metric: 'likes',
    value: likes,
    capturedAt: new Date(publishAt.getTime() + hours * HOUR),
  });
  const published = ago(10 * DAY);
  const tracked = (id: number, curve: Array<[number, number]>) => {
    const p = { id: uuid(id), provider: 'instagram', publishAt: published };
    return { post: p, rows: curve.map(([h, likes]) => snap(p.id, published, h, likes)) };
  };

  it('reads a post’s engagement at each capture, carrying each metric forward', () => {
    const history = engagementHistory('instagram', published, [
      { metric: 'likes', value: 10, capturedAt: new Date(published.getTime() + HOUR) },
      { metric: 'comments', value: 2, capturedAt: new Date(published.getTime() + HOUR) },
      // A sweep that returned likes only: comments stay at their last captured value.
      { metric: 'likes', value: 30, capturedAt: new Date(published.getTime() + 5 * HOUR) },
      // Not an engagement metric on Instagram: ignored.
      { metric: 'views', value: 900, capturedAt: new Date(published.getTime() + 6 * HOUR) },
    ]);
    expect(history).toEqual([
      { ageHours: 1, engagements: 12 },
      { ageHours: 5, engagements: 32 },
      { ageHours: 6, engagements: 32 },
    ]);
  });

  it('averages, per age, the share of the final count the last snapshot by then showed', () => {
    const a = tracked(1, [
      [1, 10],
      [5, 40],
      [11, 60],
      [23, 80],
      [47, 90],
      [200, 100],
    ]);
    const b = tracked(2, [
      [2, 20],
      [10, 50],
      [30, 150],
      [100, 200],
    ]);
    const c = tracked(3, [
      [8, 30], // first snapshot after the 6h mark: its 6h share is unknown, not 0
      [20, 60],
      [60, 60],
    ]);
    const out = accumulationSection([a.post, b.post, c.post], [...a.rows, ...b.rows, ...c.rows]);
    expect(out.postsConsidered).toBe(3);
    expect(out.postsUsed).toBe(3);
    expect(out.rules).toEqual(ACCUMULATION_RULES);
    const point = (h: number) => out.points.find((p) => p.untilHours === h)!;
    // 6h: a 40/100, b 20/200 — c has no snapshot by then.
    expect(point(6)).toEqual({ untilHours: 6, pct: 25, posts: 2 });
    // 12h: a 60%, b 25%, c 50%.
    expect(point(12).pct).toBeCloseTo(45, 6);
    expect(point(12).posts).toBe(3);
    // 24h: a 80%, b 25%, c 100%.
    expect(point(24).pct).toBeCloseTo((80 + 25 + 100) / 3, 6);
    // 48h: a 90%, b 75%, c 100%.
    expect(point(48).pct).toBeCloseTo((90 + 75 + 100) / 3, 6);
    // 7d: only a is that old, and its last snapshot by then (47h) showed 90 of its 100.
    expect(point(168)).toEqual({ untilHours: 168, pct: 90, posts: 1 });
    // 30d: nobody is that old.
    expect(point(720)).toEqual({ untilHours: 720, pct: null, posts: 0 });
    expect(out.halfByHours).toBe(24);
    expect(out.eightyByHours).toBe(48);
  });

  it('caps a share at 100% when engagement later fell', () => {
    const posts = [1, 2, 3].map((n) =>
      tracked(n, [
        [1, 50],
        [10, 120], // more than the final count: later unliked
        [60, 100],
      ]),
    );
    const out = accumulationSection(
      posts.map((p) => p.post),
      posts.flatMap((p) => p.rows),
    );
    expect(out.points.find((p) => p.untilHours === 12)!.pct).toBe(100);
  });

  it('leaves out posts without enough history and says how many it used', () => {
    const good = tracked(1, [
      [1, 10],
      [20, 30],
      [60, 40],
    ]);
    // An imported post: its history starts ten days after it went out.
    const imported = tracked(2, [
      [240, 90],
      [241, 90],
      [242, 91],
    ]);
    const twoSnapshots = tracked(3, [
      [1, 5],
      [60, 9],
    ]);
    const tooYoung = tracked(4, [
      [1, 5],
      [2, 6],
      [3, 7],
    ]);
    const noEngagement = tracked(5, [
      [1, 0],
      [20, 0],
      [60, 0],
    ]);
    const all = [good, imported, twoSnapshots, tooYoung, noEngagement];
    const out = accumulationSection(
      all.map((p) => p.post),
      all.flatMap((p) => p.rows),
    );
    // The post nobody engaged with has no curve to speak of and is not "considered".
    expect(out).toMatchObject({ postsConsidered: 4, postsUsed: 1 });
    // One post is below the minimum: no curve is drawn from it.
    expect(out.points).toEqual([]);
    expect(out.halfByHours).toBeNull();
  });

  it('has nothing to say with no snapshots at all', () => {
    expect(
      accumulationSection([{ id: uuid(1), provider: 'instagram', publishAt: published }], []),
    ).toMatchObject({
      postsConsidered: 0,
      postsUsed: 0,
      points: [],
    });
  });

  it('reads history for the period’s posts only, newest first', () => {
    const inside = post({ publishAt: ago(2 * DAY) });
    const older = post({ publishAt: ago(20 * DAY) });
    const prior = post({ publishAt: ago(40 * DAY) });
    expect(accumulationCandidates([older, prior, inside], period30).map((p) => p.id)).toEqual([
      inside.id,
      older.id,
    ]);
  });
});

describe('raw metrics', () => {
  it('lists every native name per platform with the concept it feeds, unknown ones included', () => {
    expect(
      rawMetricRows([
        { provider: 'instagram', native: { likes: 4, total_interactions: 9 } },
        { provider: 'instagram', native: { likes: 6, something_new: 2 } },
        { provider: 'facebook', native: { post_video_views: 12 } },
      ]),
    ).toEqual([
      { provider: 'facebook', metric: 'post_video_views', concept: null, posts: 1, total: 12 },
      { provider: 'instagram', metric: 'likes', concept: 'likes', posts: 2, total: 10 },
      { provider: 'instagram', metric: 'something_new', concept: null, posts: 1, total: 2 },
      { provider: 'instagram', metric: 'total_interactions', concept: null, posts: 1, total: 9 },
    ]);
  });
});

describe('buildAnalyticsReport', () => {
  const igPost = (daysAgo: number, native: Record<string, number>, patch: Partial<RawPost> = {}) =>
    post({ publishAt: ago(daysAgo * DAY), native, ...patch });
  const fbPost = (daysAgo: number, native: Record<string, number>) =>
    post({ publishAt: ago(daysAgo * DAY), native, provider: 'facebook', connectionId: FB });

  it('compares the period with the one before it', () => {
    const report = buildAnalyticsReport(
      input({
        posts: [
          igPost(1, { likes: 30, comments: 10, reach: 1000, views: 1500 }),
          igPost(5, { likes: 20, reach: 1000, views: 500 }),
          fbPost(6, { post_reactions_like_total: 5, post_media_view: 250, post_clicks: 3 }),
          // The period before.
          igPost(35, { likes: 10, reach: 500, views: 1000 }),
          igPost(45, { likes: 10, reach: 500, views: 250 }),
          // Older than both: counted nowhere.
          igPost(70, { likes: 999, reach: 1 }),
        ],
      }),
    );
    const s = report.summary;
    expect(s.posts).toEqual({ value: 3, prior: 2, deltaPct: 50 });
    expect(s.totals.likes).toEqual({ value: 55, prior: 20, deltaPct: 175 });
    expect(s.totals.views).toEqual({ value: 2250, prior: 1250, deltaPct: 80 });
    expect(s.totals.reach).toEqual({ value: 2000, prior: 1000, deltaPct: 100 });
    expect(s.totals.comments).toEqual({ value: 10, prior: null, deltaPct: null });
    expect(s.totals.clicks).toEqual({ value: 3, prior: null, deltaPct: null });
    // Nothing reports shares or saves in either period: null, not 0.
    expect(s.totals.shares).toEqual({ value: null, prior: null, deltaPct: null });
    // (40 + 20 + 5) ÷ (1000 + 1000 + 250): two posts by reach, the Facebook one by views.
    expect(s.engagementRate.rate).toBeCloseTo((65 / 2250) * 100, 9);
    expect(s.engagementRate).toMatchObject({ basis: 'mixed', byReach: 2, byViews: 1 });
    expect(s.engagementRatePrior).toBe(2);
    expect(s.engagementRateDeltaPct).toBeCloseTo((((65 / 2250) * 100 - 2) / 2) * 100, 9);
  });

  it('shows no change — not +∞% — when the prior period is empty', () => {
    const report = buildAnalyticsReport(input({ posts: [igPost(1, { likes: 30, reach: 100 })] }));
    expect(report.summary.posts).toEqual({ value: 1, prior: 0, deltaPct: null });
    expect(report.summary.totals.likes).toEqual({ value: 30, prior: null, deltaPct: null });
    expect(report.summary.engagementRateDeltaPct).toBeNull();
  });

  it('breaks the period down per platform, gaps as null', () => {
    const report = buildAnalyticsReport(
      input({
        posts: [
          igPost(1, { likes: 30, comments: 10, saved: 2, reach: 1000, views: 1500 }),
          fbPost(6, { post_reactions_like_total: 5, post_media_view: 250, post_clicks: 3 }),
        ],
        accounts: [account(IG, 'instagram'), account(FB, 'facebook'), account(uuid(3), 'gmb')],
      }),
    );
    const of = (provider: string) => report.byPlatform.find((p) => p.provider === provider)!;
    expect(of('instagram')).toMatchObject({
      posts: 1,
      totals: { likes: 30, comments: 10, saves: 2, shares: null, clicks: null, views: 1500 },
    });
    expect(of('instagram').engagementRate).toMatchObject({ rate: 4.2, basis: 'reach' });
    expect(of('facebook')).toMatchObject({
      posts: 1,
      totals: { likes: 5, comments: null, saves: null, clicks: 3, views: 250, reach: null },
    });
    expect(of('facebook').engagementRate).toMatchObject({ rate: 2, basis: 'views' });
    // A connected platform with no posts in the period is still a row.
    expect(of('gmb')).toMatchObject({ posts: 0, totals: { views: null } });
    expect(of('gmb').engagementRate.rate).toBeNull();
    expect(report.mapping.find((m) => m.provider === 'gmb')!.concepts.views).toEqual([
      'LOCAL_POST_VIEWS_SEARCH',
    ]);
    expect(report.mapping.find((m) => m.provider === 'gmb')!.followers).toEqual([]);
  });

  it('groups posts by the week they were published in, in the viewer’s zone', () => {
    // Sunday 4 Oct 20:00 UTC = Monday 5 Oct 01:30 IST.
    const boundary = post({
      publishAt: at('2026-10-04T20:00:00Z'),
      native: { likes: 7, reach: 70 },
    });
    const utc = buildAnalyticsReport(input({ posts: [boundary] }));
    const ist = buildAnalyticsReport(input({ posts: [boundary], timezone: 'Asia/Kolkata' }));
    const weekOf = (r: typeof utc) => r.overTime.find((b) => b.posts === 1)!;
    expect(weekOf(utc).key).toBe('2026-09-28');
    expect(weekOf(ist).key).toBe('2026-10-05');
    expect(weekOf(utc)).toMatchObject({ totals: { likes: 7 }, engagementRate: 10 });
    expect(weekOf(utc).byPlatform).toEqual([
      {
        provider: 'instagram',
        posts: 1,
        totals: { ...EMPTY_CONCEPTS, likes: 7, reach: 70 },
        engagementRate: 10,
      },
    ]);
    // Empty weeks are listed with nulls, not zeros.
    expect(utc.bucket).toBe('week');
    expect(utc.overTime).toHaveLength(5);
    expect(utc.overTime[0]).toMatchObject({
      posts: 0,
      totals: EMPTY_CONCEPTS,
      engagementRate: null,
    });
  });

  it('ranks posts by engagements and names the best one', () => {
    const quiet = igPost(2, { views: 5000 });
    const mid = igPost(3, { likes: 10, comments: 1, reach: 100 });
    const loud = igPost(
      4,
      { likes: 40, saved: 5, reach: 9000 },
      { thumbnailUrl: 'https://x/y.jpg' },
    );
    const report = buildAnalyticsReport(input({ posts: [quiet, mid, loud], sort: 'engagements' }));
    expect(report.topPosts.map((p) => p.id)).toEqual([loud.id, mid.id, quiet.id]);
    expect(report.topPosts[0]).toMatchObject({
      engagements: 45,
      engagementRate: 0.5,
      basis: 'reach',
      thumbnailUrl: 'https://x/y.jpg',
    });
    // No engagement metric at all: null, and no rate.
    expect(report.topPosts[2]).toMatchObject({
      engagements: null,
      engagementRate: null,
      basis: null,
    });
    expect(report.summary.bestPost).toMatchObject({ by: 'engagements', value: 45 });
    expect(report.summary.bestPost!.post.id).toBe(loud.id);
    expect(report.postsOmitted).toBe(0);
  });

  it('falls back to views for the best post and the best times when nothing reports engagement', () => {
    const report = buildAnalyticsReport(
      input({
        posts: [
          post({
            publishAt: ago(2 * DAY),
            provider: 'gmb',
            native: { LOCAL_POST_VIEWS_SEARCH: 40 },
          }),
          post({
            publishAt: ago(3 * DAY),
            provider: 'gmb',
            native: { LOCAL_POST_VIEWS_SEARCH: 90 },
          }),
        ],
      }),
    );
    expect(report.summary.bestPost).toMatchObject({ by: 'views', value: 90 });
    expect(report.bestTimes.by).toBe('views');
    expect(report.summary.engagementRate.rate).toBeNull();
  });

  it('is an honest blank for a workspace with nothing', () => {
    const report = buildAnalyticsReport(input({ accounts: [], undatedPosts: 4 }));
    expect(report.summary).toMatchObject({
      posts: { value: 0, prior: 0, deltaPct: null },
      bestPost: null,
      undatedPosts: 4,
      lastCapturedAt: null,
    });
    expect(report.summary.totals.views).toEqual({ value: null, prior: null, deltaPct: null });
    expect(report.summary.followers).toMatchObject({ value: null, accounts: 0 });
    expect(report.byPlatform).toEqual([]);
    expect(report.bestTimes).toEqual({ by: null, cells: [], top: [], postsCounted: 0 });
    expect(report.formats).toEqual([]);
    expect(report.topPosts).toEqual([]);
    expect(report.rawMetrics).toEqual([]);
    expect(report.accumulation.points).toEqual([]);
    expect(report.overTime.every((b) => b.posts === 0)).toBe(true);
  });

  it('reports the newest capture of anything it read', () => {
    const report = buildAnalyticsReport(
      input({
        posts: [igPost(1, { likes: 1 }, { capturedAt: ago(5 * HOUR) })],
        followerPoints: [{ connectionId: IG, value: 10, capturedAt: ago(2 * HOUR) }],
      }),
    );
    expect(report.summary.lastCapturedAt).toEqual(ago(2 * HOUR));
  });
});

describe('analytics v3 display facts', () => {
  it('keeps missing intensity distinct from observed zero and caps the ramp', () => {
    expect(publicationIntensity(null, 100)).toBeNull();
    expect(publicationIntensity(0, 100)).toBe(0);
    expect(publicationIntensity(0, 0)).toBe(0);
    expect(publicationIntensity(25, 100)).toBe(1);
    expect(publicationIntensity(75, 100)).toBe(3);
    expect(publicationIntensity(100, 100)).toBe(4);
    expect(publicationIntensity(200, 100)).toBe(4);
  });
  it('clips partial publication buckets to the actual window', () => {
    const buckets = timeBuckets(period30, 'UTC', 'week');
    expect(publicationWindow(buckets[0]!, period30)).toEqual({
      from: period30.start,
      to: buckets[0]!.end,
      partial: true,
    });
    expect(publicationWindow(buckets[1]!, period30).partial).toBe(false);
    expect(publicationWindow(buckets.at(-1)!, period30)).toEqual({
      from: buckets.at(-1)!.start,
      to: period30.end,
      partial: true,
    });
  });

  it('expands calendar days through DST without inventing captures or losing zero', () => {
    const period = resolvePeriod(
      { from: at('2026-10-31T04:00:00Z'), to: at('2026-11-03T04:59:00Z') },
      NOW,
    );
    expect(
      followerCalendar(
        [
          { day: '2026-10-31', value: 0 },
          { day: '2026-11-02', value: 12 },
        ],
        period,
        'America/New_York',
      ),
    ).toEqual([
      { day: '2026-10-31', value: 0 },
      { day: '2026-11-01', value: null },
      { day: '2026-11-02', value: 12 },
    ]);
    expect(followerCalendar([], period, 'America/New_York').every((p) => p.value === null)).toBe(
      true,
    );
  });

  it('requires one account and ten contributors at each age, retaining observed zero', () => {
    const points = [
      { untilHours: 6, pct: 50, posts: 9 },
      { untilHours: 12, pct: 0, posts: 10 },
      { untilHours: 24, pct: null, posts: 12 },
      { untilHours: 48, pct: 80, posts: 11 },
    ];
    expect(engagementAgeDisplayPoints(points, 1)).toEqual([points[1], points[3]]);
    expect(engagementAgeDisplayPoints(points, 0)).toEqual([]);
    expect(engagementAgeDisplayPoints(points, 2)).toEqual([]);
    expect(engagementAgeDisplayPoints([], 1)).toEqual([]);
  });

  it('exposes optional display facts via the report without synthesising findings', () => {
    const report = buildAnalyticsReport(
      input({ followerPoints: [{ connectionId: IG, value: 0, capturedAt: ago(DAY) }] }),
    );
    expect(report.overTime[0]!.window?.partial).toBe(true);
    expect(report.followerSeries[0]!.dailyPoints?.some((p) => p.value === 0)).toBe(true);
    expect(report.followerSeries[0]!.dailyPoints?.some((p) => p.value === null)).toBe(true);
    expect(report.accumulation.displayPoints).toEqual([]);
    expect(report.summary.totals.views.value).toBeNull();
  });
});

describe('revision 2 optional report facts', () => {
  it('always provides honest Monday weeks even for a short daily report', () => {
    const report = buildAnalyticsReport(
      input({
        period: resolvePeriod({ days: 7 }, NOW),
        posts: [post({ publishAt: at('2026-10-10T12:00:00Z'), native: { likes: 10, reach: 100 } })],
      }),
    );
    expect(report.bucket).toBe('day');
    expect(report.weeklySeries!.length).toBeLessThan(report.overTime.length);
    expect(report.weeklySeries!.reduce((n, b) => n + b.posts, 0)).toBe(report.summary.posts.value);
    expect(
      report.weeklySeries!.flatMap((b) => b.byPlatform).find((p) => p.provider === 'instagram'),
    ).toMatchObject({ engagementRate: 10 });
    for (const b of report.weeklySeries!.filter((b) => b.posts === 0))
      expect(b.totals).toEqual(EMPTY_CONCEPTS);
  });
  it('returns account change only with a prior-period capture', () => {
    const period = resolvePeriod({ days: 30 }, NOW);
    const report = buildAnalyticsReport(
      input({
        period,
        accounts: [account(IG, 'instagram')],
        followerPoints: [
          { connectionId: IG, value: 100, capturedAt: new Date(period.start.getTime() - 1000) },
          { connectionId: IG, value: 120, capturedAt: NOW },
        ],
      }),
    );
    expect(report.followerSeries[0]!.change).toBe(20);
    const missing = buildAnalyticsReport(
      input({
        period,
        accounts: [account(IG, 'instagram')],
        followerPoints: [{ connectionId: IG, value: 120, capturedAt: NOW }],
      }),
    );
    expect(missing.followerSeries[0]!.change).toBeNull();
  });
});

describe('report publication sorting', () => {
  const igPost = (daysAgo: number, native: Record<string, number>) =>
    post({ publishAt: ago(daysAgo * DAY), native });
  it('defaults to newest first and returns every post before display paging', () => {
    const old = igPost(5, {}),
      recent = igPost(1, {});
    const report = buildAnalyticsReport(input({ posts: [old, recent] }));
    expect(report.topPosts.map((p) => p.id)).toEqual([recent.id, old.id]);
    expect(report.postsOmitted).toBe(0);
  });
  it.each([
    'views',
    'reach',
    'likes',
    'comments',
    'shares',
    'saves',
    'clicks',
    'follows',
    'engagements',
    'engagementRate',
  ] as const)('puts missing %s last and breaks ties by publication', (key) => {
    const rows = buildAnalyticsReport(
      input({ posts: [igPost(4, {}), igPost(2, {}), igPost(1, {})] }),
    ).topPosts;
    const [recent, mid, old] = rows;
    const measured = (p: typeof recent, value: number | null) => ({
      ...p!,
      metrics: { ...p!.metrics, [key]: value },
      [key]: value,
    });
    const a = measured(recent, 5),
      b = measured(mid, 5),
      c = measured(old, null);
    for (const dir of ['asc', 'desc'] as const)
      expect(sortReportPosts([c, b, a], key, dir).map((p) => p.id)).toEqual([a.id, b.id, c.id]);
  });
});
