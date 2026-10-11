import { describe, expect, it } from 'vitest';
import { articleMarkdownToHtml } from '@meegrow-social/contracts';
import {
  ConnectError,
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import {
  SafeFetchError,
  SsrfBlockedError,
  type SafeFetchOptions,
  type SafeResponse,
} from '../../net/safe-fetch.js';
import type { AuthTokens, PostDetails } from '../types.js';
import { decodeCredentials, encodeCredentials, type WordPressFetch } from './client.js';
import { WordPressProvider } from './wordpress.js';
import { WordPressXmlRpcClient, XmlRpcFaultError, type XmlRpcLogin } from './xmlrpc-client.js';
import { decodeMethodResponse, type XmlRpcValue } from './xmlrpc.js';

/**
 * The XML-RPC transport and the username-and-password connect, against canned answers.
 *
 * DOCUMENTATION-BUILT, NOT RECORDED. No request was ever made to a WordPress site to produce
 * these. The shapes are transcribed from the XML-RPC WordPress API reference
 * (https://codex.wordpress.org/XML-RPC_WordPress_API and its /Posts, /Taxonomies, /Media, /Users
 * and /Options pages) and from WordPress core (wp-includes/class-wp-xmlrpc-server.php for the
 * methods and fault codes, wp-includes/IXR/ for the wire layout). Whether a real site answers
 * exactly so is what the live bring-up checklist in docs/dev/research/wordpress.md §11.7 is for.
 */

const SITE = 'https://blog.example.com';
const ENDPOINT = `${SITE}/xmlrpc.php`;
const API_ROOT = `${SITE}/wp-json/`;
/** Distinctive on purpose: every "never appears" assertion below searches for these. */
const USERNAME = 'priya.editor';
const PASSWORD = 'Tr0ub4dor&3 <correct> "horse"';
const LOGIN: XmlRpcLogin = { endpoint: ENDPOINT, username: USERNAME, password: PASSWORD };

// --- Rendering answers the way WordPress's serialiser (IXR_Value::getXml) does ------------------

type Wire = string | number | boolean | Wire[] | { [name: string]: Wire };

function ixr(value: Wire): string {
  if (typeof value === 'boolean') return `<boolean>${value ? 1 : 0}</boolean>`;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `<int>${value}</int>` : `<double>${value}</double>`;
  }
  if (typeof value === 'string') {
    const escaped = value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
    return `<string>${escaped}</string>`;
  }
  if (Array.isArray(value)) {
    return `<array><data>\n${value.map((v) => `  <value>${ixr(v)}</value>\n`).join('')}</data></array>`;
  }
  const members = Object.entries(value)
    .map(([name, v]) => `  <member><name>${name}</name><value>${ixr(v)}</value></member>\n`)
    .join('');
  return `<struct>\n${members}</struct>`;
}

const ok = (value: Wire): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<methodResponse>\n  <params>\n    <param>\n      <value>\n      ${ixr(value)}\n      </value>\n    </param>\n  </params>\n</methodResponse>\n`;

/** IXR_Error::getXml. WordPress sends it with HTTP 200 (405 for "services are disabled"). */
const fault = (code: number, message: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<methodResponse>\n  <fault>\n    <value>\n      <struct>\n        <member>\n          <name>faultCode</name>\n          <value><int>${code}</int></value>\n        </member>\n        <member>\n          <name>faultString</name>\n          <value><string>${message}</string></value>\n        </member>\n      </struct>\n    </value>\n  </fault>\n</methodResponse>\n`;

const WRONG_LOGIN = fault(403, 'Incorrect username or password.');
const DISABLED = fault(405, 'XML-RPC services are disabled on this site.');
const FIREWALL_PAGE = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head></html>';

/** `system.listMethods` on a stock WordPress (abridged). */
const METHODS = [
  'system.multicall',
  'system.listMethods',
  'system.getCapabilities',
  'demo.sayHello',
  'pingback.ping',
  'wp.getUsersBlogs',
  'wp.newPost',
  'wp.editPost',
  'wp.getPost',
  'wp.getPosts',
  'wp.getTerms',
  'wp.getProfile',
  'wp.getOptions',
  'wp.uploadFile',
];

/** `wp.getProfile` with the fields this app asks for. */
const profile = (roles: string[]): Wire => ({
  user_id: '7',
  username: USERNAME,
  display_name: 'Priya Editor',
  roles,
});

/** `wp.getOptions`: each option is `{ desc, readonly, value }`. */
const options = (over: Record<string, string> = {}): Wire =>
  Object.fromEntries(
    Object.entries({
      blog_title: 'Ecolive &amp; Co',
      home_url: SITE,
      blog_url: SITE,
      ...over,
    }).map(([name, value]) => [name, { desc: name, readonly: true, value }]),
  );

/** One term as `wp.getTerms` / `wp.getPost` return it. */
const term = (id: number, name: string, taxonomy: string): Wire => ({
  term_id: String(id),
  name,
  slug: name.toLowerCase().replace(/\W+/g, '-'),
  term_group: '0',
  term_taxonomy_id: String(id),
  taxonomy,
  description: '',
  parent: '0',
  count: 4,
});

/** `wp.uploadFile` → the attachment. */
const UPLOADED: Wire = {
  attachment_id: '551',
  parent: 0,
  link: `${SITE}/wp-content/uploads/2026/10/five-ways-to-cut-plastic.jpg`,
  title: 'five-ways-to-cut-plastic.jpg',
  type: 'image/jpeg',
  id: '551',
  file: 'five-ways-to-cut-plastic.jpg',
  url: `${SITE}/wp-content/uploads/2026/10/five-ways-to-cut-plastic.jpg`,
};

/** `wp.getPost` with the fields this app asks for. `post_thumbnail` is `[]` when there is none. */
const storedPost = (over: Record<string, Wire> = {}): Wire => ({
  post_id: '1284',
  post_status: 'publish',
  post_type: 'post',
  link: `${SITE}/2026/10/five-ways-to-cut-plastic/`,
  post_thumbnail: [],
  terms: [term(1, 'Uncategorized', 'category')],
  ...over,
});

// --- A recording stand-in for safeFetch ---------------------------------------------------------

interface Answer {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  url?: string;
  throws?: Error;
}
type Rule = Answer | ((call: Call) => Answer);

interface Call {
  method: string;
  url: string;
  options: SafeFetchOptions;
  /** The XML-RPC method a POST carried, or '' for anything else. */
  rpc: string;
}

/**
 * Rules are keyed by `"rpc.method"` (optionally `"rpc.method host"`) for XML-RPC POSTs and by
 * `"VERB url-substring"` for everything else. First match wins.
 */
