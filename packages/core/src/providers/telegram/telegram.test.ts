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
  assertBotToken,
  decodeTelegramCredentials,
  encodeTelegramCredentials,
  parseChat,
  TelegramProvider,
} from './telegram.js';

/**
 * FIXTURES ARE DOCUMENTATION-BUILT. Every request and response shape below is taken from the
 * Telegram Bot API reference (docs/dev/research/quick-platforms.md §2), not captured from
 * Telegram: this provider has never talked to it.
 */

const TOKEN = '123456789:AAF-secret_bot_token_value_0123456789abc';
const CHAT_ID = -1001234567890;
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';

interface Seen {
  method: string;
  url: string;
  params: Record<string, unknown>;
  options: SafeFetchOptions;
}

type Reply = { status?: number; body: unknown };
type Route = (params: Record<string, unknown>) => Reply;

const ok = (result: unknown): Reply => ({ body: { ok: true, result } });
const refuse = (status: number, description: string, parameters?: unknown): Reply => ({
  status,
  body: { ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) },
});

function telegram(overrides: Record<string, Route> = {}) {
  const seen: Seen[] = [];
  const routes: Record<string, Route> = {
    getMe: () => ok({ id: 987654321, is_bot: true, first_name: 'Acme Bot', username: 'acme_bot' }),
    getChat: () => ok({ id: CHAT_ID, type: 'channel', title: 'Acme News', username: 'acme_news' }),
    getChatMember: () =>
      ok({ status: 'administrator', user: { id: 987654321 }, can_post_messages: true }),
    sendMessage: () =>
      ok({ message_id: 42, chat: { id: CHAT_ID, type: 'channel', username: 'acme_news' } }),
    sendPhoto: () =>
      ok({ message_id: 43, chat: { id: CHAT_ID, type: 'channel', username: 'acme_news' } }),
    sendVideo: () =>
      ok({ message_id: 44, chat: { id: CHAT_ID, type: 'channel', username: 'acme_news' } }),
    sendMediaGroup: () =>
      ok([
        { message_id: 45, chat: { id: CHAT_ID, type: 'channel', username: 'acme_news' } },
        { message_id: 46, chat: { id: CHAT_ID, type: 'channel', username: 'acme_news' } },
      ]),
    ...overrides,
  };
  const fetchImpl = async (url: string, options: SafeFetchOptions): Promise<SafeResponse> => {
    const prefix = `https://api.telegram.org/bot${TOKEN}/`;
    if (!url.startsWith(prefix)) throw new Error('unexpected request');
    const method = url.slice(prefix.length);
    const params = JSON.parse(String(options.body)) as Record<string, unknown>;
    seen.push({ method, url, params, options });
    const route = routes[method];
    if (!route) throw new Error(`unexpected method ${method}`);
    const reply = route(params);
    return {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)),
      url,
    };
  };
  return { seen, fetchImpl };
}

const provider = (net = telegram()) => new TelegramProvider({ fetchImpl: net.fetchImpl });
const tokens = (
  overrides: Partial<Parameters<typeof encodeTelegramCredentials>[0]> = {},
): AuthTokens => ({
  accessToken: encodeTelegramCredentials({
    token: TOKEN,
    chatId: String(CHAT_ID),
    username: 'acme_news',
    ...overrides,
  }),
  externalId: String(CHAT_ID),
  displayName: 'Acme News',
});
const post = (caption: string, media: PostDetails['media'] = []): PostDetails[] => [
  { caption, media },
];
const photo = (n = 1) => ({
  mediaId: MEDIA_ID,
  kind: 'image' as const,
  url: `https://media.example.com/${n}.jpg`,
});
const video = { mediaId: MEDIA_ID, kind: 'video' as const, url: 'https://media.example.com/v.mp4' };
const fields = { token: TOKEN, chat: '@acme_news' };

