import { describe, expect, it, vi } from 'vitest';
import {
  ProviderBadRequestError,
  ProviderRateLimitError,
  ProviderTransientError,
} from '../../errors.js';
import { SafeFetchError, SsrfBlockedError, type SafeResponse } from '../../net/safe-fetch.js';
import {
  decodeStored,
  downloadMedia,
  encodeStored,
  fixedHostFetch,
  multipartBody,
  rateLimited,
  redact,
  retryAfterHeader,
  said,
  transportError,
  type ProviderFetch,
} from './http.js';

const SECRET = '123456789:AAF-secret_bot_token_value_0123456789abc';
const ok = (url: string): SafeResponse => ({
  status: 200,
  headers: {},
  body: Buffer.from(''),
  url,
});
const MEDIA = {
  mediaId: '11111111-1111-4111-8111-111111111111',
  kind: 'image' as const,
  url: 'https://media.example.com/a.jpg',
};

describe('fixedHostFetch', () => {
  it('passes a request to an allowed host through, with redirects off', async () => {
    const inner = vi.fn<ProviderFetch>(async (url) => ok(url));
    const fetch = fixedHostFetch(['api.telegram.org'], inner);
    await fetch(`https://api.telegram.org/bot${SECRET}/getMe`, { maxRedirects: 5 });
    expect(inner).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${SECRET}/getMe`,
      expect.objectContaining({ maxRedirects: 0 }),
    );
  });

  it.each([
    'https://evil.example/bot1/getMe',
    'https://api.telegram.org.evil.example/x',
    'https://api.telegram.org@evil.example/x',
    'https://evil.example/?https://api.telegram.org/',
    'https://xapi.telegram.org/x',
    'not a url',
  ])('refuses %s without making a request', async (url) => {
    const inner = vi.fn<ProviderFetch>(async (u) => ok(u));
    const fetch = fixedHostFetch(['api.telegram.org'], inner);
    await expect(fetch(url, {})).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(inner).not.toHaveBeenCalled();
  });

  it('never puts the refused address in the error: it may be the secret', async () => {
    const fetch = fixedHostFetch(['discord.com'], vi.fn());
    const err = await fetch(`https://evil.example/api/webhooks/1/${SECRET}`, {}).catch((e) => e);
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(String((err as Error).message)).not.toContain('evil.example');
  });
});

