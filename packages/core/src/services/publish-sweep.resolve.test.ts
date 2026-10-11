import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@meegrow-social/db';
import type * as DbModule from '@meegrow-social/db';
import { abandonUnqueuedPosts, unqueuedPublishMessage } from './posts.js';
import { sweepStrandedPublishesForWorkspace } from './publish-sweep.js';
import { setScheduler, type PublishJobState } from './scheduler.js';

/**
 * The writes the sweep and the enqueue-failure handler make, against a stand-in for
 * `withWorkspace` (no Postgres in unit tests). A transaction's writes only "commit" when its
 * callback resolves. The fake evaluates no WHERE clause and takes no lock: `lockedElsewhere`
 * stands in for a row `FOR UPDATE SKIP LOCKED` would not return. The real thing is covered by
 * publish-sweep.integration.test.ts and posts.enqueue.integration.test.ts.
 */
interface Write {
  op: 'update' | 'insert';
  table: unknown;
  values: unknown;
}
interface FakePost {
  id: string;
  status: string;
  publishAt: Date | null;
  createdAt: Date;
  provider: string;
  connectionId: string;
}

const NOW = new Date('2026-10-12T09:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const state = {
  posts: [] as FakePost[],
  lockedElsewhere: new Set<string>(),
  committed: [] as Write[],
  failWrites: false,
};
/** The post the current transaction asked for — the fake's substitute for `WHERE id = ?`. */
let current: FakePost | undefined;

function fakeTx(pending: Write[]) {
  const postRows = (locking: boolean) =>
    current && !(locking && state.lockedElsewhere.has(current.id)) ? [current] : [];
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          // The candidate list: every post, in order.
          orderBy: () => ({ limit: async () => state.posts.map((p) => ({ id: p.id })) }),
          limit: () => {
            const plain = Promise.resolve(
              table === schema.posts ? postRows(false) : [{ displayName: 'City Hospital' }],
            );
            return Object.assign(plain, { for: async () => postRows(true) });
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (state.failWrites) throw new Error('connection terminated');
          pending.push({ op: 'update', table, values });
          const done = Promise.resolve();
          return Object.assign(done, {
            returning: async () => state.posts.map((p) => ({ provider: p.provider })),
          });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => void pending.push({ op: 'insert', table, values }),
    }),
  };
}

vi.mock('@meegrow-social/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  withWorkspace: async <T>(_ws: string, fn: (tx: ReturnType<typeof fakeTx>) => Promise<T>) => {
    const pending: Write[] = [];
    const out = await fn(fakeTx(pending));
    state.committed.push(...pending);
    return out;
  },
}));

const jobs = new Map<string, PublishJobState>();
const queueCalls: string[] = [];
let queueDown = false;

beforeEach(() => {
  state.posts = [];
  state.lockedElsewhere.clear();
  state.committed = [];
  state.failWrites = false;
  jobs.clear();
  queueCalls.length = 0;
  queueDown = false;
  setScheduler({
    async schedulePublish({ postId, when }) {
      if (queueDown) throw new Error('redis is down');
      queueCalls.push(`schedule ${postId} ${when === 'now' ? 'now' : when.toISOString()}`);
      jobs.set(postId, 'live');
    },
    async cancelPublish({ postId }) {
      if (queueDown) throw new Error('redis is down');
      queueCalls.push(`cancel ${postId}`);
      jobs.delete(postId);
    },
    async publishJobState({ postId }) {
      if (queueDown) throw new Error('redis is down');
      return jobs.get(postId) ?? 'none';
    },
  });
});

function post(id: string, overdueMs: number, status = 'scheduled'): FakePost {
  return {
    id,
    status,
    publishAt: ago(overdueMs),
    createdAt: ago(overdueMs + 60 * MIN),
    provider: 'facebook',
    connectionId: 'conn-1',
  };
}

/** Sweeps one post at a time, as the per-post transactions of the real sweep do. */
async function sweep(...posts: FakePost[]) {
  const totals = { examined: 0, requeued: 0, failed: 0, errors: [] as string[] };
  for (const p of posts) {
    state.posts = [p];
    current = p;
    const r = await sweepStrandedPublishesForWorkspace('ws-1', NOW);
    totals.examined += r.examined;
    totals.requeued += r.requeued;
    totals.failed += r.failed;
    totals.errors.push(...r.errors);
  }
  return totals;
}

const committedTo = (table: unknown) => state.committed.filter((w) => w.table === table);