describe('assertBotToken', () => {
  it('accepts a token as BotFather issues it', () => {
    expect(assertBotToken(` ${TOKEN}\n`)).toBe(TOKEN);
    expect(assertBotToken('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11')).toBe(
      '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    );
  });

  it.each([
    '',
    'not a token',
    '123456789',
    ':AAF-secret_bot_token_value_0123456789abc',
    '123456789:short',
    // Anything that could change the path of the request the token is placed in.
    `123456789:AAF-secret/../../getUpdates?x=${'a'.repeat(20)}`,
    `123456789:${'a'.repeat(20)}/sendMessage`,
    `123456789:${'a'.repeat(20)}?chat_id=1`,
    `123456789:${'a'.repeat(20)}#frag`,
    `123456789:${'a'.repeat(20)}%2F..`,
    `123456789:${'a'.repeat(20)} extra`,
    `bot123456789:${'a'.repeat(30)}`,
  ])('refuses %j before anything is contacted, without repeating it', (typed) => {
    let thrown: unknown;
    try {
      assertBotToken(typed);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CredentialFormatError);
    // (The message carries a made-up example of the shape; anything longer is what was typed.)
    if (typed.length > 12) expect((thrown as Error).message).not.toContain(typed);
  });
});

describe('parseChat', () => {
  it.each([
    ['@acme_news', '@acme_news'],
    ['acme_news', '@acme_news'],
    ['https://t.me/acme_news', '@acme_news'],
    ['t.me/acme_news/', '@acme_news'],
    ['https://telegram.me/acme_news?start=1', '@acme_news'],
    ['-1001234567890', '-1001234567890'],
    [' -1001234567890 ', '-1001234567890'],
    ['123456789', '123456789'],
  ])('reads %j as %s', (typed, chat) => {
    expect(parseChat(typed)).toBe(chat);
  });

  it.each([
    '',
    '@ab',
    '@1starts_with_digit',
    'has space',
    'https://evil.example/acme_news',
    'https://t.me/acme_news/123',
    '@acme-news',
    '@acme_news/../x',
  ])('refuses %j', (typed) => {
    expect(() => parseChat(typed)).toThrow(CredentialFormatError);
  });

  it('explains that an invite link is not an address a bot can use', () => {
    for (const link of ['https://t.me/+AbCdEfGhIjKlMnOp', 't.me/joinchat']) {
      expect(() => parseChat(link)).toThrow(/numeric id/);
    }
  });
});

describe('connectWithCredentials', () => {
  it('checks the token, the channel and the bot’s right to post, then stores the three', async () => {
    const net = telegram();
    const result = await provider(net).connectWithCredentials(fields);
    expect(result).toEqual({
      accessToken: expect.any(String),
      externalId: String(CHAT_ID),
      displayName: 'Acme News',
    });
    expect(decodeTelegramCredentials(result.accessToken)).toEqual({
      token: TOKEN,
      chatId: String(CHAT_ID),
      username: 'acme_news',
    });
    expect(net.seen.map((s) => [s.method, s.params])).toEqual([
      ['getMe', {}],
      ['getChat', { chat_id: '@acme_news' }],
      ['getChatMember', { chat_id: CHAT_ID, user_id: 987654321 }],
    ]);
    // Verifying sends nothing to the channel.
    expect(net.seen.some((s) => s.method.startsWith('send'))).toBe(false);
    for (const s of net.seen) expect(s.options.maxRedirects).toBe(0);
  });

  it('shows only the channel’s title and id — never the token', async () => {
    const { accessToken, ...shown } = await provider().connectWithCredentials(fields);
    expect(JSON.stringify(shown)).not.toContain(TOKEN);
    expect(accessToken).toContain(TOKEN);
  });

  it('connects a private channel by its numeric id', async () => {
    const net = telegram({
      getChat: () => ok({ id: CHAT_ID, type: 'channel', title: 'Inner Circle' }),
    });
    const result = await provider(net).connectWithCredentials({
      token: TOKEN,
      chat: String(CHAT_ID),
    });
    expect(result.displayName).toBe('Inner Circle');
    expect(decodeTelegramCredentials(result.accessToken).username).toBeUndefined();
    expect(net.seen[1]?.params).toEqual({ chat_id: String(CHAT_ID) });
  });

  it('a token Telegram does not know → auth error, and nothing further is asked', async () => {
    const net = telegram({ getMe: () => refuse(401, 'Unauthorized') });
    const err = await provider(net)
      .connectWithCredentials(fields)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/did not accept the bot token/);
    expect(net.seen.map((s) => s.method)).toEqual(['getMe']);
  });

  it('a channel the bot is not in → words about adding it, not a token problem', async () => {
    for (const reply of [
      refuse(400, 'Bad Request: chat not found'),
      refuse(403, 'Forbidden: bot is not a member of the channel chat'),
    ]) {
      const net = telegram({ getChat: () => reply });
      const err = await provider(net)
        .connectWithCredentials(fields)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err).not.toBeInstanceOf(CredentialFormatError);
      expect(err.message).toMatch(/Add the bot to the channel as an administrator first/);
    }
  });

  it.each([
    [{ status: 'administrator', can_post_messages: false }, /switch on “Post messages”/],
    [{ status: 'administrator' }, /switch on “Post messages”/],
    [{ status: 'member' }, /not an administrator of that channel/],
    [{ status: 'left' }, /not an administrator of that channel/],
    [{ status: 'kicked' }, /not an administrator of that channel/],
  ])('a channel where the bot is %j cannot be connected', async (member, wording) => {
    const net = telegram({ getChatMember: () => ok(member) });
    await expect(provider(net).connectWithCredentials(fields)).rejects.toThrow(wording);
  });

  it('accepts the channel’s creator, and a group the bot is simply a member of', async () => {
    const creator = telegram({ getChatMember: () => ok({ status: 'creator' }) });
    await expect(provider(creator).connectWithCredentials(fields)).resolves.toBeTruthy();
    const group = telegram({
      getChat: () => ok({ id: -100555, type: 'supergroup', title: 'Team' }),
      getChatMember: () => ok({ status: 'member' }),
    });
    await expect(provider(group).connectWithCredentials(fields)).resolves.toMatchObject({
      displayName: 'Team',
    });
    const muted = telegram({
      getChat: () => ok({ id: -100555, type: 'supergroup', title: 'Team' }),
      getChatMember: () => ok({ status: 'restricted', can_send_messages: false }),
    });
    await expect(provider(muted).connectWithCredentials(fields)).rejects.toThrow(/not a member/);
  });

  it('refuses a private chat with a person, and a token that is not a bot’s', async () => {
    const dm = telegram({
      getChat: () => ok({ id: 5550001, type: 'private', first_name: 'Asha' }),
    });
    await expect(provider(dm).connectWithCredentials(fields)).rejects.toThrow(/private chat/);
    const human = telegram({ getMe: () => ok({ id: 1, is_bot: false }) });
    await expect(provider(human).connectWithCredentials(fields)).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
  });

  it('rejects malformed input without a single request', async () => {
    const net = telegram();
    const inputs: Array<Record<string, string>> = [
      {},
      { token: TOKEN },
      { token: 'nope', chat: '@acme_news' },
      { token: TOKEN, chat: 'https://t.me/+invite' },
    ];
    for (const bad of inputs) {
      await expect(provider(net).connectWithCredentials(bad)).rejects.toBeInstanceOf(
        CredentialFormatError,
      );
    }
    expect(net.seen).toHaveLength(0);
  });

  it('treats Telegram being down as transient', async () => {
    const net = telegram({ getMe: () => refuse(502, 'Bad Gateway') });
    await expect(provider(net).connectWithCredentials(fields)).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });
});

