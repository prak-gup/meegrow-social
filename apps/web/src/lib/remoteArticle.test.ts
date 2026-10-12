import { describe, it, expect } from 'vitest';
import { postView, updateRemotePostInput, trashRemotePostInput } from '@meegrow-social/contracts';
import { articleFields, articlePatch, parseSiteIds } from './remoteArticle';
const post = postView.parse({
  id: '11111111-1111-4111-8111-111111111111',
  groupId: '22222222-2222-4222-8222-222222222222',
  provider: 'wordpress',
  connectionId: '33333333-3333-4333-8333-333333333333',
  status: 'published',
  caption: '<p>HTML</p>',
  media: [],
  publishAt: null,
  releaseUrl: null,
  error: null,
  queueId: null,
  createdAt: new Date(),
  source: 'imported',
  platformRemovedAt: null,
  options: {
    kind: 'wordpress',
    title: 'Title',
    remote: {
      title: 'Title',
      excerpt: '',
      slug: 'title',
      status: 'draft',
      modifiedAt: '2026-10-10T11:00:00.000Z',
      publishedAt: null,
      categories: [],
      tags: [],
      categoryIds: [3],
      tagIds: [4],
      featuredMediaId: 7,
      author: '',
      bodyFormat: 'html',
      bodyTruncated: false,
    },
  },
});
describe('remote article editing', () => {
  it('preserves HTML and existing IDs', () => {
    expect(articleFields(post)).toMatchObject({
      body: '<p>HTML</p>',
      categories: [3],
      tags: [4],
      featuredImage: 7,
    });
  });
  it('sends only changed fields with the version seen', () => {
    expect(articlePatch(post, { ...articleFields(post), title: 'New' })).toEqual({
      expectedModifiedAt: '2026-10-10T11:00:00.000Z',
      fields: { title: 'New' },
    });
  });
  it('never sends truncated HTML even if callers changed it', () => {
    const truncated = postView.parse({
      ...post,
      options: {
        ...post.options,
        remote: {
          ...(post.options?.kind === 'wordpress' ? post.options.remote : {}),
          bodyTruncated: true,
        },
      },
    });
    expect(
      articlePatch(truncated, { ...articleFields(truncated), body: 'short', title: 'New' }).fields,
    ).toEqual({ title: 'New' });
  });
  it('parses existing site IDs and explicit removals', () => {
    expect(parseSiteIds('3, 4,3')).toEqual([3, 4]);
    expect(parseSiteIds('')).toEqual([]);
    expect(() => parseSiteIds('3,wrong')).toThrow();
  });
  it('requires explicit trash confirmation, version and one post', () => {
    expect(
      trashRemotePostInput.safeParse({
        expectedModifiedAt: '2026-10-10T11:00:00.000Z',
        confirm: false,
      }).success,
    ).toBe(false);
    expect(trashRemotePostInput.safeParse({ confirm: true }).success).toBe(false);
  });
  it('rejects force-delete and arbitrary status fields', () => {
    expect(
      updateRemotePostInput.safeParse({
        expectedModifiedAt: '2026-10-10T11:00:00.000Z',
        fields: { status: 'trash' },
      }).success,
    ).toBe(false);
    expect(
      updateRemotePostInput.safeParse({
        expectedModifiedAt: '2026-10-10T11:00:00.000Z',
        fields: { force: true },
      }).success,
    ).toBe(false);
  });
});
