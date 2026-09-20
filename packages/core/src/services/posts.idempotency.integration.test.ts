import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import {
  createConnection,
  createQueue,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import { createPost } from './posts.js';

/**
 * Idempotent create (D2). The guarantee under test: a caller that retries a create with the same
 * key gets the FIRST call's posts back and nothing new is written — including when both attempts
 * are in flight at once, which is the case a select-then-insert check cannot cover on its own.
 *
 * These run against real Postgres deliberately. The guarantee lives in a partial unique index and
 * a 23505 rescue; a fake repository would happily "pass" this file while production duplicated
 * posts (the lesson of PR #47 — a fake must never define a more permissive contract than the
 * adapter it stands in for).
 */

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://prakhar@localhost:5432/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const KEY = 'autopost:jedh:2026-09-21T06:00';

async function groupCount(): Promise<number> {
  const rows = await db().select({ id: schema.postGroups.id }).from(schema.postGroups);
  return rows.length;
}
async function postCount(): Promise<number> {
  const rows = await db().select({ id: schema.posts.id }).from(schema.posts);
  return rows.length;
}

function draft(connectionId: string, caption = 'hello') {
  return {
    caption,
    media: [],
    variants: [{ connectionId, provider: 'fake' as const }],
    schedule: { type: 'draft' as const },
  };
}

describe('createPost — idempotency key', () => {
  it('returns the original posts on replay and writes nothing new', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);

    const first = await createPost(ws, draft(conn), { idempotencyKey: KEY });
    const second = await createPost(ws, draft(conn, 'a different caption'), {
      idempotencyKey: KEY,
    });

    expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
    // The replay is the ORIGINAL post, not a re-created one: the second call's caption is ignored.
    expect(second[0]!.caption).toBe('hello');
    expect(await groupCount()).toBe(1);
    expect(await postCount()).toBe(1);
  });

  it('keeps every child of a multi-platform group under one key', async () => {
    const ws = await createWorkspace();
    const a = await createConnection(ws, 'fake', 'A', { externalId: 'ext-a' });
    const b = await createConnection(ws, 'fake', 'B', { externalId: 'ext-b' });

    const input = {
      caption: 'multi',
      media: [],
      variants: [
        { connectionId: a, provider: 'fake' as const },
        { connectionId: b, provider: 'fake' as const },
      ],
      schedule: { type: 'draft' as const },
    };

    const first = await createPost(ws, input, { idempotencyKey: KEY });
    const replay = await createPost(ws, input, { idempotencyKey: KEY });

    // Two children, one key — the reason the key lives on post_groups and not on posts.
    expect(first).toHaveLength(2);
    expect(replay.map((p) => p.id).sort()).toEqual(first.map((p) => p.id).sort());
    expect(await postCount()).toBe(2);
  });

  it('does not deduplicate when no key is supplied', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);

    await createPost(ws, draft(conn));
    await createPost(ws, draft(conn));

    expect(await groupCount()).toBe(2);
  });

  it('treats a different key as a different request', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);

    const first = await createPost(ws, draft(conn), { idempotencyKey: KEY });
    const other = await createPost(ws, draft(conn), { idempotencyKey: `${KEY}:2` });

    expect(other[0]!.id).not.toBe(first[0]!.id);
    expect(await groupCount()).toBe(2);
  });

  it('scopes keys per workspace', async () => {
    const wsA = await createWorkspace('A');
    const wsB = await createWorkspace('B');
    const connA = await createConnection(wsA);
    const connB = await createConnection(wsB);

    const a = await createPost(wsA, draft(connA), { idempotencyKey: KEY });
    const b = await createPost(wsB, draft(connB), { idempotencyKey: KEY });

    // Same key, different tenants: neither may see or collide with the other.
    expect(b[0]!.id).not.toBe(a[0]!.id);
    expect(await groupCount()).toBe(2);
  });

  it('serves one winner when two identical creates race', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);

    // Both calls pass the pre-check before either inserts — the unique index is the only thing
    // standing between this and a duplicate post on a live account.
    const [one, two] = await Promise.all([
      createPost(ws, draft(conn), { idempotencyKey: KEY }),
      createPost(ws, draft(conn), { idempotencyKey: KEY }),
    ]);

    expect(two.map((p) => p.id)).toEqual(one.map((p) => p.id));
    expect(await groupCount()).toBe(1);
    expect(await postCount()).toBe(1);
  });

  it('schedules a replayed post exactly once', async () => {
    const { calls } = useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const publishAt = new Date(Date.now() + 3_600_000);

    const input = {
      caption: 'scheduled',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' as const }],
      schedule: { type: 'at' as const, publishAt },
    };
    const first = await createPost(ws, input, { idempotencyKey: KEY });
    await createPost(ws, input, { idempotencyKey: KEY });

    // A replay that re-enqueued would publish twice at the platform even though only one row exists.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.postId).toBe(first[0]!.id);
  });

  it('does not consume a second queue slot on replay', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const queueId = await createQueue(ws);

    const input = {
      caption: 'queued',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' as const }],
      schedule: { type: 'queue' as const, queueId },
    };
    const first = await createPost(ws, input, { idempotencyKey: KEY });
    const replay = await createPost(ws, input, { idempotencyKey: KEY });

    // Slotting is a side-effecting read: a replay that recomputed it would silently walk the
    // client's calendar forward a week per retry.
    expect(replay[0]!.publishAt?.getTime()).toBe(first[0]!.publishAt?.getTime());
    expect(await groupCount()).toBe(1);
  });

  it('stores the key on the group', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [post] = await createPost(ws, draft(conn), { idempotencyKey: KEY });

    const [group] = await db()
      .select({ key: schema.postGroups.idempotencyKey })
      .from(schema.postGroups)
      .where(eq(schema.postGroups.id, post!.groupId));
    expect(group!.key).toBe(KEY);
  });
  it('the database itself rejects a duplicate key (the rescue path depends on it)', async () => {
    const ws = await createWorkspace();
    const dup = () =>
      db().insert(schema.postGroups).values({ workspaceId: ws, caption: 'x', idempotencyKey: KEY });

    await dup();
    // Asserted at the DB, not through createPost: if this index ever stops being unique or stops
    // being applied, every test above would still pass on timing alone while production duplicated.
    await expect(dup()).rejects.toMatchObject({ code: '23505' });
  });

  it('leaves unkeyed groups unconstrained (the index is partial)', async () => {
    const ws = await createWorkspace();
    const unkeyed = () => db().insert(schema.postGroups).values({ workspaceId: ws, caption: 'x' });
    await unkeyed();
    await expect(unkeyed()).resolves.toBeDefined();
  });
});
