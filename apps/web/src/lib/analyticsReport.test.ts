import { describe, expect, it } from 'vitest';
import {
  METRIC_CONCEPTS,
  type AnalyticsReportView,
  type ConceptValues,
  type EngagementRateStat,
  type ReportPost,
} from '@meegrow-social/contracts';
import {
  CONCEPTS,
  CONCEPT_LABEL,
  DASH,
  ageLabel,
  bandLabel,
  basisText,
  bucketLabel,
  conceptsInView,
  csvCell,
  dayInput,
  formatRate,
  hourLabel,
  parseReportFilters,
  platformsOf,
  postsCsv,
  rateNote,
  reportFiltersToParams,
  reportQuery,
  resolveReportFilters,
  signedPercent,
  slotLabel,
  sortPosts,
  sortReportRows,
  readReportTableSort,
  type ReportFilters,
} from './analyticsReport';

const NONE: ConceptValues = {
  views: null,
  reach: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  clicks: null,
  follows: null,
};
const DEFAULTS: ReportFilters = {
  platform: '',
  connection: '',
  source: '',
  range: '30',
  from: '',
  to: '',
  scope: 'workspace',
};
const parse = (qs: string) => parseReportFilters(new URLSearchParams(qs));
const IG = { id: 'c-ig', provider: 'instagram' };
const FB = { id: 'c-fb', provider: 'facebook' };

describe('concepts', () => {
  it('lists the same concepts as the contract, each with a label', () => {
    expect([...CONCEPTS]).toEqual([...METRIC_CONCEPTS]);
    expect(Object.keys(CONCEPT_LABEL).sort()).toEqual([...METRIC_CONCEPTS].sort());
  });

  it('shows a concept when any platform in view can report it, and names the rest', () => {
    const none = Object.fromEntries(METRIC_CONCEPTS.map((c) => [c, [] as string[]]));
    const mapping = [
      {
        provider: 'instagram',
        followers: [],
        concepts: { ...none, likes: ['likes'], saves: ['saved'] },
      },
      {
        provider: 'facebook',
        followers: [],
        concepts: { ...none, likes: ['x'], clicks: ['post_clicks'] },
      },
    ] as AnalyticsReportView['mapping'];
    expect(conceptsInView(mapping)).toEqual({
      shown: ['likes', 'saves', 'clicks'],
      absent: ['views', 'reach', 'comments', 'shares', 'follows'],
    });
    expect(conceptsInView([]).shown).toEqual([]);
  });
});

describe('URL filters', () => {
  it('falls back to the defaults for anything missing or unrecognised', () => {
    expect(parse('')).toEqual(DEFAULTS);
    expect(parse('range=14&source=elsewhere&scope=everyone')).toEqual(DEFAULTS);
  });

  it('reads every filter, and the older ?days= spelling of the period', () => {
    expect(parse('platform=instagram&connection=c-ig&source=imported&range=90&scope=all')).toEqual({
      ...DEFAULTS,
      platform: 'instagram',
      connection: 'c-ig',
      source: 'imported',
      range: '90',
      scope: 'all',
    });
    expect(parse('days=7').range).toBe('7');
  });

  it('takes a custom range only with two real days in order', () => {
    expect(parse('range=custom&from=2026-09-01&to=2026-09-20')).toMatchObject({
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-20',
    });
    expect(parse('range=custom&from=2026-09-20&to=2026-09-01')).toEqual(DEFAULTS);
    expect(parse('range=custom&from=yesterday&to=2026-09-01')).toEqual(DEFAULTS);
    expect(parse('range=custom')).toEqual(DEFAULTS);
  });

  it('writes only what differs from the default, and round-trips', () => {
    expect(reportFiltersToParams(DEFAULTS).toString()).toBe('');
    const custom: ReportFilters = {
      platform: 'facebook',
      connection: 'c-fb',
      source: 'app',
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-20',
      scope: 'all',
    };
    expect(parseReportFilters(reportFiltersToParams(custom))).toEqual(custom);
    expect(reportFiltersToParams({ ...DEFAULTS, range: '7' }).toString()).toBe('range=7');
  });

  it('drops a platform or account the view does not have, and an account of another platform', () => {
    const accounts = [IG, FB];
    expect(resolveReportFilters({ ...DEFAULTS, platform: 'gmb' }, accounts).platform).toBe('');
    expect(resolveReportFilters({ ...DEFAULTS, connection: 'gone' }, accounts).connection).toBe('');
    expect(
      resolveReportFilters({ ...DEFAULTS, platform: 'facebook', connection: 'c-ig' }, accounts),
    ).toMatchObject({ platform: 'facebook', connection: '' });
    expect(
      resolveReportFilters({ ...DEFAULTS, platform: 'instagram', connection: 'c-ig' }, accounts),
    ).toMatchObject({ platform: 'instagram', connection: 'c-ig' });
    expect(platformsOf([IG, FB, { id: 'c-ig2', provider: 'instagram' }])).toEqual([
      'instagram',
      'facebook',
    ]);
  });
});

