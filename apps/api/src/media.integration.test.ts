import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@meegrow-social/db';
import { createApiKeyForWorkspace } from '@meegrow-social/core';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTempDiskStorage,
} from '@meegrow-social/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

// Smallest-known-valid 1x1 white-pixel JPEG (same fixture used across the media test suite).
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
const TINY_JPEG = Buffer.from(TINY_JPEG_BASE64, 'base64');

function multipartBody(filename: string, contentType: string, data: Buffer) {
  const boundary = `----mgsTestBoundary${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  process.env.MEDIA_STORAGE_DRIVER ??= 'disk';
  useRecordingScheduler();
  app = await buildServer();
});
beforeEach(async () => {
  await resetDb();
  useTempDiskStorage();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('POST /v1/media', () => {
  it('stores the upload and returns {mediaId, url, kind, meta}', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const { body, contentType } = multipartBody('tiny.jpg', 'image/jpeg', TINY_JPEG);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${secret}`, 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const created = res.json<{
      mediaId: string;
      url: string;
      kind: string;
      meta: { width: number };
    }>();
    expect(created.kind).toBe('image');
    expect(created.url).toMatch(/^http:\/\/localhost:8990\/media\//);
    expect(created.meta.width).toBe(1);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/media/${created.mediaId}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ media: { id: string } }>().media.id).toBe(created.mediaId);
  });

  it('rejects requests without a valid API key', async () => {
    const { body, contentType } = multipartBody('tiny.jpg', 'image/jpeg', TINY_JPEG);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('404s reading media from a different workspace', async () => {
    const wsA = await createWorkspace('A');
    const { secret: keyA } = await createApiKeyForWorkspace(wsA, 'A');
    const { body, contentType } = multipartBody('tiny.jpg', 'image/jpeg', TINY_JPEG);
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${keyA}`, 'content-type': contentType },
      payload: body,
    });
    const { mediaId } = upload.json<{ mediaId: string }>();

    const wsB = await createWorkspace('B');
    const { secret: keyB } = await createApiKeyForWorkspace(wsB, 'B');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/media/${mediaId}`,
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/media/register', () => {
  let sourceServer: Server;
  let sourceUrl: string;

  beforeAll(async () => {
    sourceServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(TINY_JPEG);
    });
    await new Promise<void>((r) => sourceServer.listen(0, '127.0.0.1', r));
    const { port } = sourceServer.address() as AddressInfo;
    sourceUrl = `http://127.0.0.1:${port}/hero.jpg`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => sourceServer.close(() => r()));
  });

  it('registers an externally-hosted image without re-uploading it', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/media/register',
      headers: { authorization: `Bearer ${secret}` },
      payload: { url: sourceUrl },
    });

    expect(res.statusCode).toBe(201);
    const created = res.json<{
      mediaId: string;
      url: string;
      kind: string;
      meta: { width: number };
    }>();
    expect(created.url).toBe(sourceUrl); // not re-hosted onto our storage
    expect(created.kind).toBe('image');
    expect(created.meta.width).toBe(1);
  });
});

describe('POST /v1/media/:id/validate', () => {
  it('rejects an out-of-spec upload for a named platform with a human-readable reason', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    // image/png content-type + jpeg bytes trips the "must be JPEG" container check deterministically.
    const { body, contentType } = multipartBody('tiny.png', 'image/png', TINY_JPEG);
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${secret}`, 'content-type': contentType },
      payload: body,
    });
    const { mediaId } = upload.json<{ mediaId: string }>();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/media/${mediaId}/validate`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { provider: 'instagram' },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json<{ valid: boolean; reason?: string }>();
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/JPEG/);
  });

  it('accepts an in-spec upload', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const { body, contentType } = multipartBody('tiny.jpg', 'image/jpeg', TINY_JPEG);
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${secret}`, 'content-type': contentType },
      payload: body,
    });
    const { mediaId } = upload.json<{ mediaId: string }>();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/media/${mediaId}/validate`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { provider: 'instagram' },
    });
    expect(res.json<{ valid: boolean }>().valid).toBe(true);
  });
});

describe('POST /v1/posts with mediaId refs', () => {
  it('accepts a post-group referencing an uploaded mediaId (no url required at create time)', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const { body, contentType } = multipartBody('tiny.jpg', 'image/jpeg', TINY_JPEG);
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${secret}`, 'content-type': contentType },
      payload: body,
    });
    const { mediaId } = upload.json<{ mediaId: string }>();

    // A connection is needed to satisfy the variant shape; reuse the posts test's fake provider.
    const connectionId = await createConnection(ws, 'fake');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/posts',
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        caption: 'with media',
        media: [{ mediaId, kind: 'image' }],
        variants: [{ connectionId, provider: 'fake' }],
        schedule: { type: 'draft' },
      },
    });
    expect(res.statusCode).toBe(201);
  });
});
