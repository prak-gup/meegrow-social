import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { createPost, getPost, listPosts, updatePost } from './posts.js';
import { publishPost } from './publish.js';
import { registerProvider } from '../providers/registry.js';
import { ProviderBadRequestError } from '../errors.js';
import type { AuthTokens, PostDetails, PostResult, SocialProvider } from '../providers/types.js';

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  registerProvider(stubGmb);
});
beforeEach(() => {
  received.length = 0;
  rejectWith = null;
  return resetDb();
});
afterAll(closeDb);

/** What the provider was handed at publish time — proves options survive the round trip. */
const received: PostDetails[][] = [];
/** Set to make the stub's `assertPublishable` reject, standing in for a real platform rule. */
let rejectWith: string | null = null;

/**
 * A stand-in for the real GBP provider (#21), registered under `gmb` because that identifier is
 * already mapped to the `gmb` options arm. Exists to test the #44 wiring — create-time validation
 * and options reaching `post()` — without waiting on the real provider or its API approvals.
 */
const stubGmb: SocialProvider = {
  identifier: 'gmb',
  displayName: 'GBP (stub)',
  isBetweenSteps: false,
  tokenModel: 'auto-refresh',
  maxConcurrentJobs: 1,
  async generateAuthUrl() {
    return { url: 'https://example.test/auth' };
  },
  async authenticate(): Promise<AuthTokens> {
    throw new Error('not exercised');
  },
  async refreshToken(): Promise<AuthTokens> {
    throw new Error('not exercised');
  },
  assertPublishable(): void {
    if (rejectWith) throw new ProviderBadRequestError(rejectWith);
  },
  async post(_tokens, details): Promise<PostResult> {
    received.push(details);
    return { externalPostId: 'gmb-post-1', releaseUrl: 'https://maps.test/post/1' };
  },
  async postAnalytics() {
    return [];
  },
  async accountAnalytics() {
    return [];
  },
};

const GMB_OPTIONS = {
  kind: 'gmb',
  topicType: 'EVENT',
  cta: { actionType: 'LEARN_MORE', url: 'https://valueplusretail.com/sale' },
} as const;

describe('per-platform options persistence (#44)', () => {
  it('stores options on create and returns them in the post view', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'gmb');

    const [post] = await createPost(ws, {
      caption: 'Diwali sale',
      media: [],
      variants: [{ connectionId, provider: 'gmb', options: GMB_OPTIONS }],
      schedule: { type: 'draft' },
    });

    expect(post!.options).toMatchObject({ kind: 'gmb', topicType: 'EVENT' });
    expect((await getPost(ws, post!.id))?.options).toMatchObject({ topicType: 'EVENT' });
  });

  it('does not inherit options across variants — they are per-platform by definition', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const gmbConn = await createConnection(ws, 'gmb');
    const fakeConn = await createConnection(ws, 'fake');

    const posts = await createPost(ws, {
      caption: 'Diwali sale',
      media: [],
      variants: [
        { connectionId: gmbConn, provider: 'gmb', options: GMB_OPTIONS },
        { connectionId: fakeConn, provider: 'fake' },
      ],
      schedule: { type: 'draft' },
    });

    const fakePost = posts.find((p) => p.provider === 'fake');
    expect(fakePost!.options).toBeNull();
  });
});

describe('create-time validation (#44)', () => {
  it("surfaces the provider's own rejection as ProviderBadRequestError, before anything is stored", async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'gmb');
    rejectWith = 'an EVENT post needs event dates';

    await expect(
      createPost(ws, {
        caption: 'Diwali sale',
        media: [],
        variants: [{ connectionId, provider: 'gmb', options: GMB_OPTIONS }],
        schedule: { type: 'at', publishAt: new Date(Date.now() + 60_000) },
      }),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);

    // The whole point of validating at create time: nothing persisted, nothing scheduled.
    expect(await listPosts(ws)).toHaveLength(0);
  });

  it('rejects an options patch whose arm does not match the stored provider', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'gmb');
    const [post] = await createPost(ws, {
      caption: 'Diwali sale',
      media: [],
      variants: [{ connectionId, provider: 'gmb', options: GMB_OPTIONS }],
      schedule: { type: 'draft' },
    });

    // The patch carries no provider, so only the stored row can catch this.
    await expect(
      updatePost(ws, post!.id, { options: { kind: 'youtube', title: 'wrong platform' } }),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
  });

  it('persists a valid options patch on a draft', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'gmb');
    const [post] = await createPost(ws, {
      caption: 'Diwali sale',
      media: [],
      variants: [{ connectionId, provider: 'gmb', options: GMB_OPTIONS }],
      schedule: { type: 'draft' },
    });

    const updated = await updatePost(ws, post!.id, {
      options: { kind: 'gmb', topicType: 'OFFER' },
    });
    expect(updated?.options).toMatchObject({ kind: 'gmb', topicType: 'OFFER' });
  });
});

describe('publish hands options to the provider (#44)', () => {
  it('gives the provider real Dates, not the strings jsonb round-trips to', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'gmb');
    const [post] = await createPost(ws, {
      caption: 'Diwali sale',
      media: [],
      variants: [
        {
          connectionId,
          provider: 'gmb',
          options: {
            kind: 'gmb',
            topicType: 'EVENT',
            event: {
              title: 'Diwali sale',
              start: '2026-08-01T10:00:00.000Z',
              end: '2026-08-02T10:00:00.000Z',
            },
          },
        },
      ],
      schedule: { type: 'now' },
    });

    await publishPost(ws, post!.id);

    const opts = received[0]![0]!.options;
    expect(opts?.kind).toBe('gmb');
    // `z.coerce.date()` produces a Date on the way in; jsonb serialises it to a string. If the read
    // path only casts, the provider gets a string and any .getTime() blows up at publish time.
    expect(opts?.kind === 'gmb' && opts.event?.start).toBeInstanceOf(Date);
  });

  it('replays the stored options verbatim into post()', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'gmb');
    const [post] = await createPost(ws, {
      caption: 'Diwali sale',
      media: [],
      variants: [{ connectionId, provider: 'gmb', options: GMB_OPTIONS }],
      schedule: { type: 'now' },
    });

    const outcome = await publishPost(ws, post!.id);

    expect(outcome.status).toBe('published');
    expect(received).toHaveLength(1);
    expect(received[0]![0]!.options).toMatchObject({
      kind: 'gmb',
      topicType: 'EVENT',
      cta: { actionType: 'LEARN_MORE' },
    });
  });

  it('leaves options undefined for a provider that carries none', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'gmb');
    const [post] = await createPost(ws, {
      caption: 'plain post',
      media: [],
      variants: [{ connectionId, provider: 'gmb' }],
      schedule: { type: 'now' },
    });

    await publishPost(ws, post!.id);
    expect(received[0]![0]!.options).toBeUndefined();
  });
});
