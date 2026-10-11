import { describe, expect, it } from 'vitest';
import {
  BULK_METRICS_MAX_POSTS,
  type PostMediaView,
  type PostView,
} from '@meegrow-social/contracts';
import { TIME_NOT_RECORDED } from './postDate';
import {
  BULK_METRICS_MAX,
  GROUP_PAGE_SIZE,
  NO_GROUP_FILTERS,
  appendGroups,
  applyPosts,
  compactNumber,
  dayEntries,
  distinctCaptions,
  groupActions,
  groupCaption,
  groupError,
  groupMatchesStatus,
  groupMetric,
  groupQuery,
  groupThumb,
  groupTime,
  groupWhen,
  hasGroupFilters,
  idChunks,
  mediaThumb,
  metricsToLoad,
  rangeBounds,
  shortDateTime,
  topMetricNames,
  visibleGroup,
  type PostGroup,
} from './postGroups';

let n = 0;
const post = (over: Partial<PostView> = {}): PostView => ({
  id: `post-${++n}`,
  groupId: 'group-1',
  provider: 'facebook',
  connectionId: 'conn-1',
  status: 'scheduled',
  caption: 'Hello',
  options: null,
  publishAt: new Date('2026-06-01T10:00:00Z'),
  releaseUrl: null,
  error: null,
  queueId: null,
  createdAt: new Date('2026-05-01T10:00:00Z'),
  media: [],
  ...over,
});

const group = (posts: PostView[], over: Partial<PostGroup> = {}): PostGroup => ({
  id: 'group-1',
  caption: 'Hello',
  media: [],
  status: 'scheduled',
  posts,
  ...over,
});

const image = (url: string | null): PostMediaView => ({
  id: 'm-1',
  kind: 'image',
  url,
  thumbnailUrl: null,
});
const video = (thumbnailUrl: string | null): PostMediaView => ({
  id: 'm-2',
  kind: 'video',
  url: 'https://cdn.test/clip.mp4',
  thumbnailUrl,
});

describe('filters', () => {
  it('counts the search, status, platform, account and date as filters, but not the order', () => {
    expect(hasGroupFilters(NO_GROUP_FILTERS)).toBe(false);
    expect(hasGroupFilters({ ...NO_GROUP_FILTERS, order: 'asc' })).toBe(false);
    expect(hasGroupFilters({ ...NO_GROUP_FILTERS, q: '  ' })).toBe(false);
    expect(hasGroupFilters({ ...NO_GROUP_FILTERS, q: 'sale' })).toBe(true);
    expect(hasGroupFilters({ ...NO_GROUP_FILTERS, connectionId: 'c' })).toBe(true);
    expect(hasGroupFilters({ ...NO_GROUP_FILTERS, range: 'last7' })).toBe(true);
  });

  it('turns a range preset into bounds around now', () => {
    const now = Date.UTC(2026, 9, 11, 12);
    expect(rangeBounds('', now)).toEqual({});
    expect(rangeBounds('next7', now)).toEqual({
      from: '2026-10-11T12:00:00.000Z',
      to: '2026-10-18T12:00:00.000Z',
    });
    expect(rangeBounds('last30', now)).toEqual({
      from: '2026-09-11T12:00:00.000Z',
      to: '2026-10-11T12:00:00.000Z',
    });
  });

  it('builds the list query with a real offset and leaves empty filters out', () => {
    expect(groupQuery(NO_GROUP_FILTERS, 0, 96)).toEqual({
      q: undefined,
      status: undefined,
      provider: undefined,
      connectionId: undefined,
      order: 'desc',
      limit: GROUP_PAGE_SIZE,
      offset: 96,
    });
    const q = groupQuery(
      { ...NO_GROUP_FILTERS, q: ' open day ', status: 'failed', order: 'asc', range: 'last7' },
      Date.UTC(2026, 9, 11),
      0,
    );
    expect(q).toMatchObject({ q: 'open day', status: 'failed', order: 'asc' });
    expect(q.from).toBe('2026-10-04T00:00:00.000Z');
  });

  it('fills whole rows at every column count the grid uses', () => {
    for (const columns of [1, 2, 3, 4, 6]) expect(GROUP_PAGE_SIZE % columns).toBe(0);
  });
});

