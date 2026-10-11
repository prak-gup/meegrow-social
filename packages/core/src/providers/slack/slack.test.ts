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
  decodeSlackCredentials,
  encodeSlackCredentials,
  parseLabel,
  parseSlackWebhookUrl,
  SlackProvider,
} from './slack.js';

/**
 * FIXTURES ARE DOCUMENTATION-BUILT. Every request and response shape below is taken from Slack's
 * documentation (docs/dev/research/quick-platforms.md §4), not captured from Slack: this provider
 * has never talked to it. In particular, that an EMPTY payload is answered `no_text` by a live
 * webhook is read off the documented error list, not observed.
 */

const TEAM = 'T00000000';
const HOOK = 'B00000000';
const SECRET = 'XXXXXXXXXXXXsecretXXXXXX';
const URL_ = `https://hooks.slack.com/services/${TEAM}/${HOOK}/${SECRET}`;
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';

interface Seen {
  url: string;
  payload: Record<string, unknown>;
  options: SafeFetchOptions;
}

type Reply = { status?: number; body?: string; headers?: Record<string, string> };

/** A live webhook: refuses an empty payload as `no_text`, answers `ok` to a real one. */
const live = (payload: Record<string, unknown>): Reply =>
  payload.text === undefined && payload.blocks === undefined
    ? { status: 400, body: 'no_text' }
    : { body: 'ok' };

function slack(answer: (payload: Record<string, unknown>) => Reply = live) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, options: SafeFetchOptions): Promise<SafeResponse> => {
    if (url !== URL_ || options.method !== 'POST') throw new Error('unexpected request');
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    seen.push({ url, payload, options });
    const reply = answer(payload);
    return {
      status: reply.status ?? 200,
      headers: { 'content-type': 'text/plain', ...reply.headers },
      body: Buffer.from(reply.body ?? ''),
      url,
    };
  };
  return { seen, fetchImpl };
}

const provider = (net = slack()) => new SlackProvider({ fetchImpl: net.fetchImpl });
const tokens = (): AuthTokens => ({
  accessToken: encodeSlackCredentials({ team: TEAM, hook: HOOK, secret: SECRET }),
  externalId: `${TEAM}/${HOOK}`,
  displayName: '#announcements',
});
const post = (caption: string, media: PostDetails['media'] = []): PostDetails[] => [
  { caption, media },
];
const image = (n = 1) => ({
  mediaId: MEDIA_ID,
  kind: 'image' as const,
  url: `https://media.example.com/${n}.png`,
});
const fields = { webhookUrl: URL_, label: '#announcements' };

describe('parseSlackWebhookUrl', () => {
  it('accepts an incoming-webhook address', () => {
    expect(parseSlackWebhookUrl(` ${URL_}\n`)).toEqual({ team: TEAM, hook: HOOK, secret: SECRET });
  });

  const tail = `/services/${TEAM}/${HOOK}/${SECRET}`;
  it.each([
    ['empty', ''],
    ['http', `http://hooks.slack.com${tail}`],
    ['no scheme', `hooks.slack.com${tail}`],
    ['scheme without slashes', `https:hooks.slack.com${tail}`],
    ['another host', `https://evil.example${tail}`],
    ['look-alike suffix', `https://hooks.slack.com.evil.example${tail}`],
    ['other Slack host', `https://slack.com${tail}`],
    ['workspace host', `https://acme.slack.com${tail}`],
    ['gov host', `https://hooks.slack-gov.com${tail}`],
    ['userinfo naming slack', `https://hooks.slack.com@evil.example${tail}`],
    ['backslash before @', `https://hooks.slack.com\\@evil.example${tail}`],
    ['port', `https://hooks.slack.com:8443${tail}`],
    ['trailing dot host', `https://hooks.slack.com.${tail}`],
    ['upper-case host', `https://HOOKS.SLACK.COM${tail}`],
    ['workflow trigger', `https://hooks.slack.com/triggers/${TEAM}/123/${SECRET}`],
    ['workflow webhook', `https://hooks.slack.com/workflows/${TEAM}/${HOOK}/123/${SECRET}`],
    ['missing secret', `https://hooks.slack.com/services/${TEAM}/${HOOK}`],
    ['short secret', `https://hooks.slack.com/services/${TEAM}/${HOOK}/abc`],
    ['ids swapped', `https://hooks.slack.com/services/${HOOK}/${TEAM}/${SECRET}`],
    ['encoded slash', `https://hooks.slack.com/services/${TEAM}%2F${HOOK}/${SECRET}`],
    ['dot segments', `https://hooks.slack.com/services/../services/${TEAM}/${HOOK}/${SECRET}`],
    ['trailing slash', `${URL_}/`],
    ['query', `${URL_}?x=1`],
    ['fragment', `${URL_}#x`],
    ['newline injection', `${URL_}\nHost: evil.example`],
    ['two urls', `${URL_} https://evil.example`],
    [
      'a Discord webhook',
      'https://discord.com/api/webhooks/199737254929760256/abcdefghijklmnopqrstuvwx',
    ],
  ])('refuses %s', (_name, typed) => {
    let thrown: unknown;
    try {
      parseSlackWebhookUrl(typed);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CredentialFormatError);
    expect((thrown as Error).message).not.toContain(SECRET);
  });
});

