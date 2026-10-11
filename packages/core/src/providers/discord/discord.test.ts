import { describe, expect, it } from 'vitest';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderRateLimitError,
  ProviderTransientError,
} from '../../errors.js';
import { SafeFetchError, type SafeFetchOptions, type SafeResponse } from '../../net/safe-fetch.js';
import { CredentialFormatError } from '../shared/http.js';
import type { AuthTokens, PostDetails } from '../types.js';
import {
  decodeDiscordCredentials,
  DiscordProvider,
  encodeDiscordCredentials,
  parseWebhookUrl,
} from './discord.js';

/**
 * FIXTURES ARE DOCUMENTATION-BUILT. Every request and response shape below is taken from
 * Discord's API documentation (docs/dev/research/quick-platforms.md §3), not captured from
 * Discord: this provider has never talked to it.
 */

const ID = '199737254929760256';
const SECRET =
  '3d89bb7572e0fb30d8128367b3b1b44fecd1726de135cbe28a41f8b2f777c372ba2939e72279b94526ff5d1bd4358d65cf11';
const URL_ = `https://discord.com/api/webhooks/${ID}/${SECRET}`;
const GUILD = '199737254929760257';
const CHANNEL = '199737254929760258';
const MESSAGE = '1199737254929760259';
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | string | undefined;
  options: SafeFetchOptions;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

const webhookObject = {
  type: 1,
  id: ID,
  name: 'Acme Announcements',
  avatar: null,
  channel_id: CHANNEL,
  guild_id: GUILD,
  application_id: null,
  token: SECRET,
};

function discord(
  overrides: {
    get?: () => Reply;
    execute?: (seen: Seen) => Reply;
    media?: (url: string) => Reply;
  } = {},
) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, options: SafeFetchOptions): Promise<SafeResponse> => {
    const method = (options.method ?? 'GET').toUpperCase();
    const entry: Seen = {
      method,
      url,
      headers: options.headers ?? {},
      body: options.body,
      options,
    };
    seen.push(entry);
    let reply: Reply;
    if (url.startsWith('https://media.example.com/')) {
      reply = overrides.media?.(url) ?? {
        body: Buffer.from(`bytes-of-${url.split('/').pop()}`),
        headers: { 'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/png' },
      };
    } else if (method === 'GET' && url === URL_) {
      reply = overrides.get?.() ?? { body: webhookObject };
    } else if (method === 'POST' && url === `${URL_}?wait=true`) {
      reply = overrides.execute?.(entry) ?? {
        body: { id: MESSAGE, channel_id: CHANNEL, webhook_id: ID, content: 'x' },
      };
    } else {
      throw new Error(`unexpected request: ${method} to ${new URL(url).host}`);
    }
    const body = reply.body ?? {};
    return {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
      body: Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      url,
    };
  };
  return { seen, fetchImpl };
}

const provider = (net = discord()) => new DiscordProvider({ fetchImpl: net.fetchImpl });
const tokens = (
  overrides: Partial<Parameters<typeof encodeDiscordCredentials>[0]> = {},
): AuthTokens => ({
  accessToken: encodeDiscordCredentials({
    id: ID,
    token: SECRET,
    guildId: GUILD,
    channelId: CHANNEL,
    ...overrides,
  }),
  externalId: ID,
  displayName: 'Acme Announcements',
});
const post = (caption: string, media: PostDetails['media'] = []): PostDetails[] => [
  { caption, media },
];
const file = (name: string, kind: 'image' | 'video' = 'image') => ({
  mediaId: MEDIA_ID,
  kind,
  url: `https://media.example.com/${name}`,
});
const executes = (seen: Seen[]) => seen.filter((s) => s.method === 'POST');
const sentJson = (seen: Seen | undefined) =>
  JSON.parse(String(seen?.body)) as Record<string, unknown>;

/** A multipart body, parsed the way a server would: by its own boundary. */
function parseMultipart(seen: Seen) {
  const boundary = /boundary=(.+)$/.exec(seen.headers['content-type'] ?? '')?.[1];
  if (!boundary) throw new Error('not multipart');
  const raw = (seen.body as Buffer).toString('latin1');
  return raw
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [head, ...rest] = part.replace(/^\r\n/, '').split('\r\n\r\n');
      return {
        name: /name="([^"]+)"/.exec(head!)?.[1],
        filename: /filename="([^"]+)"/.exec(head!)?.[1],
        contentType: /Content-Type: (.+)/.exec(head!)?.[1],
        body: rest.join('\r\n\r\n').replace(/\r\n$/, ''),
      };
    });
}

