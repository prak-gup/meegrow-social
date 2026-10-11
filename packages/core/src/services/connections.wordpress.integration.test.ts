import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createUser,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { decryptToken, signConnectFlow } from '../crypto.js';
import { ConnectError, ProviderBadRequestError } from '../errors.js';
import { registerProvider } from '../providers/registry.js';
import type { SafeFetchOptions, SafeResponse } from '../net/safe-fetch.js';
import { decodeCredentials, encodeCredentials } from '../providers/wordpress/client.js';
import { WordPressProvider } from '../providers/wordpress/wordpress.js';
import {
  completeCredentialCallback,
  getInviteFlow,
  handleCallback,
  listConnections,
  openCallbackOutcome,
  startConnect,
} from './connections.js';
import { createConnectInvite, getConnectInvite, startInviteConnect } from './invites.js';
import { createPost, updatePost } from './posts.js';
import { publishPost } from './publish.js';

/**
 * The WordPress connect flow against real Postgres: what the flow row holds, that the credential
 * is stored encrypted, and the binding the unit tests cannot reach — unknown / used / expired
 * state, the wrong browser, a forged site, and replay.
 *
 * NEVER EXECUTED BY ITS AUTHOR: this file was written without access to a database (the build
 * that added it was forbidden to connect to one). CI is its first run. WordPress itself is a stub
 * here — the same documentation-built shapes as providers/wordpress/wordpress.test.ts.
 */

const APP = 'https://social.meegrowlabs.com';
const SITE = 'https://blog.example.com';
const API_ROOT = `${SITE}/wp-json/`;
const NONEXISTENT = '00000000-0000-0000-0000-000000000000';
const APP_PASSWORD = 'abcd EFGH 1234 ijkl MNOP 5678';

interface Seen {
  method: string;
  url: string;
  authorization?: string;
}
let seen: Seen[] = [];
/** How the stub site answers `GET /wp/v2/users/me` and `POST /wp/v2/posts`. */
let site: { me: { status: number; body: unknown }; post: { status: number; body: unknown } };

function answer(status: number, body: unknown, url: string, headers = {}): SafeResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    url,
  };
}

async function stubSite(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const method = (options.method ?? 'GET').toUpperCase();
  seen.push({ method, url, authorization: options.headers?.authorization });
  if (!url.startsWith(SITE)) throw new Error(`unexpected request to ${url}`);
  if (method === 'HEAD') {
    return answer(200, '', url, { link: `<${API_ROOT}>; rel="https://api.w.org/"` });
  }
  if (url.includes('/wp/v2/users/me')) return answer(site.me.status, site.me.body, url);
  if (method === 'POST' && url.endsWith('/wp/v2/posts')) {
    return answer(site.post.status, site.post.body, url);
  }
  if (url.startsWith(`${API_ROOT}?_fields`)) {
    return answer(
      200,
      {
        name: 'Ecolive Blog',
        url: SITE,
        home: SITE,
        namespaces: ['wp/v2'],
        authentication: {
          'application-passwords': {
            endpoints: { authorization: `${SITE}/wp-admin/authorize-application.php` },
          },
        },
      },
      url,
    );
  }
  throw new Error(`no stub for ${method} ${url}`);
}

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  // Not registered by default (WORDPRESS_ENABLED is off); vitest isolates the registry per file.
  registerProvider(new WordPressProvider({ fetchImpl: stubSite }));
});
beforeEach(async () => {
  await resetDb();
  seen = [];
  site = {
    me: {
      status: 200,
      body: { id: 7, name: 'Priya', capabilities: { edit_posts: true, publish_posts: true } },
    },
    post: {
      status: 201,
      body: { id: 1284, status: 'publish', link: `${SITE}/2026/10/hello/` },
    },
  };
});
afterAll(closeDb);

const approved = (flowId: string, over: Record<string, string | undefined> = {}) => ({
  state: flowId,
  site_url: SITE,
  user_login: 'priya',
  password: APP_PASSWORD,
  ...over,
});

async function flowRow(flowId: string) {
  const [row] = await db().select().from(schema.oauthFlows).where(eq(schema.oauthFlows.id, flowId));
  return row!;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof ConnectError ? err.code : `not a ConnectError: ${String(err)}`;
  }
  return 'resolved';
}

