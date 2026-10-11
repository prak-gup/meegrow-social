import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@meegrow-social/db';
import type * as DbModule from '@meegrow-social/db';
import {
  exhaustedPublishMessage,
  PublishExhaustionError,
  recordPublishExhaustion,
} from './publish.js';

/**
 * `recordPublishExhaustion` against a stand-in for `withWorkspace` (no Postgres in unit tests).
 * Writes only "commit" when the transaction callback resolves, so a failed write leaves nothing
 * behind, as in Postgres. The fake does not evaluate WHERE clauses or take the row lock — those
 * are covered by publish.integration.test.ts.
 */
interface Write {
  op: 'update' | 'insert';
  table: unknown;
  values: Record<string, unknown>;
}

const state = {
  post: undefined as { status: string; provider: string; connectionId: string } | undefined,
  connection: { displayName: 'Acme Page' } as { displayName: string } | undefined,
  /** Errors thrown by the next writes to a table, consumed one per write. */
  failures: new Map<unknown, Error[]>(),
  committed: [] as Write[],
  transactions: 0,
};

function write(pending: Write[], w: Write): void {
  const queued = state.failures.get(w.table);
  const err = queued?.shift();
  if (err) throw err;
  pending.push(w);
}

function fakeTx(pending: Write[]) {
  const rows = (table: unknown) => {
    const found = table === schema.posts ? state.post : state.connection;
    const result = Promise.resolve(found ? [found] : []);
    return Object.assign(result, { for: () => result });
  };
  return {
    select: () => ({
      from: (table: unknown) => ({ where: () => ({ limit: () => rows(table) }) }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => write(pending, { op: 'update', table, values }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) =>
        write(pending, { op: 'insert', table, values }),
    }),
  };
}

vi.mock('@meegrow-social/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  withWorkspace: async <T>(_ws: string, fn: (tx: ReturnType<typeof fakeTx>) => Promise<T>) => {
    state.transactions += 1;
    const pending: Write[] = [];
    const out = await fn(fakeTx(pending));
    state.committed.push(...pending);
    return out;
  },
}));

const input = {
  workspaceId: 'ws-1',
  postId: 'post-1',
  queue: 'publish',
  payload: { workspaceId: 'ws-1', postId: 'post-1' },
  error: 'platform returned 503',
  attempts: 3,
};
const sleeps: number[] = [];
const sleep = async (ms: number) => void sleeps.push(ms);
const record = () => recordPublishExhaustion(input, sleep);

const committedTo = (table: unknown) => state.committed.filter((w) => w.table === table);
const failNext = (table: unknown, times: number) =>
  state.failures.set(
    table,
    Array.from({ length: times }, () => new Error('connection terminated')),
  );

beforeEach(() => {
  state.post = { status: 'scheduled', provider: 'facebook', connectionId: 'conn-1' };
  state.connection = { displayName: 'Acme Page' };
  state.failures.clear();
  state.committed = [];
  state.transactions = 0;
  sleeps.length = 0;
});

describe('exhaustedPublishMessage', () => {
  it('says how many attempts were made and why the last one failed', () => {
    expect(exhaustedPublishMessage(3, 'platform returned 503')).toBe(
      'Publishing failed after 3 attempts: platform returned 503',
    );
    expect(exhaustedPublishMessage(1, 'boom')).toBe('Publishing failed after 1 attempt: boom');
  });

  it('never ends in a bare colon when the error had no message', () => {
    expect(exhaustedPublishMessage(3, '')).toBe(
      'Publishing failed after 3 attempts: unknown error',
    );
  });
});

describe('recordPublishExhaustion', () => {
  it('marks a still-scheduled post failed with the reason, logs it, and parks the job', async () => {
    expect(await record()).toEqual({ postMarkedFailed: true, dlqRecorded: true });

    expect(committedTo(schema.posts)).toEqual([
      {
        op: 'update',
        table: schema.posts,
        values: {
          status: 'failed',
          error: 'Publishing failed after 3 attempts: platform returned 503',
        },
      },
    ]);
    expect(committedTo(schema.eventLogs)[0]!.values).toMatchObject({
      workspaceId: 'ws-1',
      kind: 'publish',
      status: 'failed',
      platform: 'facebook',
      account: 'Acme Page',
    });
    expect(committedTo(schema.jobsDlq)[0]!.values).toEqual({
      workspaceId: 'ws-1',
      queue: 'publish',
      payload: input.payload,
      error: 'platform returned 503',
    });
    expect(sleeps).toEqual([]);
  });

  it.each(['published', 'cancelled', 'draft', 'failed'])(
    'leaves a %s post exactly as it is, and still parks the job',
    async (status) => {
      state.post = { status, provider: 'facebook', connectionId: 'conn-1' };
      expect(await record()).toEqual({ postMarkedFailed: false, dlqRecorded: true });
      expect(committedTo(schema.posts)).toEqual([]);
      expect(committedTo(schema.eventLogs)).toEqual([]);
      expect(committedTo(schema.jobsDlq)).toHaveLength(1);
    },
  );

  it('marks a post left in publishing too', async () => {
    state.post = { status: 'publishing', provider: 'facebook', connectionId: 'conn-1' };
    expect((await record()).postMarkedFailed).toBe(true);
  });

  it('still parks the job when the post no longer exists', async () => {
    state.post = undefined;
    expect(await record()).toEqual({ postMarkedFailed: false, dlqRecorded: true });
    expect(committedTo(schema.posts)).toEqual([]);
  });

  it('marks the post even when its connection has been removed', async () => {
    state.connection = undefined;
    expect((await record()).postMarkedFailed).toBe(true);
    expect(committedTo(schema.eventLogs)[0]!.values.account).toBeNull();
  });

  it('re-tries a failed mark-failed write and succeeds once the database is back', async () => {
    failNext(schema.posts, 2);
    expect(await record()).toEqual({ postMarkedFailed: true, dlqRecorded: true });
    expect(sleeps).toEqual([250, 1000]);
    expect(committedTo(schema.posts)).toHaveLength(1);
    // One event-log row, not three: the failed tries rolled back whole.
    expect(committedTo(schema.eventLogs)).toHaveLength(1);
  });

  it('still parks the job when the post cannot be marked, then reports the post', async () => {
    failNext(schema.posts, 3);
    const err = await record().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishExhaustionError);
    expect((err as PublishExhaustionError).postId).toBe('post-1');
    expect((err as PublishExhaustionError).outcome).toEqual({
      postMarkedFailed: false,
      dlqRecorded: true,
    });
    expect((err as Error).message).toContain('connection terminated');
    expect(committedTo(schema.posts)).toEqual([]);
    expect(committedTo(schema.jobsDlq)).toHaveLength(1);
  });

  it('still marks the post when the DLQ write cannot be made, then reports it', async () => {
    failNext(schema.jobsDlq, 3);
    const err = await record().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishExhaustionError);
    expect((err as PublishExhaustionError).outcome).toEqual({
      postMarkedFailed: true,
      dlqRecorded: false,
    });
    expect(committedTo(schema.posts)).toHaveLength(1);
    expect(committedTo(schema.jobsDlq)).toEqual([]);
  });
});
