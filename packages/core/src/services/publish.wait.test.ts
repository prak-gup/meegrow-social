import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@meegrow-social/db';
import type * as DbModule from '@meegrow-social/db';
import { ProviderRateLimitError, ProviderTransientError } from '../errors.js';
import { publishPost } from './publish.js';
import { rateLimitWaitMessage, readRateLimitWait } from './publish-rate-limit.js';

const due = new Date('2026-10-12T00:00:00Z');
const send = vi.fn();
const state = {
  post: {
    id: 'post-1',
    connectionId: 'conn-1',
    provider: 'telegram',
    caption: 'Hello',
    media: [],
    options: null,
    status: 'scheduled',
    source: 'local',
    publishAt: due as Date | null,
    createdAt: due,
    error: null as string | null,
    releaseUrl: null,
  },
  logs: [] as Record<string, unknown>[],
  locked: false,
};

vi.mock('../providers/registry.js', () => ({ getProvider: () => ({ post: send }) }));
vi.mock('../crypto.js', () => ({ decryptToken: () => 'TEST_ONLY_NOT_A_CREDENTIAL' }));
vi.mock('./media.js', () => ({ resolveMediaRefs: async () => [] }));
vi.mock('@meegrow-social/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>) => {
    const writes: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const tx = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => {
              const rows = Promise.resolve(
                table === schema.posts
                  ? [{ ...state.post }]
                  : [
                      {
                        id: 'conn-1',
                        displayName: 'Test account',
                        externalId: 'test-account',
                        accessToken: null,
                      },
                    ],
              );
              return Object.assign(rows, {
                for: (lock: string) => {
                  state.locked = lock === 'update';
                  return rows;
                },
              });
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            writes.push(values);
          },
        }),
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          logs.push(values);
        },
      }),
    };
    try {
      const result = await fn(tx);
      for (const write of writes) Object.assign(state.post, write);
      state.logs.push(...logs);
      return result;
    } finally {
      state.locked = false;
    }
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(state.post, {
    status: 'scheduled',
    error: null,
    publishAt: due,
    createdAt: due,
    source: 'local',
  });
  state.logs = [];
});

describe('publish waiting state under the publish guard', () => {
  it('commits a truthful scheduled note under the lock and refuses to send before its timer', async () => {
    send.mockImplementation(async () => {
      expect(state.locked).toBe(true);
      throw new ProviderRateLimitError('limited', 3600_000);
    });
    const result = await publishPost('ws-1', 'post-1', due);
    expect(result).toMatchObject({
      status: 'waiting',
      retryAt: new Date(due.getTime() + 3600_000),
    });
    expect(state.post.status).toBe('scheduled');
    expect(state.post.publishAt).toEqual(due);
    expect(readRateLimitWait(state.post.error)?.pauses).toBe(1);
    expect(state.logs[0]?.status).toBe('rate_limited');
    expect(await publishPost('ws-1', 'post-1', new Date(due.getTime() + 1000))).toMatchObject({
      status: 'waiting',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('increments pauses, preserves them through ordinary transient rollback, and clears the note after success', async () => {
    send.mockRejectedValue(new ProviderRateLimitError('limited'));
    const first = await publishPost('ws-1', 'post-1', due);
    expect(first.retryAt).toEqual(new Date(due.getTime() + 120_000));
    const second = await publishPost('ws-1', 'post-1', first.retryAt);
    expect(second.retryAt).toEqual(new Date(due.getTime() + 360_000));
    const note = state.post.error;
    send.mockRejectedValue(new ProviderTransientError('503'));
    await expect(publishPost('ws-1', 'post-1', second.retryAt)).rejects.toThrow('503');
    expect(state.post.error).toBe(note);
    expect(state.post.status).toBe('scheduled');
    send.mockResolvedValue({ externalPostId: 'test-post' });
    expect(await publishPost('ws-1', 'post-1', second.retryAt)).toMatchObject({
      status: 'published',
    });
    expect(state.post.error).toBeNull();
    const count = send.mock.calls.length;
    await publishPost('ws-1', 'post-1', second.retryAt);
    expect(send).toHaveBeenCalledTimes(count);
  });
  it('starts a platform wait at response time, after a slow request', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(due);
      send.mockImplementation(async () => {
        vi.setSystemTime(new Date(due.getTime() + 300_000));
        throw new ProviderRateLimitError('limited', 600_000);
      });
      expect(await publishPost('ws-1', 'post-1')).toMatchObject({
        status: 'waiting',
        retryAt: new Date(due.getTime() + 900_000),
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('fails at the persisted deadline without contacting the provider', async () => {
    const deadline = new Date(due.getTime() + 12 * 3600_000);
    state.post.error = rateLimitWaitMessage('telegram', { retryAt: deadline, deadline, pauses: 5 });
    expect(await publishPost('ws-1', 'post-1', deadline)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Rate limited by telegram — try again'),
    });
    expect(state.post.status).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'draft', 'failed'])('does not revive a %s waiting post', async (status) => {
    state.post.status = status;
    state.post.error = rateLimitWaitMessage('telegram', {
      retryAt: due,
      deadline: new Date(due.getTime() + 12 * 3600_000),
      pauses: 1,
    });
    expect(await publishPost('ws-1', 'post-1', due)).toMatchObject({ status: 'skipped' });
    expect(send).not.toHaveBeenCalled();
  });
});
