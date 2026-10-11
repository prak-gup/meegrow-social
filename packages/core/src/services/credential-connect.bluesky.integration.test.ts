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
import { BlueskyProvider } from '../providers/bluesky/bluesky.js';
import { decodeBlueskyCredentials } from '../providers/bluesky/client.js';
import { registerProvider } from '../providers/registry.js';
import { resetAttemptStore } from './auth-throttle.js';
import { listConnections } from './connections.js';
import { connectWithCredentials } from './credential-connect.js';
import { createPost } from './posts.js';
import { publishPost } from './publish.js';
import { validatePost } from './validate-post.js';

/**
 * Bluesky through the service layer against real Postgres: connect (verify, then store
 * encrypted), the dry run, publish, and a revoked app password. Bluesky itself is a stub — the
 * same documentation-built shapes as providers/bluesky/bluesky.test.ts.
 *
 * NEVER EXECUTED BY ITS AUTHOR: this file was written without access to a database (the build
 * that added it was forbidden to connect to one). CI is its first run.
 */

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const HANDLE = 'acme.bsky.social';
const PDS = 'https://morel.us-east.host.bsky.network';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const IP = '203.0.113.7';
const ACCESS = [
  Buffer.from('{"typ":"at+jwt"}').toString('base64url'),
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url'),
  'sig',
].join('.');

let seen: Array<{ method: string; url: string; body?: string }> = [];
/** How the stub PDS answers a login and a createRecord. */
let pds: { login: { status: number; body: unknown }; create: { status: number; body: unknown } };

function answer(status: number, body: unknown, url: string): SafeResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    url,
  };
}

async function stubBluesky(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const method = (options.method ?? 'GET').toUpperCase();
  seen.push({ method, url, body: typeof options.body === 'string' ? options.body : undefined });
  if (url === `https://${HANDLE}/.well-known/atproto-did`) return answer(200, DID, url);
  if (url === `https://plc.directory/${DID}`) {
    return answer(
      200,
      {
        id: DID,
        alsoKnownAs: [`at://${HANDLE}`],
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
      },
      url,
    );
  }
  if (url === `${PDS}/xrpc/com.atproto.server.createSession`) {
    return answer(pds.login.status, pds.login.body, url);
  }
  if (url === `${PDS}/xrpc/com.atproto.repo.createRecord`) {
    return answer(pds.create.status, pds.create.body, url);
  }
  throw new Error(`no stub for ${method} ${url}`);
}

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  // Not registered by default (BLUESKY_ENABLED is off); vitest isolates the registry per file.
  registerProvider(
    new BlueskyProvider({
      fetchImpl: stubBluesky,
      resolveTxt: async () => {
        throw new Error('ENOTFOUND');
      },
    }),
  );
});
beforeEach(async () => {
  await resetDb();
  resetAttemptStore();
  seen = [];
  pds = {
    login: { status: 200, body: { accessJwt: ACCESS, refreshJwt: 'r', handle: HANDLE, did: DID } },
    create: { status: 200, body: { uri: `at://${DID}/app.bsky.feed.post/3k4duaz5vfs2b` } },
  };
});
afterAll(closeDb);

async function connect() {
  const ws = await createWorkspace();
  const result = await connectWithCredentials(
    ws,
    'bluesky',
    { handle: `@${HANDLE}`, appPassword: APP_PASSWORD },
    IP,
  );
  if (!result.ok) throw new Error('expected a connection');
  return { ws, connectionId: result.connectionId };
}

describe('Bluesky — connect', () => {
  it('verifies the app password, then stores it encrypted under the account’s DID', async () => {
    const { ws } = await connect();
    const [row] = await withWorkspace(ws, (tx) => tx.select().from(schema.connections));
    expect(row).toMatchObject({
      provider: 'bluesky',
      externalId: DID,
      displayName: `@${HANDLE}`,
      tokenModel: 'one-time',
      refreshToken: null,
      expiresAt: null,
      // Bluesky has no `listPublishedPosts`, so no import is queued.
      importState: null,
    });
    expect(row!.accessToken).not.toContain(APP_PASSWORD);
    expect(decodeBlueskyCredentials(decryptToken(row!.accessToken!))).toEqual({
      did: DID,
      handle: HANDLE,
      pds: PDS,
      appPassword: APP_PASSWORD,
    });
    // Neither the session's tokens nor the password is in anything the API lists.
    const listed = JSON.stringify(await listConnections(ws));
    expect(listed).not.toContain(APP_PASSWORD);
    expect(listed).not.toContain(ACCESS);
    expect(row!.accessToken).not.toContain(ACCESS);
  });

  it('stores nothing when Bluesky refuses the password, and says nothing about it', async () => {
    const ws = await createWorkspace();
    pds.login = {
      status: 401,
      body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' },
    };
    const err = await connectWithCredentials(
      ws,
      'bluesky',
      { handle: HANDLE, appPassword: APP_PASSWORD },
      IP,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect((err as Error).message).not.toContain(APP_PASSWORD);
    expect(await listConnections(ws)).toHaveLength(0);
  });
});

describe('Bluesky — validate and publish', () => {
  it('the dry run reports the 300 character limit per account, in graphemes', async () => {
    const { ws, connectionId } = await connect();
    const variants = [{ connectionId, provider: 'bluesky' as const }];
    const fits = await validatePost(ws, {
      caption: '👍'.repeat(300),
      media: [],
      variants,
      schedule: { type: 'draft' },
    });
    expect(fits).toEqual({ valid: true, issues: [] });
    const over = await validatePost(ws, {
      caption: 'a'.repeat(301),
      media: [],
      variants,
      schedule: { type: 'draft' },
    });
    expect(over.valid).toBe(false);
    expect(over.issues).toEqual([
      {
        connectionId,
        provider: 'bluesky',
        code: 'not_publishable',
        message: 'The text is 301 characters; Bluesky takes at most 300',
      },
    ]);
  });

  it('publishes a post and records its link and at-uri', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    const [post] = await createPost(ws, {
      caption: 'नमस्ते 🙏 https://example.com/diwali #दिवाली',
      media: [],
      variants: [{ connectionId, provider: 'bluesky' }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome).toMatchObject({
      status: 'published',
      releaseUrl: `https://bsky.app/profile/${HANDLE}/post/3k4duaz5vfs2b`,
    });
    const [stored] = await withWorkspace(ws, (tx) =>
      tx.select().from(schema.posts).where(eq(schema.posts.id, post!.id)),
    );
    expect(stored!.externalPostId).toBe(`at://${DID}/app.bsky.feed.post/3k4duaz5vfs2b`);
    const create = seen.find((s) => s.url.endsWith('com.atproto.repo.createRecord'))!;
    const record = (JSON.parse(create.body!) as { record: { facets: unknown[] } }).record;
    expect(record.facets).toHaveLength(2);
  });

  it('marks the connection for reconnect when the app password was revoked', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    // Both: an earlier test may have left a session cached in the provider, in which case the
    // post is what gets refused first and the fresh login after it.
    const refused = { status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid' } };
    pds.login = refused;
    pds.create = refused;
    const [post] = await createPost(ws, {
      caption: 'hello',
      media: [],
      variants: [{ connectionId, provider: 'bluesky' }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).not.toContain(APP_PASSWORD);
    expect((await listConnections(ws))[0]!.health).toBe('needs_reconnect');
  });
});