describe('parseLabel', () => {
  it('tidies a channel name and bounds it', () => {
    expect(parseLabel('  #announce\n\tments  ')).toBe('#announce ments');
    expect(() => parseLabel('   ')).toThrow(CredentialFormatError);
    expect(() => parseLabel('x'.repeat(81))).toThrow(/at most 80/);
  });
});

describe('connectWithCredentials', () => {
  it('proves the webhook is live with an empty payload — which posts nothing — then stores it', async () => {
    const net = slack();
    const result = await provider(net).connectWithCredentials(fields);
    expect(result).toEqual({
      accessToken: expect.any(String),
      externalId: `${TEAM}/${HOOK}`,
      displayName: '#announcements',
    });
    expect(decodeSlackCredentials(result.accessToken)).toEqual({
      team: TEAM,
      hook: HOOK,
      secret: SECRET,
    });
    expect(net.seen).toHaveLength(1);
    // The probe carries no text and no blocks: there is nothing in it Slack could post.
    expect(net.seen[0]?.payload).toEqual({});
    expect(net.seen[0]?.options.maxRedirects).toBe(0);
  });

  it('shows the label and the two ids, never the address', async () => {
    const { accessToken, ...shown } = await provider().connectWithCredentials(fields);
    expect(JSON.stringify(shown)).not.toContain(SECRET);
    expect(accessToken).toContain(SECRET);
  });

  it.each(['no_text', 'invalid_payload', 'missing_text_or_fallback_or_attachments'])(
    'takes a 400 "%s" as proof of life',
    async (body) => {
      const net = slack(() => ({ status: 400, body }));
      await expect(provider(net).connectWithCredentials(fields)).resolves.toBeTruthy();
    },
  );

  it.each([
    [404, 'no_service'],
    [404, 'no_active_hooks'],
    [403, 'invalid_token'],
    [400, 'no_service_id'],
    [400, 'no_team'],
    [404, ''],
    [410, 'gone'],
  ])('a webhook Slack does not know (%i %s) → auth error', async (status, body) => {
    const net = slack(() => ({ status, body }));
    const err = await provider(net)
      .connectWithCredentials(fields)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/does not know that webhook/);
    expect(err.message).not.toContain(SECRET);
  });

  it('says why when the channel is archived or an administrator forbids it', async () => {
    const archived = slack(() => ({ status: 410, body: 'channel_is_archived' }));
    await expect(provider(archived).connectWithCredentials(fields)).rejects.toThrow(/archived/);
    const restricted = slack(() => ({ status: 403, body: 'action_prohibited' }));
    const err = await provider(restricted)
      .connectWithCredentials(fields)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(/administrator has restricted/);
  });

  it('rejects malformed input without a single request', async () => {
    const net = slack();
    const inputs: Array<Record<string, string>> = [
      {},
      { webhookUrl: URL_ },
      { webhookUrl: URL_, label: '  ' },
      {
        webhookUrl: 'https://evil.example/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
        label: 'x',
      },
    ];
    for (const bad of inputs) {
      await expect(provider(net).connectWithCredentials(bad)).rejects.toBeInstanceOf(
        CredentialFormatError,
      );
    }
    expect(net.seen).toHaveLength(0);
  });

  it('treats Slack being down, or throttling, as transient', async () => {
    const down = slack(() => ({ status: 503, body: 'upstream' }));
    await expect(provider(down).connectWithCredentials(fields)).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
    const slow = slack(() => ({ status: 429, headers: { 'retry-after': '30' } }));
    await expect(provider(slow).connectWithCredentials(fields)).rejects.toBeInstanceOf(
      ProviderRateLimitError,
    );
  });
});

