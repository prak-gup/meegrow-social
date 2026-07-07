import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isFfprobeAvailable, probeFile } from './ffprobe.js';

// Smallest-known-valid 1x1 white-pixel JPEG, embedded so this test needs no network/fixtures dir.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mgs-ffprobe-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!isFfprobeAvailable())('probeFile (real ffprobe binary)', () => {
  it('reads dimensions + codec off a tiny JPEG fixture', async () => {
    const filePath = join(dir, 'tiny.jpg');
    await writeFile(filePath, Buffer.from(TINY_JPEG_BASE64, 'base64'));

    const meta = await probeFile(filePath);
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    expect(meta.codec).toBe('mjpeg');
  });

  it('rejects/throws on a non-media file', async () => {
    const filePath = join(dir, 'not-media.txt');
    await writeFile(filePath, 'this is not a media file');
    await expect(probeFile(filePath)).rejects.toThrow();
  });
});