describe('visibleGroup', () => {
  const real = post({ provider: 'instagram', status: 'published' });
  const fake = post({ provider: 'fake', status: 'failed' });
  const notFake = (p: string) => !p.startsWith('fake');

  it('returns the same group when nothing is hidden', () => {
    const g = group([real]);
    expect(visibleGroup(g, notFake)).toBe(g);
  });

  it('drops hidden variants and recomputes the status over what is left', () => {
    const g = visibleGroup(group([real, fake], { status: 'partly_failed' }), notFake);
    expect(g?.posts).toEqual([real]);
    expect(g?.status).toBe('published');
  });

  it('is null when every variant is hidden', () => {
    expect(visibleGroup(group([fake]), notFake)).toBeNull();
  });
});

describe('local updates', () => {
  it('appends a page without repeating a group that shifted between pages', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((id) => group([], { id }));
    expect(appendGroups([a!, b!], [b!, c!]).map((g) => g.id)).toEqual(['a', 'b', 'c']);
  });

  it('swaps an updated variant in and recomputes the group status by the shared rule', () => {
    const ok = post({ status: 'published' });
    const bad = post({ status: 'failed' });
    const g = group([ok, bad], { status: 'partly_failed' });
    const next = applyPosts(g, [{ ...bad, status: 'scheduled', error: null }]);
    expect(next.posts.map((p) => p.status)).toEqual(['published', 'scheduled']);
    expect(next.status).toBe('scheduled');
  });

  it('keeps a variant’s media when the update carries none', () => {
    const media = [image('https://cdn.test/a.jpg')];
    const p = post({ media });
    const next = applyPosts(group([p]), [{ ...p, status: 'cancelled', media: undefined }]);
    expect(next.posts[0]?.media).toEqual(media);
    expect(next.status).toBe('cancelled');
  });

  it('returns the same group when none of its variants changed', () => {
    const g = group([post()]);
    expect(applyPosts(g, [post({ id: 'someone-else' })])).toBe(g);
  });

  it('keeps a group under a status filter while any variant still matches', () => {
    const g = group([post({ status: 'failed' }), post({ status: 'published' })]);
    expect(groupMatchesStatus(g, '')).toBe(true);
    expect(groupMatchesStatus(g, 'failed')).toBe(true);
    expect(groupMatchesStatus(g, 'scheduled')).toBe(false);
  });
});

describe('thumbnail', () => {
  it('is null for a text-only post', () => {
    expect(mediaThumb([])).toBeNull();
    expect(mediaThumb(undefined)).toBeNull();
    expect(groupThumb(group([post()]))).toBeNull();
  });

  it('is the first image, with the carousel count', () => {
    const media = [image('https://cdn.test/a.jpg'), image('https://cdn.test/b.jpg')];
    expect(groupThumb(group([post()], { media }))).toEqual({
      kind: 'image',
      src: 'https://cdn.test/a.jpg',
      count: 2,
    });
  });

  it('never draws a url that is not plain http(s)', () => {
    expect(mediaThumb([image('javascript:alert(1)')])?.src).toBeNull();
    expect(mediaThumb([image('data:image/svg+xml,<svg/>')])?.src).toBeNull();
    expect(mediaThumb([image(null)])?.src).toBeNull();
  });

  it('shows a video by its cover, and has no picture for a video without one', () => {
    expect(mediaThumb([video('https://cdn.test/cover.jpg')])).toEqual({
      kind: 'video',
      src: 'https://cdn.test/cover.jpg',
      count: 1,
    });
    expect(mediaThumb([video(null)])).toEqual({ kind: 'video', src: null, count: 1 });
  });

  it('prefers what the variants carry, and falls back to the group’s shared media', () => {
    const p = post({ media: [image('https://cdn.test/variant.jpg')] });
    expect(groupThumb(group([post(), p]))?.src).toBe('https://cdn.test/variant.jpg');
    const shared = [image('https://cdn.test/group.jpg')];
    expect(groupThumb(group([post(), p], { media: shared }))?.src).toBe(
      'https://cdn.test/variant.jpg',
    );
    expect(groupThumb(group([post()], { media: shared }))?.src).toBe('https://cdn.test/group.jpg');
  });

  it('shows the caption that goes out — the first variant’s — not the one the group was made with', () => {
    const edited = group([post({ caption: 'Edited' }), post({ caption: 'Edited #ig' })], {
      caption: 'Original',
    });
    expect(groupCaption(edited)).toBe('Edited');
    expect(groupCaption(group([], { caption: 'Original' }))).toBe('Original');
    expect(groupCaption(group([post({ caption: '' })], { caption: 'Original' }))).toBe('');
  });

  it('finds a video’s cover on the variant that carries it', () => {
    const g = group(
      [post({ media: [video(null)] }), post({ media: [video('https://c.test/c.jpg')] })],
      {
        media: [video(null)],
      },
    );
    expect(groupThumb(g)).toEqual({ kind: 'video', src: 'https://c.test/c.jpg', count: 1 });
  });
});