describe('WordPress connect — start', () => {
  it('discovers the site, remembers which site the flow is for, and binds it to the browser', async () => {
    const ws = await createWorkspace();
    const started = await startConnect(ws, 'wordpress', APP, undefined, {
      siteUrl: 'blog.example.com',
    });

    const url = new URL(started.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${SITE}/wp-admin/authorize-application.php`);
    expect(url.searchParams.get('success_url')).toBe(
      `${APP}/connect/callback?state=${started.flowId}`,
    );
    expect(started.proof).toBe(signConnectFlow(started.flowId));

    const flow = await flowRow(started.flowId);
    expect(flow.status).toBe('pending');
    expect(flow.workspaceId).toBe(ws);
    expect(JSON.parse(flow.codeVerifier!)).toMatchObject({ siteUrl: SITE, apiRoot: API_ROOT });
    // Nothing secret exists yet, and nothing was sent with credentials.
    expect(flow.encryptedTokens).toBeNull();
    expect(seen.every((s) => s.authorization === undefined)).toBe(true);
  });

  it('burns the flow when the address is refused, so nothing is left to finish', async () => {
    const ws = await createWorkspace();
    await expect(
      startConnect(ws, 'wordpress', APP, undefined, { siteUrl: 'http://blog.example.com' }),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(startConnect(ws, 'wordpress', APP)).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );
    const flows = await db().select().from(schema.oauthFlows);
    expect(flows).toHaveLength(2);
    expect(flows.every((f) => f.status === 'consumed')).toBe(true);
  });

  it('gives an OAuth provider no proof: its flows are not browser-bound', async () => {
    const ws = await createWorkspace();
    expect((await startConnect(ws, 'fake', APP)).proof).toBeUndefined();
  });
});

describe('WordPress connect — callback', () => {
  const start = async () => {
    const ws = await createWorkspace();
    const started = await startConnect(ws, 'wordpress', APP, undefined, { siteUrl: SITE });
    seen = [];
    return { ws, flowId: started.flowId, proof: started.proof! };
  };

  it('creates the connection and stores the application password encrypted', async () => {
    const { ws, flowId, proof } = await start();
    const result = await handleCallback(flowId, '', proof, approved(flowId));
    expect(result.status).toBe('connected');

    const [view] = await listConnections(ws);
    expect(view).toMatchObject({
      provider: 'wordpress',
      externalId: SITE,
      displayName: 'Ecolive Blog',
      health: 'healthy',
      expiresAt: null,
    });
    // The view a client receives carries no credential at all.
    expect(JSON.stringify(view)).not.toContain('abcd');
    expect(JSON.stringify(view)).not.toContain('priya');

    const [row] = await withWorkspace(ws, (tx) => tx.select().from(schema.connections));
    expect(row!.tokenModel).toBe('one-time');
    expect(row!.refreshToken).toBeNull();
    // At rest: ciphertext. Neither the password nor the username is readable in the row.
    expect(JSON.stringify(row)).not.toContain('abcd');
    expect(JSON.stringify(row)).not.toContain('MNOP');
    expect(JSON.stringify(row)).not.toContain('priya');
    expect(decodeCredentials(decryptToken(row!.accessToken!))).toEqual({
      siteUrl: SITE,
      apiRoot: API_ROOT,
      username: 'priya',
      password: APP_PASSWORD,
    });

    // The flow is spent, and never held the credential.
    const flow = await flowRow(flowId);
    expect(flow.status).toBe('consumed');
    expect(flow.encryptedTokens).toBeNull();
    expect(JSON.stringify(flow)).not.toContain('abcd');
    // The password was tried once, against the site the flow was started for.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.startsWith(`${API_ROOT}wp/v2/users/me`)).toBe(true);
  });

  it('refuses a forged or malformed state without touching anything', async () => {
    const { ws, proof } = await start();
    for (const state of [NONEXISTENT, 'not-a-uuid', '', "'; DROP TABLE oauth_flows; --"]) {
      expect(await code(handleCallback(state, '', proof, approved(state)))).toBe('invalid_state');
    }
    expect(await listConnections(ws)).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it('refuses a callback from any browser but the one that started the flow, and burns the flow', async () => {
    const { ws, flowId, proof } = await start();
    // Someone who learned the flow id (it is in the URL the site was sent) but holds no cookie.
    expect(await code(handleCallback(flowId, '', undefined, approved(flowId)))).toBe(
      'different_browser',
    );
    expect(seen).toHaveLength(0);
    // Burned: the genuine redirect arriving afterwards connects nothing either.
    expect(await code(handleCallback(flowId, '', proof, approved(flowId)))).toBe('invalid_state');
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('refuses a proof made for another flow', async () => {
    const a = await start();
    const b = await start();
    expect(await code(handleCallback(a.flowId, '', b.proof, approved(a.flowId)))).toBe(
      'different_browser',
    );
    expect(await listConnections(a.ws)).toHaveLength(0);
  });

  it('refuses credentials said to come from a different site, and never tries them anywhere', async () => {
    const { ws, flowId, proof } = await start();
    expect(
      await code(
        handleCallback(
          flowId,
          '',
          proof,
          approved(flowId, { site_url: 'https://evil.example.net' }),
        ),
      ),
    ).toBe('site_mismatch');
    expect(seen).toHaveLength(0);
    expect(await listConnections(ws)).toHaveLength(0);
    // One attempt per flow: a second try with the right site finds the flow already spent.
    expect(await code(handleCallback(flowId, '', proof, approved(flowId)))).toBe('invalid_state');
  });

  it('refuses credentials the site does not accept', async () => {
    const { ws, flowId, proof } = await start();
    site.me = {
      status: 401,
      body: { code: 'incorrect_password', message: 'invalid', data: { status: 401 } },
    };
    expect(await code(handleCallback(flowId, '', proof, approved(flowId)))).toBe(
      'credentials_rejected',
    );
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('refuses a replay of a callback that already connected', async () => {
    const { ws, flowId, proof } = await start();
    await handleCallback(flowId, '', proof, approved(flowId));
    expect(await code(handleCallback(flowId, '', proof, approved(flowId)))).toBe('invalid_state');
    expect(await listConnections(ws)).toHaveLength(1);
  });

  it('lets exactly one of two simultaneous callbacks through', async () => {
    const { ws, flowId, proof } = await start();
    const results = await Promise.allSettled([
      handleCallback(flowId, '', proof, approved(flowId)),
      handleCallback(flowId, '', proof, approved(flowId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await listConnections(ws)).toHaveLength(1);
  });

  it('refuses an expired flow', async () => {
    const { ws, flowId, proof } = await start();
    await db()
      .update(schema.oauthFlows)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.oauthFlows.id, flowId));
    expect(await code(handleCallback(flowId, '', proof, approved(flowId)))).toBe('expired');
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('cannot land in another workspace: the flow decides, not the callback', async () => {
    const mine = await start();
    const theirs = await start();
    await handleCallback(mine.flowId, '', mine.proof, approved(mine.flowId));
    expect(await listConnections(mine.ws)).toHaveLength(1);
    expect(await listConnections(theirs.ws)).toHaveLength(0);
  });

  it('a dashboard flow’s proof opens nothing on the public invite picker', async () => {
    const { flowId, proof } = await start();
    expect(await getInviteFlow(flowId, proof)).toEqual({ status: 'not_found' });
    await handleCallback(flowId, '', proof, approved(flowId));
    expect((await getInviteFlow(flowId, proof)).status).not.toBe('choose_account');
  });
});

describe('WordPress connect — the sealed result', () => {
  it('reports a connection as a seal that carries nothing from the callback', async () => {
    const ws = await createWorkspace();
    const started = await startConnect(ws, 'wordpress', APP, undefined, { siteUrl: SITE });
    const sealed = await completeCredentialCallback(approved(started.flowId), started.proof);
    expect(sealed).not.toContain('abcd');
    expect(sealed).not.toContain('priya');
    const [conn] = await listConnections(ws);
    expect(openCallbackOutcome(Object.fromEntries(new URLSearchParams(sealed)))).toEqual({
      status: 'connected',
      connectionId: conn!.id,
    });
  });

  it('reports a refusal as its code, and never throws', async () => {
    const ws = await createWorkspace();
    const started = await startConnect(ws, 'wordpress', APP, undefined, { siteUrl: SITE });
    const sealed = await completeCredentialCallback(approved(started.flowId), undefined);
    expect(new URLSearchParams(sealed).get('detail')).toBe('different_browser');
    expect(await listConnections(ws)).toHaveLength(0);
  });
});

describe('WordPress connect — through a client invite', () => {
  it('connects the client’s site into the invite’s workspace and closes the link', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Ecolive');
    const invite = await createConnectInvite(ws, 'wordpress', uid);
    expect((await getConnectInvite(invite.token))?.connectInput).toBe('site_url');

    const started = await startInviteConnect(invite.token, APP, { siteUrl: SITE });
    const result = await handleCallback(
      started!.flowId,
      '',
      started!.proof,
      approved(started!.flowId),
    );
    expect(result.status).toBe('connected');
    expect(await listConnections(ws)).toHaveLength(1);
    expect(await getConnectInvite(invite.token)).toBeNull();
  });

  it('keeps the link usable when the address was refused or the approval failed', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Ecolive');
    const invite = await createConnectInvite(ws, 'wordpress', uid);
    await expect(
      startInviteConnect(invite.token, APP, { siteUrl: 'http://blog.example.com' }),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);

    const started = await startInviteConnect(invite.token, APP, { siteUrl: SITE });
    expect(
      await code(
        handleCallback(
          started!.flowId,
          '',
          started!.proof,
          approved(started!.flowId, { site_url: 'https://evil.example.net' }),
        ),
      ),
    ).toBe('site_mismatch');
    expect(await listConnections(ws)).toHaveLength(0);
    expect(await getConnectInvite(invite.token)).not.toBeNull();
  });
});

describe('WordPress posts', () => {
  const connect = async () => {
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'wordpress', 'Ecolive Blog', {
      externalId: SITE,
      tokenModel: 'one-time',
      accessToken: encodeCredentials({
        siteUrl: SITE,
        apiRoot: API_ROOT,
        username: 'priya',
        password: APP_PASSWORD,
      }),
    });
    return { ws, connectionId };
  };
  const options = { kind: 'wordpress' as const, title: 'Hello', status: 'publish' as const };

  it('publishes an article and records its permalink and WordPress id', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    const [post] = await createPost(ws, {
      caption: 'A **body**.',
      media: [],
      variants: [{ connectionId, provider: 'wordpress', options }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome).toMatchObject({ status: 'published', releaseUrl: `${SITE}/2026/10/hello/` });

    const [stored] = await withWorkspace(ws, (tx) =>
      tx.select().from(schema.posts).where(eq(schema.posts.id, post!.id)),
    );
    expect(stored!.externalPostId).toBe('1284');
    const create = seen.find((s) => s.method === 'POST')!;
    expect(create.url).toBe(`${API_ROOT}wp/v2/posts`);
    expect(create.authorization).toMatch(/^Basic /);
  });

  it('marks the connection for reconnect when the application password was revoked', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    site.post = {
      status: 401,
      body: { code: 'incorrect_password', message: 'invalid', data: { status: 401 } },
    };
    const [post] = await createPost(ws, {
      caption: 'A body.',
      media: [],
      variants: [{ connectionId, provider: 'wordpress', options }],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).not.toContain('abcd');
    expect((await listConnections(ws))[0]!.health).toBe('needs_reconnect');
  });

  it('takes an article body far longer than a social caption, in the variant', async () => {
    useRecordingScheduler();
    const { ws, connectionId } = await connect();
    const body = 'word '.repeat(4000); // 20 000 characters
    const [post] = await createPost(ws, {
      caption: '',
      media: [],
      variants: [{ connectionId, provider: 'wordpress', caption: body, options }],
      schedule: { type: 'draft' },
    });
    expect(post!.caption).toBe(body);
    const edited = await updatePost(ws, post!.id, { caption: `${body}more` });
    expect(edited!.caption.length).toBe(body.length + 4);
  });

  it('still holds every other platform to the social caption limit on edit', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'fake');
    const [post] = await createPost(ws, {
      caption: 'short',
      media: [],
      variants: [{ connectionId, provider: 'fake' }],
      schedule: { type: 'draft' },
    });
    await expect(updatePost(ws, post!.id, { caption: 'x'.repeat(5001) })).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );
    expect((await updatePost(ws, post!.id, { caption: 'x'.repeat(5000) }))!.caption).toHaveLength(
      5000,
    );
  });
});
