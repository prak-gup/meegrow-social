import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { decodeDiscordCredentials, DiscordProvider } from '../providers/discord/discord.js';
import { registerProvider } from '../providers/registry.js';
import { resetAttemptStore } from './auth-throttle.js';
import { listConnections } from './connections.js';
import { connectWithCredentials } from './credential-connect.js';
import { createPost } from './posts.js';
import { publishPost } from './publish.js';
import { validatePost } from './validate-post.js';

/**
 * Discord through the service layer against real Postgres: connect (verify, then store
 * encrypted), the dry run, publish, and a deleted webhook. Discord itself is a stub — the same
 * documentation-built shapes as providers/discord/discord.test.ts.
 *
 * NEVER EXECUTED BY ITS AUTHOR: this file was written without access to a database (the build
 * that added it was forbidden to connect to one). CI is its first run.
 */

const ID = '199737254929760256';
const SECRET = 'wh_SECRET_3d89bb7572e0fb30d8128367b3b1b44fecd1726de135cbe28a41f8b2';
const URL_ = `https://discord.com/api/webhooks/${ID}/${SECRET}`;
const GUILD = '199737254929760257';
const CHANNEL = '199737254929760258';
const MESSAGE = '1199737254929760259';
const IP = '203.0.113.7';

let seen: Array<{ method: string; url: string; body?: string }> = [];
/** How the stub answers the read and the execute: `[http status, body]`. */
let webhook: { get: [number, unknown]; execute: [number, unknown] };

async function stubDiscord(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const method = (options.method ?? 'GET').toUpperCase();
  seen.push({ method, url, body: typeof options.body === 'string' ? options.body : undefined });
  const reply =
    method === 'GET' && url === URL_
      ? webhook.get
      : method === 'POST' && url === `${URL_}?wait=true`
        ? webhook.execute
        : null;
  if (!reply) throw new Error('no stub for that request');
  return {
    status: reply[0],
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(reply[1])),
    url,
  };
}

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  // Not registered by default (DISCORD_ENABLED is off); vitest isolates the registry per file.
  registerProvider(new DiscordProvider({ fetchImpl: stubDiscord }));
});
beforeEach(async () => {
  await resetDb();
  resetAttemptStore();
  seen = [];
  webhook = {
    get: [
      200,
      { type: 1, id: ID, name: 'Acme Announcements', channel_id: CHANNEL, guild_id: GUILD },
    ],
    execute: [200, { id: MESSAGE, channel_id: CHANNEL }],
  };
});
afterAll(closeDb);

async function connect() {
  const ws = await createWorkspace();
  const result = await connectWithCredentials(ws, 'discord', { webhookUrl: URL_ }, IP);
  if (!result.ok) throw new Error('expected a connection');
  return { ws, connectionId: result.connectionId };
}

describe('Discord — connect', () => {
  it('reads the webhook, then stores its address encrypted under the webhook id', async () => {
    const { ws } = await connect();
    const [row] = await withWorkspace(ws, (tx) => tx.select().from(schema.connections));
    expect(row).toMatchObject({
      provider: 'discord',
      externalId: ID,
      displayName: 'Acme Announcements',
      tokenModel: 'one-time',
      refreshToken: null,
      expiresAt: null,
      importState: null,
    });
    expect(row!.accessToken).not.toContain(SECRET);
    expect(decodeDiscordCredentials(decryptToken(row!.accessToken!))).toEqual({
      id: ID,
      token: SECRET,
      guildId: GUILD,
      channelId: CHANNEL,
    });
    expect(JSON.stringify(await listConnections(ws))).not.toContain(SECRET);
    // Connecting posted nothing.
    expect(seen.map((s) => s.method)).toEqual(['GET']);
  });

  it('stores nothing for a webhook Discord does not know, and never repeats its address', async () => {
    const ws = await createWorkspace();
    webhook.get = [404, { message: 'Unknown Webhook', code: 10015 }];
    const err = await connectWithCredentials(ws, 'discord', { webhookUrl: URL_ }, IP).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect((err as Error).message).not.toContain(SECRET);
    expect(await listConnections(ws)).toHaveLength(0);
  });
});

describe('Discord — validate and publish', () => {
  it('the dry run reports the limit on the text as Discord receives it', async () => {
    const { ws, connectionId } = await connect();
    const result = await validatePost(ws, {
      caption: '*'.repeat(1500),
      media: [],
      variants: [{ connectionId, provider: 'discord' }],
      schedule: { type: 'draft' },
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({ connectionId, code: 'not_publishable' });
    expect(result.issues[0]!.message).toMatch(/3000 characters as Discord receives it/);
  });

  it('publishes a message that can ping nobody, and records its link and id', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    const [post] = await createPost(ws, {
      caption: '@everyone **sale** today',
      media: [],
      variants: [{ connectionId, provider: 'discord' }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome).toMatchObject({
      status: 'published',
      releaseUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
    });
    const [stored] = await withWorkspace(ws, (tx) =>
      tx.select().from(schema.posts).where(eq(schema.posts.id, post!.id)),
    );
    expect(stored!.externalPostId).toBe(MESSAGE);
    expect(JSON.parse(seen.at(-1)!.body!)).toEqual({
      content: '@everyone \\*\\*sale\\*\\* today',
      allowed_mentions: { parse: [] },
    });
  });

  it('marks the connection for reconnect when the webhook was deleted', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    webhook.execute = [404, { message: 'Unknown Webhook', code: 10015 }];
    const [post] = await createPost(ws, {
      caption: 'hello',
      media: [],
      variants: [{ connectionId, provider: 'discord' }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).not.toContain(SECRET);
    expect((await listConnections(ws))[0]!.health).toBe('needs_reconnect');
  });
});
