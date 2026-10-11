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
import { registerProvider } from '../providers/registry.js';
import { decodeTelegramCredentials, TelegramProvider } from '../providers/telegram/telegram.js';
import { resetAttemptStore } from './auth-throttle.js';
import { listConnections } from './connections.js';
import { connectWithCredentials } from './credential-connect.js';
import { createPost } from './posts.js';
import { publishPost } from './publish.js';
import { validatePost } from './validate-post.js';

/**
 * Telegram through the service layer against real Postgres: connect (verify, then store
 * encrypted), the dry run, publish, and a bot that was removed. Telegram itself is a stub — the
 * same documentation-built shapes as providers/telegram/telegram.test.ts.
 *
 * NEVER EXECUTED BY ITS AUTHOR: this file was written without access to a database (the build
 * that added it was forbidden to connect to one). CI is its first run.
 */

const TOKEN = '123456789:AAF-secret_bot_token_value_0123456789abc';
const CHAT_ID = -1001234567890;
const IP = '203.0.113.7';

let seen: Array<{ method: string; params: Record<string, unknown> }> = [];
/** How the stub answers each Bot API method: `[http status, body]`. */
let bot: Record<string, [number, unknown]>;

async function stubTelegram(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const prefix = `https://api.telegram.org/bot${TOKEN}/`;
  if (!url.startsWith(prefix)) throw new Error('no stub for that request');
  const method = url.slice(prefix.length);
  seen.push({ method, params: JSON.parse(String(options.body)) as Record<string, unknown> });
  const reply = bot[method];
  if (!reply) throw new Error(`no stub for ${method}`);
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
  // Not registered by default (TELEGRAM_ENABLED is off); vitest isolates the registry per file.
  registerProvider(new TelegramProvider({ fetchImpl: stubTelegram }));
});
beforeEach(async () => {
  await resetDb();
  resetAttemptStore();
  seen = [];
  const chat = { id: CHAT_ID, type: 'channel', title: 'Acme News', username: 'acme_news' };
  bot = {
    getMe: [200, { ok: true, result: { id: 987654321, is_bot: true, username: 'acme_bot' } }],
    getChat: [200, { ok: true, result: chat }],
    getChatMember: [
      200,
      { ok: true, result: { status: 'administrator', can_post_messages: true } },
    ],
    sendMessage: [200, { ok: true, result: { message_id: 42, chat } }],
  };
});
afterAll(closeDb);

async function connect() {
  const ws = await createWorkspace();
  const result = await connectWithCredentials(
    ws,
    'telegram',
    { token: TOKEN, chat: '@acme_news' },
    IP,
  );
  if (!result.ok) throw new Error('expected a connection');
  return { ws, connectionId: result.connectionId };
}

describe('Telegram — connect', () => {
  it('verifies the bot and the channel, then stores the token encrypted under the chat id', async () => {
    const { ws } = await connect();
    const [row] = await withWorkspace(ws, (tx) => tx.select().from(schema.connections));
    expect(row).toMatchObject({
      provider: 'telegram',
      externalId: String(CHAT_ID),
      displayName: 'Acme News',
      tokenModel: 'one-time',
      refreshToken: null,
      expiresAt: null,
      importState: null,
    });
    expect(row!.accessToken).not.toContain(TOKEN);
    expect(decodeTelegramCredentials(decryptToken(row!.accessToken!))).toEqual({
      token: TOKEN,
      chatId: String(CHAT_ID),
      username: 'acme_news',
    });
    expect(JSON.stringify(await listConnections(ws))).not.toContain(TOKEN);
    expect(seen.map((s) => s.method)).toEqual(['getMe', 'getChat', 'getChatMember']);
  });

  it('stores nothing when the bot may not post in the channel', async () => {
    const ws = await createWorkspace();
    bot.getChatMember = [200, { ok: true, result: { status: 'member' } }];
    await expect(
      connectWithCredentials(ws, 'telegram', { token: TOKEN, chat: '@acme_news' }, IP),
    ).rejects.toThrow(/not an administrator/);
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('stores nothing when Telegram does not know the token, and never repeats it', async () => {
    const ws = await createWorkspace();
    bot.getMe = [401, { ok: false, error_code: 401, description: 'Unauthorized' }];
    const err = await connectWithCredentials(
      ws,
      'telegram',
      { token: TOKEN, chat: '@acme_news' },
      IP,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(await listConnections(ws)).toHaveLength(0);
  });
});

describe('Telegram — validate and publish', () => {
  it('the dry run reports the text limit per account', async () => {
    const { ws, connectionId } = await connect();
    const result = await validatePost(ws, {
      caption: 'a'.repeat(4097),
      media: [],
      variants: [{ connectionId, provider: 'telegram' }],
      schedule: { type: 'draft' },
    });
    expect(result.issues).toEqual([
      {
        connectionId,
        provider: 'telegram',
        code: 'not_publishable',
        message: 'The text is 4097 characters; Telegram takes at most 4096',
      },
    ]);
  });

  it('publishes a message and records its link and message id', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    const [post] = await createPost(ws, {
      caption: 'Open today 10 < 6 & tomorrow',
      media: [],
      variants: [{ connectionId, provider: 'telegram' }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome).toMatchObject({ status: 'published', releaseUrl: 'https://t.me/acme_news/42' });
    const [stored] = await withWorkspace(ws, (tx) =>
      tx.select().from(schema.posts).where(eq(schema.posts.id, post!.id)),
    );
    expect(stored!.externalPostId).toBe('42');
    expect(seen.at(-1)).toEqual({
      method: 'sendMessage',
      params: {
        chat_id: String(CHAT_ID),
        text: 'Open today 10 &lt; 6 &amp; tomorrow',
        parse_mode: 'HTML',
      },
    });
  });

  it('marks the connection for reconnect when the bot was removed from the channel', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    bot.sendMessage = [
      403,
      {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was kicked from the channel chat',
      },
    ];
    const [post] = await createPost(ws, {
      caption: 'hello',
      media: [],
      variants: [{ connectionId, provider: 'telegram' }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).not.toContain(TOKEN);
    expect((await listConnections(ws))[0]!.health).toBe('needs_reconnect');
  });
});