describe('assertPublishable', () => {
  const p = provider();
  const check = (caption: string, media: PostDetails['media'] = []) =>
    p.assertPublishable(post(caption, media));

  it('takes 4096 characters of text, and 1024 beside media', () => {
    expect(() => check('a'.repeat(4096))).not.toThrow();
    expect(() => check('a'.repeat(4097))).toThrow(
      'The text is 4097 characters; Telegram takes at most 4096',
    );
    expect(() => check('a'.repeat(1024), [photo()])).not.toThrow();
    expect(() => check('a'.repeat(1025), [photo()])).toThrow(
      'The text is 1025 characters; beside a photo or video Telegram takes at most 1024 (4096 without media)',
    );
  });

  it('counts the typed text, not the escapes added for HTML mode', () => {
    // 4096 ampersands are 20 480 characters once escaped; Telegram counts them after parsing.
    expect(() => check('&'.repeat(4096))).not.toThrow();
  });

  it('takes up to ten photos and videos, mixed', () => {
    expect(() =>
      check(
        'x',
        Array.from({ length: 10 }, (_, i) => (i % 2 ? video : photo(i))),
      ),
    ).not.toThrow();
    expect(() =>
      check(
        'x',
        Array.from({ length: 11 }, (_, i) => photo(i)),
      ),
    ).toThrow(/at most 10/);
  });

  it('needs something to send, and exactly one post', () => {
    expect(() => check('  \n')).toThrow(/needs text, a photo or a video/);
    expect(() => check('', [photo()])).not.toThrow();
    expect(() => p.assertPublishable([])).toThrow(/exactly one post/);
  });

  it('decides on kind and count alone — a media ref has no url yet at create time', () => {
    expect(() => check('x', [{ mediaId: MEDIA_ID, kind: 'image' }])).not.toThrow();
  });
});

