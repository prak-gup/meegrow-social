import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import { createWorkspace, resetDb, useTempDiskStorage } from '@meegrow-social/testing';
import {
  getMedia,
  listMedia,
  registerMediaFromUrl,
  resolveMediaRefs,
  uploadMedia,
  validateMediaAgainstPlatform,
} from './media.js';

// Smallest-known-valid 1x1 white-pixel JPEG (same fixture as media/ffprobe.test.ts).
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
const TINY_JPEG = Buffer.from(TINY_JPEG_BASE64, 'base64');

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(async () => {
  await resetDb();
  useTempDiskStorage();
});
afterAll(closeDb);

describe('uploadMedia', () => {
  it('stores the file, probes it with ffprobe, and persists a media row with a public url', async () => {
    const ws = await createWorkspace();

    const media = await uploadMedia(ws, {
      filename: 'tiny.jpg',
      contentType: 'image/jpeg',
      data: TINY_JPEG,
    });

    expect(media.kind).toBe('image');
    expect(media.url).toMatch(/^http:\/\/localhost:8990\/media\//);
    expect(media.bytes).toBe(TINY_JPEG.byteLength);
    expect(media.meta.container).toBe('jpeg');
    expect(media.meta.width).toBe(1);
    expect(media.meta.height).toBe(1);

    const fetched = await getMedia(ws, media.id);
    expect(fetched?.id).toBe(media.id);
  });

  it('rejects an unsupported content type before touching storage or the db', async () => {
    const ws = await createWorkspace();
    await expect(
      uploadMedia(ws, {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('x'),
      }),
    ).rejects.toThrow(/unsupported media content type/);
  });
});

describe('registerMediaFromUrl', () => {
  it('probes and persists media without re-uploading — url points at the original source', async () => {
    const ws = await createWorkspace();
    const sourceUrl = 'https://antidote.example.com/generated/hero.jpg';
    const fetchImpl = async () =>
      new Response(TINY_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });

    const media = await registerMediaFromUrl(ws, { url: sourceUrl }, { fetchImpl });

    expect(media.url).toBe(sourceUrl); // not re-hosted
    expect(media.kind).toBe('image');
    expect(media.meta.width).toBe(1);

    const [raw] = await withWorkspace(ws, (tx) =>
      tx.select().from(schema.media).where(eq(schema.media.id, media.id)),
    );
    expect(raw?.s3Key).toBeNull();
  });

  it('surfaces a clear error when the source url is unreachable', async () => {
    const ws = await createWorkspace();
    const fetchImpl = async () => new Response('not found', { status: 404 });
    await expect(
      registerMediaFromUrl(ws, { url: 'https://example.com/missing.jpg' }, { fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('validateMediaAgainstPlatform', () => {
  it('rejects an out-of-spec upload for the named platform with a human-readable reason', async () => {
    const ws = await createWorkspace();
    // 1x1 JPEG has an aspect ratio of 1:1 — inside IG's 4:5–1.91:1 band, so use a PNG to trip the
    // container check instead (deterministic without needing a custom-aspect fixture).
    const media = await uploadMedia(ws, {
      filename: 'tiny.png',
      contentType: 'image/png',
      data: TINY_JPEG, // ffprobe reads pixel data regardless of the extension we give it
    });

    const result = await validateMediaAgainstPlatform(ws, media.id, 'instagram');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/JPEG/);
  });

  it('accepts media with no researched spec for the given provider', async () => {
    const ws = await createWorkspace();
    const media = await uploadMedia(ws, {
      filename: 'tiny.jpg',
      contentType: 'image/jpeg',
      data: TINY_JPEG,
    });
    const result = await validateMediaAgainstPlatform(ws, media.id, 'fake');
    expect(result).toEqual({ valid: true });
  });

  it('throws for an unknown mediaId', async () => {
    const ws = await createWorkspace();
    await expect(
      validateMediaAgainstPlatform(ws, '00000000-0000-0000-0000-000000000000', 'instagram'),
    ).rejects.toThrow(/not found/);
  });
});

describe('resolveMediaRefs (used by publish to fill in public urls)', () => {
  it('leaves refs with a url untouched and fills in refs that only carry a mediaId', async () => {
    const ws = await createWorkspace();
    const media = await uploadMedia(ws, {
      filename: 'tiny.jpg',
      contentType: 'image/jpeg',
      data: TINY_JPEG,
    });

    const resolved = await withWorkspace(ws, (tx) =>
      resolveMediaRefs(tx, [
        { mediaId: media.id, kind: 'image' },
        { mediaId: media.id, kind: 'image', url: 'https://already-has.example.com/x.jpg' },
      ]),
    );

    expect(resolved[0]?.url).toBe(media.url);
    expect(resolved[1]?.url).toBe('https://already-has.example.com/x.jpg');
  });

  it('throws when a referenced mediaId has no stored url', async () => {
    const ws = await createWorkspace();
    await expect(
      withWorkspace(ws, (tx) =>
        resolveMediaRefs(tx, [{ mediaId: '00000000-0000-0000-0000-000000000000', kind: 'image' }]),
      ),
    ).rejects.toThrow(/has no stored url/);
  });
});

describe('listMedia (D1)', () => {
  async function seed(ws: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [row] = await withWorkspace(ws, (tx) =>
        tx
          .insert(schema.media)
          .values({
            workspaceId: ws,
            kind: 'image',
            url: `https://cdn.example/${i}.jpg`,
            // Explicit, strictly increasing timestamps so "newest first" is not a timer race.
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
          })
          .returning(),
      );
      ids.push(row!.id);
    }
    return ids;
  }

  it('returns the workspace media newest first', async () => {
    const ws = await createWorkspace();
    const ids = await seed(ws, 3);
    const listed = await listMedia(ws);
    expect(listed.map((m) => m.id)).toEqual([...ids].reverse());
    expect(listed[0]).toMatchObject({ kind: 'image', url: 'https://cdn.example/2.jpg' });
  });

  it('paginates with limit and offset without overlap', async () => {
    const ws = await createWorkspace();
    const newestFirst = (await seed(ws, 5)).reverse();
    const page1 = await listMedia(ws, { limit: 2, offset: 0 });
    const page2 = await listMedia(ws, { limit: 2, offset: 2 });
    const page3 = await listMedia(ws, { limit: 2, offset: 4 });
    expect([...page1, ...page2, ...page3].map((m) => m.id)).toEqual(newestFirst);
    expect(page3).toHaveLength(1);
  });

  it('is empty for a workspace with no media', async () => {
    expect(await listMedia(await createWorkspace())).toEqual([]);
  });

  it("never returns another workspace's media", async () => {
    const [a, b] = [await createWorkspace('A'), await createWorkspace('B')];
    const [mine] = await seed(a, 1);
    await seed(b, 2);
    expect((await listMedia(a)).map((m) => m.id)).toEqual([mine]);
    expect(await listMedia(b)).toHaveLength(2);
  });
});
