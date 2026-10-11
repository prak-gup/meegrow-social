import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@meegrow-social/db';
import type * as DbModule from '@meegrow-social/db';
import { setScheduler, type Scheduler } from './scheduler.js';
import { cancelPost, PostStateError, retryPost, updatePost } from './posts.js';

/**
 * An imported post is already live on the platform. These show that no lifecycle call can move it
 * towards publishing: each one refuses it for being imported — before looking at its status — and
 * neither writes the row nor touches the scheduler. Driven against a stand-in for `withWorkspace`
 * (no Postgres in unit tests); the same refusals against real rows, and the database's own check
 * constraint, are in post-import.integration.test.ts.
 */
const basePost = {
  id: 'post-1',
  workspaceId: 'ws-1',
  groupId: 'group-1',
  connectionId: 'conn-1',
  provider: 'facebook',
  status: 'published',
  source: 'imported',
  caption: 'Flu clinic opens Monday',
  media: [],
  options: null,
  publishAt: new Date('2026-10-01T09:00:00.000Z') as Date | null,
  releaseUrl: 'https://www.facebook.com/1112223334_9',
  externalPostId: '1112223334_9',
  error: null as string | null,
  queueId: null,
  platformRemovedAt: null,
  createdAt: new Date('2026-10-11T08:00:00.000Z'),
};

const state = { post: { ...basePost }, writes: [] as Array<Record<string, unknown>> };

function fakeTx() {
  const rows = () => {
    const result = Promise.resolve([state.post]);
    return Object.assign(result, { for: () => result });
  };
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: rows }) }) }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        const run = async () => {
          state.writes.push({ table, ...values });
          return [{ ...state.post, ...values }];
        };
        return { where: () => Object.assign(run(), { returning: run }) };
      },
    }),
    insert: () => ({ values: async () => undefined }),
  };
}

vi.mock('@meegrow-social/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  withWorkspace: async <T>(_ws: string, fn: (tx: ReturnType<typeof fakeTx>) => Promise<T>) =>
    fn(fakeTx()),
}));

const scheduler = {
  schedulePublish: vi.fn(async () => {}),
  cancelPublish: vi.fn(async () => {}),
  publishJobState: vi.fn(async () => 'none' as const),
} satisfies Scheduler;

beforeEach(() => {
  state.post = { ...basePost };
  state.writes = [];
  vi.clearAllMocks();
  setScheduler(scheduler);
});

const untouched = () => {
  expect(state.writes).toEqual([]);
  expect(scheduler.schedulePublish).not.toHaveBeenCalled();
  expect(scheduler.cancelPublish).not.toHaveBeenCalled();
};

/** Every status, not only `published`: the refusal must not depend on the status being right. */
const STATUSES = ['published', 'failed', 'scheduled', 'draft', 'publishing', 'cancelled'];

describe.each(STATUSES)('an imported post that reads %s', (status) => {
  beforeEach(() => {
    state.post = { ...basePost, status };
  });

  it('cannot be retried', async () => {
    await expect(retryPost('ws-1', 'post-1')).rejects.toThrow(PostStateError);
    await expect(retryPost('ws-1', 'post-1')).rejects.toThrow(/imported post cannot be retried/);
    untouched();
  });

  it('cannot be edited, rescheduled or moved back to draft', async () => {
    const future = new Date(Date.now() + 3_600_000);
    for (const patch of [{ caption: 'new' }, { publishAt: future }, { publishAt: null }]) {
      await expect(updatePost('ws-1', 'post-1', patch)).rejects.toThrow(
        /imported post cannot be edited or rescheduled/,
      );
    }
    untouched();
  });

  it('cannot be cancelled', async () => {
    await expect(cancelPost('ws-1', 'post-1')).rejects.toThrow(
      /imported post cannot be cancelled: it was published on the platform, not by this app/,
    );
    untouched();
  });
});

describe('the same calls on a post of this app are unaffected', () => {
  it('retries a failed post through the scheduler', async () => {
    state.post = { ...basePost, source: 'app', status: 'failed', error: 'boom', publishAt: null };
    await retryPost('ws-1', 'post-1');
    expect(scheduler.schedulePublish).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      postId: 'post-1',
      when: 'now',
    });
    expect(state.writes[0]).toMatchObject({ table: schema.posts, status: 'scheduled' });
  });

  it('cancels a scheduled post', async () => {
    state.post = { ...basePost, source: 'app', status: 'scheduled' };
    expect(await cancelPost('ws-1', 'post-1')).toBe(true);
    expect(scheduler.cancelPublish).toHaveBeenCalledWith({ postId: 'post-1' });
  });

  it('still refuses a published post of this app for its status, as before', async () => {
    state.post = { ...basePost, source: 'app' };
    await expect(retryPost('ws-1', 'post-1')).rejects.toThrow(
      "a 'published' post cannot be retried",
    );
  });
});
