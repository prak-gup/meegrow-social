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
import { ConnectionNotFoundError, deleteConnection } from './connections.js';
import { createPost, duplicatePost, listPosts } from './posts.js';
import { previewQueueSlots } from './queues.js';

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

/** Counted on the admin handle, so nothing written under ANY workspace can hide behind RLS. */
async function rowCounts(): Promise<{ groups: number; posts: number }> {
  const [groups, posts] = await Promise.all([
    db().select({ id: schema.postGroups.id }).from(schema.postGroups),
    db().select({ id: schema.posts.id }).from(schema.posts),
  ]);
  return { groups: groups.length, posts: posts.length };
}

describe('createPost — every variant must target a connection of the workspace', () => {
  it("rejects another workspace's connection and writes nothing anywhere", async () => {
    const { calls } = useRecordingScheduler();
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const theirConn = await createConnection(theirs);

    await expect(
      createPost(mine, {
        caption: 'onto their account',
        variants: [{ connectionId: theirConn, provider: 'fake' }],
        schedule: { type: 'now' },
      }),
    ).rejects.toThrow(ConnectionNotFoundError);

    expect(await rowCounts()).toEqual({ groups: 0, posts: 0 });
    expect(calls).toEqual([]);
  });

  it('gives the same error for a foreign connection as for one that does not exist', async () => {
    useRecordingScheduler();
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const theirConn = await createConnection(theirs);

    const attempt = (connectionId: string) =>
      createPost(mine, { caption: 'x', variants: [{ connectionId, provider: 'fake' }] }).then(
        () => {
          throw new Error('expected createPost to reject');
        },
        (err: unknown) => err as Error,
      );
    const foreign = await attempt(theirConn);
    const unknown = await attempt(NONEXISTENT);

    expect(foreign).toBeInstanceOf(ConnectionNotFoundError);
    expect(unknown).toBeInstanceOf(ConnectionNotFoundError);
    // Identical but for the id the caller already supplied: nothing says the first one exists.
    expect(foreign.message).toBe(`connection ${theirConn} not found`);
    expect(unknown.message).toBe(`connection ${NONEXISTENT} not found`);
  });

  it('rejects the whole create when only one variant of several is foreign', async () => {
    const { calls } = useRecordingScheduler();
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const myConn = await createConnection(mine);
    const theirConn = await createConnection(theirs);

    await expect(
      createPost(mine, {
        caption: 'mixed',
        variants: [
          { connectionId: myConn, provider: 'fake' },
          { connectionId: theirConn, provider: 'fake' },
        ],
        schedule: { type: 'at', publishAt: new Date(Date.now() + 60_000) },
      }),
    ).rejects.toThrow(`connection ${theirConn} not found`);

    expect(await rowCounts()).toEqual({ groups: 0, posts: 0 });
    expect(calls).toEqual([]);
  });

  it('takes no queue slot when it rejects', async () => {
    useRecordingScheduler();
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const myConn = await createConnection(mine);
    const theirConn = await createConnection(theirs);
    const queueId = await createQueue(mine);
    const before = await previewQueueSlots(mine, queueId, 1);

    await expect(
      createPost(mine, {
        caption: 'x',
        variants: [{ connectionId: theirConn, provider: 'fake' }],
        schedule: { type: 'queue', queueId },
      }),
    ).rejects.toThrow(ConnectionNotFoundError);

    const [legit] = await createPost(mine, {
      caption: 'legit',
      variants: [{ connectionId: myConn, provider: 'fake' }],
      schedule: { type: 'queue', queueId },
    });
    expect(legit?.publishAt).toEqual(before.slots[0]?.publishAt);
  });

  it('still accepts a connection of its own workspace, in every schedule mode', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const queueId = await createQueue(ws);

    for (const schedule of [
      { type: 'draft' },
      { type: 'now' },
      { type: 'at', publishAt: new Date(Date.now() + 60_000) },
      { type: 'queue', queueId },
    ] as const) {
      const posts = await createPost(ws, {
        caption: schedule.type,
        variants: [{ connectionId: conn, provider: 'fake' }],
        schedule,
      });
      expect(posts, schedule.type).toHaveLength(1);
    }
    expect(await listPosts(ws)).toHaveLength(4);
  });

  it('an idempotent replay still returns its posts after the connection is gone', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const input = {
      caption: 'once',
      variants: [{ connectionId: conn, provider: 'fake' as const }],
    };
    const first = await createPost(ws, input, { idempotencyKey: 'k-1' });
    await deleteConnection(ws, conn);

    const replay = await createPost(ws, input, { idempotencyKey: 'k-1' });
    expect(replay.map((p) => p.id)).toEqual(first.map((p) => p.id));
    // A NEW create against the removed connection is refused.
    await expect(createPost(ws, input, { idempotencyKey: 'k-2' })).rejects.toThrow(
      ConnectionNotFoundError,
    );
  });

  it('duplicating a post whose connection was removed is refused the same way', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [source] = await createPost(ws, {
      caption: 'source',
      variants: [{ connectionId: conn, provider: 'fake' }],
    });
    await deleteConnection(ws, conn);

    await expect(duplicatePost(ws, source!.id)).rejects.toThrow(ConnectionNotFoundError);
    expect(await listPosts(ws)).toHaveLength(1);
  });
});