describe('redact / said', () => {
  it('blots out a secret wherever it appears, URL-encoded too', () => {
    const text = `GET /bot${SECRET}/getMe failed; again ${encodeURIComponent(SECRET)}`;
    const out = redact(text, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(encodeURIComponent(SECRET));
    expect(out).toContain('[redacted]');
  });

  it('ignores an empty or tiny "secret" rather than shredding the text', () => {
    expect(redact('a b c', ['', 'a'])).toBe('a b c');
  });

  it('flattens and shortens what a platform said, and redacts it', () => {
    expect(said(`  Bad\n Request: ${SECRET} `, [SECRET])).toBe('Bad Request: [redacted]');
    expect(said('x'.repeat(1000))).toHaveLength(300);
    expect(said(42)).toBe('');
  });
});

describe('transportError', () => {
  const context = { platform: 'Telegram', secrets: [SECRET] };

  it('treats a timeout on a read as transient', () => {
    const err = transportError(new SafeFetchError('timeout', 'no answer'), context);
    expect(err).toBeInstanceOf(ProviderTransientError);
  });

  it('makes a failure AFTER a post was sent final, with words about checking first', () => {
    const err = transportError(new SafeFetchError('timeout', 'no answer', true), {
      ...context,
      posts: 'the channel',
    });
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(/may or may not have been published — check the channel/);
  });

  it('still retries a post that never left', () => {
    const err = transportError(new SafeFetchError('network', 'refused', false), {
      ...context,
      posts: 'the channel',
    });
    expect(err).toBeInstanceOf(ProviderTransientError);
  });

  it('never retries a refused address, and retries a failed lookup', () => {
    expect(transportError(new SsrfBlockedError('address', 'not public'), context)).toBeInstanceOf(
      ProviderBadRequestError,
    );
    expect(transportError(new SsrfBlockedError('dns', 'not found'), context)).toBeInstanceOf(
      ProviderTransientError,
    );
  });

  it('redacts whatever the underlying error said', () => {
    for (const cause of [
      new Error(`connect to https://api.telegram.org/bot${SECRET}/sendMessage failed`),
      new SafeFetchError('network', `could not reach /bot${SECRET}/x`),
      new SafeFetchError('too_large', `answer for ${SECRET} too large`),
      new SsrfBlockedError('address', `refused ${SECRET}`),
    ]) {
      expect(transportError(cause, context).message).not.toContain(SECRET);
    }
  });
});

describe('rateLimited / retryAfterHeader', () => {
  it('is transient, and keeps the platform’s own wait in the message', () => {
    const err = rateLimited('Discord', 1.2);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect(err.message).toBe(
      'Discord is rate limiting this connection. It asked for a 2 second wait.',
    );
    expect(rateLimited('Slack', null).message).toBe('Slack is rate limiting this connection.');
  });

  it('reads Retry-After as seconds', () => {
    const response = (value?: string): SafeResponse => ({
      ...ok('https://x.example'),
      headers: value === undefined ? {} : { 'retry-after': value },
    });
    expect(retryAfterHeader(response('30'))).toBe(30);
    expect(retryAfterHeader(response('0.5'))).toBe(0.5);
    expect(retryAfterHeader(response('soon'))).toBeNull();
    expect(retryAfterHeader(response())).toBeNull();
  });
});

describe('downloadMedia', () => {
  it('fetches through the guard with a byte cap and returns the bare content type', async () => {
    const inner = vi.fn<ProviderFetch>(async (url) => ({
      status: 200,
      headers: { 'content-type': 'Image/JPEG; charset=binary' },
      body: Buffer.from('jpg'),
      url,
    }));
    const got = await downloadMedia(MEDIA, { maxBytes: 2_000_000, platform: 'Bluesky' }, inner);
    expect(got).toEqual({ body: Buffer.from('jpg'), contentType: 'image/jpeg' });
    expect(inner).toHaveBeenCalledWith(
      MEDIA.url,
      expect.objectContaining({ maxResponseBytes: 2_000_000 }),
    );
  });

  it('says how big is too big, in the platform’s own figure', async () => {
    const inner: ProviderFetch = async () => {
      throw new SafeFetchError('too_large', 'more than 2000000 bytes');
    };
    await expect(
      downloadMedia(MEDIA, { maxBytes: 2_000_000, platform: 'Bluesky' }, inner),
    ).rejects.toThrow('The image is larger than 2.0 MB, the most Bluesky takes.');
  });

  it('refuses media at a private address for good, and retries a server error', async () => {
    const blocked: ProviderFetch = async () => {
      throw new SsrfBlockedError('address', 'not public');
    };
    await expect(
      downloadMedia(MEDIA, { maxBytes: 1, platform: 'Discord' }, blocked),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    const down: ProviderFetch = async (url) => ({ ...ok(url), status: 503 });
    await expect(
      downloadMedia(MEDIA, { maxBytes: 1, platform: 'Discord' }, down),
    ).rejects.toBeInstanceOf(ProviderTransientError);
    const gone: ProviderFetch = async (url) => ({ ...ok(url), status: 404 });
    await expect(
      downloadMedia(MEDIA, { maxBytes: 1, platform: 'Discord' }, gone),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
  });

  it('refuses media that has no stored address', async () => {
    await expect(
      downloadMedia({ ...MEDIA, url: undefined }, { maxBytes: 1, platform: 'Discord' }, vi.fn()),
    ).rejects.toThrow(/no stored url/);
  });
});

describe('encodeStored / decodeStored', () => {
  it('round-trips, and answers null for anything that is not one of ours', () => {
    expect(decodeStored(encodeStored({ token: 't' }))).toEqual({ v: 1, token: 't' });
    for (const junk of ['', 'nope', '[]', '"x"', 'null']) expect(decodeStored(junk)).toBeNull();
  });
});

describe('multipartBody', () => {
  it('frames each part with one boundary that appears nowhere else', () => {
    const { body, contentType } = multipartBody([
      { name: 'payload_json', body: '{"content":"hi"}', contentType: 'application/json' },
      {
        name: 'files[0]',
        filename: 'image-1.png',
        contentType: 'image/png',
        body: Buffer.from([0, 255, 13, 10]),
      },
    ]);
    const boundary = /^multipart\/form-data; boundary=(mgs-[0-9a-f]{32})$/.exec(contentType)?.[1];
    expect(boundary).toBeDefined();
    const text = body.toString('latin1');
    expect(text.split(`--${boundary}`)).toHaveLength(4);
    expect(text).toContain(
      'Content-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n{"content":"hi"}\r\n',
    );
    expect(text).toContain(
      'name="files[0]"; filename="image-1.png"\r\nContent-Type: image/png\r\n\r\n',
    );
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
    // Binary bytes survive untouched.
    expect(body.includes(Buffer.from([0, 255, 13, 10]))).toBe(true);
  });

  it('cannot be made to inject a header through a name, a filename or a content type', () => {
    const { body } = multipartBody([
      {
        name: 'x"\r\nX-Evil: 1',
        filename: 'a".png\r\nX-Evil: 2',
        contentType: 'image/png\r\nX-Evil: 3',
        body: 'data',
      },
    ]);
    const head = body.toString('latin1').split('\r\n\r\n')[0]!;
    expect(head.split('\r\n')).toHaveLength(3);
    expect(head).not.toMatch(/^X-Evil/m);
  });

  it('uses a fresh boundary every time', () => {
    expect(multipartBody([]).contentType).not.toBe(multipartBody([]).contentType);
  });
});
