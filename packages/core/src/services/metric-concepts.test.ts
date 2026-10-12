import { describe, expect, it } from 'vitest';
import { METRIC_CONCEPTS, type ConceptValues } from '@meegrow-social/contracts';
import {
  EMPTY_CONCEPTS,
  allEngagementMetricNames,
  allFollowerMetricNames,
  conceptOf,
  conceptSources,
  deltaPct,
  engagementDenominator,
  engagementRate,
  engagementsOf,
  followerSources,
  postEngagementRate,
  sumConcepts,
  toConcepts,
  unmappedMetrics,
} from './metric-concepts.js';

const values = (patch: Partial<ConceptValues>): ConceptValues => ({ ...EMPTY_CONCEPTS, ...patch });

/**
 * The whole mapping, spelled out: every platform × every concept. A change to the mapping has to
 * change this table too, so a rename or a new gap is a visible decision. The native names are the
 * ones the providers request (`POST_METRICS` / `MEDIA_METRICS` / `VIDEO_REPORT_METRICS`).
 */
const EXPECTED: Record<string, Record<(typeof METRIC_CONCEPTS)[number], string[]>> = {
  bluesky: {
    views: [],
    reach: [],
    likes: ['likeCount'],
    comments: ['replyCount'],
    shares: ['repostCount'],
    saves: ['bookmarkCount'],
    clicks: [],
    follows: [],
  },
  facebook: {
    views: ['post_media_view'],
    reach: ['post_total_media_view_unique'],
    likes: ['post_reactions_like_total'],
    comments: [],
    shares: [],
    saves: [],
    clicks: ['post_clicks'],
    follows: [],
  },
  instagram: {
    views: ['views'],
    reach: ['reach'],
    likes: ['likes'],
    comments: ['comments'],
    shares: [],
    saves: ['saved'],
    clicks: [],
    follows: [],
  },
  youtube: {
    views: ['viewCount', 'views'],
    reach: [],
    likes: ['likeCount', 'likes'],
    comments: ['commentCount', 'comments'],
    shares: ['shares'],
    saves: [],
    clicks: [],
    follows: ['subscribersGained'],
  },
  gmb: {
    views: ['LOCAL_POST_VIEWS_SEARCH'],
    reach: [],
    likes: [],
    comments: [],
    shares: [],
    saves: [],
    clicks: ['LOCAL_POST_ACTIONS_CALL_TO_ACTION'],
    follows: [],
  },
};
const UNMAPPED_PLATFORMS = [
  'linkedin',
  'linkedin-page',
  'x',
  'wordpress',
  'fake',
  'not-a-platform',
];