describe('time', () => {
  const now = new Date(2026, 9, 11);

  it('formats this year without the year and another year with it', () => {
    expect(shortDateTime(new Date(2026, 9, 4, 19, 7), now)).not.toContain('2026');
    expect(shortDateTime(new Date(2025, 9, 4, 19, 7), now)).toContain('2025');
  });

  it('takes the earliest real time among the variants, ignoring missing and placeholder ones', () => {
    const posts = [
      post({ publishAt: new Date('2026-06-02T10:00:00Z') }),
      post({ publishAt: new Date('2026-06-01T10:00:00Z') }),
      post({ publishAt: null }),
      post({ publishAt: new Date(0) }),
    ];
    expect(groupTime(posts)?.toISOString()).toBe('2026-06-01T10:00:00.000Z');
    expect(groupTime([post({ publishAt: null })])).toBeNull();
  });

  it('names a published post with no stored time instead of leaving it blank', () => {
    const g = group([post({ status: 'published', publishAt: null })], { status: 'published' });
    expect(groupWhen(g, now)).toEqual({ text: TIME_NOT_RECORDED, date: null });
  });

  it('says a "publish now" post is on its way, and that a draft has no time', () => {
    const sending = group([post({ status: 'scheduled', publishAt: null })]);
    expect(groupWhen(sending, now).text).toBe('Sending as soon as possible');
    const draft = group([post({ status: 'draft', publishAt: null })], { status: 'draft' });
    expect(groupWhen(draft, now).text).toBe('Not scheduled');
  });

  it('shows the date when there is one', () => {
    const at = new Date(2026, 5, 1, 10);
    const when = groupWhen(group([post({ publishAt: at })]), now);
    expect(when.date).toEqual(at);
    expect(when.text).toBe(shortDateTime(at, now));
  });
});

describe('actions', () => {
  it('offers each action only for the variants the API accepts it for', () => {
    const draft = post({ status: 'draft' });
    const scheduled = post({ status: 'scheduled' });
    const failed = post({ status: 'failed' });
    const published = post({ status: 'published', releaseUrl: 'https://example.com/p/1' });
    const cancelled = post({ status: 'cancelled' });
    const actions = groupActions([draft, scheduled, failed, published, cancelled]);
    expect(actions.editable).toEqual([draft, scheduled]);
    expect(actions.cancelable).toEqual([draft, scheduled]);
    expect(actions.failed).toEqual([failed]);
    expect(actions.links).toEqual([{ post: published, url: 'https://example.com/p/1' }]);
  });

  it('offers no link for a release url that is not http(s)', () => {
    const p = post({ status: 'published', releaseUrl: 'javascript:alert(1)' });
    expect(groupActions([p]).links).toEqual([]);
  });

  it('tells tailored captions from a shared one', () => {
    expect(distinctCaptions([post(), post()])).toEqual(['Hello']);
    expect(distinctCaptions([post(), post({ caption: 'Hello #ig' })])).toHaveLength(2);
  });

  it('surfaces the first provider error and how many variants failed', () => {
    const posts = [
      post({ status: 'published' }),
      post({ status: 'failed', error: null, provider: 'gmb' }),
      post({ status: 'failed', error: 'Token expired', provider: 'instagram' }),
    ];
    expect(groupError(posts)).toEqual({
      message: 'Token expired',
      provider: 'instagram',
      count: 2,
    });
    expect(groupError([post({ status: 'published' })])).toBeNull();
    expect(groupError([post({ status: 'failed', error: null })])?.message).toBe(
      'Publishing failed.',
    );
  });
});

