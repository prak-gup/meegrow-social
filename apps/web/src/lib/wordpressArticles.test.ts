import { describe, expect, it } from 'vitest';
import type { PostView } from '@meegrow-social/contracts';
import {
  dayEntries,
  groupCaption,
  groupChip,
  groupQuery,
  NO_GROUP_FILTERS,
  groupActions,
} from './postGroups';
import { CHIP } from './statusChip';

function post(status: 'publish' | 'draft' | 'future' | 'private' | 'pending'): PostView {
  return {
    id: 'post',
    groupId: 'group',
    connectionId: 'wp-account',
    provider: 'wordpress',
    caption: '<p>HTML body</p>',
    status: 'published',
    source: 'imported',
    media: [],
    publishAt: new Date('2026-10-10T10:00:00Z'),
    releaseUrl: 'https://example.test/article',
    externalPostId: '12',
    platformRemovedAt: null,
    createdAt: new Date('2026-10-10'),
    options: {
      kind: 'wordpress',
      title: 'Article title',
      status: 'draft',
      remote: {
        title: 'Article title',
        excerpt: '',
        slug: 'article',
        status,
        modifiedAt: '2026-10-10T11:00:00Z',
        publishedAt: '2026-10-10T10:00:00Z',
        categories: ['News'],
        tags: ['Blog'],
        author: 'Editor',
        bodyFormat: 'html',
        bodyTruncated: false,
      },
    },
  } as PostView;
}

describe('WordPress articles in Content and Calendar', () => {
  it.each([
    ['publish', 'Published'],
    ['draft', 'Draft on site'],
    ['future', 'Scheduled on site'],
    ['private', 'Private'],
    ['pending', 'Pending on site'],
  ] as const)('shows site status %s honestly', (status, label) => {
    const p = post(status);
    const group = {
      id: 'group',
      caption: 'HTML body',
      media: [],
      status: 'published' as const,
      posts: [p],
    };
    expect(groupCaption(group)).toBe('Article title');
    expect(CHIP[groupChip(group)].label).toBe(label);
    expect(dayEntries([p])[0]!.caption).toBe('Article title');
    expect(groupActions([p]).editable).toHaveLength(0);
  });
  it('sends WordPress and account filters to the existing scoped query', () => {
    expect(
      groupQuery(
        { ...NO_GROUP_FILTERS, provider: 'wordpress', connectionId: 'wp-account' },
        new Date('2026-10-10').getTime(),
        0,
      ),
    ).toMatchObject({ provider: 'wordpress', connectionId: 'wp-account' });
  });
});