describe('assertPublishable', () => {
  const p = provider();
  const check = (caption: string, media: PostDetails['media'] = []) =>
    p.assertPublishable(post(caption, media));

  it('takes 3000 characters as Slack receives them', () => {
    expect(() => check('a'.repeat(3000))).not.toThrow();
    expect(() => check('a'.repeat(3001))).toThrow(
      /3001 characters as Slack receives it; it takes at most 3000/,
    );
  });

  it('counts the escapes: 700 ampersands are 3500 characters once escaped', () => {
    expect(() => check('&'.repeat(600))).not.toThrow();
    expect(() => check('&'.repeat(700))).toThrow(/3500 characters as Slack receives it/);
  });

  it('takes images only: a webhook cannot upload a video', () => {
    expect(() => check('x', [image()])).not.toThrow();
    expect(() => check('x', [{ mediaId: MEDIA_ID, kind: 'video' }])).toThrow(
      /cannot send video or any other file/,
    );
    expect(() =>
      check(
        'x',
        Array.from({ length: 11 }, (_, i) => image(i)),
      ),
    ).toThrow(/at most 10/);
  });

  it('needs something to send, and exactly one post', () => {
    expect(() => check(' \n ')).toThrow(/needs text or an image/);
    expect(() => check('', [image()])).not.toThrow();
    expect(() => p.assertPublishable([])).toThrow(/exactly one post/);
  });
});

describe('post', () => {
  it('sends one verbatim mrkdwn section and reports that Slack gives no link', async () => {
    const net = slack();
    const result = await provider(net).post(tokens(), post('Hello Slack'));
    expect(result.externalPostId).toBeUndefined();
    expect(result.releaseUrl).toBeUndefined();
    expect(result.notice).toMatch(/reports no link to the message/);
    expect(net.seen).toHaveLength(1);
    expect(net.seen[0]?.payload).toEqual({
      text: 'Hello Slack',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Hello Slack', verbatim: true } }],
    });
  });

  it('escapes & < > so no mention or command survives, and writes links explicitly', async () => {
    const net = slack();
    await provider(net).post(
      tokens(),
      post('<!channel> <!here> <@U123> Tom & Jerry > 2 see https://example.com/a?b=1&c=2.'),
    );
    const expected =
      '&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; Tom &amp; Jerry &gt; 2 see <https://example.com/a?b=1&amp;c=2>.';
    expect(net.seen[0]?.payload.text).toBe(expected);
    expect(net.seen[0]?.payload.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: expected, verbatim: true } },
    ]);
  });

  it('leaves Hindi and emoji exactly as typed', async () => {
    const net = slack();
    const caption = 'दिवाली की शुभकामनाएं 🪔';
    await provider(net).post(tokens(), post(caption));
    expect(net.seen[0]?.payload.text).toBe(caption);
  });

  it('shows images by their public address, one image block each — nothing is uploaded', async () => {
    const net = slack();
    await provider(net).post(tokens(), post('two', [image(1), image(2)]));
    expect(net.seen).toHaveLength(1);
    expect(net.seen[0]?.payload.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'two', verbatim: true } },
      { type: 'image', image_url: 'https://media.example.com/1.png', alt_text: 'Image 1' },
      { type: 'image', image_url: 'https://media.example.com/2.png', alt_text: 'Image 2' },
    ]);
  });

  it('sends an image alone with a fallback text and no empty section', async () => {
    const net = slack();
    await provider(net).post(tokens(), post('', [image()]));
    expect(net.seen[0]?.payload).toEqual({
      text: 'Image',
      blocks: [{ type: 'image', image_url: 'https://media.example.com/1.png', alt_text: 'Image' }],
    });
  });

  it('refuses an image Slack could not fetch, before posting anything', async () => {
    const net = slack();
    for (const url of [undefined, 'http://localhost:8990/media/a.png']) {
      await expect(
        provider(net).post(tokens(), post('x', [{ mediaId: MEDIA_ID, kind: 'image', url }])),
      ).rejects.toBeInstanceOf(ProviderBadRequestError);
    }
    expect(net.seen).toHaveLength(0);
  });

  it('refuses unreadable stored credentials as an auth error, without quoting them', async () => {
    for (const blob of [
      `{"secret":"${SECRET}"}`,
      // A stored blob cannot point the request at another host either.
      JSON.stringify({ team: 'T00000000', hook: 'B00000000', secret: `${SECRET}@evil.example/x` }),
      JSON.stringify({ team: '../T00000000', hook: 'B00000000', secret: SECRET }),
    ]) {
      const err = await provider()
        .post({ accessToken: blob, externalId: 'x', displayName: 'x' }, post('x'))
        .catch((e) => e);
      expect(err).toBeInstanceOf(ProviderAuthError);
      expect(err.message).not.toContain(SECRET);
    }
  });
});