describe('parseWebhookUrl', () => {
  it.each([
    URL_,
    ` ${URL_}\n`,
    `${URL_}/`,
    `https://discordapp.com/api/webhooks/${ID}/${SECRET}`,
    `https://discord.com/api/v10/webhooks/${ID}/${SECRET}`,
  ])('accepts %s', (typed) => {
    expect(parseWebhookUrl(typed)).toEqual({ id: ID, token: SECRET });
  });

  const tail = `/api/webhooks/${ID}/${SECRET}`;
  it.each([
    ['empty', ''],
    ['not a url', 'discord webhook'],
    ['http', `http://discord.com${tail}`],
    ['no scheme', `discord.com${tail}`],
    ['scheme without slashes', `https:discord.com${tail}`],
    ['extra slash', `https:///discord.com${tail}`],
    ['another host', `https://evil.example${tail}`],
    ['look-alike suffix', `https://discord.com.evil.example${tail}`],
    ['look-alike prefix', `https://notdiscord.com${tail}`],
    ['subdomain', `https://canary.discord.com${tail}`],
    ['media host', `https://cdn.discordapp.com${tail}`],
    ['userinfo naming discord', `https://discord.com@evil.example${tail}`],
    ['userinfo with password', `https://user:pw@discord.com${tail}`],
    ['backslash before @', `https://discord.com\\@evil.example${tail}`],
    ['backslash as slash', `https:\\\\discord.com${tail}`],
    ['port', `https://discord.com:8443${tail}`],
    ['explicit default port', `https://discord.com:443${tail}`],
    ['trailing dot host', `https://discord.com.${tail}`],
    ['upper-case host', `https://DISCORD.COM${tail}`],
    ['homoglyph host', `https://dіscord.com${tail}`],
    ['fullwidth dot host', `https://discord。com${tail}`],
    ['IP literal', `https://162.159.128.233${tail}`],
    ['IPv6 literal', `https://[::1]${tail}`],
    ['encoded slash', `https://discord.com/api/webhooks/${ID}%2F${SECRET}`],
    ['encoded dots', `https://discord.com/api/%2e%2e/api/webhooks/${ID}/${SECRET}`],
    ['dot segments', `https://discord.com/api/webhooks/../webhooks/${ID}/${SECRET}`],
    ['double slash', `https://discord.com//api/webhooks/${ID}/${SECRET}`],
    ['other path', `https://discord.com/api/channels/${ID}/messages`],
    ['extra path', `${URL_}/slack`],
    ['github suffix', `${URL_}/github`],
    ['message path', `${URL_}/messages/123`],
    ['query', `${URL_}?wait=true`],
    ['thread query', `${URL_}?thread_id=123`],
    ['fragment', `${URL_}#x`],
    ['non-numeric id', `https://discord.com/api/webhooks/abc/${SECRET}`],
    ['short id', `https://discord.com/api/webhooks/123/${SECRET}`],
    ['missing token', `https://discord.com/api/webhooks/${ID}`],
    ['short token', `https://discord.com/api/webhooks/${ID}/short`],
    [
      'token with a dot',
      `https://discord.com/api/webhooks/${ID}/${SECRET.slice(0, 30)}.${SECRET.slice(30)}`,
    ],
    ['inner whitespace', `https://discord.com/api/webhooks/${ID}/ ${SECRET}`],
    ['newline injection', `https://discord.com/api/webhooks/${ID}/${SECRET}\nHost: evil.example`],
    ['tab in host', `https://dis\tcord.com${tail}`],
    ['null byte', `${URL_}\u0000`],
    ['two urls', `${URL_} https://evil.example`],
    ['wrapped in angle brackets', `<${URL_}>`],
    ['javascript scheme', `javascript:fetch('${URL_}')`],
    ['version too long', `https://discord.com/api/v100/webhooks/${ID}/${SECRET}`],
  ])('refuses %s', (_name, typed) => {
    let thrown: unknown;
    try {
      parseWebhookUrl(typed);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CredentialFormatError);
    // The refusal never repeats what was typed: it may be a working address with a typo.
    expect((thrown as Error).message).not.toContain(SECRET);
  });
});

