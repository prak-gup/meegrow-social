import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { registerProvider } from '../providers/registry.js';
import type { AuthTokens, PostResult, SocialProvider } from '../providers/types.js';
import { cancelPost, createPost, getPost, PostStateError, updatePost } from './posts.js';
import { publishPost } from './publish.js';

/**
 * The publish status guard against real Postgres — the part the unit test cannot show: the row
 * lock that makes "check the status" and "send the post" one step.
 */
beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  registerProvider(slow);
});
beforeEach(() => {
  sent.length = 0;
  hold = null;
  entered = null;
  return resetDb();
});
afterAll(closeDb);

/** Every caption the platform was actually handed — one entry per real publish. */
const sent: string[] = [];
/** While set, `post()` waits on it — an upload in flight that the test controls. */
let hold: Promise<void> | null = null;
/** Called when `post()` is entered, so a test can wait until the publish holds the row. */
let entered: (() => void) | null = null;

/** A platform whose `post()` can be held open, registered under `x` (no real provider yet). */
const slow: SocialProvider = {
  identifier: 'x',
  displayName: 'Slow (stub)',
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
  async post(_tokens, details): Promise<PostResult> {
    entered?.();
    if (hold) await hold;
    sent.push(details[0]!.caption);
    return { externalPostId: `x-${sent.length}`, releaseUrl: `https://x.test/p/${sent.length}` };
  },
  async postAnalytics() {
    return [];
  },
  async accountAnalytics() {
    return [];
  },
};

async function seed(ws: string, schedule: { type: 'now' } | { type: 'at'; publishAt: Date }) {
  const conn = await createConnection(ws, 'x');
  const [post] = await createPost(ws, {
    caption: 'visiting hours change on Monday',
    media: [],
    variants: [{ connectionId: conn, provider: 'x' }],
    schedule,
  });
  return post!.id;
}

/** Holds `post()` open; resolves `inFlight` once a publish is inside it. */
function holdProvider(): { inFlight: Promise<void>; release: () => void } {
  let release!: () => void;
  hold = new Promise<void>((r) => (release = r));
  const inFlight = new Promise<void>((r) => (entered = r));
  return { inFlight, release };
}

const publishLogs = (ws: string) =>
  withWorkspace(ws, (tx) => tx.select().from(schema.eventLogs)).then((rows) =>
    rows.filter((r) => r.kind === 'publish'),
  );

describe('publish status guard', () => {
  it('does not publish a post that was cancelled before its job fired', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seed(ws, { type: 'now' });

    expect(await cancelPost(ws, postId)).toBe(true);
    // The job could not be removed in time (it was already running) and fires anyway.
    const outcome = await publishPost(ws, postId);

    expect(outcome).toEqual({ postId, status: 'skipped', skipped: 'not_scheduled' });
    expect(sent).toEqual([]);
    // Still cancelled: not published, and not turned into a retryable `failed` post.
    expect(await getPost(ws, postId)).toMatchObject({ status: 'cancelled', error: null });
    expect((await publishLogs(ws)).map((l) => l.status)).toEqual(['skipped']);
  });

  it('does not publish a post that was moved back to draft', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seed(ws, { type: 'at', publishAt: new Date(Date.now() + 30_000) });

    await updatePost(ws, postId, { publishAt: null });
    expect(await publishPost(ws, postId)).toMatchObject({ status: 'skipped' });

    expect(sent).toEqual([]);
    expect(await getPost(ws, postId)).toMatchObject({ status: 'draft' });
  });

  it('does not publish early when the post was rescheduled after its job was queued', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seed(ws, { type: 'at', publishAt: new Date(Date.now() + 30_000) });
    const later = new Date(Date.now() + 6 * 3_600_000);

    await updatePost(ws, postId, { publishAt: later });
    // The original job fires at the original time.
    expect(await publishPost(ws, postId)).toMatchObject({ status: 'skipped', skipped: 'not_due' });

    expect(sent).toEqual([]);
    const post = await getPost(ws, postId);
    expect(post).toMatchObject({ status: 'scheduled' });
    expect(post!.publishAt!.getTime()).toBe(later.getTime());
  });

  it('sends a post once when two publish jobs run for it at the same time', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seed(ws, { type: 'now' });
    const { inFlight, release } = holdProvider();

    const first = publishPost(ws, postId);
    await inFlight;
    // The second job starts while the first is mid-upload and has to wait for the row.
    const second = publishPost(ws, postId);
    await new Promise((r) => setTimeout(r, 200));
    release();

    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map((o) => o.status)).toEqual(['published', 'published']);
    expect(sent).toHaveLength(1);
    expect((await publishLogs(ws)).filter((l) => l.status === 'published')).toHaveLength(1);
  });

  it('refuses a cancel that arrives while the post is being sent, and keeps it published', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seed(ws, { type: 'now' });
    const { inFlight, release } = holdProvider();

    const publishing = publishPost(ws, postId);
    await inFlight;
    const cancelling = cancelPost(ws, postId).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200));
    release();

    expect((await publishing).status).toBe('published');
    // Before the row lock this cancel overwrote the published post as `cancelled`.
    expect(await cancelling).toBeInstanceOf(PostStateError);
    expect(await getPost(ws, postId)).toMatchObject({ status: 'published' });
    expect(sent).toHaveLength(1);
  });

  it('refuses an edit that arrives while the post is being sent', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seed(ws, { type: 'now' });
    const { inFlight, release } = holdProvider();

    const publishing = publishPost(ws, postId);
    await inFlight;
    const editing = updatePost(ws, postId, { publishAt: null }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200));
    release();

    expect((await publishing).status).toBe('published');
    expect(await editing).toBeInstanceOf(PostStateError);
    expect(await getPost(ws, postId)).toMatchObject({ status: 'published' });
  });
});