describe('post', () => {
  it('sends text in HTML mode with exactly the reserved characters escaped', async () => {
    const net = telegram();
    const caption =
      'Sale: 2 < 3 & "50%" > nothing <b>not bold</b> *still plain* _too_ https://example.com/a_b';
    const result = await provider(net).post(tokens(), post(caption));
    expect(result).toEqual({ externalPostId: '42', releaseUrl: 'https://t.me/acme_news/42' });
    expect(net.seen).toHaveLength(1);
    expect(net.seen[0]?.method).toBe('sendMessage');
    expect(net.seen[0]?.params).toEqual({
      chat_id: String(CHAT_ID),
      parse_mode: 'HTML',
      text: 'Sale: 2 &lt; 3 &amp; "50%" &gt; nothing &lt;b&gt;not bold&lt;/b&gt; *still plain* _too_ https://example.com/a_b',
    });
  });

  it('leaves Hindi and emoji exactly as typed', async () => {
    const net = telegram();
    const caption = 'दिवाली की शुभकामनाएं 🪔 #दिवाली';
    await provider(net).post(tokens(), post(caption));
    expect(net.seen[0]?.params.text).toBe(caption);
  });

  it('sends one photo by its public address, with the text as caption', async () => {
    const net = telegram();
    const result = await provider(net).post(tokens(), post('A & B', [photo()]));
    expect(net.seen.map((s) => s.method)).toEqual(['sendPhoto']);
    expect(net.seen[0]?.params).toEqual({
      chat_id: String(CHAT_ID),
      photo: 'https://media.example.com/1.jpg',
      caption: 'A &amp; B',
      parse_mode: 'HTML',
    });
    expect(result.releaseUrl).toBe('https://t.me/acme_news/43');
  });

  it('sends one video with sendVideo, and no caption field when there is no text', async () => {
    const net = telegram();
    await provider(net).post(tokens(), post('', [video]));
    expect(net.seen[0]?.method).toBe('sendVideo');
    expect(net.seen[0]?.params).toEqual({ chat_id: String(CHAT_ID), video: video.url });
  });

  it('sends several items as one album, captioned on the first', async () => {
    const net = telegram();
    const result = await provider(net).post(tokens(), post('<album>', [photo(1), video, photo(3)]));
    expect(net.seen.map((s) => s.method)).toEqual(['sendMediaGroup']);
    expect(net.seen[0]?.params).toEqual({
      chat_id: String(CHAT_ID),
      media: [
        {
          type: 'photo',
          media: 'https://media.example.com/1.jpg',
          caption: '&lt;album&gt;',
          parse_mode: 'HTML',
        },
        { type: 'video', media: video.url },
        { type: 'photo', media: 'https://media.example.com/3.jpg' },
      ],
    });
    expect(result).toEqual({ externalPostId: '45', releaseUrl: 'https://t.me/acme_news/45' });
  });

  it('links a private channel’s message the only way there is, and a basic group’s not at all', async () => {
    const inner = telegram({
      sendMessage: () => ok({ message_id: 7, chat: { id: CHAT_ID, type: 'channel' } }),
    });
    const privateChannel = await provider(inner).post(tokens({ username: undefined }), post('x'));
    expect(privateChannel.releaseUrl).toBe('https://t.me/c/1234567890/7');

    const basic = telegram({
      sendMessage: () => ok({ message_id: 8, chat: { id: -55501, type: 'group' } }),
    });
    const group = await provider(basic).post(
      tokens({ chatId: '-55501', username: undefined }),
      post('x'),
    );
    expect(group.releaseUrl).toBeUndefined();
    expect(group.externalPostId).toBe('8');
    expect(group.notice).toMatch(/no link to a single message/);
  });

  it('refuses media that is not at a public https address before asking Telegram', async () => {
    const net = telegram();
    for (const url of [undefined, 'http://localhost:8990/media/a.jpg']) {
      await expect(
        provider(net).post(tokens(), post('x', [{ mediaId: MEDIA_ID, kind: 'image', url }])),
      ).rejects.toBeInstanceOf(ProviderBadRequestError);
    }
    expect(net.seen).toHaveLength(0);
  });

  it('refuses unreadable stored credentials as an auth error, without quoting them', async () => {
    const err = await provider()
      .post({ accessToken: `{"token":"${TOKEN}"}`, externalId: 'x', displayName: 'x' }, post('x'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('error mapping', () => {
  const failing = (reply: Reply) => telegram({ sendMessage: () => reply });
  const publish = (net: ReturnType<typeof telegram>) =>
    provider(net)
      .post(tokens(), post('x'))
      .catch((e) => e);

  it('401: the token was revoked → auth (needs reconnect)', async () => {
    const err = await publish(failing(refuse(401, 'Unauthorized')));
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/Reconnect with the bot’s current token/);
  });

  it('403: the bot was removed from the channel → auth (needs reconnect)', async () => {
    const err = await publish(
      failing(refuse(403, 'Forbidden: bot was kicked from the channel chat')),
    );
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toBe(
      'Telegram says: Forbidden: bot was kicked from the channel chat. The bot was removed from the channel or lost the right to post there. Add it back as an administrator, then reconnect.',
    );
  });

  it.each([
    'Bad Request: chat not found',
    'Bad Request: not enough rights to send text messages to the chat',
    'Bad Request: need administrator rights in the channel chat',
    'Bad Request: group chat was upgraded to a supergroup chat',
  ])('400 "%s" at publish time → auth: the connection is what is broken', async (description) => {
    const err = await publish(failing(refuse(400, description)));
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toContain(description.replace('Bad Request: ', ''));
  });

  it('any other 400 → bad request, with Telegram’s own message', async () => {
    const err = await publish(failing(refuse(400, 'Bad Request: message is too long')));
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err.message).toBe('Telegram says: message is too long');
  });

  it('a media URL Telegram could not fetch → bad request', async () => {
    const net = telegram({
      sendPhoto: () => refuse(400, 'Bad Request: failed to get HTTP URL content'),
    });
    const err = await provider(net)
      .post(tokens(), post('x', [photo()]))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe('Telegram says: failed to get HTTP URL content');
  });

  it('429 → rate limited (transient), with Telegram’s retry_after', async () => {
    const err = await publish(
      failing(refuse(429, 'Too Many Requests: retry after 17', { retry_after: 17 })),
    );
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect(err.message).toBe(
      'Telegram is rate limiting this connection. It asked for a 17 second wait.',
    );
  });

  it('5xx → transient', async () => {
    const err = await publish(failing(refuse(502, 'Bad Gateway')));
    expect(err).toBeInstanceOf(ProviderTransientError);
    expect(err).not.toBeInstanceOf(ProviderRateLimitError);
  });

  it('a timeout AFTER the message was sent is final: it may have been posted', async () => {
    const net = telegram();
    net.fetchImpl = async () => {
      throw new SafeFetchError('timeout', 'no answer from api.telegram.org within 30000 ms', true);
    };
    const err = await publish(net);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe(
      'Telegram did not answer in time. The post may or may not have been published — check the channel before retrying, so it is not posted twice.',
    );
  });

  it('a failure before anything was sent is retried', async () => {
    const net = telegram();
    net.fetchImpl = async () => {
      throw new SafeFetchError('network', 'could not reach api.telegram.org: ECONNRESET', false);
    };
    expect(await publish(net)).toBeInstanceOf(ProviderTransientError);
  });

  it('a 200 that is not Telegram’s JSON is final for a send, since it may have gone out', async () => {
    const err = await publish(failing({ body: '<html>gateway</html>' }));
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(/may or may not have been published/);
  });

  it('a message without an id is not reported as published', async () => {
    const err = await publish(failing(ok({ chat: { id: CHAT_ID } })));
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(/check the channel before retrying/);
  });
});

describe('the token is in every request URL, and in nothing else', () => {
  it('whatever fails, no error carries the token or the URL', async () => {
    const echo = `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed for ${TOKEN}`;
    const replies: Reply[] = [
      refuse(400, echo),
      refuse(401, echo),
      refuse(403, echo),
      refuse(404, echo),
      refuse(429, echo, { retry_after: 3 }),
      refuse(500, echo),
      refuse(400, `Bad Request: chat not found ${echo}`),
      { body: echo },
      { status: 200, body: { ok: false, description: echo } },
    ];
    const messages: string[] = [];
    for (const reply of replies) {
      for (const method of ['getMe', 'getChat', 'getChatMember', 'sendMessage']) {
        const net = telegram({ [method]: () => reply });
        messages.push(
          String(
            (
              await provider(net)
                .connectWithCredentials(fields)
                .catch((e) => e)
            )?.message ?? '',
          ),
          String(
            (
              await provider(net)
                .post(tokens(), post('x'))
                .catch((e) => e)
            )?.message ?? '',
          ),
        );
      }
    }
    // Transport errors that quote the request, as a careless HTTP layer would.
    for (const cause of [
      new Error(`fetch https://api.telegram.org/bot${TOKEN}/sendMessage failed`),
      new SafeFetchError('network', `could not reach /bot${TOKEN}/sendMessage`, false),
      new SafeFetchError('timeout', `no answer for bot${TOKEN}`, true),
      new SafeFetchError('too_large', `answer to bot${TOKEN} too large`, true),
    ]) {
      const net = telegram();
      net.fetchImpl = async () => {
        throw cause;
      };
      messages.push(
        String(
          (
            await provider(net)
              .connectWithCredentials(fields)
              .catch((e) => e)
          ).message,
        ),
        String(
          (
            await provider(net)
              .post(tokens(), post('x'))
              .catch((e) => e)
          ).message,
        ),
      );
    }
    expect(messages.length).toBeGreaterThan(70);
    for (const message of messages) {
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(TOKEN.split(':')[1]);
      expect(message).not.toMatch(/\/bot\d/);
    }
  });

  it('only ever talks to api.telegram.org', async () => {
    const hosts: string[] = [];
    const net = telegram();
    const p = new TelegramProvider({
      fetchImpl: async (url, options) => {
        hosts.push(new URL(url).host);
        return net.fetchImpl(url, options);
      },
    });
    await p.connectWithCredentials(fields);
    await p.post(tokens(), post('x', [photo(), photo(2)]));
    expect(new Set(hosts)).toEqual(new Set(['api.telegram.org']));
  });
});

describe('analytics and the OAuth-shaped methods', () => {
  it('reports no numbers: the Bot API has none to give', async () => {
    const net = telegram();
    const p = provider(net);
    expect(await p.postAnalytics()).toEqual([]);
    expect(await p.accountAnalytics()).toEqual([]);
    expect(net.seen).toHaveLength(0);
  });

  it('say how Telegram is connected instead of producing a URL', async () => {
    const p = provider();
    await expect(p.generateAuthUrl()).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(p.authenticate()).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(p.refreshToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