function site(rules: Record<string, Rule>): { fetchImpl: WordPressFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: WordPressFetch = async (url, options) => {
    const method = (options.method ?? 'GET').toUpperCase();
    const rpc = /<methodName>([^<]+)<\/methodName>/.exec(String(options.body ?? ''))?.[1] ?? '';
    const call: Call = { method, url, options, rpc };
    calls.push(call);
    const key = Object.keys(rules).find((k) => {
      const [first, second] = k.split(' ');
      if (rpc !== '') return first === rpc && (second === undefined || url.includes(second));
      return first === method && url.includes(second ?? '');
    });
    if (key === undefined) throw new Error(`no rule for ${method} ${url} ${rpc}`);
    const rule = rules[key]!;
    const answer = typeof rule === 'function' ? rule(call) : rule;
    if (answer.throws) throw answer.throws;
    const response: SafeResponse = {
      status: answer.status ?? 200,
      headers: { 'content-type': 'text/xml; charset=UTF-8', ...answer.headers },
      body: Buffer.from(answer.body ?? ''),
      url: answer.url ?? url,
    };
    return response;
  };
  return { fetchImpl, calls };
}

/** The parameters an XML-RPC call sent, decoded. */
function sent(call: Call): XmlRpcValue[] {
  const body = String(call.options.body);
  const inner = /<params>(.*)<\/params>/s.exec(body)?.[1] ?? '';
  return inner
    .split('</param><param>')
    .map((p) => p.replace(/^<param>/, '').replace(/<\/param>$/, ''))
    .filter((p) => p !== '')
    .map((p) => {
      const decoded = decodeMethodResponse(
        `<methodResponse><params><param>${p}</param></params></methodResponse>`,
      );
      if (decoded.fault) throw new Error('unreachable');
      return decoded.value;
    });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

/** Nothing a person or a log could read may carry the login. */
function expectNoSecrets(text: string): void {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain('Tr0ub4dor');
  expect(text).not.toContain(USERNAME);
}

const client = (rules: Record<string, Rule>) => {
  const { fetchImpl, calls } = site(rules);
  return { xmlrpc: new WordPressXmlRpcClient({ fetchImpl }), calls };
};

// --- The transport ------------------------------------------------------------------------------

describe('XML-RPC transport', () => {
  it('POSTs to the endpoint with the login as the leading parameters, and nothing in a header', async () => {
    const { xmlrpc, calls } = client({ 'wp.getTerms': { body: ok([]) } });
    await xmlrpc.findTerm(LOGIN, 'category', 'News');
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.method).toBe('POST');
    expect(call.url).toBe(ENDPOINT);
    expect(call.options.headers?.['content-type']).toBe('text/xml; charset=utf-8');
    expect(call.options.headers?.authorization).toBeUndefined();
    // A request that carries the password is never replayed to wherever a redirect points.
    expect(call.options.maxRedirects ?? 0).toBe(0);
    expect(call.options.maxResponseBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(call.options.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(sent(call)).toEqual([
      1,
      USERNAME,
      PASSWORD,
      'category',
      { search: 'News', number: 100, hide_empty: false },
    ]);
  });

  const faults: Array<[string, Answer, new (m: string) => Error, RegExp]> = [
    [
      'a wrong username or password',
      { body: WRONG_LOGIN },
      ProviderAuthError,
      /no longer accepts the saved username and password.*Reconnect/,
    ],
    [
      'a user who may not do this (fault 401)',
      { body: fault(401, 'Sorry, you are not allowed to publish posts in this post type.') },
      ProviderAuthError,
      /not allowed to do this.*not allowed to publish posts.*\[401\]/,
    ],
    [
      'XML-RPC switched off (fault with HTTP 405)',
      { status: 405, body: DISABLED },
      ProviderBadRequestError,
      /XML-RPC is switched off on this site/,
    ],
    [
      'XML-RPC switched off by the web server (bare 405)',
      { status: 405, body: 'Method Not Allowed' },
      ProviderBadRequestError,
      /XML-RPC is switched off on this site/,
    ],
    [
      'a firewall page with 403',
      { status: 403, body: FIREWALL_PAGE },
      ProviderBadRequestError,
      /firewall or security plugin is blocking XML-RPC/,
    ],
    [
      'a firewall page served as 200',
      { status: 200, body: FIREWALL_PAGE },
      ProviderBadRequestError,
      /not with the XML-RPC WordPress sends/,
    ],
    [
      'HTTP authentication in front of the site',
      { status: 401, body: 'Authorization Required' },
      ProviderBadRequestError,
      /blocking XML-RPC/,
    ],
    [
      'no xmlrpc.php at the address',
      { status: 404, body: '<html>Not found</html>' },
      ProviderBadRequestError,
      /no xmlrpc\.php at the address/,
    ],
    [
      'a method a security plugin removed',
      { body: fault(-32601, 'server error. requested method wp.getTerms does not exist.') },
      ProviderBadRequestError,
      /switched off the XML-RPC method wp\.getTerms/,
    ],
    [
      'a refused argument',
      { body: fault(403, 'Invalid taxonomy.') },
      ProviderBadRequestError,
      /WordPress says: Invalid taxonomy\. \[403\]/,
    ],
    [
      'a redirect',
      { status: 301, headers: { location: 'https://www.example.com/xmlrpc.php' } },
      ProviderBadRequestError,
      /address has changed.*Reconnect/,
    ],
    [
      'a WordPress-side failure (fault 500)',
      { body: fault(500, 'Sorry, the post could not be created.') },
      ProviderTransientError,
      /could not be created/,
    ],
    [
      'a server error',
      { status: 503, body: 'Service Unavailable' },
      ProviderTransientError,
      /HTTP 503/,
    ],
    ['rate limiting', { status: 429, body: 'slow down' }, ProviderTransientError, /HTTP 429/],
    [
      'no answer',
      { throws: new SafeFetchError('timeout', 'no answer from blog.example.com') },
      ProviderTransientError,
      /could not be reached/,
    ],
    [
      'an address that stopped being public',
      { throws: new SsrfBlockedError('address', 'That address is not a public website.') },
      ProviderBadRequestError,
      /no longer leads to a public website/,
    ],
  ];
  it.each(faults)('maps %s', async (_name, answer, kind, message) => {
    const { xmlrpc } = client({
      'wp.getTerms': answer,
      // Asked only to settle an ambiguous 403; here the login is fine.
      'wp.getProfile': { body: ok(profile(['editor'])) },
    });
    const err = await rejection(xmlrpc.findTerm(LOGIN, 'category', 'News'));
    expect(err).toBeInstanceOf(kind);
    expect(err.message).toMatch(message);
    expectNoSecrets(err.message);
  });

  it('never follows a redirect: the password went to one address and is not sent to another', async () => {
    const { xmlrpc, calls } = client({
      'wp.getTerms': { status: 302, headers: { location: 'https://evil.test/xmlrpc.php' } },
    });
    await rejection(xmlrpc.findTerm(LOGIN, 'category', 'News'));
    expect(calls.map((c) => c.url)).toEqual([ENDPOINT]);
  });

  it('settles a 403 it cannot read — a translated wrong-password — by asking a login-only method', async () => {
    const { xmlrpc, calls } = client({
      'wp.newPost': { body: fault(403, 'Benutzername oder Passwort falsch.') },
      'wp.getProfile': { body: fault(403, 'Benutzername oder Passwort falsch.') },
    });
    const err = await rejection(xmlrpc.newPost(LOGIN, { post_title: 'x' }));
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(calls.map((c) => c.rpc)).toEqual(['wp.newPost', 'wp.getProfile']);
    expect(calls.every((c) => c.url === ENDPOINT)).toBe(true);
  });

  it('keeps a 403 that is not about the login as a bad request, with WordPress’s words', async () => {
    const { xmlrpc } = client({
      'wp.newPost': { body: fault(403, 'Invalid post type.') },
      'wp.getProfile': { body: ok(profile(['editor'])) },
    });
    const err = await rejection(xmlrpc.newPost(LOGIN, { post_title: 'x' }));
    expect(err).toBeInstanceOf(XmlRpcFaultError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/Invalid post type/);
  });

  it('strips markup from a fault before it is shown', async () => {
    const { xmlrpc } = client({
      'wp.getTerms': {
        body: fault(
          400,
          '&lt;strong&gt;Error&lt;/strong&gt;: nope &lt;script&gt;x()&lt;/script&gt;',
        ),
      },
    });
    const err = await rejection(xmlrpc.findTerm(LOGIN, 'category', 'News'));
    expect(err.message).toContain('Error: nope');
    expect(err.message).not.toContain('<');
  });
});

describe('probe — is XML-RPC there, asked without credentials', () => {
  const state = async (rules: Record<string, Rule>) => {
    const { xmlrpc, calls } = client(rules);
    return { state: await xmlrpc.probe(ENDPOINT), calls };
  };

  it('sends system.listMethods with no login at all', async () => {
    const { state: found, calls } = await state({ 'system.listMethods': { body: ok(METHODS) } });
    expect(found).toBe('available');
    expect(sent(calls[0]!)).toEqual([]);
    expect(String(calls[0]!.options.body)).not.toContain('<param>');
    expect(calls[0]!.options.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it.each<[string, Answer, string]>([
    [
      'the publishing methods removed',
      { body: ok(['pingback.ping', 'demo.sayHello']) },
      'disabled',
    ],
    ['WordPress saying it is disabled', { status: 405, body: DISABLED }, 'disabled'],
    ['a bare 405', { status: 405, body: '' }, 'disabled'],
    [
      'a hidden method list',
      { body: fault(-32601, 'requested method system.listMethods does not exist.') },
      'unknown',
    ],
    ['a firewall 403', { status: 403, body: FIREWALL_PAGE }, 'blocked'],
    ['a challenge page served as 200', { body: FIREWALL_PAGE }, 'blocked'],
    ['an answer that is not a list', { body: ok('Hello!') }, 'blocked'],
    ['a 404', { status: 404, body: 'Not Found' }, 'not_found'],
    ['a redirect', { status: 301, headers: { location: '/' } }, 'not_found'],
    ['a server error', { status: 502, body: 'Bad Gateway' }, 'unreachable'],
    ['no answer', { throws: new SafeFetchError('timeout', 'no answer') }, 'unreachable'],
    [
      'an address the guard refuses',
      { throws: new SsrfBlockedError('address', 'no') },
      'unreachable',
    ],
  ])('reports %s', async (_name, answer, expected) => {
    expect((await state({ 'system.listMethods': answer })).state).toBe(expected);
  });
});

describe('verifyLogin — a typed username and password', () => {
  const verify = (answer: Answer) => {
    const { xmlrpc, calls } = client({ 'wp.getProfile': answer });
    return { promise: xmlrpc.verifyLogin(LOGIN), calls };
  };
  const code = async (answer: Answer): Promise<string> => {
    const err = await rejection(verify(answer).promise);
    expect(err).toBeInstanceOf(ConnectError);
    // A fixed sentence: nothing typed and nothing the site said.
    expectNoSecrets(err.message);
    return (err as ConnectError).code;
  };

  it('accepts a user whose role can publish, asking only for what it needs', async () => {
    const { promise, calls } = verify({ body: ok(profile(['editor'])) });
    await expect(promise).resolves.toEqual({
      userId: 7,
      username: USERNAME,
      displayName: 'Priya Editor',
      roles: ['editor'],
    });
    expect(sent(calls[0]!)).toEqual([
      1,
      USERNAME,
      PASSWORD,
      ['user_id', 'username', 'display_name', 'roles'],
    ]);
  });

  it.each([['administrator'], ['editor'], ['author'], ['wpseo_manager', 'author']])(
    'accepts the role(s) %s',
    async (...roles) => {
      await expect(verify({ body: ok(profile(roles)) }).promise).resolves.toBeDefined();
    },
  );

  it.each([
    ['a Contributor (can write, cannot publish)', ['contributor']],
    ['a Subscriber', ['subscriber']],
    ['a custom role whose rights cannot be read', ['shop_manager']],
    ['a user with no role on the site', []],
  ])('refuses %s', async (_name, roles) => {
    expect(await code({ body: ok(profile(roles)) })).toBe('role_cannot_publish');
  });

  it.each<[string, Answer, string]>([
    ['a wrong password', { body: WRONG_LOGIN }, 'login_rejected'],
    [
      'a wrong password on a translated site',
      { body: fault(403, 'Identifiant ou mot de passe incorrect.') },
      'login_rejected',
    ],
    ['XML-RPC disabled (fault, HTTP 405)', { status: 405, body: DISABLED }, 'xmlrpc_disabled'],
    ['XML-RPC disabled (fault, HTTP 200)', { body: DISABLED }, 'xmlrpc_disabled'],
    ['XML-RPC disabled (bare 405)', { status: 405, body: '' }, 'xmlrpc_disabled'],
    ['a firewall 403 page', { status: 403, body: FIREWALL_PAGE }, 'xmlrpc_blocked'],
    ['a challenge page served as 200', { body: FIREWALL_PAGE }, 'xmlrpc_blocked'],
    [
      'a login-limiter’s HTML lockout',
      { status: 200, body: '<html>Too many failed attempts</html>' },
      'xmlrpc_blocked',
    ],
    [
      'a removed method',
      { body: fault(-32601, 'requested method wp.getProfile does not exist.') },
      'xmlrpc_blocked',
    ],
    ['no xmlrpc.php', { status: 404, body: '' }, 'xmlrpc_not_found'],
    ['a redirect', { status: 302, headers: { location: 'https://elsewhere.test/' } }, 'site_moved'],
    ['a server error', { status: 503, body: '' }, 'site_unreachable'],
    ['no answer', { throws: new SafeFetchError('network', 'reset') }, 'site_unreachable'],
    ['an answer that is not a profile', { body: ok('nope') }, 'xmlrpc_blocked'],
  ])('reports %s', async (_name, answer, expected) => {
    expect(await code(answer)).toBe(expected);
  });

  it('makes exactly one request, to the endpoint it was given', async () => {
    const { promise, calls } = verify({ body: WRONG_LOGIN });
    await rejection(promise);
    expect(calls.map((c) => c.url)).toEqual([ENDPOINT]);
  });
});

describe('XML-RPC methods', () => {
  it('siteOptions reads the title and both addresses out of wp.getOptions', async () => {
    const { xmlrpc, calls } = client({
      'wp.getOptions': {
        body: ok(options({ home_url: 'https://example.com/blog', blog_url: SITE })),
      },
    });
    expect(await xmlrpc.siteOptions(LOGIN)).toEqual({
      title: 'Ecolive & Co',
      homeUrl: 'https://example.com/blog',
      siteUrl: SITE,
    });
    expect(sent(calls[0]!).slice(3)).toEqual([['blog_title', 'home_url', 'blog_url']]);
  });

  it('findTerm matches the exact name only (search is a substring match)', async () => {
    const { xmlrpc } = client({
      'wp.getTerms': {
        body: ok([term(11, 'Newsletter', 'category'), term(3, 'News', 'category')]),
      },
    });
    expect(await xmlrpc.findTerm(LOGIN, 'category', ' news ')).toBe(3);
    expect(await xmlrpc.findTerm(LOGIN, 'category', 'New')).toBeNull();
  });

  it('uploadFile sends the bytes as base64 and never asks WordPress to overwrite', async () => {
    const { xmlrpc, calls } = client({ 'wp.uploadFile': { body: ok(UPLOADED) } });
    const bits = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(await xmlrpc.uploadFile(LOGIN, { name: 'a.jpg', type: 'image/jpeg', bits })).toBe(551);
    const [file] = sent(calls[0]!).slice(3) as [Record<string, XmlRpcValue>];
    expect(Object.keys(file).sort()).toEqual(['bits', 'name', 'type']);
    expect(Buffer.compare(file.bits as Buffer, bits)).toBe(0);
    expect(String(calls[0]!.options.body)).not.toContain('overwrite');
    expect(calls[0]!.options.timeoutMs).toBe(90_000);
  });

  it('uploadFile explains an upload the site could not read as a size limit', async () => {
    const { xmlrpc } = client({
      'wp.uploadFile': { body: fault(-32700, 'parse error. not well formed') },
    });
    const err = await rejection(
      xmlrpc.uploadFile(LOGIN, { name: 'a.jpg', type: 'image/jpeg', bits: Buffer.alloc(8) }),
    );
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(/larger than the site’s upload limit/);
  });

  it('uploadFile reports a user who may not upload as an auth problem', async () => {
    const { xmlrpc } = client({
      'wp.uploadFile': { body: fault(401, 'Sorry, you are not allowed to upload files.') },
    });
    expect(
      await rejection(
        xmlrpc.uploadFile(LOGIN, { name: 'a.jpg', type: 'image/jpeg', bits: Buffer.alloc(8) }),
      ),
    ).toBeInstanceOf(ProviderAuthError);
  });

  it('getPost reads back what is stored', async () => {
    const { xmlrpc, calls } = client({
      'wp.getPost': {
        body: ok(
          storedPost({
            post_status: 'draft',
            post_thumbnail: { attachment_id: '551', link: 'x', thumbnail: 'y' },
            terms: [
              term(3, 'News', 'category'),
              term(21, 'eco', 'post_tag'),
              term(22, 'plastic', 'post_tag'),
            ],
          }),
        ),
      },
    });
    expect(await xmlrpc.getPost(LOGIN, 1284)).toEqual({
      id: 1284,
      status: 'draft',
      type: 'post',
      link: `${SITE}/2026/10/five-ways-to-cut-plastic/`,
      thumbnailId: 551,
      terms: { category: [3], post_tag: [21, 22] },
    });
    expect(sent(calls[0]!).slice(3)).toEqual([
      1284,
      ['post_id', 'post_status', 'post_type', 'link', 'post_thumbnail', 'terms'],
    ]);
  });

  it('getPost answers null for a post the site does not have', async () => {
    const missing = client({ 'wp.getPost': { body: fault(404, 'Invalid post ID.') } });
    expect(await missing.xmlrpc.getPost(LOGIN, 1284)).toBeNull();
    const odd = client({ 'wp.getPost': { body: ok({ post_title: 'no id here' }) } });
    expect(await odd.xmlrpc.getPost(LOGIN, 1284)).toBeNull();
  });
});

// --- The provider: looking at a site ------------------------------------------------------------

const INDEX = {
  name: 'Ecolive &amp; Co',
  url: SITE,
  home: SITE,
  namespaces: ['oembed/1.0', 'wp/v2'],
  authentication: {
    'application-passwords': {
      endpoints: { authorization: `${SITE}/wp-admin/authorize-application.php` },
    },
  },
};
const json = (body: unknown, status = 200): Answer => ({
  status,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});
const linkTo = (root: string): Answer => ({
  headers: { link: `<${root}>; rel="https://api.w.org/"` },
});
const LISTS: Answer = { body: ok(METHODS) };

const provider = (rules: Record<string, Rule>) => {
  const { fetchImpl, calls } = site(rules);
  return { wp: new WordPressProvider({ fetchImpl }), calls };
};

describe('inspectSite — which ways a site can be connected', () => {
  it('offers both methods on an ordinary site, and names the endpoint a login would go to', async () => {
    const { wp, calls } = provider({
      'HEAD blog.example.com': linkTo(API_ROOT),
      'GET /wp-json/': json(INDEX),
      'system.listMethods': LISTS,
    });
    expect(await wp.inspectSite('blog.example.com')).toEqual({
      entered: SITE,
      name: 'Ecolive & Co',
      siteAddress: SITE,
      homeAddress: SITE,
      separateAddresses: false,
      approval: { available: true },
      password: { available: true, endpoint: ENDPOINT },
    });
    // Looking never logs in: no request carries a credential of any kind.
    for (const call of calls) {
      expect(call.options.headers?.authorization).toBeUndefined();
      expect(String(call.options.body ?? '')).not.toContain('<param>');
    }
  });

  it('says plainly that approval is unavailable when application passwords are switched off, and still offers a login', async () => {
    const { wp } = provider({
      'HEAD blog.example.com': linkTo(API_ROOT),
      'GET /wp-json/': json({ ...INDEX, authentication: [] }),
      'system.listMethods': LISTS,
    });
    const found = await wp.inspectSite(SITE);
    expect(found.approval).toMatchObject({
      available: false,
      reason: 'application_passwords_unavailable',
    });
    expect(found.approval.available === false && found.approval.message).toMatch(
      /Application Passwords are not available on this site/,
    );
    expect(found.password).toEqual({ available: true, endpoint: ENDPOINT });
  });

  /**
   * A WordPress whose two address settings are on different hosts: administered at
   * admin.example.com (WordPress Address), read at example.com/blog (Site Address). The REST root
   * follows the public address; wp-admin and xmlrpc.php live at the other.
   */
  const ADMIN = 'https://admin.example.com';
  const PUBLIC = 'https://example.com/blog';
  const SPLIT_ROOT = `${PUBLIC}/wp-json/`;
  const SPLIT_INDEX = { ...INDEX, url: ADMIN, home: PUBLIC, authentication: [] };

  it('accepts the ADMIN address of a site with separate addresses, once the other host names it back', async () => {
    const { wp, calls } = provider({
      'HEAD admin.example.com': linkTo(SPLIT_ROOT),
      'GET example.com/blog/wp-json/': json(SPLIT_INDEX),
      'system.listMethods': LISTS,
    });
    const found = await wp.inspectSite(ADMIN);
    expect(found).toMatchObject({
      entered: ADMIN,
      siteAddress: ADMIN,
      homeAddress: PUBLIC,
      separateAddresses: true,
      approval: { available: false, reason: 'application_passwords_unavailable' },
      // The entered host's xmlrpc.php is the one used, and the one shown.
      password: { available: true, endpoint: `${ADMIN}/xmlrpc.php` },
    });
    expect(calls.filter((c) => c.rpc).map((c) => c.url)).toEqual([`${ADMIN}/xmlrpc.php`]);
  });

  it('accepts the PUBLIC address of the same site, once the admin host points back at the same REST root', async () => {
    const { wp, calls } = provider({
      'HEAD example.com/blog': linkTo(SPLIT_ROOT),
      'GET example.com/blog/wp-json/': json(SPLIT_INDEX),
      'HEAD admin.example.com': linkTo(SPLIT_ROOT),
      'system.listMethods': LISTS,
    });
    const found = await wp.inspectSite(PUBLIC);
    expect(found).toMatchObject({
      entered: PUBLIC,
      siteAddress: ADMIN,
      homeAddress: PUBLIC,
      separateAddresses: true,
      password: { available: true, endpoint: `${PUBLIC}/xmlrpc.php` },
    });
    // Both hosts were asked, each as its own guarded request.
    expect(calls.filter((c) => c.method === 'HEAD').map((c) => new URL(c.url).host)).toEqual([
      'example.com',
      'admin.example.com',
    ]);
  });

  it('connects such a site by approval too, when it offers application passwords', async () => {
    const authorize = `${ADMIN}/wp-admin/authorize-application.php`;
    const { wp } = provider({
      'HEAD example.com/blog': linkTo(SPLIT_ROOT),
      'GET example.com/blog/wp-json/': json({
        ...SPLIT_INDEX,
        authentication: { 'application-passwords': { endpoints: { authorization: authorize } } },
      }),
      'HEAD admin.example.com': linkTo(SPLIT_ROOT),
    });
    const { url, codeVerifier } = await wp.generateAuthUrl({
      redirectUri: 'https://social.meegrowlabs.com/connect/callback',
      state: '9b2f6c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d',
      siteUrl: PUBLIC,
    });
    expect(url.startsWith(`${authorize}?`)).toBe(true);
    expect(JSON.parse(codeVerifier!)).toMatchObject({
      siteUrl: ADMIN,
      home: PUBLIC,
      apiRoot: SPLIT_ROOT,
    });
  });

  it('falls back to the WordPress Address when the entered address has no xmlrpc.php', async () => {
    const { wp } = provider({
      'HEAD example.com/blog': linkTo(SPLIT_ROOT),
      'GET example.com/blog/wp-json/': json(SPLIT_INDEX),
      'HEAD admin.example.com': linkTo(SPLIT_ROOT),
      'system.listMethods example.com/blog': { status: 404, body: 'Not Found' },
      'system.listMethods admin.example.com': LISTS,
    });
    expect((await wp.inspectSite(PUBLIC)).password).toEqual({
      available: true,
      endpoint: `${ADMIN}/xmlrpc.php`,
    });
  });

  it('does not take a site’s word for another host that does not point back', async () => {
    const { wp, calls } = provider({
      'HEAD blog.example.com': linkTo(API_ROOT),
      'GET /wp-json/': json({ ...INDEX, url: 'https://victim.example.org' }),
      'HEAD victim.example.org': linkTo('https://victim.example.org/wp-json/'),
      'system.listMethods': LISTS,
    });
    const found = await wp.inspectSite(SITE);
    expect(found.approval).toMatchObject({ available: false, reason: 'unconfirmed_address' });
    expect(found.siteAddress).toBeNull();
    // A login is only ever offered at the address that was entered — never at the claimed one.
    expect(found.password).toEqual({ available: true, endpoint: ENDPOINT });
    expect(calls.filter((c) => c.method === 'POST').map((c) => new URL(c.url).host)).toEqual([
      'blog.example.com',
    ]);
  });

  it('does not accept a REST root on another host whose site does not name this one', async () => {
    const { wp, calls } = provider({
      'HEAD blog.example.com': linkTo('https://victim.example.org/wp-json/'),
      'GET victim.example.org': json({
        ...INDEX,
        url: 'https://victim.example.org',
        home: 'https://victim.example.org',
      }),
      'system.listMethods': LISTS,
    });
    const found = await wp.inspectSite(SITE);
    expect(found.approval).toMatchObject({ available: false, reason: 'unconfirmed_address' });
    expect(found.password).toEqual({ available: true, endpoint: ENDPOINT });
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('victim'))).toBe(false);
  });

  it('finds xmlrpc.php through the page’s EditURI link when the REST API cannot say where WordPress lives', async () => {
    const page =
      '<html><head><link rel="alternate" href="/feed/">\n' +
      `<link rel="EditURI" type="application/rsd+xml" title="RSD" href="${SITE}/wp/xmlrpc.php?rsd" />` +
      '</head><body></body></html>';
    const { wp } = provider({
      'HEAD blog.example.com': {},
      'GET /wp-json/': { status: 404, body: '<html>404</html>' },
      'GET rest_route': { status: 404, body: '<html>404</html>' },
      'system.listMethods /wp/xmlrpc.php': LISTS,
      'system.listMethods blog.example.com/xmlrpc.php': { status: 404, body: '' },
      'GET blog.example.com/': { body: page, headers: { 'content-type': 'text/html' } },
    });
    const found = await wp.inspectSite(SITE);
    expect(found.approval).toMatchObject({ available: false, reason: 'no_rest_api' });
    expect(found.password).toEqual({ available: true, endpoint: `${SITE}/wp/xmlrpc.php` });
  });

  it('ignores an EditURI link that points at another host', async () => {
    const page =
      '<link rel="EditURI" type="application/rsd+xml" href="https://victim.example.org/xmlrpc.php?rsd">';
    const { wp, calls } = provider({
      'HEAD blog.example.com': {},
      'GET /wp-json/': { status: 404, body: '' },
      'GET rest_route': { status: 404, body: '' },
      'system.listMethods': { status: 404, body: '' },
      'GET blog.example.com/': { body: page },
    });
    const found = await wp.inspectSite(SITE);
    expect(found.password).toEqual({
      available: false,
      reason: 'not_found',
      message: 'No xmlrpc.php was found at this address.',
    });
    expect(calls.some((c) => c.url.includes('victim'))).toBe(false);
  });

  it.each<[string, Answer, string, RegExp]>([
    ['switched off', { status: 405, body: DISABLED }, 'disabled', /XML-RPC is switched off/],
    [
      'behind a firewall',
      { status: 403, body: FIREWALL_PAGE },
      'blocked',
      /firewall or security plugin/,
    ],
    [
      'not answering',
      { throws: new SafeFetchError('timeout', 'x') },
      'unreachable',
      /did not answer/,
    ],
  ])('says so when XML-RPC is %s', async (_name, answer, reason, message) => {
    const { wp } = provider({
      'HEAD blog.example.com': linkTo(API_ROOT),
      'GET /wp-json/': json({ ...INDEX, authentication: [] }),
      'system.listMethods': answer,
    });
    const found = await wp.inspectSite(SITE);
    expect(found.password).toMatchObject({ available: false, reason });
    expect(found.password.available === false && found.password.message).toMatch(message);
  });

  it('refuses an address the guard will not contact, before anything else is tried', async () => {
    const { wp, calls } = provider({
      'HEAD ': { throws: new SsrfBlockedError('address', 'That address is not a public website.') },
    });
    const err = await rejection(wp.inspectSite('https://10.0.0.5'));
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe('That address is not a public website.');
    expect(calls).toHaveLength(1);
  });

  it('never contacts an http address', async () => {
    const { wp, calls } = provider({});
    expect(await rejection(wp.inspectSite('http://blog.example.com'))).toBeInstanceOf(
      ProviderBadRequestError,
    );
    expect(calls).toHaveLength(0);
  });
});

// --- The provider: connecting with a password ----------------------------------------------------

describe('authenticateWithPassword', () => {
  const params = (
    over: Partial<Parameters<WordPressProvider['authenticateWithPassword']>[0]> = {},
  ) => ({
    endpoint: ENDPOINT,
    username: USERNAME,
    password: PASSWORD,
    site: { entered: SITE, home: SITE, name: 'Ecolive & Co' },
    ...over,
  });

  it('verifies the login, then stores it with the transport and the endpoint it was verified at', async () => {
    const { wp, calls } = provider({
      'wp.getProfile': { body: ok(profile(['editor'])) },
      'wp.getOptions': { body: ok(options()) },
    });
    const tokens = await wp.authenticateWithPassword(params());
    expect(decodeCredentials(tokens.accessToken)).toEqual({
      transport: 'xmlrpc',
      siteUrl: SITE,
      endpoint: ENDPOINT,
      username: USERNAME,
      password: PASSWORD,
    });
    expect(tokens.externalId).toBe(SITE);
    expect(tokens.displayName).toBe('Ecolive & Co');
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt).toBeUndefined();
    // What is kept in the clear says HOW it was connected, and nothing that is a secret.
    expect(tokens.connectionMeta).toEqual({ method: 'password', endpoint: ENDPOINT });
    expectNoSecrets(JSON.stringify(tokens.connectionMeta));
    expect(calls.map((c) => `${c.rpc} ${c.url}`)).toEqual([
      `wp.getProfile ${ENDPOINT}`,
      `wp.getOptions ${ENDPOINT}`,
    ]);
  });

  it('records the public address of a site with separate addresses', async () => {
    const { wp } = provider({
      'wp.getProfile': { body: ok(profile(['author'])) },
      'wp.getOptions': {
        body: ok(
          options({ home_url: 'https://example.com/blog/', blog_url: 'https://admin.example.com' }),
        ),
      },
    });
    const tokens = await wp.authenticateWithPassword(
      params({
        endpoint: 'https://admin.example.com/xmlrpc.php',
        site: {
          entered: 'https://admin.example.com',
          home: 'https://example.com/blog',
          name: null,
        },
      }),
    );
    expect(tokens.externalId).toBe('https://example.com/blog');
    expect(decodeCredentials(tokens.accessToken)).toMatchObject({
      siteUrl: 'https://admin.example.com',
      endpoint: 'https://admin.example.com/xmlrpc.php',
    });
  });

  it('does not let the site name itself after a host nobody confirmed', async () => {
    const { wp } = provider({
      'wp.getProfile': { body: ok(profile(['editor'])) },
      'wp.getOptions': {
        body: ok(
          options({
            home_url: 'https://www.famous-newspaper.test',
            blog_url: 'https://other.test',
          }),
        ),
      },
    });
    const tokens = await wp.authenticateWithPassword(params());
    expect(tokens.externalId).toBe(SITE);
    expect(decodeCredentials(tokens.accessToken).siteUrl).toBe(SITE);
  });

  it('still connects a site that will not answer wp.getOptions, under the address typed', async () => {
    const { wp } = provider({
      'wp.getProfile': { body: ok(profile(['editor'])) },
      'wp.getOptions': { body: fault(-32601, 'requested method wp.getOptions does not exist.') },
    });
    const tokens = await wp.authenticateWithPassword(
      params({ site: { entered: `${SITE}/`, home: null, name: null } }),
    );
    expect(tokens.externalId).toBe(SITE);
    expect(tokens.displayName).toBe('blog.example.com');
  });

  it.each<[string, Answer, string]>([
    ['a wrong password', { body: WRONG_LOGIN }, 'login_rejected'],
    ['XML-RPC disabled', { status: 405, body: DISABLED }, 'xmlrpc_disabled'],
    ['a firewall', { status: 403, body: FIREWALL_PAGE }, 'xmlrpc_blocked'],
    ['a contributor', { body: ok(profile(['contributor'])) }, 'role_cannot_publish'],
  ])(
    'refuses %s with a fixed code and no trace of what was typed',
    async (_n, answer, expected) => {
      const { wp, calls } = provider({ 'wp.getProfile': answer });
      const err = await rejection(wp.authenticateWithPassword(params()));
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(expected);
      expectNoSecrets(err.message);
      expectNoSecrets(String(err.stack));
      // Nothing is asked of the site after a refusal.
      expect(calls).toHaveLength(1);
    },
  );

  it('declares both connect methods', () => {
    const { wp } = provider({});
    expect(wp.connectMethods).toEqual(['approval', 'password']);
  });
});

// --- The provider: publishing -------------------------------------------------------------------

const XMLRPC_TOKENS: AuthTokens = {
  accessToken: encodeCredentials({
    transport: 'xmlrpc',
    siteUrl: SITE,
    endpoint: ENDPOINT,
    username: USERNAME,
    password: PASSWORD,
  }),
  externalId: SITE,
  displayName: 'Ecolive & Co',
};

const article = (over: Partial<PostDetails> = {}, opts: object = {}): PostDetails[] => [
  {
    caption: '# Why\n\nBecause **plastic** lasts.',
    media: [],
    options: {
      kind: 'wordpress',
      title: 'Five ways to cut plastic',
      status: 'publish',
      ...opts,
    } as PostDetails['options'],
    ...over,
  },
];

const CREATED: Answer = { body: ok('1284') };
const READ_BACK: Answer = { body: ok(storedPost()) };

/** The struct `wp.newPost` was sent. */
const newPostContent = (calls: Call[]): Record<string, XmlRpcValue> =>
  sent(calls.find((c) => c.rpc === 'wp.newPost')!)[3] as Record<string, XmlRpcValue>;

describe('post — dispatch by transport', () => {
  it('sends a REST connection to the REST API and never to xmlrpc.php', async () => {
    const { wp, calls } = provider({
      'POST /wp/v2/posts': json({ id: 9, status: 'publish', link: `${SITE}/a/` }, 201),
    });
    const rest: AuthTokens = {
      ...XMLRPC_TOKENS,
      // Written before transports existed: no `transport` key at all.
      accessToken: JSON.stringify({
        v: 1,
        siteUrl: SITE,
        apiRoot: API_ROOT,
        username: 'priya',
        password: 'abcd EFGH 1234',
      }),
    };
    expect((await wp.post(rest, article())).externalPostId).toBe('9');
    expect(calls.map((c) => c.url)).toEqual([`${API_ROOT}wp/v2/posts`]);
    expect(calls[0]!.options.headers?.authorization).toMatch(/^Basic /);
    expect(calls[0]!.rpc).toBe('');
  });

  it('sends an XML-RPC connection to its stored endpoint and never to the REST API', async () => {
    const { wp, calls } = provider({ 'wp.newPost': CREATED, 'wp.getPost': READ_BACK });
    await wp.post(XMLRPC_TOKENS, article());
    expect(calls.map((c) => `${c.rpc} ${c.url}`)).toEqual([
      `wp.newPost ${ENDPOINT}`,
      `wp.getPost ${ENDPOINT}`,
    ]);
    for (const call of calls) expect(call.options.headers?.authorization).toBeUndefined();
  });

  it('reports stored credentials it cannot read without quoting them', async () => {
    const { wp, calls } = provider({});
    const blob = JSON.stringify({ transport: 'carrier-pigeon', siteUrl: SITE, password: PASSWORD });
    const err = await rejection(wp.post({ ...XMLRPC_TOKENS, accessToken: blob }, article()));
    expect(err).toBeInstanceOf(ProviderAuthError);
    expectNoSecrets(err.message);
    expect(calls).toHaveLength(0);
  });
});

describe('post over XML-RPC', () => {
  it('creates the article with the same converted body as REST, then reports what the site stored', async () => {
    const { wp, calls } = provider({ 'wp.newPost': CREATED, 'wp.getPost': READ_BACK });
    const result = await wp.post(
      XMLRPC_TOKENS,
      article({}, { slug: 'five-ways', excerpt: 'Short & sweet' }),
    );
    expect(result).toEqual({
      externalPostId: '1284',
      releaseUrl: `${SITE}/2026/10/five-ways-to-cut-plastic/`,
    });
    expect(newPostContent(calls)).toEqual({
      post_type: 'post',
      post_status: 'publish',
      post_title: 'Five ways to cut plastic',
      post_content: articleMarkdownToHtml('# Why\n\nBecause **plastic** lasts.'),
      post_name: 'five-ways',
      post_excerpt: 'Short & sweet',
    });
    // The permalink came from the read-back, asked for by the id WordPress returned.
    expect(sent(calls[1]!)[3]).toBe(1284);
  });

  it('never lets the body become markup of its own choosing', async () => {
    const { wp, calls } = provider({ 'wp.newPost': CREATED, 'wp.getPost': READ_BACK });
    await wp.post(XMLRPC_TOKENS, article({ caption: 'Hi <script>alert(1)</script> there' }));
    const content = String(newPostContent(calls).post_content);
    expect(content).not.toContain('<script>');
    expect(content).toContain('&lt;script&gt;');
  });

  it.each(['draft', 'pending', 'private'] as const)(
    'creates a %s as asked and says it is not public',
    async (status) => {
      const { wp, calls } = provider({
        'wp.newPost': CREATED,
        'wp.getPost': { body: ok(storedPost({ post_status: status })) },
      });
      const result = await wp.post(XMLRPC_TOKENS, article({}, { status }));
      expect(newPostContent(calls).post_status).toBe(status);
      expect(result.notice).toMatch(/as asked — it is not public/);
    },
  );

  it('says so when WordPress saved a different status than was asked for', async () => {
    const { wp } = provider({
      'wp.newPost': CREATED,
      'wp.getPost': { body: ok(storedPost({ post_status: 'pending' })) },
    });
    const result = await wp.post(XMLRPC_TOKENS, article());
    expect(result.notice).toMatch(/saved this as pending review instead of "publish"/);
  });

  it('sends categories as ids it looked up, and tags by name', async () => {
    const { wp, calls } = provider({
      'wp.getTerms': (call) => {
        const [, , , taxonomy, filter] = sent(call) as [
          number,
          string,
          string,
          string,
          { search: string },
        ];
        expect(taxonomy).toBe('category');
        return { body: ok(filter.search === 'News' ? [term(3, 'News', 'category')] : []) };
      },
      'wp.newPost': CREATED,
      'wp.getPost': {
        body: ok(
          storedPost({
            terms: [
              term(3, 'News', 'category'),
              term(8, 'Guides', 'category'),
              term(21, 'eco', 'post_tag'),
              term(22, 'plastic', 'post_tag'),
              term(40, 'old', 'post_tag'),
            ],
          }),
        ),
      },
    });
    const result = await wp.post(
      XMLRPC_TOKENS,
      article({}, { categories: ['News', 8, 'News'], tags: ['eco', 'plastic', 'Eco', 40] }),
    );
    const content = newPostContent(calls);
    expect(content.terms).toEqual({ category: [3, 8], post_tag: [40] });
    // `terms_names` creates what does not exist — wanted for tags, never used for categories.
    expect(content.terms_names).toEqual({ post_tag: ['eco', 'plastic'] });
    expect(result.notice).toBeUndefined();
  });

  it('fails on an unknown category BEFORE anything is created, as the REST path does', async () => {
    const { wp, calls } = provider({
      'wp.getTerms': { body: ok([term(11, 'Newsletter', 'category')]) },
    });
    const err = await rejection(wp.post(XMLRPC_TOKENS, article({}, { categories: ['News'] })));
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe(
      'The site has no category named "News". Create it in WordPress, or correct the name.',
    );
    expect(calls.some((c) => c.rpc === 'wp.newPost')).toBe(false);
  });

  it('says so when the stored post is missing a category or tag that was asked for', async () => {
    const { wp } = provider({
      'wp.newPost': CREATED,
      'wp.getPost': { body: ok(storedPost({ terms: [term(1, 'Uncategorized', 'category')] })) },
    });
    const result = await wp.post(XMLRPC_TOKENS, article({}, { categories: [3], tags: ['eco'] }));
    expect(result.notice).toMatch(/without some of the categories asked for/);
    expect(result.notice).toMatch(/without some of the tags asked for/);
  });

  const MEDIA = [{ mediaId: 'm1', kind: 'image' as const, url: 'https://cdn.example.net/a.jpg' }];
  const imageRules = {
    'GET cdn.example.net': { body: 'JPEG', headers: { 'content-type': 'image/jpeg' } } as Answer,
  };

  it('uploads the featured image first and attaches it by id', async () => {
    const { wp, calls } = provider({
      ...imageRules,
      'wp.uploadFile': { body: ok(UPLOADED) },
      'wp.newPost': CREATED,
      'wp.getPost': {
        body: ok(storedPost({ post_thumbnail: { attachment_id: '551', link: 'x' } })),
      },
    });
    const result = await wp.post(XMLRPC_TOKENS, article({ media: MEDIA }));
    expect(calls.map((c) => c.rpc || c.method)).toEqual([
      'GET',
      'wp.uploadFile',
      'wp.newPost',
      'wp.getPost',
    ]);
    const [file] = sent(calls[1]!).slice(3) as [Record<string, XmlRpcValue>];
    expect(file.name).toBe('five-ways-to-cut-plastic.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(newPostContent(calls).post_thumbnail).toBe(551);
    expect(result.notice).toBeUndefined();
    // The image is fetched without credentials: it is not the site.
    expect(String(calls[0]!.options.body ?? '')).toBe('');
  });

  it('says so when the stored post does not carry the featured image', async () => {
    const { wp } = provider({
      ...imageRules,
      'wp.uploadFile': { body: ok(UPLOADED) },
      'wp.newPost': CREATED,
      'wp.getPost': READ_BACK,
    });
    const result = await wp.post(XMLRPC_TOKENS, article({ media: MEDIA }));
    expect(result.externalPostId).toBe('1284');
    expect(result.notice).toMatch(/without its featured image/);
  });

  it('refuses an image type WordPress does not take before creating anything', async () => {
    const { wp, calls } = provider({
      'GET cdn.example.net': { body: 'x', headers: { 'content-type': 'image/svg+xml' } },
    });
    const err = await rejection(wp.post(XMLRPC_TOKENS, article({ media: MEDIA })));
    expect(err.message).toMatch(/WordPress takes JPEG, PNG, GIF or WebP/);
    expect(calls.some((c) => c.rpc !== '')).toBe(false);
  });

  describe('read-back — an adapter must never report a write it has not seen', () => {
    it('fails when WordPress returns an id for a post the site does not have', async () => {
      const { wp } = provider({
        'wp.newPost': CREATED,
        'wp.getPost': { body: fault(404, 'Invalid post ID.') },
      });
      const err = await rejection(wp.post(XMLRPC_TOKENS, article()));
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/created post 1284, but the site has no such post/);
      expect(err.message).toMatch(/Check the site before retrying/);
    });

    it('fails when the post read back is a different one', async () => {
      const { wp } = provider({
        'wp.newPost': CREATED,
        'wp.getPost': { body: ok(storedPost({ post_id: '77' })) },
      });
      expect(await rejection(wp.post(XMLRPC_TOKENS, article()))).toBeInstanceOf(
        ProviderBadRequestError,
      );
    });

    it.each<[string, Answer]>([
      ['times out', { throws: new SafeFetchError('timeout', 'no answer', true) }],
      ['hits a server error', { status: 502, body: 'Bad Gateway' }],
      ['is answered by a firewall page', { status: 403, body: FIREWALL_PAGE }],
    ])(
      'when the read-back %s, reports the post as created but NOT confirmed — and never as retryable',
      async (_name, answer) => {
        const { wp } = provider({ 'wp.newPost': CREATED, 'wp.getPost': answer });
        const result = await wp.post(XMLRPC_TOKENS, article());
        expect(result.externalPostId).toBe('1284');
        expect(result.releaseUrl).toBe(`${SITE}/?p=1284`);
        expect(result.notice).toMatch(/could not be read back.*NOT confirmed/);
      },
    );
  });

  describe('duplicate safety — the same rule as REST', () => {
    it('treats no answer AFTER the create was sent as final, with words', async () => {
      const { wp, calls } = provider({
        'wp.newPost': { throws: new SafeFetchError('timeout', 'no answer', true) },
      });
      const err = await rejection(wp.post(XMLRPC_TOKENS, article()));
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/may or may not have been created — check the site/);
      expect(calls.filter((c) => c.rpc === 'wp.newPost')).toHaveLength(1);
    });

    it('retries when the create never left', async () => {
      const { wp } = provider({
        'wp.newPost': { throws: new SafeFetchError('network', 'connection refused', false) },
      });
      expect(await rejection(wp.post(XMLRPC_TOKENS, article()))).toBeInstanceOf(
        ProviderTransientError,
      );
    });

    it('treats a 200 that is not XML-RPC as "may have been created"', async () => {
      const { wp } = provider({
        'wp.newPost': { body: `<br /><b>Warning</b>: something in hook.php\n${ok('1284')}` },
      });
      const err = await rejection(wp.post(XMLRPC_TOKENS, article()));
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/may or may not have been created/);
    });

    it('treats an answer that names no post as "check the site"', async () => {
      const { wp } = provider({ 'wp.newPost': { body: ok(true) } });
      const err = await rejection(wp.post(XMLRPC_TOKENS, article()));
      expect(err.message).toMatch(/did not say which one it is — check the site/);
    });

    it('retries a 5xx on the create, as the REST path does', async () => {
      const { wp } = provider({ 'wp.newPost': { status: 500, body: 'Internal Server Error' } });
      expect(await rejection(wp.post(XMLRPC_TOKENS, article()))).toBeInstanceOf(
        ProviderTransientError,
      );
    });
  });

  it('turns a changed or revoked password into "needs reconnect", naming no credential', async () => {
    const { wp } = provider({ 'wp.newPost': { body: WRONG_LOGIN } });
    const err = await rejection(wp.post(XMLRPC_TOKENS, article()));
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/Reconnect the site/);
    expectNoSecrets(err.message);
  });

  it('keeps the login out of every error the publish path can raise', async () => {
    const xmlEscaped = PASSWORD.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const answers: Answer[] = [
      { body: WRONG_LOGIN },
      { body: fault(401, 'Sorry, you are not allowed to post on this site.') },
      { status: 405, body: DISABLED },
      { status: 403, body: FIREWALL_PAGE },
      { body: FIREWALL_PAGE },
      { status: 500, body: 'x' },
      { throws: new SafeFetchError('timeout', 'no answer from blog.example.com', true) },
      // A site (or a plugin's debug output) repeating the request back in its fault text.
      { body: fault(400, `debug: login failed with password ${xmlEscaped}`) },
      { body: fault(401, `not allowed (tried ${xmlEscaped})`) },
      { body: fault(500, `${xmlEscaped}${xmlEscaped}`) },
    ];
    for (const answer of answers) {
      const { wp } = provider({
        'wp.newPost': answer,
        'wp.getProfile': { body: ok(profile(['editor'])) },
      });
      const err = await rejection(wp.post(XMLRPC_TOKENS, article()));
      expect(err.message).not.toContain(PASSWORD);
      expect(err.message).not.toContain('Tr0ub4dor');
    }
  });
});