describe('error mapping', () => {
  const publish = (reply: Reply) =>
    provider(slack(() => reply))
      .post(tokens(), post('x'))
      .catch((e) => e);

  it.each([
    [404, 'no_service'],
    [404, 'no_active_hooks'],
    [403, 'invalid_token'],
    [403, ''],
    [410, 'channel_is_archived'],
  ])('%i %s: the webhook or its channel is gone → auth (needs reconnect)', async (status, body) => {
    const err = await publish({ status, body });
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/reconnect/);
  });

  it('an administrator’s restriction → bad request, not a broken connection', async () => {
    for (const body of ['action_prohibited', 'posting_to_general_channel_denied']) {
      const err = await publish({ status: 403, body });
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err).not.toBeInstanceOf(ProviderAuthError);
    }
  });

  it('400 → bad request, with Slack’s own word', async () => {
    const err = await publish({ status: 400, body: 'invalid_payload' });
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe(
      'Slack says: invalid_payload — it could not read the message as sent.',
    );
    expect((await publish({ status: 400, body: 'invalid_blocks' })).message).toBe(
      'Slack says: invalid_blocks',
    );
  });

  it('does not pass along an answer that is not one of Slack’s words', async () => {
    const err = await publish({ status: 400, body: '<html><body>Bad Request</body></html>' });
    expect(err.message).toBe('Slack answered HTTP 400');
  });

  it('429 → rate limited (transient), with Retry-After', async () => {
    const err = await publish({ status: 429, body: '', headers: { 'retry-after': '30' } });
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect(err.message).toBe(
      'Slack is rate limiting this connection. It asked for a 30 second wait.',
    );
  });

  it('5xx → transient', async () => {
    const err = await publish({ status: 500, body: 'rollup_error' });
    expect(err).toBeInstanceOf(ProviderTransientError);
    expect(err).not.toBeInstanceOf(ProviderRateLimitError);
  });

  it('a timeout AFTER the message was sent is final: it may have been posted', async () => {
    const net = slack();
    net.fetchImpl = async () => {
      throw new SafeFetchError('timeout', 'no answer from hooks.slack.com within 30000 ms', true);
    };
    const err = await provider(net)
      .post(tokens(), post('x'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe(
      'Slack did not answer in time. The post may or may not have been published — check the channel before retrying, so it is not posted twice.',
    );
  });

  it('a failure before anything was sent is retried', async () => {
    const net = slack();
    net.fetchImpl = async () => {
      throw new SafeFetchError('network', 'could not reach hooks.slack.com: ECONNRESET', false);
    };
    await expect(provider(net).post(tokens(), post('x'))).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });

  it('a 200 that is not "ok" is not reported as published, nor retried', async () => {
    const err = await publish({ status: 200, body: '<html>gateway</html>' });
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(/may or may not have been published/);
  });
});

describe('the webhook address is a credential, and stays out of every error', () => {
  it('whatever fails, and whatever the far side echoes back', async () => {
    const echo = `POST ${URL_} failed for ${SECRET}`;
    const replies: Reply[] = [
      { status: 400, body: echo },
      { status: 403, body: echo },
      { status: 404, body: echo },
      { status: 429, body: echo },
      { status: 500, body: echo },
      { status: 200, body: echo },
    ];
    const messages: string[] = [];
    for (const reply of replies) {
      messages.push(
        String(
          (
            await provider(slack(() => reply))
              .post(tokens(), post('x'))
              .catch((e) => e)
          )?.message ?? '',
        ),
        String(
          (
            await provider(slack(() => reply))
              .connectWithCredentials(fields)
              .catch((e) => e)
          )?.message ?? '',
        ),
      );
    }
    for (const cause of [
      new Error(`fetch ${URL_} failed`),
      new SafeFetchError('network', `could not reach ${URL_}`, false),
      new SafeFetchError('timeout', `no answer from ${URL_}`, true),
    ]) {
      const net = slack();
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
              .connectWithCredentials(fields)
              .catch((e) => e)
          ).message,
        ),
      );
    }
    expect(messages.length).toBeGreaterThan(15);
    for (const message of messages) {
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('/services/');
    }
  });

  it('only ever talks to hooks.slack.com — images are Slack’s to fetch, not ours', async () => {
    const hosts: string[] = [];
    const net = slack();
    const p = new SlackProvider({
      fetchImpl: async (url, options) => {
        hosts.push(new URL(url).host);
        return net.fetchImpl(url, options);
      },
    });
    await p.connectWithCredentials(fields);
    await p.post(tokens(), post('x', [image(1), image(2)]));
    expect(new Set(hosts)).toEqual(new Set(['hooks.slack.com']));
  });
});

describe('analytics and the OAuth-shaped methods', () => {
  it('reports no numbers: a webhook returns no id to read anything by', async () => {
    const net = slack();
    const p = provider(net);
    expect(await p.postAnalytics()).toEqual([]);
    expect(await p.accountAnalytics()).toEqual([]);
    expect(net.seen).toHaveLength(0);
  });

  it('say how Slack is connected instead of producing a URL', async () => {
    const p = provider();
    await expect(p.generateAuthUrl()).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(p.authenticate()).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(p.refreshToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