describe('connectWithCredentials', () => {
  it('reads the webhook once and stores its id, token and where it posts', async () => {
    const net = discord();
    const result = await provider(net).connectWithCredentials({ webhookUrl: URL_ });
    expect(result).toEqual({
      accessToken: expect.any(String),
      externalId: ID,
      displayName: 'Acme Announcements',
    });
    expect(decodeDiscordCredentials(result.accessToken)).toEqual({
      id: ID,
      token: SECRET,
      guildId: GUILD,
      channelId: CHANNEL,
    });
    expect(net.seen).toHaveLength(1);
    expect(net.seen[0]).toMatchObject({ method: 'GET', url: URL_ });
    expect(net.seen[0]?.options.maxRedirects).toBe(0);
    // Verifying posts nothing.
    expect(executes(net.seen)).toHaveLength(0);
  });

  it('shows the webhook’s name and id, never its address', async () => {
    const { accessToken, ...shown } = await provider().connectWithCredentials({ webhookUrl: URL_ });
    expect(JSON.stringify(shown)).not.toContain(SECRET);
    expect(accessToken).toContain(SECRET);
  });

  it('always calls discord.com, even for the discordapp.com spelling', async () => {
    const net = discord();
    await provider(net).connectWithCredentials({
      webhookUrl: `https://discordapp.com/api/v10/webhooks/${ID}/${SECRET}/`,
    });
    expect(net.seen[0]?.url).toBe(URL_);
  });

  it.each([401, 403, 404])('a webhook Discord does not know (%i) → auth error', async (status) => {
    const net = discord({
      get: () => ({ status, body: { message: 'Unknown Webhook', code: 10015 } }),
    });
    const err = await provider(net)
      .connectWithCredentials({ webhookUrl: URL_ })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/does not know that webhook/);
    expect(err.message).not.toContain(SECRET);
  });

  it('refuses a webhook that cannot post, and an answer about a different webhook', async () => {
    const follower = discord({ get: () => ({ body: { ...webhookObject, type: 2 } }) });
    await expect(provider(follower).connectWithCredentials({ webhookUrl: URL_ })).rejects.toThrow(
      /cannot post messages/,
    );
    const other = discord({
      get: () => ({ body: { ...webhookObject, id: '299737254929760256' } }),
    });
    await expect(
      provider(other).connectWithCredentials({ webhookUrl: URL_ }),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
  });

  it('falls back to a plain name, and tolerates missing channel details', async () => {
    const net = discord({
      get: () => ({ body: { type: 1, id: ID, name: null, channel_id: null } }),
    });
    const result = await provider(net).connectWithCredentials({ webhookUrl: URL_ });
    expect(result.displayName).toBe('Discord webhook');
    expect(decodeDiscordCredentials(result.accessToken)).toEqual({ id: ID, token: SECRET });
  });

  it('rejects a malformed address without a single request', async () => {
    const net = discord();
    const inputs: Array<Record<string, string>> = [
      {},
      { webhookUrl: '' },
      { webhookUrl: `https://evil.example/api/webhooks/${ID}/${SECRET}` },
      { webhookUrl: `${URL_}?wait=true` },
    ];
    for (const bad of inputs) {
      await expect(provider(net).connectWithCredentials(bad)).rejects.toBeInstanceOf(
        CredentialFormatError,
      );
    }
    expect(net.seen).toHaveLength(0);
  });

  it('treats Discord being down, or throttling, as transient', async () => {
    const down = discord({ get: () => ({ status: 503, body: 'upstream' }) });
    await expect(
      provider(down).connectWithCredentials({ webhookUrl: URL_ }),
    ).rejects.toBeInstanceOf(ProviderTransientError);
    const slow = discord({
      get: () => ({ status: 429, body: { retry_after: 2.5, global: false } }),
    });
    await expect(
      provider(slow).connectWithCredentials({ webhookUrl: URL_ }),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
  });
});

describe('assertPublishable', () => {
  const p = provider();
  const check = (caption: string, media: PostDetails['media'] = []) =>
    p.assertPublishable(post(caption, media));

  it('takes 2000 characters as Discord receives them', () => {
    expect(() => check('a'.repeat(2000))).not.toThrow();
    expect(() => check('a'.repeat(2001))).toThrow(
      /2001 characters as Discord receives it; it takes at most 2000/,
    );
  });

  it('counts the escapes: 1500 asterisks are 3000 characters once defused', () => {
    expect(() => check('*'.repeat(1000))).not.toThrow();
    expect(() => check('*'.repeat(1500))).toThrow(/3000 characters as Discord receives it/);
  });

  it('takes up to ten files, images and videos alike', () => {
    expect(() =>
      check(
        'x',
        Array.from({ length: 10 }, (_, i) => file(`${i}.png`)),
      ),
    ).not.toThrow();
    expect(() => check('', [file('v.mp4', 'video')])).not.toThrow();
    expect(() =>
      check(
        'x',
        Array.from({ length: 11 }, (_, i) => file(`${i}.png`)),
      ),
    ).toThrow(/at most 10 files/);
  });

  it('needs something to send, and exactly one post', () => {
    expect(() => check(' \n ')).toThrow(/needs text, an image or a video/);
    expect(() => p.assertPublishable([])).toThrow(/exactly one post/);
  });
});

describe('post', () => {
  it('executes the webhook with wait=true and reports the message it created', async () => {
    const net = discord();
    const result = await provider(net).post(tokens(), post('Hello Discord'));
    expect(result).toEqual({
      externalPostId: MESSAGE,
      releaseUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
    });
    expect(net.seen).toHaveLength(1);
    expect(net.seen[0]).toMatchObject({ method: 'POST', url: `${URL_}?wait=true` });
    expect(net.seen[0]?.options.maxRedirects).toBe(0);
    expect(sentJson(net.seen[0])).toEqual({
      content: 'Hello Discord',
      allowed_mentions: { parse: [] },
    });
  });

  it('pings nobody: allowed_mentions is empty on every message, whatever the text says', async () => {
    const captions = [
      '@everyone big news',
      '@here <@123456789012345678> <@&123456789012345678> <#123456789012345678>',
      'plain',
      '',
    ];
    for (const caption of captions) {
      const net = discord();
      await provider(net).post(tokens(), post(caption, caption === '' ? [file('a.png')] : []));
      const [execute] = executes(net.seen);
      const payload =
        caption === ''
          ? (JSON.parse(
              parseMultipart(execute!).find((p) => p.name === 'payload_json')!.body,
            ) as Record<string, unknown>)
          : sentJson(execute);
      expect(payload.allowed_mentions).toEqual({ parse: [] });
    }
  });

  it('sends the text with its Markdown and mention syntax defused, and addresses intact', async () => {
    const net = discord();
    await provider(net).post(
      tokens(),
      post(
        '# SALE\n**50% off** _today_ <@123456789012345678> [click](https://evil.example)\nhttps://example.com/a_b_c',
      ),
    );
    expect(sentJson(net.seen[0]).content).toBe(
      '\\# SALE\n\\*\\*50% off\\*\\* \\_today\\_ \\<@123456789012345678> \\[click](https://evil.example)\nhttps://example.com/a_b_c',
    );
  });

  it('leaves Hindi and emoji exactly as typed', async () => {
    const net = discord();
    const caption = 'दिवाली की शुभकामनाएं 🪔';
    await provider(net).post(tokens(), post(caption));
    expect(sentJson(net.seen[0]).content).toBe(caption);
  });

  it('uploads files as multipart: payload_json first, then files[n] with names and types', async () => {
    const net = discord();
    await provider(net).post(
      tokens(),
      post('two files', [file('a.png'), file('clip.mp4', 'video')]),
    );
    const [execute] = executes(net.seen);
    expect(execute?.headers['content-type']).toMatch(
      /^multipart\/form-data; boundary=mgs-[0-9a-f]{32}$/,
    );
    const parts = parseMultipart(execute!);
    expect(parts.map((p) => [p.name, p.filename, p.contentType])).toEqual([
      ['payload_json', undefined, 'application/json'],
      ['files[0]', 'image-1.png', 'image/png'],
      ['files[1]', 'video-2.mp4', 'video/mp4'],
    ]);
    expect(JSON.parse(parts[0]!.body)).toEqual({
      content: 'two files',
      allowed_mentions: { parse: [] },
      attachments: [
        { id: 0, filename: 'image-1.png' },
        { id: 1, filename: 'video-2.mp4' },
      ],
    });
    expect(parts[1]!.body).toBe('bytes-of-a.png');
    expect(parts[2]!.body).toBe('bytes-of-clip.mp4');
    // The files were fetched first: nothing is posted if one cannot be had.
    expect(net.seen.map((s) => s.method)).toEqual(['GET', 'GET', 'POST']);
  });

  it('caps each download at 20 MiB and refuses a file type Discord is not sent', async () => {
    const net = discord();
    await provider(net).post(tokens(), post('x', [file('a.png')]));
    expect(net.seen[0]?.options.maxResponseBytes).toBe(20 * 1024 * 1024);

    const pdf = discord({
      media: () => ({ body: 'x', headers: { 'content-type': 'application/pdf' } }),
    });
    await expect(provider(pdf).post(tokens(), post('x', [file('a.pdf')]))).rejects.toThrow(
      /JPEG, PNG, GIF or WebP images and MP4, MOV or WebM videos/,
    );
    expect(executes(pdf.seen)).toHaveLength(0);

    const big = discord();
    const inner = big.fetchImpl;
    big.fetchImpl = async (url, options) => {
      if (url.startsWith('https://media.example.com/'))
        throw new SafeFetchError('too_large', 'big');
      return inner(url, options);
    };
    await expect(provider(big).post(tokens(), post('x', [file('a.png')]))).rejects.toThrow(
      'The image is larger than 21 MB, the most Discord takes.',
    );
    expect(executes(big.seen)).toHaveLength(0);
  });

  it('holds one post’s files together under this app’s own 50 MB ceiling', async () => {
    const net = discord({
      media: () => ({
        body: Buffer.alloc(18 * 1024 * 1024),
        headers: { 'content-type': 'image/png' },
      }),
    });
    await expect(
      provider(net).post(tokens(), post('x', [file('1.png'), file('2.png'), file('3.png')])),
    ).rejects.toThrow(/add up to more than 50 MB/);
    expect(executes(net.seen)).toHaveLength(0);
  });

  it('posts without a link when Discord never said which server the webhook is in', async () => {
    const net = discord({ execute: () => ({ body: { id: MESSAGE } }) });
    const result = await provider(net).post(
      tokens({ guildId: undefined, channelId: undefined }),
      post('x'),
    );
    expect(result.externalPostId).toBe(MESSAGE);
    expect(result.releaseUrl).toBeUndefined();
    expect(result.notice).toMatch(/did not report enough to link/);
  });

  it('refuses unreadable stored credentials as an auth error, without quoting them', async () => {
    const err = await provider()
      .post({ accessToken: `{"token":"${SECRET}"}`, externalId: 'x', displayName: 'x' }, post('x'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).not.toContain(SECRET);
  });
});

describe('error mapping', () => {
  const publish = (reply: Reply) =>
    provider(discord({ execute: () => reply }))
      .post(tokens(), post('x'))
      .catch((e) => e);

  it.each([
    [404, { message: 'Unknown Webhook', code: 10015 }],
    [401, { message: 'Invalid Webhook Token', code: 50027 }],
    [403, { message: 'Missing Access', code: 50001 }],
  ])('%i: the webhook is gone → auth (needs reconnect)', async (status, body) => {
    const err = await publish({ status, body });
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/Create a webhook on the channel again and reconnect/);
  });

  it('400 → bad request, with Discord’s own message and code', async () => {
    const err = await publish({
      status: 400,
      body: {
        message: 'Invalid Form Body',
        code: 50035,
        errors: { content: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH' }] } },
      },
    });
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe('Discord says: Invalid Form Body [50035]');
  });

  it('a forum channel’s webhook → bad request that says what to use instead', async () => {
    const err = await publish({
      status: 400,
      body: {
        message: 'Webhooks posted to forum channels must have a thread_name or thread_id',
        code: 220001,
      },
    });
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(/forum or media channel/);
  });

  it('413 → bad request about the file size', async () => {
    const err = await publish({
      status: 413,
      body: { message: 'Request entity too large', code: 40005 },
    });
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(/20 MB per file/);
  });

  it('429 → rate limited (transient), with retry_after from the body or the header', async () => {
    const body = await publish({
      status: 429,
      body: { message: 'You are being rate limited.', retry_after: 64.57, global: false },
      headers: { 'retry-after': '65', 'x-ratelimit-scope': 'user' },
    });
    expect(body).toBeInstanceOf(ProviderRateLimitError);
    expect(body.message).toBe(
      'Discord is rate limiting this connection. It asked for a 65 second wait.',
    );
    const header = await publish({
      status: 429,
      body: 'slow down',
      headers: { 'retry-after': '3' },
    });
    expect(header.message).toMatch(/3 second wait/);
  });

  it('5xx → transient', async () => {
    const err = await publish({ status: 502, body: 'Bad Gateway' });
    expect(err).toBeInstanceOf(ProviderTransientError);
    expect(err).not.toBeInstanceOf(ProviderRateLimitError);
  });

  it('a timeout AFTER the message was sent is final: it may have been posted', async () => {
    const net = discord();
    net.fetchImpl = async () => {
      throw new SafeFetchError('timeout', 'no answer from discord.com within 30000 ms', true);
    };
    const err = await provider(net)
      .post(tokens(), post('x'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe(
      'Discord did not answer in time. The post may or may not have been published — check the channel before retrying, so it is not posted twice.',
    );
  });

  it('a failure before anything was sent is retried', async () => {
    const net = discord();
    net.fetchImpl = async () => {
      throw new SafeFetchError('network', 'could not reach discord.com: ECONNRESET', false);
    };
    await expect(provider(net).post(tokens(), post('x'))).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });

  it('an answer without a message id is not reported as published', async () => {
    const err = await publish({ status: 200, body: {} });
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(/check the channel before retrying/);
  });
});

describe('the webhook address is a credential, and stays out of every error', () => {
  it('whatever fails, and whatever the far side echoes back', async () => {
    const echo = `POST ${URL_}?wait=true failed for token ${SECRET}`;
    const replies: Reply[] = [
      { status: 400, body: { message: echo, code: 50035 } },
      { status: 401, body: { message: echo } },
      { status: 404, body: { message: echo, code: 10015 } },
      { status: 413, body: { message: echo } },
      { status: 429, body: { message: echo, retry_after: 1 } },
      { status: 500, body: { message: echo } },
      { status: 500, body: echo },
      { status: 302, body: echo, headers: { location: URL_ } },
      { status: 200, body: echo },
    ];
    const messages: string[] = [];
    for (const reply of replies) {
      messages.push(
        String(
          (
            await provider(discord({ execute: () => reply }))
              .post(tokens(), post('x'))
              .catch((e) => e)
          )?.message ?? '',
        ),
        String(
          (
            await provider(discord({ get: () => reply }))
              .connectWithCredentials({ webhookUrl: URL_ })
              .catch((e) => e)
          )?.message ?? '',
        ),
      );
    }
    for (const cause of [
      new Error(`fetch ${URL_} failed`),
      new SafeFetchError('network', `could not reach ${URL_}`, false),
      new SafeFetchError('timeout', `no answer from ${URL_}`, true),
      new SafeFetchError('too_large', `${URL_} answered with too much`, true),
    ]) {
      const net = discord();
      net.fetchImpl = async () => {
        throw cause;
      };
      messages.push(
        String(
          (
            await provider(net)
              .post(tokens(), post('x'))
              .catch((e) => e)
          ).message,
        ),
        String(
          (
            await provider(net)
              .connectWithCredentials({ webhookUrl: URL_ })
              .catch((e) => e)
          ).message,
        ),
      );
    }
    expect(messages.length).toBeGreaterThan(20);
    for (const message of messages) {
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('/api/webhooks/');
    }
  });

  it('talks to discord.com for the webhook and to nothing else but the media’s own address', async () => {
    const hosts: string[] = [];
    const net = discord();
    const p = new DiscordProvider({
      fetchImpl: async (url, options) => {
        hosts.push(new URL(url).host);
        return net.fetchImpl(url, options);
      },
    });
    await p.connectWithCredentials({ webhookUrl: URL_ });
    await p.post(tokens(), post('x', [file('a.png')]));
    expect(hosts).toEqual(['discord.com', 'media.example.com', 'discord.com']);
    // The webhook address is never sent to the media host.
    const mediaRequest = net.seen.find((s) => s.url.startsWith('https://media.example.com/'));
    expect(JSON.stringify(mediaRequest?.headers)).not.toContain(SECRET);
  });
});

describe('analytics and the OAuth-shaped methods', () => {
  it('reports no numbers: a webhook cannot read anything back', async () => {
    const net = discord();
    const p = provider(net);
    expect(await p.postAnalytics()).toEqual([]);
    expect(await p.accountAnalytics()).toEqual([]);
    expect(net.seen).toHaveLength(0);
  });

  it('say how Discord is connected instead of producing a URL', async () => {
    const p = provider();
    await expect(p.generateAuthUrl()).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(p.authenticate()).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(p.refreshToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
