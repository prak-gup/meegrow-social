import { describe, expect, it } from 'vitest';
import { BULK_METRICS_MAX_POSTS, bulkPostMetricsInput } from './analytics.js';
import {
  groupDisplayStatus,
  listPostGroupsQuery,
  postStatus,
  postView,
  type PostStatus,
} from './posts.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('groupDisplayStatus', () => {
  const cases: Array<[PostStatus[], string]> = [
    // One variant, or all agreeing: its own status.
    [['draft'], 'draft'],
    [['scheduled', 'scheduled'], 'scheduled'],
    [['publishing', 'publishing'], 'publishing'],
    [['published', 'published', 'published'], 'published'],
    [['failed', 'failed'], 'failed'],
    [['cancelled', 'cancelled'], 'cancelled'],
    // Any failure among the rest outranks everything else.
    [['published', 'failed'], 'partly_failed'],
    [['failed', 'scheduled', 'published'], 'partly_failed'],
    [['draft', 'failed'], 'partly_failed'],
    // Not all out yet: the least advanced pending state.
    [['published', 'scheduled'], 'scheduled'],
    [['published', 'publishing'], 'publishing'],
    [['scheduled', 'publishing'], 'scheduled'],
    [['draft', 'scheduled', 'published'], 'draft'],
    // A cancelled variant is set aside while another is live.
    [['published', 'cancelled'], 'published'],
    [['cancelled', 'scheduled'], 'scheduled'],
    [['cancelled', 'failed'], 'failed'],
    [['cancelled', 'failed', 'published'], 'partly_failed'],
  ];
  it.each(cases)('%j reads %s', (statuses, expected) => {
    expect(groupDisplayStatus(statuses)).toBe(expected);
  });

  it('does not depend on the order of the variants', () => {
    for (const [statuses, expected] of cases) {
      expect(groupDisplayStatus([...statuses].reverse())).toBe(expected);
    }
  });

  it('a single variant always reads as itself', () => {
    for (const status of postStatus.options) expect(groupDisplayStatus([status])).toBe(status);
  });

  it('falls back to draft for a group with no variants', () => {
    expect(groupDisplayStatus([])).toBe('draft');
  });
});

describe('listPostGroupsQuery', () => {
  it('defaults to the newest first, 50 at a time', () => {
    expect(listPostGroupsQuery.parse({})).toMatchObject({ order: 'desc', limit: 50, offset: 0 });
  });

  it('takes the post-list filters plus a caption search and an order', () => {
    const parsed = listPostGroupsQuery.parse({
      status: 'failed',
      provider: 'instagram',
      connectionId: ID,
      from: '2026-10-01T00:00:00Z',
      q: '  open day ',
      order: 'asc',
      limit: '20',
      offset: '40',
    });
    expect(parsed).toMatchObject({ status: 'failed', q: 'open day', order: 'asc', limit: 20 });
    expect(parsed.from).toBeInstanceOf(Date);
  });

  it('rejects an empty search, an unknown order and an oversized page', () => {
    expect(listPostGroupsQuery.safeParse({ q: '   ' }).success).toBe(false);
    expect(listPostGroupsQuery.safeParse({ order: 'random' }).success).toBe(false);
    expect(listPostGroupsQuery.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('postView media', () => {
  const base = {
    id: ID,
    groupId: ID,
    provider: 'instagram',
    connectionId: ID,
    status: 'published',
    caption: '',
    publishAt: null,
    releaseUrl: null,
    error: null,
    queueId: null,
    createdAt: '2026-10-01T00:00:00Z',
  };

  it('still parses a payload from before media was added', () => {
    expect(postView.parse(base).media).toBeUndefined();
  });

  it('carries a url and thumbnail per item, either of which may be null', () => {
    const parsed = postView.parse({
      ...base,
      media: [
        { id: ID, kind: 'image', url: 'https://cdn.test/a.jpg', thumbnailUrl: null },
        { id: ID, kind: 'video', url: null, thumbnailUrl: 'https://cdn.test/cover.jpg' },
      ],
    });
    expect(parsed.media).toHaveLength(2);
  });
});

describe('bulkPostMetricsInput', () => {
  it('takes between one id and the cap', () => {
    expect(bulkPostMetricsInput.safeParse({ postIds: [] }).success).toBe(false);
    expect(bulkPostMetricsInput.safeParse({ postIds: [ID] }).success).toBe(true);
    const tooMany = Array.from({ length: BULK_METRICS_MAX_POSTS + 1 }, () => ID);
    expect(bulkPostMetricsInput.safeParse({ postIds: tooMany }).success).toBe(false);
  });

  it('rejects anything that is not a uuid', () => {
    expect(bulkPostMetricsInput.safeParse({ postIds: ['metrics'] }).success).toBe(false);
  });
});
