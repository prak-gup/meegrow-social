import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import {
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { decryptToken } from '../crypto.js';
import { ProviderAuthError } from '../errors.js';
import type { SafeFetchOptions, SafeResponse } from '../net/safe-fetch.js';
import { registerProvider } from '../providers/registry.js';
import { decodeSlackCredentials, SlackProvider } from '../providers/slack/slack.js';
import { resetAttemptStore } from './auth-throttle.js';
import { listConnections } from './connections.js';
import { connectWithCredentials } from './credential-connect.js';
import { createPost, getPost } from './posts.js';
import { publishPost } from './publish.js';
import { validatePost } from './validate-post.js';

/**
 * Slack through the service layer against real Postgres: connect (probe, then store encrypted),
 * the dry run, a publish that has NO link and NO platform id to record, and a removed webhook.
 * Slack itself is a stub — the same documentation-built shapes as providers/slack/slack.test.ts.
 *
 * NEVER EXECUTED BY ITS AUTHOR: this file was written without access to a database (the build
 * that added it was forbidden to connect to one). CI is its first run.
 */

const SECRET = 'XXXXXXXXXXXXsecretXXXXXX';
const URL_ = `https://hooks.slack.com/services/T00000000/B00000000/${SECRET}`;
const IP = '203.0.113.7';

let seen: Array<Record<string, unknown>> = [];
/** How the stub answers a real message: `[http status, body]`. An empty payload gets `no_text`. */
let message: [number, string];

async function stubSlack(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
  if (url !== URL_) throw new Error('no stub for that request');
  const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
  seen.push(payload);
  const [status, body] = payload.text === undefined ? [400, 'no_text'] : message;
  return { status, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body), url };
}

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  // Not registered by default (SLACK_ENABLED is off); vitest isolates the registry per file.
  registerProvider(new SlackProvider({ fetchImpl: stubSlack }));
});
beforeEach(async () => {
  await resetDb();
  resetAttemptStore();
  seen = [];
  message = [200, 'ok'];
});
afterAll(closeDb);

async function connect() {
  const ws = await createWorkspace();
  const result = await connectWithCredentials(
    ws,
    'slack',
    { webhookUrl: URL_, label: '#announcements' },
    IP,
  );
  if (!result.ok) throw new Error('expected a connection');
  return { ws, connectionId: result.connectionId };
}

describe('Slack — connect', () => {
  it('probes the webhook without posting, then stores its address encrypted', async () => {
    const { ws } = await connect();
    const [row] = await withWorkspace(ws, (tx) => tx.select().from(schema.connections));
    expect(row).toMatchObject({
      provider: 'slack',
      externalId: 'T00000000/B00000000',
      displayName: '#announcements',
      tokenModel: 'one-time',
      refreshToken: null,
      expiresAt: null,
      importState: null,
    });
    expect(row!.accessToken).not.toContain(SECRET);
    expect(decodeSlackCredentials(decryptToken(row!.accessToken!))).toEqual({
      team: 'T00000000',
      hook: 'B00000000',
      secret: SECRET,
    });
    expect(JSON.stringify(await listConnections(ws))).not.toContain(SECRET);
    expect(seen).toEqual([{}]);
  });

  it('stores nothing for a webhook Slack does not know, and never repeats its address', async () => {
    const ws = await createWorkspace();
    const dead = new SlackProvider({
      fetchImpl: async (url) => ({
        status: 404,
        headers: {},
        body: Buffer.from('no_service'),
        url,
      }),
    });
    registerProvider(dead);
    try {
      const err = await connectWithCredentials(
        ws,
        'slack',
        { webhookUrl: URL_, label: '#announcements' },
        IP,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderAuthError);
      expect((err as Error).message).not.toContain(SECRET);
      expect(await listConnections(ws)).toHaveLength(0);
    } finally {
      registerProvider(new SlackProvider({ fetchImpl: stubSlack }));
    }
  });
});

describe('Slack — validate and publish', () => {
  it('the dry run says a video cannot be sent, per account', async () => {
    const { ws, connectionId } = await connect();
    const result = await validatePost(ws, {
      caption: 'launch video',
      media: [
        {
          mediaId: '11111111-1111-4111-8111-111111111111',
          kind: 'video',
          url: 'https://media.example.com/v.mp4',
        },
      ],
      variants: [{ connectionId, provider: 'slack' }],
      schedule: { type: 'draft' },
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({ connectionId, code: 'not_publishable' });
    expect(result.issues[0]!.message).toMatch(/cannot send video/);
  });

  it('publishes a message that has no link and no platform id, and says so on the log', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    const [post] = await createPost(ws, {
      caption: '<!channel> lunch & learn at 1',
      media: [],
      variants: [{ connectionId, provider: 'slack' }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome.status).toBe('published');
    expect(outcome.releaseUrl).toBeUndefined();

    const [stored] = await withWorkspace(ws, (tx) =>
      tx.select().from(schema.posts).where(eq(schema.posts.id, post!.id)),
    );
    expect(stored).toMatchObject({ status: 'published', releaseUrl: null, externalPostId: null });
    // The API's view of the post is still a valid one.
    expect(await getPost(ws, post!.id)).toMatchObject({ status: 'published', releaseUrl: null });

    const [logged] = await withWorkspace(ws, (tx) =>
      tx
        .select()
        .from(schema.eventLogs)
        .where(eq(schema.eventLogs.kind, 'publish'))
        .orderBy(desc(schema.eventLogs.createdAt))
        .limit(1),
    );
    expect(logged!.status).toBe('published');
    expect(logged!.message).toMatch(/reports no link to the message/);
    expect(logged!.message).not.toMatch(/^undefined/);

    expect(seen.at(-1)).toMatchObject({
      text: '&lt;!channel&gt; lunch &amp; learn at 1',
    });
  });

  it('marks the connection for reconnect when the webhook was removed', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    message = [404, 'no_service'];
    const [post] = await createPost(ws, {
      caption: 'hello',
      media: [],
      variants: [{ connectionId, provider: 'slack' }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).not.toContain(SECRET);
    expect((await listConnections(ws))[0]!.health).toBe('needs_reconnect');
  });
});
