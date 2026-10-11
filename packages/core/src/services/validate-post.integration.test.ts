import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db, schema } from '@meegrow-social/db';
import {
  createConnection,
  createQueue,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import type { MediaMeta } from '@meegrow-social/contracts';
import { createPost } from './posts.js';
import { previewQueueSlots } from './queues.js';
import { validatePost } from './validate-post.js';

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

async function seedMedia(ws: string, kind: 'image' | 'video', meta: MediaMeta): Promise<string> {
  const [row] = await db()
    .insert(schema.media)
    .values({ workspaceId: ws, kind, url: `https://cdn.example/${kind}`, meta })
    .returning();
  return row!.id;
}

/** Counted on the admin handle: a dry run must leave no row under any workspace. */
async function nothingWritten(): Promise<void> {
  expect(await db().select({ id: schema.postGroups.id }).from(schema.postGroups)).toEqual([]);
  expect(await db().select({ id: schema.posts.id }).from(schema.posts)).toEqual([]);
}

describe('validatePost — dry run of createPost', () => {
  it('passes a post createPost would accept, and creates, schedules and slots nothing', async () => {
    const { calls } = useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const queueId = await createQueue(ws);
    const before = await previewQueueSlots(ws, queueId, 2);

    for (const schedule of [
      { type: 'draft' },
      { type: 'now' },
      { type: 'at', publishAt: '2030-01-01T09:00:00Z' },
      { type: 'queue', queueId },
    ]) {
      expect(
        await validatePost(ws, {
          caption: 'hello',
          variants: [{ connectionId: conn, provider: 'fake' }],
          schedule,
        }),
        schedule.type,
      ).toEqual({ valid: true, issues: [] });
    }

    await nothingWritten();
    expect(calls).toEqual([]);
    expect(await previewQueueSlots(ws, queueId, 2)).toEqual(before);
  });

  it('reports a body that fails the contract instead of throwing', async () => {
    const ws = await createWorkspace();
    const result = await validatePost(ws, { caption: 'no variants' });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([{ code: 'invalid_request', message: 'variants: Required' }]);
  });

  it("flags another workspace's connection exactly like one that does not exist", async () => {
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const myConn = await createConnection(mine);
    const theirConn = await createConnection(theirs);

    const result = await validatePost(mine, {
      caption: 'x',
      variants: [
        { connectionId: myConn, provider: 'fake' },
        { connectionId: theirConn, provider: 'fake' },
        { connectionId: NONEXISTENT, provider: 'fake' },
      ],
    });
    expect(result).toEqual({
      valid: false,
      issues: [
        {
          connectionId: theirConn,
          provider: 'fake',
          code: 'connection_not_found',
          message: `connection ${theirConn} not found`,
        },
        {
          connectionId: NONEXISTENT,
          provider: 'fake',
          code: 'connection_not_found',
          message: `connection ${NONEXISTENT} not found`,
        },
      ],
    });
  });

  it('agrees with createPost: what one rejects for its connection, the other flags', async () => {
    useRecordingScheduler();
    const mine = await createWorkspace('Mine');
    const theirConn = await createConnection(await createWorkspace('Theirs'));
    const body = {
      caption: 'x',
      variants: [{ connectionId: theirConn, provider: 'fake' as const }],
    };

    const verdict = await validatePost(mine, body);
    expect(verdict.issues.map((i) => i.code)).toEqual(['connection_not_found']);
    await expect(createPost(mine, body)).rejects.toThrow(verdict.issues[0]!.message);
  });

  it('flags an unknown queue, an inactive queue, and a foreign queue', async () => {
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const conn = await createConnection(mine);
    const paused = await createQueue(mine, { active: false });
    const theirQueue = await createQueue(theirs);
    const verdict = (queueId: string) =>
      validatePost(mine, {
        caption: 'x',
        variants: [{ connectionId: conn, provider: 'fake' }],
        schedule: { type: 'queue', queueId },
      });

    expect((await verdict(paused)).issues).toEqual([
      { code: 'queue_inactive', message: `queue ${paused} is not active` },
    ]);
    for (const queueId of [NONEXISTENT, theirQueue]) {
      expect((await verdict(queueId)).issues).toEqual([
        { code: 'queue_not_found', message: `queue ${queueId} not found` },
      ]);
    }
  });

  it('flags media that fails the platform spec — which createPost does not check', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const instagram = await createConnection(ws, 'instagram', 'IG', { externalId: 'ig' });
    const fake = await createConnection(ws, 'fake', 'Fake', { externalId: 'fk' });
    const png = await seedMedia(ws, 'image', { container: 'png', width: 1080, height: 1080 });
    const body = {
      caption: 'x',
      media: [{ mediaId: png, kind: 'image' as const }],
      variants: [
        { connectionId: instagram, provider: 'instagram' as const },
        { connectionId: fake, provider: 'fake' as const }, // no spec: unconstrained
      ],
    };

    const result = await validatePost(ws, body);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      connectionId: instagram,
      provider: 'instagram',
      code: 'media_rejected',
    });
    expect(result.issues[0]!.message).toMatch(/instagram images must be JPEG, got PNG/);

    // The documented gap: create accepts this post today.
    await expect(createPost(ws, body)).resolves.toHaveLength(2);
  });

  it('uses the variant media override, not the group media, when a variant has one', async () => {
    const ws = await createWorkspace();
    const instagram = await createConnection(ws, 'instagram', 'IG', { externalId: 'ig' });
    const png = await seedMedia(ws, 'image', { container: 'png', width: 1080, height: 1080 });
    const jpeg = await seedMedia(ws, 'image', { container: 'jpeg', width: 1080, height: 1080 });

    expect(
      await validatePost(ws, {
        caption: 'x',
        media: [{ mediaId: png, kind: 'image' }],
        variants: [
          {
            connectionId: instagram,
            provider: 'instagram',
            media: [{ mediaId: jpeg, kind: 'image' }],
          },
        ],
      }),
    ).toEqual({ valid: true, issues: [] });
  });

  it('flags a media ref that resolves to nothing, but not one that carries its own url', async () => {
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const conn = await createConnection(mine);
    const theirMedia = await seedMedia(theirs, 'image', { container: 'jpeg' });

    const result = await validatePost(mine, {
      caption: 'x',
      media: [
        { mediaId: NONEXISTENT, kind: 'image' },
        { mediaId: theirMedia, kind: 'image' },
        { mediaId: NONEXISTENT, kind: 'image', url: 'https://cdn.example/own.jpg' },
      ],
      variants: [{ connectionId: conn, provider: 'fake' }],
    });
    expect(result.issues).toEqual([
      {
        connectionId: conn,
        provider: 'fake',
        code: 'media_not_found',
        message: `media ${NONEXISTENT} not found`,
      },
      {
        connectionId: conn,
        provider: 'fake',
        code: 'media_not_found',
        message: `media ${theirMedia} not found`,
      },
    ]);
  });

  it('reports every problem of a request together', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const result = await validatePost(ws, {
      caption: 'x',
      media: [{ mediaId: NONEXISTENT, kind: 'image' }],
      variants: [
        { connectionId: conn, provider: 'fake' },
        { connectionId: NONEXISTENT, provider: 'fake' },
      ],
      schedule: { type: 'queue', queueId: NONEXISTENT },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual([
      'connection_not_found',
      'queue_not_found',
      'media_not_found',
      'media_not_found',
    ]);
  });
});
