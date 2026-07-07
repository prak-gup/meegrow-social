import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskStorageDriver } from './disk.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'mgs-disk-storage-test-'));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('DiskStorageDriver', () => {
  it('writes the file under a workspace-scoped key and returns a public url', async () => {
    const driver = new DiskStorageDriver({ rootDir, publicBaseUrl: 'http://localhost:8990/media' });
    const data = Buffer.from('hello world');

    const stored = await driver.put({
      workspaceId: 'ws_1',
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      data,
    });

    expect(stored.key).toMatch(/^ws_1\/.+\.jpg$/);
    expect(stored.url).toBe(`http://localhost:8990/media/${stored.key}`);

    const written = await readFile(join(rootDir, stored.key));
    expect(written.equals(data)).toBe(true);
  });

  it('generates a distinct key per upload, even for the same filename', async () => {
    const driver = new DiskStorageDriver({ rootDir, publicBaseUrl: 'http://localhost:8990/media' });
    const a = await driver.put({
      workspaceId: 'ws_1',
      filename: 'same.jpg',
      contentType: 'image/jpeg',
      data: Buffer.from('a'),
    });
    const b = await driver.put({
      workspaceId: 'ws_1',
      filename: 'same.jpg',
      contentType: 'image/jpeg',
      data: Buffer.from('b'),
    });
    expect(a.key).not.toBe(b.key);
  });

  it('strips a trailing slash from publicBaseUrl', async () => {
    const driver = new DiskStorageDriver({
      rootDir,
      publicBaseUrl: 'http://localhost:8990/media/',
    });
    const stored = await driver.put({
      workspaceId: 'ws_1',
      filename: 'a.png',
      contentType: 'image/png',
      data: Buffer.from('x'),
    });
    expect(stored.url).not.toContain('media//');
  });
});
