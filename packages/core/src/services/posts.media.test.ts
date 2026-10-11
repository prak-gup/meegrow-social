import { describe, expect, it } from 'vitest';
import type { MediaRef } from '@meegrow-social/contracts';
import { toMediaViews } from './posts.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

/** How stored media refs become what a post view shows. Pure: the url lookup is passed in. */
describe('toMediaViews', () => {
  it("prefers the ref's own url, then the stored one, then null", () => {
    const refs: MediaRef[] = [
      { mediaId: A, kind: 'image', url: 'https://cdn.test/own.jpg' },
      { mediaId: B, kind: 'image' },
      { mediaId: C, kind: 'image' },
    ];
    const stored = new Map<string, string | null>([
      [A, 'https://cdn.test/stored-a.jpg'],
      [B, 'https://cdn.test/stored-b.jpg'],
    ]);
    expect(toMediaViews(refs, stored)).toEqual([
      { id: A, kind: 'image', url: 'https://cdn.test/own.jpg', thumbnailUrl: null },
      { id: B, kind: 'image', url: 'https://cdn.test/stored-b.jpg', thumbnailUrl: null },
      { id: C, kind: 'image', url: null, thumbnailUrl: null },
    ]);
  });

  it('keeps carousel order', () => {
    const refs: MediaRef[] = [
      { mediaId: C, kind: 'image' },
      { mediaId: A, kind: 'video' },
      { mediaId: B, kind: 'image' },
    ];
    expect(toMediaViews(refs, new Map()).map((m) => m.id)).toEqual([C, A, B]);
  });

  it('gives a cover to the first video only, and never to an image', () => {
    const refs: MediaRef[] = [
      { mediaId: A, kind: 'image' },
      { mediaId: B, kind: 'video' },
      { mediaId: C, kind: 'video' },
    ];
    const views = toMediaViews(refs, new Map(), 'https://cdn.test/cover.jpg');
    expect(views.map((m) => m.thumbnailUrl)).toEqual([null, 'https://cdn.test/cover.jpg', null]);
  });

  it('has no thumbnail for a video without a cover: none is generated', () => {
    expect(toMediaViews([{ mediaId: A, kind: 'video' }], new Map())[0]?.thumbnailUrl).toBeNull();
  });

  it('carries nothing but id, kind and the two urls', () => {
    const [view] = toMediaViews(
      [{ mediaId: A, kind: 'image' }],
      new Map([[A, 'https://x.test/a']]),
    );
    expect(Object.keys(view!).sort()).toEqual(['id', 'kind', 'thumbnailUrl', 'url']);
  });
});
