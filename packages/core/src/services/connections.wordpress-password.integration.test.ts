import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema, withWorkspace } from '@meegrow-social/db';
import {
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { decryptToken } from '../crypto.js';
import { registerProvider } from '../providers/registry.js';
import type { SafeFetchOptions, SafeResponse } from '../net/safe-fetch.js';
import { decodeCredentials } from '../providers/wordpress/client.js';
import { WordPressProvider } from '../providers/wordpress/wordpress.js';
import { resetAttemptStore, SITE_LOGIN_LIMIT } from './auth-throttle.js';
import { checkConnectSite, connectWithPassword, listConnections } from './connections.js';
import { createPost } from './posts.js';
import { publishPost } from './publish.js';

/**
 * Connecting a WordPress site with a username and login password, against real Postgres: what
 * the connection row holds (ciphertext, and the method in the clear), that the row is the
 * workspace's and nobody else's, and that a publish goes out over the stored XML-RPC endpoint.
 *
 * NEVER EXECUTED BY ITS AUTHOR: this file was written without access to a database (the build
 * that added it was forbidden to connect to one). CI is its first run. WordPress itself is a stub
 * here — the same documentation-built shapes as providers/wordpress/wordpress.xmlrpc.test.ts.
 */

const SITE = 'https://blog.example.com';
const ENDPOINT = `${SITE}/xmlrpc.php`;
const USERNAME = 'priya.editor';
const PASSWORD = 'Tr0ub4dor&3 <correct> "horse"';
const CALLER = { ip: '203.0.113.7', actor: 'user-1' };

interface Seen {
  method: string;
  url: string;
  rpc: string;
}
let seen: Seen[] = [];

const xml = (inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<methodResponse><params><param><value>${inner}</value></param></params></methodResponse>`;
const fault = (code: number, message: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<methodResponse><fault><value><struct>' +
  `<member><name>faultCode</name><value><int>${code}</int></value></member>` +
  `<member><name>faultString</name><value><string>${message}</string></value></member>` +
  '</struct></value></fault></methodResponse>';
const member = (name: string, value: string): string =>
  `<member><name>${name}</name><value>${value}</value></member>`;
const text = (value: string): string => `<string>${value}</string>`;
const option = (name: string, value: string): string =>
  member(name, `<struct>${member('value', text(value))}</struct>`);

function answer(status: number, body: string, url: string, headers = {}): SafeResponse {
  return { status, headers: { ...headers }, body: Buffer.from(body), url };
}

/** The password travels XML-escaped inside the request body. */
const ESCAPED_PASSWORD = PASSWORD.replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

async function stubSite(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const method = (options.method ?? 'GET').toUpperCase();
  const body = String(options.body ?? '');
  const rpc = /<methodName>([^<]+)<\/methodName>/.exec(body)?.[1] ?? '';
  seen.push({ method, url, rpc });
  if (!url.startsWith(SITE)) throw new Error(`unexpected request to ${url}`);
  if (method === 'HEAD') {
    return answer(200, '', url, { link: `<${SITE}/wp-json/>; rel="https://api.w.org/"` });
  }
  if (method === 'GET') {
    // Application passwords switched off: `authentication` is empty.
    return answer(
      200,
      JSON.stringify({
        name: 'Ecolive Blog',
        url: SITE,
        home: SITE,
        namespaces: ['wp/v2'],
        authentication: [],
      }),
      url,
    );
  }
  if (url !== ENDPOINT) throw new Error(`XML-RPC sent to ${url}`);
  if (rpc === 'system.listMethods') {
    return answer(
      200,
      xml(
        `<array><data>${['wp.newPost', 'wp.getPost', 'wp.getProfile']
          .map((m) => `<value>${text(m)}</value>`)
          .join('')}</data></array>`,
      ),
      url,
    );
  }
  if (!body.includes(`<string>${ESCAPED_PASSWORD}</string>`)) {
    return answer(200, fault(403, 'Incorrect username or password.'), url);
  }
  switch (rpc) {
    case 'wp.getProfile':
      return answer(
        200,
        xml(
          `<struct>${member('user_id', text('7'))}${member('username', text(USERNAME))}` +
            `${member('display_name', text('Priya Editor'))}` +
            `${member('roles', `<array><data><value>${text('editor')}</value></data></array>`)}</struct>`,
        ),
        url,
      );
    case 'wp.getOptions':
      return answer(
        200,
        xml(
          `<struct>${option('blog_title', 'Ecolive Blog')}${option('home_url', SITE)}` +
            `${option('blog_url', SITE)}</struct>`,
        ),
        url,
      );
    case 'wp.newPost':
      return answer(200, xml(text('1284')), url);
    case 'wp.getPost':
      return answer(
        200,
        xml(
          `<struct>${member('post_id', text('1284'))}${member('post_status', text('publish'))}` +
            `${member('post_type', text('post'))}${member('link', text(`${SITE}/2026/10/hello/`))}` +
            `${member('post_thumbnail', '<array><data></data></array>')}` +
            `${member('terms', '<array><data></data></array>')}</struct>`,
        ),
        url,
      );
    default:
      throw new Error(`no stub for ${rpc}`);
  }
}

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  // Not registered by default (WORDPRESS_ENABLED is off); vitest isolates the registry per file.
  registerProvider(new WordPressProvider({ fetchImpl: stubSite }));
});
beforeEach(async () => {
  await resetDb();
  resetAttemptStore();
  seen = [];
});
afterAll(closeDb);

async function connect(ws: string, password = PASSWORD) {
  const check = await checkConnectSite(ws, 'wordpress', 'blog.example.com');
  return connectWithPassword(
    ws,
    'wordpress',
    { ticket: check.ticket!, username: USERNAME, password },
    CALLER,
  );
}

async function connectionRows(ws: string) {
  return withWorkspace(ws, (tx) => tx.select().from(schema.connections));
}

describe('WordPress connect — username and password', () => {
  it('tells the operator approval is unavailable and where a login would go', async () => {
    const ws = await createWorkspace();
    const check = await checkConnectSite(ws, 'wordpress', 'blog.example.com');
    expect(check.approval).toMatchObject({
      available: false,
      reason: 'application_passwords_unavailable',
    });
    expect(check.password).toEqual({ available: true, endpoint: ENDPOINT });
    expect(check.ticket).toEqual(expect.any(String));
    // Nothing is stored by looking.
    expect(await connectionRows(ws)).toHaveLength(0);
  });

  it('stores the login encrypted, the method in the clear, and returns neither secret', async () => {
    const ws = await createWorkspace();
    const outcome = await connect(ws);
    expect(outcome).toMatchObject({
      ok: true,
      displayName: 'Ecolive Blog',
      externalId: SITE,
      endpoint: ENDPOINT,
    });
    expect(JSON.stringify(outcome)).not.toContain('Tr0ub4dor');

    const [row] = await connectionRows(ws);
    expect(row).toMatchObject({
      provider: 'wordpress',
      externalId: SITE,
      displayName: 'Ecolive Blog',
      tokenModel: 'one-time',
      expiresAt: null,
      refreshToken: null,
      needsReconnect: false,
      meta: { method: 'password', endpoint: ENDPOINT },
    });
    // No column holds the password or the username in the clear.
    expect(JSON.stringify(row)).not.toContain('Tr0ub4dor');
    expect(JSON.stringify(row)).not.toContain(USERNAME);
    expect(decodeCredentials(decryptToken(row!.accessToken!))).toEqual({
      transport: 'xmlrpc',
      siteUrl: SITE,
      endpoint: ENDPOINT,
      username: USERNAME,
      password: PASSWORD,
    });

    // The list the dashboard reads says how it was connected, and carries no token.
    const [view] = await listConnections(ws);
    expect(view).toMatchObject({ provider: 'wordpress', method: 'password', health: 'healthy' });
    expect(JSON.stringify(view)).not.toContain('Tr0ub4dor');
    expect(Object.keys(view!)).not.toContain('accessToken');
  });

  it('creates the connection in the caller’s workspace and no other', async () => {
    const ws = await createWorkspace();
    const other = await createWorkspace();
    await connect(ws);
    expect(await listConnections(ws)).toHaveLength(1);
    expect(await listConnections(other)).toHaveLength(0);
  });

  it('refuses a site check made for another workspace', async () => {
    const ws = await createWorkspace();
    const other = await createWorkspace();
    const check = await checkConnectSite(ws, 'wordpress', 'blog.example.com');
    seen = [];
    const outcome = await connectWithPassword(
      other,
      'wordpress',
      { ticket: check.ticket!, username: USERNAME, password: PASSWORD },
      CALLER,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'check_expired' });
    expect(seen).toHaveLength(0);
    expect(await listConnections(other)).toHaveLength(0);
  });

  it('creates nothing for a wrong password, and says only that it was not accepted', async () => {
    const ws = await createWorkspace();
    const outcome = await connect(ws, 'not the password');
    expect(outcome).toEqual({
      ok: false,
      reason: 'login_rejected',
      message: 'the site did not accept that username and password',
    });
    expect(await connectionRows(ws)).toHaveLength(0);
  });

  it('stops asking the site after too many wrong logins', async () => {
    const ws = await createWorkspace();
    for (let i = 0; i < SITE_LOGIN_LIMIT.perSite; i++) await connect(ws, `guess-${i}`);
    seen = [];
    const check = await checkConnectSite(ws, 'wordpress', 'blog.example.com');
    const logins = seen.length;
    const outcome = await connectWithPassword(
      ws,
      'wordpress',
      { ticket: check.ticket!, username: USERNAME, password: PASSWORD },
      CALLER,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'rate_limited' });
    // Only the check's own unauthenticated requests were made; no login was sent.
    expect(seen).toHaveLength(logins);
    expect(seen.some((s) => s.rpc === 'wp.getProfile')).toBe(false);
  });

  it('publishes an article over the stored XML-RPC endpoint and reports what the site stored', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connected = await connect(ws);
    if (!connected.ok) throw new Error('expected a connection');
    seen = [];
    const [post] = await createPost(ws, {
      caption: 'A **body**.',
      media: [],
      variants: [
        {
          connectionId: connected.connectionId,
          provider: 'wordpress',
          options: { kind: 'wordpress', title: 'Hello', status: 'publish' },
        },
      ],
      schedule: { type: 'now' },
    });
    const outcome = await publishPost(ws, post!.id);
    expect(outcome).toMatchObject({ status: 'published', releaseUrl: `${SITE}/2026/10/hello/` });

    const [stored] = await withWorkspace(ws, (tx) =>
      tx.select().from(schema.posts).where(eq(schema.posts.id, post!.id)),
    );
    expect(stored!.externalPostId).toBe('1284');
    expect(seen.map((s) => `${s.rpc} ${s.url}`)).toEqual([
      `wp.newPost ${ENDPOINT}`,
      `wp.getPost ${ENDPOINT}`,
    ]);

    // Nothing the publish wrote down carries the login.
    const logs = await db().select().from(schema.eventLogs);
    expect(JSON.stringify(logs)).not.toContain('Tr0ub4dor');
    expect(JSON.stringify(stored)).not.toContain('Tr0ub4dor');
  });
});