describe('report query', () => {
  const now = new Date(2026, 9, 11, 15, 30);

  it('asks for a number of days, with the viewer’s zone and only the filters that are set', () => {
    expect(reportQuery(DEFAULTS, 'Asia/Kolkata', now)).toEqual({
      timezone: 'Asia/Kolkata',
      days: 30,
      provider: undefined,
      connectionId: undefined,
      source: undefined,
      scope: undefined,
    });
    expect(
      reportQuery(
        {
          ...DEFAULTS,
          platform: 'instagram',
          connection: 'c-ig',
          source: 'app',
          scope: 'all',
          range: '7',
        },
        'UTC',
        now,
      ),
    ).toEqual({
      timezone: 'UTC',
      days: 7,
      provider: 'instagram',
      connectionId: 'c-ig',
      source: 'app',
      scope: 'all',
    });
  });

  it('a custom range runs from the start of its first local day to the end of its last', () => {
    const q = reportQuery(
      { ...DEFAULTS, range: 'custom', from: '2026-09-01', to: '2026-09-20' },
      'UTC',
      now,
    );
    expect(q.days).toBeUndefined();
    expect(q.from).toBe(new Date(2026, 8, 1).toISOString());
    expect(q.to).toBe(new Date(2026, 8, 21).toISOString());
  });

  it('a custom range that ends today stops now, not at midnight to come', () => {
    const q = reportQuery(
      { ...DEFAULTS, range: 'custom', from: '2026-10-01', to: dayInput(now) },
      'UTC',
      now,
    );
    expect(q.to).toBe(now.toISOString());
  });

  it('writes a date as the local day an <input type="date"> holds', () => {
    expect(dayInput(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('formatting', () => {
  it('shows a rate with two decimals under 10 and one above; a dash when there is none', () => {
    expect(formatRate(4.2468)).toBe(
      `${(4.25).toLocaleString(undefined, { minimumFractionDigits: 2 })}%`,
    );
    expect(formatRate(12.34)).toBe(
      `${(12.3).toLocaleString(undefined, { minimumFractionDigits: 1 })}%`,
    );
    expect(formatRate(0)).toBe(`${(0).toLocaleString(undefined, { minimumFractionDigits: 2 })}%`);
    expect(formatRate(null)).toBe(DASH);
  });

  it('shows a change with its sign, and a dash — never +∞% — when there is none', () => {
    expect(signedPercent(12.34)).toBe(`+${(12.3).toLocaleString()}%`);
    expect(signedPercent(-8)).toBe('−8%');
    expect(signedPercent(0.01)).toBe('0%');
    expect(signedPercent(null)).toBe(DASH);
    expect(signedPercent(Infinity)).toBe(DASH);
  });

  it('labels hours, slots, ages and cadence bands', () => {
    expect([0, 9, 12, 13, 23].map(hourLabel)).toEqual(['12am', '9am', '12pm', '1pm', '11pm']);
    expect(slotLabel({ weekday: 4, hour: 9 })).toBe('Fri 9am');
    expect(slotLabel({ weekday: 6, hour: 18 })).toBe('Sun 6pm');
    expect([6, 12, 24, 48, 168, 720].map(ageLabel)).toEqual([
      '6h',
      '12h',
      '24h',
      '2d',
      '7d',
      '30d',
    ]);
    expect(bandLabel({ min: 1, max: 2 })).toBe('1–2/wk');
    expect(bandLabel({ min: 11, max: null })).toBe('11+/wk');
    expect(bandLabel({ min: 3, max: 3 })).toBe('3/wk');
  });

  it('labels a bucket by its own day, whatever the browser’s zone', () => {
    expect(bucketLabel('2026-09-28')).toBe(
      new Date(2026, 8, 28).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
  });
});

describe('engagement rate, in words', () => {
  const stat = (patch: Partial<EngagementRateStat>): EngagementRateStat => ({
    rate: 5,
    engagements: 50,
    basis: 'reach',
    posts: 10,
    postsCounted: 10,
    byReach: 10,
    byViews: 0,
    components: ['likes', 'comments'],
    ...patch,
  });

  it('says what a rate was divided by, and spells out a mix', () => {
    expect(basisText(stat({}))).toBe('÷ reach');
    expect(basisText(stat({ basis: 'views' }))).toBe('÷ views');
    expect(basisText(stat({ basis: 'mixed', byReach: 46, byViews: 2 }))).toBe(
      'mixed: 46 by reach, 2 by views',
    );
    expect(basisText(stat({ basis: null }))).toBeNull();
  });

  it('says how many posts it rests on and what was counted', () => {
    expect(rateNote(stat({}))).toBe('From 10 posts, ÷ reach. Counted: likes + comments.');
    expect(rateNote(stat({ postsCounted: 3, byReach: 3, components: ['likes'] }))).toBe(
      'From 3 of 10 posts, ÷ reach. Counted: likes.',
    );
    expect(rateNote(stat({ rate: null, basis: null, postsCounted: 0 }))).toBe(
      'No post reports both an engagement count and reach or views.',
    );
    expect(rateNote(stat({ rate: null, basis: null, posts: 0, postsCounted: 0 }))).toBe(
      'No posts in this period.',
    );
  });
});

describe('top posts', () => {
  let n = 0;
  const post = (patch: Partial<ReportPost> & { metrics?: Partial<ConceptValues> }): ReportPost => {
    n += 1;
    return {
      id: `p${n}`,
      provider: 'instagram',
      connectionId: 'c-ig',
      caption: `post ${n}`,
      publishAt: new Date(2026, 9, n),
      releaseUrl: null,
      source: 'app',
      format: 'image',
      thumbnailUrl: null,
      engagements: null,
      engagementRate: null,
      basis: null,
      capturedAt: null,
      ...patch,
      metrics: { ...NONE, ...patch.metrics },
    };
  };

  it('sorts by any column, a post with no value last in both directions', () => {
    const a = post({ metrics: { likes: 5 } });
    const b = post({ metrics: { likes: 50 } });
    const c = post({}); // no likes reported
    const d = post({ metrics: { likes: 0 } });
    const ids = (dir: 'asc' | 'desc') => sortPosts([a, b, c, d], 'likes', dir).map((p) => p.id);
    expect(ids('desc')).toEqual([b.id, a.id, d.id, c.id]);
    expect(ids('asc')).toEqual([d.id, a.id, b.id, c.id]);
  });

  it('sorts by rate, engagements and publish time, breaking ties by newest publication', () => {
    const a = post({ engagementRate: 2, engagements: 9 });
    const b = post({ engagementRate: 7, engagements: 9 });
    const c = post({ engagementRate: null, engagements: 20 });
    expect(sortPosts([a, b, c], 'engagementRate', 'desc').map((p) => p.id)).toEqual([
      b.id,
      a.id,
      c.id,
    ]);
    expect(sortPosts([a, b, c], 'engagements', 'desc').map((p) => p.id)).toEqual([
      c.id,
      b.id,
      a.id,
    ]);
    expect(sortPosts([a, b, c], 'publishAt', 'desc').map((p) => p.id)).toEqual([c.id, b.id, a.id]);
    expect(sortPosts([a, b, c], 'publishAt', 'asc').map((p) => p.id)).toEqual([a.id, b.id, c.id]);
  });

  it('quotes a CSV cell only when needed, and disarms a formula', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1 for this')).toBe("'+1 for this");
    expect(csvCell('@mention first')).toBe("'@mention first");
    expect(csvCell(42)).toBe('42');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
  });

  it('exports the rows it is given, an unreported value as an empty cell', () => {
    const p = post({
      caption: 'Two\nlines, one "quote"',
      publishAt: new Date('2026-10-02T03:30:00Z'),
      releaseUrl: 'https://www.instagram.com/p/1/',
      source: 'imported',
      format: 'video',
      metrics: { likes: 12, views: 0 },
      engagements: 12,
      engagementRate: 3.4567,
      basis: 'reach',
    });
    const csv = postsCsv(
      [p],
      [{ id: 'c-ig', displayName: 'blossom' }],
      ['views', 'likes', 'comments'],
      () => 'Instagram',
    );
    expect(csv.split('\r\n')).toEqual([
      'Published (UTC),Platform,Account,Source,Format,Caption,Link,Views,Likes,Comments,Engagements,Engagement rate %,Rate divided by',
      '2026-10-02T03:30:00.000Z,Instagram,blossom,Imported,video,"Two lines, one ""quote""",https://www.instagram.com/p/1/,0,12,,12,3.46,reach',
      '',
    ]);
  });
});

describe('aggregate table sorting', () => {
  it('sorts counts and labels, missing last, deterministic identities', () => {
    const rows = [
      { id: 'b', value: 2 },
      { id: 'a', value: 2 },
      { id: 'c', value: null },
    ];
    for (const dir of ['asc', 'desc'] as const)
      expect(
        sortReportRows(
          rows,
          (r) => r.value,
          dir,
          (r) => r.id,
        ).map((r) => r.id),
      ).toEqual(['a', 'b', 'c']);
    expect(
      sortReportRows(
        rows,
        (r) => r.id,
        'desc',
        (r) => r.id,
      ).map((r) => r.id),
    ).toEqual(['c', 'b', 'a']);
  });
});

describe('report table URL sorting', () => {
  const options = [{ value: 'publishAt' }, { value: 'views' }];
  it('uses the complete default for unknown or unavailable columns', () => {
    expect(
      readReportTableSort(
        new URLSearchParams('postsSort=invalid&postsDir=asc'),
        'posts',
        options,
        'publishAt',
      ),
    ).toEqual({ key: 'publishAt', dir: 'desc' });
    expect(
      readReportTableSort(
        new URLSearchParams('postsSort=reach&postsDir=asc'),
        'posts',
        options,
        'publishAt',
      ),
    ).toEqual({ key: 'publishAt', dir: 'desc' });
  });
  it('preserves valid columns and directions and defaults invalid directions', () => {
    expect(
      readReportTableSort(
        new URLSearchParams('postsSort=views&postsDir=asc'),
        'posts',
        options,
        'publishAt',
      ),
    ).toEqual({ key: 'views', dir: 'asc' });
    expect(
      readReportTableSort(
        new URLSearchParams('postsSort=views&postsDir=invalid'),
        'posts',
        options,
        'publishAt',
      ),
    ).toEqual({ key: 'views', dir: 'desc' });
  });
});
