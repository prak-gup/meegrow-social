import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorageDriver, setStorageDriver } from '../media/storage/index.js';
import type { PutObjectInput } from '../media/storage/types.js';
import { copyThumbnail } from './post-import.js';

/**
 * Copying an imported post's still into our own storage. The platform's url is short-lived, so it
 * is fetched once and never stored; and a post is worth importing without a picture, so nothing
 * here may throw.
 */
const puts: PutObjectInput[] = [];

beforeEach(() => {
  puts.length = 0;
  setStorageDriver({
    kind: 'disk',
    put: async (input) => {
      puts.push(input);
      return { key: `${input.workspaceId}/stored.jpg`, url: 'https://media.test/ws-1/stored.jpg' };
    },
  });
});
afterEach(() => resetStorageDriver());

const image = (bytes = 1200, type = 'image/jpeg', extra: Record<string, string> = {}) =>
  vi.fn(
    async () =>
      new Response(new Uint8Array(bytes), { headers: { 'content-type': type, ...extra } }),
  ) as unknown as typeof fetch;

const item = {
  thumbnailUrl: 'https://scontent.cdn.test/v/still.jpg?oe=6712AB34',
  mediaKind: 'image' as const,
};

describe('copyThumbnail', () => {
  it('stores the bytes under the workspace and returns OUR url, never the platform’s', async () => {
    const fetchImpl = image();
    const stored = await copyThumbnail('ws-1', item, fetchImpl);

    expect(stored).toEqual({
      url: 'https://media.test/ws-1/stored.jpg',
      key: 'ws-1/stored.jpg',
      bytes: 1200,
    });
    expect(stored!.url).not.toContain('scontent');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      workspaceId: 'ws-1',
      filename: 'imported.jpg',
      contentType: 'image/jpeg',
    });
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe(item.thumbnailUrl);
  });

  it('keeps the right extension for png and webp', async () => {
    await copyThumbnail('ws-1', item, image(10, 'image/png'));
    await copyThumbnail('ws-1', item, image(10, 'image/webp; charset=binary'));
    expect(puts.map((p) => p.filename)).toEqual(['imported.png', 'imported.webp']);
  });

  it('has no thumbnail for a text post or a post the platform gave no picture for', async () => {
    const fetchImpl = image();
    expect(await copyThumbnail('ws-1', { thumbnailUrl: null, mediaKind: 'video' }, fetchImpl)).toBe(
      null,
    );
    expect(await copyThumbnail('ws-1', { ...item, mediaKind: null }, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses anything that is not https, without fetching it', async () => {
    const fetchImpl = image();
    for (const thumbnailUrl of ['http://cdn.test/a.jpg', 'file:///etc/passwd', 'not a url']) {
      expect(await copyThumbnail('ws-1', { ...item, thumbnailUrl }, fetchImpl)).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a response that is not an image — a video file, an error page', async () => {
    expect(await copyThumbnail('ws-1', item, image(10, 'video/mp4'))).toBeNull();
    expect(await copyThumbnail('ws-1', item, image(10, 'text/html'))).toBeNull();
    expect(puts).toEqual([]);
  });

  it('refuses an oversized picture, by its declared and by its real size', async () => {
    const tooBig = 5 * 1024 * 1024 + 1;
    expect(
      await copyThumbnail(
        'ws-1',
        item,
        image(10, 'image/jpeg', { 'content-length': String(tooBig) }),
      ),
    ).toBeNull();
    expect(await copyThumbnail('ws-1', item, image(tooBig))).toBeNull();
    expect(await copyThumbnail('ws-1', item, image(0))).toBeNull();
    expect(puts).toEqual([]);
  });

  it('is "no thumbnail", not an error, when the url has already expired', async () => {
    const expired = vi.fn(async () => new Response('URL signature expired', { status: 403 }));
    expect(await copyThumbnail('ws-1', item, expired as unknown as typeof fetch)).toBeNull();
  });

  it('is "no thumbnail", not an error, when the fetch or the storage fails', async () => {
    const down = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    expect(await copyThumbnail('ws-1', item, down as unknown as typeof fetch)).toBeNull();

    setStorageDriver({
      kind: 's3',
      put: async () => {
        throw new Error('S3_BUCKET is not set');
      },
    });
    expect(await copyThumbnail('ws-1', item, image())).toBeNull();
  });
});

describe('WordPress thumbnail SSRF boundary', () => {
  it('uses a bounded guarded request and copies the still to our storage', async () => {
    const { copyWordPressThumbnail } = await import('./post-import.js');
    const guarded = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.from(new Uint8Array(1200)),
      url: item.thumbnailUrl,
    }));
    expect(await copyWordPressThumbnail('ws-1', item, guarded)).toMatchObject({
      url: 'https://media.test/ws-1/stored.jpg',
    });
    expect(guarded).toHaveBeenCalledWith(item.thumbnailUrl, {
      maxResponseBytes: 5 * 1024 * 1024,
      timeoutMs: 15_000,
      maxRedirects: 3,
    });
  });
  it('leaves a missing image when the guard refuses a site-controlled URL', async () => {
    const { copyWordPressThumbnail } = await import('./post-import.js');
    const guarded = vi.fn(async () => {
      throw new Error('SSRF refused');
    });
    expect(
      await copyWordPressThumbnail(
        'ws-1',
        { ...item, thumbnailUrl: 'https://127.0.0.1/still.jpg' },
        guarded,
      ),
    ).toBeNull();
    expect(puts).toHaveLength(0);
  });
});
