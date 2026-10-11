import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@meegrow-social/db';
import type * as DbModule from '@meegrow-social/db';
import { registerProvider } from '../providers/registry.js';
import type { SocialProvider } from '../providers/types.js';
import { EARLY_PUBLISH_TOLERANCE_MS, publishPost, publishRefusal } from './publish.js';

/**
 * The publish status guard: which posts a fired job may send. `publishRefusal` is the pure rule;
 * `publishPost` is driven against a stand-in for `withWorkspace` (no Postgres in unit tests) to
 * show a refused job never reaches the platform and never writes to the post. The row lock that
 * makes the check atomic is only real in Postgres — see publish.guard.integration.test.ts.
 */
interface Write {
  op: 'update' | 'insert';
  table: unknown;
  values: Record<string, unknown>;
}

const NOW = new Date('2026-10-12T09:00:00.000Z');
const basePost = {
  id: 'post-1',
  status: 'scheduled',
  publishAt: null as Date | null,
  provider: 'x',
  connectionId: 'conn-1',
  caption: 'visiting hours change on Monday',
  media: [],
  options: null,
  releaseUrl: null as string | null,
  source: 'app',
};

const state = {
  post: { ...basePost } as typeof basePost | undefined,
  committed: [] as Write[],
  /** True when the post row was read with FOR UPDATE. */
  locked: false,
};

function fakeTx(pending: Write[]) {
  const rows = (table: unknown) => {
    const found =
      table === schema.posts ? state.post : { id: 'conn-1', displayName: 'City Hospital' };
    const result = Promise.resolve(found ? [found] : []);
    return Object.assign(result, {
      for: () => {
        if (table === schema.posts) state.locked = true;
        return result;
      },
    });
  };
  return {
    select: () => ({
      from: (table: unknown) => ({ where: () => ({ limit: () => rows(table) }) }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => void pending.push({ op: 'update', table, values }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) =>
        void pending.push({ op: 'insert', table, values }),
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

const post = vi.fn(async () => ({ externalPostId: 'x-1', releaseUrl: 'https://x.test/p/1' }));

beforeAll(() => {
  registerProvider({
    identifier: 'x',
    displayName: 'Stub',
    isBetweenSteps: false,
    tokenModel: 'auto-refresh',
    maxConcurrentJobs: 1,
    post,
  } as unknown as SocialProvider);
});

beforeEach(() => {
  state.post = { ...basePost };
  state.committed = [];
  state.locked = false;
  post.mockClear();
});

const committedTo = (table: unknown) => state.committed.filter((w) => w.table === table);
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('publishRefusal', () => {
  it('lets a scheduled post through, with or without a publish time', () => {
    expect(publishRefusal({ status: 'scheduled', publishAt: null }, NOW)).toBeNull();
    expect(publishRefusal({ status: 'scheduled', publishAt: NOW }, NOW)).toBeNull();
    expect(publishRefusal({ status: 'scheduled', publishAt: minutes(-90) }, NOW)).toBeNull();
  });

  it.each(['cancelled', 'draft', 'failed', 'publishing', 'something-new'])(
    'refuses a %s post',
    (status) => {
      expect(publishRefusal({ status, publishAt: null }, NOW)).toBe('not_scheduled');
      expect(publishRefusal({ status, publishAt: minutes(-5) }, NOW)).toBe('not_scheduled');
    },
  );

  it('refuses a scheduled post whose time was moved later than the job that fired', () => {
    expect(publishRefusal({ status: 'scheduled', publishAt: minutes(360) }, NOW)).toBe('not_due');
  });

  it('allows a job that fires early by no more than the clock-skew tolerance', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    expect(
      publishRefusal({ status: 'scheduled', publishAt: at(EARLY_PUBLISH_TOLERANCE_MS) }, NOW),
    ).toBeNull();
    expect(
      publishRefusal({ status: 'scheduled', publishAt: at(EARLY_PUBLISH_TOLERANCE_MS + 1) }, NOW),
    ).toBe('not_due');
  });
});

describe('an imported post can never be published', () => {
  const STATUSES = ['published', 'scheduled', 'draft', 'failed', 'publishing', 'cancelled'];

  it.each(STATUSES)('publishRefusal refuses an imported post that reads %s', (status) => {
    // `scheduled` and due is the case that matters: a row that looks exactly like one to send.
    expect(publishRefusal({ status, publishAt: null, source: 'imported' }, NOW)).toBe('imported');
    expect(publishRefusal({ status, publishAt: minutes(-5), source: 'imported' }, NOW)).toBe(
      'imported',
    );
  });

  it('does not refuse a post of this app for its source', () => {
    expect(publishRefusal({ status: 'scheduled', publishAt: null, source: 'app' }, NOW)).toBeNull();
  });

  it.each(STATUSES)(
    'publishPost never calls the provider for an imported post that reads %s',
    async (status) => {
      state.post = {
        ...basePost,
        status,
        source: 'imported',
        releaseUrl: 'https://www.facebook.com/1112223334_9',
      };
      expect(await publishPost('ws-1', 'post-1', NOW)).toEqual({
        postId: 'post-1',
        status: 'skipped',
        skipped: 'imported',
      });
      expect(post).not.toHaveBeenCalled();
      // The post row is not written at all — not published "again", not failed.
      expect(committedTo(schema.posts)).toEqual([]);
      expect(committedTo(schema.eventLogs)[0]!.values).toMatchObject({
        kind: 'publish',
        status: 'skipped',
        message:
          'Publish job ignored: the post was imported from the platform and is never published by this app',
      });
    },
  );
});

describe('publishPost status guard', () => {
  it('publishes a scheduled post, reading it under a row lock', async () => {
    expect(await publishPost('ws-1', 'post-1', NOW)).toMatchObject({ status: 'published' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(state.locked).toBe(true);
  });

  it.each(['cancelled', 'draft', 'failed', 'publishing'])(
    'does not send a %s post, leaves it untouched, and ends without an error',
    async (status) => {
      state.post = { ...basePost, status };
      expect(await publishPost('ws-1', 'post-1', NOW)).toEqual({
        postId: 'post-1',
        status: 'skipped',
        skipped: 'not_scheduled',
      });
      expect(post).not.toHaveBeenCalled();
      // Not marked failed, not anything: the post keeps the status its owner gave it.
      expect(committedTo(schema.posts)).toEqual([]);
      expect(committedTo(schema.eventLogs)).toHaveLength(1);
      expect(committedTo(schema.eventLogs)[0]!.values).toMatchObject({
        kind: 'publish',
        status: 'skipped',
        platform: 'x',
        account: 'City Hospital',
        message: `Publish job ignored: the post is '${status}', not 'scheduled'`,
      });
    },
  );

  it('does not send a post rescheduled to later; it stays scheduled for its new time', async () => {
    state.post = { ...basePost, publishAt: minutes(360) };
    expect(await publishPost('ws-1', 'post-1', NOW)).toMatchObject({
      status: 'skipped',
      skipped: 'not_due',
    });
    expect(post).not.toHaveBeenCalled();
    expect(committedTo(schema.posts)).toEqual([]);
  });

  it('reports an already-published post as published without sending it again', async () => {
    state.post = { ...basePost, status: 'published', releaseUrl: 'https://x.test/p/1' };
    expect(await publishPost('ws-1', 'post-1', NOW)).toEqual({
      postId: 'post-1',
      status: 'published',
      releaseUrl: 'https://x.test/p/1',
    });
    expect(post).not.toHaveBeenCalled();
    expect(state.committed).toEqual([]);
  });
});