describe('dayEntries', () => {
  it('makes one entry per group, with the shared status rule and the earliest time', () => {
    const a1 = post({
      groupId: 'a',
      status: 'published',
      publishAt: new Date('2026-06-01T10:01:00Z'),
    });
    const a2 = post({
      groupId: 'a',
      status: 'failed',
      publishAt: new Date('2026-06-01T10:00:00Z'),
    });
    const b = post({
      groupId: 'b',
      status: 'scheduled',
      publishAt: new Date('2026-06-01T08:00:00Z'),
    });
    const entries = dayEntries([a1, a2, b]);
    expect(entries.map((e) => [e.id, e.status, e.posts.length])).toEqual([
      ['b', 'scheduled', 1],
      ['a', 'partly_failed', 2],
    ]);
    expect(entries[1]?.at).toBe(Date.parse('2026-06-01T10:00:00Z'));
  });

  it('drops posts without a real time', () => {
    expect(dayEntries([post({ publishAt: null }), post({ publishAt: new Date(0) })])).toEqual([]);
  });
});

describe('metrics on cards', () => {
  const a = post({ id: 'a', status: 'published' });
  const b = post({ id: 'b', status: 'published' });
  const c = post({ id: 'c', status: 'scheduled' });
  const groups = [
    group([a, c], { id: 'g1' }),
    group([b], { id: 'g2' }),
    group([post({ id: 'd', status: 'published' })], { id: 'g3' }),
  ];
  const latest = new Map<string, Record<string, number>>([
    ['a', { views: 100, likes: 5 }],
    ['b', { views: 50, post_clicks: 2 }],
    ['d', { likes: 1 }],
  ]);

  it('asks only for published variants that are not loaded yet', () => {
    expect(metricsToLoad(groups, new Set())).toEqual(['a', 'b', 'd']);
    expect(metricsToLoad(groups, new Set(['a', 'd']))).toEqual(['b']);
  });

  it('picks the names most groups carry, the larger total first among equals, from the data alone', () => {
    // views and likes are each on two groups; views totals 150 against 6.
    expect(topMetricNames(groups, latest)).toEqual(['views', 'likes', 'post_clicks']);
    expect(topMetricNames(groups, latest, 1)).toEqual(['views']);
    expect(topMetricNames(groups, new Map())).toEqual([]);
  });

  it('falls back to alphabetical when count and total are both equal', () => {
    const tie = new Map<string, Record<string, number>>([['a', { zeta: 1, alpha: 1 }]]);
    expect(topMetricNames(groups, tie)).toEqual(['alpha', 'zeta']);
  });

  it('sums a metric over the variants that report it, and is null — not 0 — when none does', () => {
    const both = [a, b];
    expect(groupMetric(both, latest, 'views')).toBe(150);
    expect(groupMetric(both, latest, 'likes')).toBe(5);
    expect(groupMetric(both, latest, 'saved')).toBeNull();
    expect(groupMetric([c], latest, 'views')).toBeNull();
    expect(groupMetric([a], new Map([['a', { views: 0 }]]), 'views')).toBe(0);
  });

  it('chunks at the size the API accepts', () => {
    expect(BULK_METRICS_MAX).toBe(BULK_METRICS_MAX_POSTS);
  });

  it('formats compactly and chunks ids for the bulk read', () => {
    expect(compactNumber(12)).toBe('12');
    expect(compactNumber(4231)).toMatch(/^4[.,]2\s?K$/i);
    expect(idChunks(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
    expect(idChunks([], 2)).toEqual([]);
  });
});