describe('the concept mapping', () => {
  for (const [provider, concepts] of Object.entries(EXPECTED)) {
    for (const concept of METRIC_CONCEPTS) {
      it(`${provider} · ${concept} → ${concepts[concept].join(' | ') || '(gap)'}`, () => {
        expect([...conceptSources(provider)[concept]]).toEqual(concepts[concept]);
      });
    }
  }

  it.each(UNMAPPED_PLATFORMS)('%s has no mapping: every concept is a gap', (provider) => {
    for (const concept of METRIC_CONCEPTS) expect(conceptSources(provider)[concept]).toEqual([]);
    expect(toConcepts(provider, { views: 10, likes: 2 })).toEqual(EMPTY_CONCEPTS);
  });

  it('never feeds two concepts of one platform from the same native name', () => {
    for (const provider of Object.keys(EXPECTED)) {
      const names = METRIC_CONCEPTS.flatMap((c) => [...conceptSources(provider)[c]]);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('followers: the literal name on the three platforms that have it, none on the rest', () => {
    expect(followerSources('facebook')).toEqual(['followers']);
    expect(followerSources('instagram')).toEqual(['followers']);
    expect(followerSources('youtube')).toEqual(['followers']);
    expect(followerSources('bluesky')).toEqual(['followers']);
    expect(followerSources('gmb')).toEqual([]);
    expect(followerSources('wordpress')).toEqual([]);
    expect(allFollowerMetricNames()).toEqual(['followers']);
  });

  it('names every native metric an engagement can come from', () => {
    expect(allEngagementMetricNames().sort()).toEqual(
      [
        'bookmarkCount',
        'replyCount',
        'repostCount',
        'commentCount',
        'comments',
        'likeCount',
        'likes',
        'post_reactions_like_total',
        'saved',
        'shares',
      ].sort(),
    );
  });
});

describe('toConcepts', () => {
  it('reads an Instagram post, leaving what Instagram does not report as null', () => {
    expect(
      toConcepts('instagram', {
        views: 900,
        reach: 700,
        likes: 40,
        comments: 5,
        saved: 3,
        total_interactions: 50,
      }),
    ).toEqual(values({ views: 900, reach: 700, likes: 40, comments: 5, saves: 3 }));
  });

  it('reads a Facebook post: no comments, shares or saves — null, not 0', () => {
    const read = toConcepts('facebook', {
      post_media_view: 310,
      post_total_media_view_unique: 204,
      post_reactions_like_total: 17,
      post_clicks: 9,
      post_video_views: 12,
    });
    expect(read).toEqual(values({ views: 310, reach: 204, likes: 17, clicks: 9 }));
    expect(read.comments).toBeNull();
  });

  it('keeps a reported zero as zero', () => {
    expect(toConcepts('instagram', { likes: 0 }).likes).toBe(0);
  });

  it('does not read one platform’s name on another', () => {
    // `views` is Instagram's name; on Facebook it means nothing.
    expect(toConcepts('facebook', { views: 50 }).views).toBeNull();
  });

  it('YouTube: the current counter wins over the lagging Analytics total, which still serves alone', () => {
    expect(toConcepts('youtube', { viewCount: 1523, views: 1490 }).views).toBe(1523);
    expect(toConcepts('youtube', { views: 1490 }).views).toBe(1490);
    expect(toConcepts('youtube', { subscribersGained: 4, shares: 9 })).toEqual(
      values({ follows: 4, shares: 9 }),
    );
  });
});

describe('YouTube provider metrics', () => {
  it('maps documentation-built counters and Analytics totals, leaving reach unavailable', () => {
    // Documentation-built fixture: youtube.ts emits these native metric names; no live channel data.
    const concepts = toConcepts('youtube', {
      viewCount: 1000,
      views: 950,
      likeCount: 20,
      likes: 18,
      commentCount: 5,
      comments: 4,
      shares: 5,
      subscribersGained: 2,
    });
    expect(concepts).toEqual(
      values({ views: 1000, likes: 20, comments: 5, shares: 5, follows: 2 }),
    );
    expect(postEngagementRate(concepts)).toEqual({ rate: 3, basis: 'views' });
    expect(engagementRate([concepts]).basis).toBe('views');
    expect(unmappedMetrics('youtube', { followers: 100 })).toEqual({ followers: 100 });
    expect(followerSources('youtube')).toEqual(['followers']);
  });
});

describe('unknown and unmapped metrics', () => {
  it('are preserved, not dropped', () => {
    expect(
      unmappedMetrics('instagram', { likes: 4, total_interactions: 9, brand_new_metric: 7 }),
    ).toEqual({ total_interactions: 9, brand_new_metric: 7 });
    expect(unmappedMetrics('facebook', { post_video_views: 12, post_clicks: 1 })).toEqual({
      post_video_views: 12,
    });
  });

  it('on a platform with no mapping, everything is unmapped', () => {
    expect(unmappedMetrics('x', { impressions: 5 })).toEqual({ impressions: 5 });
  });

  it('conceptOf names the concept a native metric feeds, per platform', () => {
    expect(conceptOf('instagram', 'saved')).toBe('saves');
    expect(conceptOf('instagram', 'total_interactions')).toBeNull();
    expect(conceptOf('facebook', 'saved')).toBeNull();
    expect(conceptOf('youtube', 'views')).toBe('views');
  });
});

describe('engagement rate', () => {
  it('a post: (likes + comments + shares + saves) ÷ reach', () => {
    const post = values({ likes: 40, comments: 5, shares: 2, saves: 3, reach: 1000, views: 4000 });
    expect(engagementsOf(post)).toBe(50);
    expect(postEngagementRate(post)).toEqual({ rate: 5, basis: 'reach' });
  });

  it('falls back to views where reach is absent', () => {
    const post = values({ likes: 30, views: 600 });
    expect(engagementDenominator(post)).toEqual({ basis: 'views', value: 600 });
    expect(postEngagementRate(post)).toEqual({ rate: 5, basis: 'views' });
  });

  it('falls back to views where reach is reported as zero', () => {
    expect(postEngagementRate(values({ likes: 3, reach: 0, views: 100 }))).toEqual({
      rate: 3,
      basis: 'views',
    });
  });

  it('has no rate without a denominator — absent or zero — rather than infinity or 0', () => {
    expect(postEngagementRate(values({ likes: 3 }))).toEqual({ rate: null, basis: null });
    expect(postEngagementRate(values({ likes: 3, reach: 0, views: 0 }))).toEqual({
      rate: null,
      basis: null,
    });
  });

  it('has no rate when no engagement concept is reported, even with reach', () => {
    const post = values({ reach: 500, clicks: 9 });
    expect(engagementsOf(post)).toBeNull();
    expect(postEngagementRate(post).rate).toBeNull();
  });

  it('is 0 — a real number — for a post seen by people who did nothing', () => {
    expect(postEngagementRate(values({ likes: 0, comments: 0, reach: 200 })).rate).toBe(0);
  });

  it('a set: ratio of sums, not a mean of rates', () => {
    const stat = engagementRate([
      values({ likes: 10, reach: 100 }), // 10%
      values({ likes: 10, reach: 900 }), // 1.1%
    ]);
    expect(stat.rate).toBe(2); // 20 ÷ 1000, not (10 + 1.1) ÷ 2
    expect(stat).toMatchObject({ basis: 'reach', posts: 2, postsCounted: 2, engagements: 20 });
  });

  it('flags mixed denominators instead of hiding them', () => {
    const stat = engagementRate([
      values({ likes: 10, comments: 2, reach: 100 }),
      values({ likes: 6, views: 300 }),
    ]);
    expect(stat).toMatchObject({ basis: 'mixed', byReach: 1, byViews: 1, postsCounted: 2 });
    expect(stat.rate).toBe((18 / 400) * 100);
    expect(stat.components).toEqual(['likes', 'comments']);
  });

  it('leaves a post without a denominator out of both sums, and says how many it counted', () => {
    const stat = engagementRate([
      values({ likes: 10, reach: 200 }),
      values({ likes: 500 }), // no reach, no views
      values({ reach: 1000 }), // no engagement reported
    ]);
    expect(stat.rate).toBe(5);
    expect(stat).toMatchObject({ posts: 3, postsCounted: 1, basis: 'reach' });
    // The uncounted post's likes are still engagements, just not part of the rate.
    expect(stat.engagements).toBe(510);
  });

  it('is null for an empty set and for a set with nothing to divide', () => {
    expect(engagementRate([])).toMatchObject({ rate: null, basis: null, engagements: null });
    expect(engagementRate([values({ clicks: 4 })])).toMatchObject({ rate: null, postsCounted: 0 });
  });
});

describe('sumConcepts', () => {
  it('adds what is reported and leaves the rest null', () => {
    expect(
      sumConcepts([values({ likes: 3, views: 10 }), values({ likes: 4 }), values({ clicks: 0 })]),
    ).toEqual(values({ likes: 7, views: 10, clicks: 0 }));
    expect(sumConcepts([])).toEqual(EMPTY_CONCEPTS);
  });
});

describe('deltaPct', () => {
  it('is the percentage change against the prior period', () => {
    expect(deltaPct(150, 100)).toBe(50);
    expect(deltaPct(50, 100)).toBe(-50);
    expect(deltaPct(100, 100)).toBe(0);
    expect(deltaPct(0, 80)).toBe(-100);
  });

  it('is null — never +∞% — when the prior period has nothing', () => {
    expect(deltaPct(40, 0)).toBeNull();
    expect(deltaPct(40, null)).toBeNull();
    expect(deltaPct(null, 40)).toBeNull();
    expect(deltaPct(0, 0)).toBeNull();
  });
});

it('reads Bluesky native counts and preserves missing concepts', () => {
  expect(
    toConcepts('bluesky', { likeCount: 0, replyCount: 2, repostCount: 3, bookmarkCount: 4 }),
  ).toEqual({ ...EMPTY_CONCEPTS, likes: 0, comments: 2, shares: 3, saves: 4 });
  expect(toConcepts('bluesky', { likeCount: 1 })).toEqual({ ...EMPTY_CONCEPTS, likes: 1 });
});