describe('sweepStrandedPublishesForWorkspace', () => {
  it('queues a slightly-late post with no job again: cancel first, then schedule now', async () => {
    expect(await sweep(post('p1', 10 * MIN))).toMatchObject({
      examined: 1,
      requeued: 1,
      failed: 0,
    });
    expect(queueCalls).toEqual(['cancel p1', 'schedule p1 now']);
    // The post itself is not written: it stays scheduled and its new job publishes it.
    expect(committedTo(schema.posts)).toEqual([]);
    expect(committedTo(schema.jobsDlq)).toEqual([]);
    expect(committedTo(schema.eventLogs)[0]!.values).toMatchObject({
      kind: 'publish',
      status: 'requeued',
      platform: 'facebook',
      account: 'City Hospital',
    });
  });

  it('does not queue it a second time: the next sweep finds the live job', async () => {
    const p = post('p1', 10 * MIN);
    await sweep(p);
    expect(await sweep(p)).toMatchObject({ examined: 1, requeued: 0, failed: 0 });
    expect(queueCalls.filter((c) => c.startsWith('schedule'))).toHaveLength(1);
  });

  it('fails a long-overdue post with no job, with a DLQ row, and enqueues nothing', async () => {
    expect(await sweep(post('p1', 31 * 60 * MIN))).toMatchObject({ requeued: 0, failed: 1 });
    expect(queueCalls).toEqual([]);
    const message =
      'Not published: no publish job was found 31 hours after it was due, and it was not sent late automatically. Retry to publish it now.';
    expect(committedTo(schema.posts)).toEqual([
      { op: 'update', table: schema.posts, values: { status: 'failed', error: message } },
    ]);
    expect(committedTo(schema.eventLogs)[0]!.values).toMatchObject({ status: 'failed', message });
    expect(committedTo(schema.jobsDlq)[0]!.values).toEqual({
      workspaceId: 'ws-1',
      queue: 'publish',
      payload: { workspaceId: 'ws-1', postId: 'p1' },
      error: message,
    });
  });

  it('fails a post whose job died and never runs that job again', async () => {
    jobs.set('p1', 'dead');
    expect(await sweep(post('p1', 8 * MIN))).toMatchObject({ requeued: 0, failed: 1 });
    expect(queueCalls).toEqual([]);
    expect(committedTo(schema.posts)[0]!.values).toMatchObject({ status: 'failed' });
    expect(String((committedTo(schema.posts)[0]!.values as { error: string }).error)).toContain(
      'check the account before retrying',
    );
  });

  it('leaves a post with a live job alone, however overdue', async () => {
    jobs.set('p1', 'live');
    expect(await sweep(post('p1', 26 * 60 * MIN))).toEqual({
      examined: 1,
      requeued: 0,
      failed: 0,
      errors: [],
    });
    expect(queueCalls).toEqual([]);
    expect(state.committed).toEqual([]);
  });

  it('skips a post whose row is locked — it is being published right now', async () => {
    state.lockedElsewhere.add('p1');
    expect(await sweep(post('p1', 31 * 60 * MIN))).toMatchObject({ requeued: 0, failed: 0 });
    expect(queueCalls).toEqual([]);
    expect(state.committed).toEqual([]);
  });

  it('honours a status that changed after the candidate list was read', async () => {
    // Cancelled (or published) between the list and the lock: the locked row decides.
    expect(await sweep(post('p1', 31 * 60 * MIN, 'cancelled'))).toMatchObject({ failed: 0 });
    expect(state.committed).toEqual([]);
  });

  it('touches nothing when the job engine cannot be asked, and reports the post', async () => {
    queueDown = true;
    const result = await sweep(post('p1', 31 * 60 * MIN));
    expect(result).toMatchObject({ requeued: 0, failed: 0 });
    expect(result.errors).toEqual(['post p1 (workspace ws-1): redis is down']);
    expect(state.committed).toEqual([]);
  });

  it('keeps going after one post errors', async () => {
    state.failWrites = true;
    const first = await sweep(post('p1', 31 * 60 * MIN));
    expect(first.errors).toHaveLength(1);
    state.failWrites = false;
    expect(await sweep(post('p2', 31 * 60 * MIN))).toMatchObject({ failed: 1, errors: [] });
  });
});

describe('abandonUnqueuedPosts', () => {
  it('explains the failure in words a person can act on', () => {
    expect(unqueuedPublishMessage(new Error('redis is down'))).toBe(
      'Could not be queued for publishing: redis is down. Nothing was sent — retry to queue it again.',
    );
    expect(unqueuedPublishMessage(new Error(''))).toContain('unknown error');
  });

  it('marks the posts failed with the reason, logs each, and clears their jobs', async () => {
    state.posts = [post('p1', 0), post('p2', 0)];
    await abandonUnqueuedPosts('ws-1', ['p1', 'p2'], new Error('redis is down'));

    const message =
      'Could not be queued for publishing: redis is down. Nothing was sent — retry to queue it again.';
    expect(committedTo(schema.posts)).toEqual([
      { op: 'update', table: schema.posts, values: { status: 'failed', error: message } },
    ]);
    expect(committedTo(schema.eventLogs)[0]!.values).toEqual([
      { workspaceId: 'ws-1', kind: 'publish', status: 'failed', platform: 'facebook', message },
      { workspaceId: 'ws-1', kind: 'publish', status: 'failed', platform: 'facebook', message },
    ]);
    expect(queueCalls).toEqual(['cancel p1', 'cancel p2']);
  });

  it('never throws — not when the queue is still down, not when the write fails too', async () => {
    state.posts = [post('p1', 0)];
    queueDown = true;
    await expect(abandonUnqueuedPosts('ws-1', ['p1'], new Error('x'))).resolves.toBeUndefined();
    expect(committedTo(schema.posts)).toHaveLength(1);

    state.committed = [];
    state.failWrites = true;
    await expect(abandonUnqueuedPosts('ws-1', ['p1'], new Error('x'))).resolves.toBeUndefined();
    // Nothing written: the post is still `scheduled` with no job — the sweep's case.
    expect(state.committed).toEqual([]);
  });
});
