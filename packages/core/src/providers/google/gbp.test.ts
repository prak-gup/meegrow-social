import { afterEach, describe, expect, it, vi } from 'vitest';
import { GBP_SCOPES, GBP_SUMMARY_MAX, GbpProvider } from './gbp.js';
import {
  GBP_ACCESS_NOT_GRANTED,
  GoogleOAuthClient,
  mapGoogleError,
  type GoogleFetchLike,
} from './client.js';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import type { AuthTokens, PostDetails } from '../types.js';

/**
 * Contract tests for the Google Business Profile provider (#21) — CI never touches Google.
 *
 * FIXTURE PROVENANCE: NOT RECORDED. Google had granted no API access when these were written
 * (BUILD-SPEC-V2 §A1), so every response below is hand-built from Google's documented shapes as
 * summarised in docs/dev/research/gbp-linkedin.md. None of it came off the wire. They prove this
 * code matches the documentation, not that the documentation matches Google — the Meta bring-up
 * found exactly that gap (`post_impressions_unique`). Replace them with real recordings at the
 * live bring-up; §A7 of the research note is the checklist.
 */

interface Recorded {
  /** Substring matched against the request URL — first match wins. */
  match: string;
  status?: number;
  body: unknown;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const NOW = new Date('2026-10-11T09:30:00.000Z');

function recorder(responses: Recorded[]): { fetchImpl: GoogleFetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: GoogleFetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const hit = responses.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`no fixture recorded for ${url}`);
    const status = hit.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => hit.body };
  };
  return { fetchImpl, calls };
}

function provider(
  responses: Recorded[],
  clock: { ms: number } = { ms: NOW.getTime() },
): { gbp: GbpProvider; calls: Call[]; clock: { ms: number } } {
  const { fetchImpl, calls } = recorder(responses);
  const gbp = new GbpProvider(
    new GoogleOAuthClient({
      clientId: 'test-client.apps.googleusercontent.com',
      clientSecret: 'test-secret',
      fetchImpl,
      now: () => clock.ms,
    }),
    () => new Date(clock.ms),
  );
  return { gbp, calls, clock };
}

const REDIRECT = 'https://social.meegrowlabs.com/connect/callback';
const LOCATION = 'accounts/1001/locations/2002';
const POST_NAME = `${LOCATION}/localPosts/3003`;

/** A stored connection as the publish path rebuilds it: stale access token + the refresh token. */
const TOKENS: AuthTokens = {
  accessToken: 'STALE-ACCESS-TOKEN',
  refreshToken: 'REFRESH-TOKEN',
  externalId: LOCATION,
  displayName: 'Meegrow Labs — Noida',
};

/** Just-consented tokens, before a location is picked. No refresh token on purpose for these. */
const FRESH: AuthTokens = {
  accessToken: 'ACCESS-1',
  externalId: 'pending',
  displayName: 'pending',
};

const TOKEN_OK: Recorded = {
  match: 'oauth2.googleapis.com/token',
  body: {
    access_token: 'MINTED-ACCESS-TOKEN',
    expires_in: 3599,
    scope: 'https://www.googleapis.com/auth/business.manage',
    token_type: 'Bearer',
  },
};

const ACCOUNTS: Recorded = {
  match: 'mybusinessaccountmanagement.googleapis.com/v1/accounts',
  body: {
    accounts: [
      { name: 'accounts/1001', accountName: 'Meegrow Labs', type: 'LOCATION_GROUP' },
      { name: 'accounts/1009', accountName: 'Prakhar Gupta', type: 'PERSONAL' },
    ],
  },
};

const LOCATIONS_1001: Recorded = {
  match: 'accounts/1001/locations',
  body: {
    locations: [
      {
        name: 'locations/2002',
        title: 'Meegrow Labs',
        storefrontAddress: { regionCode: 'IN', locality: 'Noida', postalCode: '201301' },
      },
      // A service-area business: no storefront address at all.
      { name: 'locations/2003', title: 'Meegrow Mobile' },
    ],
  },
};

/** A personal account that manages nothing answers with an empty object, not an empty array. */
const LOCATIONS_1009: Recorded = { match: 'accounts/1009/locations', body: {} };

const LOCAL_POST_LIVE: Recorded = {
  match: '/localPosts',
  body: {
    name: POST_NAME,
    languageCode: 'en',
    summary: 'We are open this Diwali',
    state: 'LIVE',
    topicType: 'STANDARD',
    createTime: '2026-10-11T09:30:01.000Z',
    updateTime: '2026-10-11T09:30:01.000Z',
    searchUrl: 'https://local.google.com/place?id=2002&use=posts&lpsid=3003',
  },
};

/** The 0-QPM gate as Google documents a disabled/ungranted API. */
const ZERO_QPM_403 = {
  error: {
    code: 403,
    message:
      'Google My Business API has not been used in project 123456789012 before or it is disabled.',
    status: 'PERMISSION_DENIED',
  },
};

const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const PHOTO = {
  mediaId: MEDIA_ID,
  kind: 'image' as const,
  url: 'https://cdn.meegrowlabs.com/m/diwali.jpg',
};

function detail(over: Partial<PostDetails> = {}): PostDetails {
  return { caption: 'We are open this Diwali', media: [], ...over };
}

function gmb(over: Record<string, unknown> = {}): PostDetails['options'] {
  return { kind: 'gmb', topicType: 'STANDARD', ...over } as PostDetails['options'];
}

const EVENT = {
  title: 'Diwali open house',
  start: new Date('2026-11-08T04:30:00.000Z'),
  end: new Date('2026-11-08T12:00:00.000Z'),
};

function sentBody(call: Call): Record<string, unknown> {
  return JSON.parse(call.body ?? '{}') as Record<string, unknown>;
}

describe('auth url', () => {
  it('asks for offline access with a forced consent so a refresh token always comes back', async () => {
    const { gbp } = provider([]);
    const { url } = await gbp.generateAuthUrl({ redirectUri: REDIRECT, state: 'flow-123' });
    const parsed = new URL(url);

    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('include_granted_scopes')).toBe('false');
    expect(parsed.searchParams.get('state')).toBe('flow-123');
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(parsed.searchParams.get('client_id')).toBe('test-client.apps.googleusercontent.com');
  });

  it('requests business.manage and nothing else', async () => {
    const { gbp } = provider([]);
    const { url } = await gbp.generateAuthUrl({ redirectUri: REDIRECT, state: 's' });
    const scopes = new URL(url).searchParams.get('scope')!.split(' ');

    expect(scopes).toEqual([...GBP_SCOPES]);
    expect(scopes).toEqual(['https://www.googleapis.com/auth/business.manage']);
  });
});

describe('authenticate', () => {
  it('exchanges the code server-side and keeps the refresh token', async () => {
    const { gbp, calls } = provider([
      {
        match: 'oauth2.googleapis.com/token',
        body: { access_token: 'ACCESS-1', refresh_token: 'REFRESH-TOKEN', expires_in: 3599 },
      },
    ]);
    const tokens = await gbp.authenticate({ code: 'auth-code', redirectUri: REDIRECT });

    expect(tokens.accessToken).toBe('ACCESS-1');
    expect(tokens.refreshToken).toBe('REFRESH-TOKEN');
    // Two-phase: identity is unknown until a location is picked.
    expect(tokens.externalId).toBe('pending');
    expect(tokens.displayName).toBe('pending');

    const form = new URLSearchParams(calls[0]!.body);
    expect(calls[0]!.method).toBe('POST');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code');
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    expect(form.get('client_secret')).toBe('test-secret');
    // The secret travels in the POST body, never the URL.
    expect(calls[0]!.url).not.toContain('test-secret');
  });

  it('stores NO expiry, so health reads healthy instead of a permanent "expiring"', async () => {
    const { gbp } = provider([
      {
        match: 'oauth2.googleapis.com/token',
        body: { access_token: 'ACCESS-1', refresh_token: 'REFRESH-TOKEN', expires_in: 3599 },
      },
    ]);
    const tokens = await gbp.authenticate({ code: 'auth-code', redirectUri: REDIRECT });
    // The one-hour access-token expiry would sit inside the 7-day health window forever.
    expect(tokens.expiresAt).toBeUndefined();
  });

  it('refuses a consent that came back without a refresh token', async () => {
    const { gbp } = provider([
      {
        match: 'oauth2.googleapis.com/token',
        body: { access_token: 'ACCESS-1', expires_in: 3599 },
      },
    ]);
    const attempt = gbp.authenticate({ code: 'auth-code', redirectUri: REDIRECT });

    await expect(attempt).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(attempt).rejects.toThrow(/prompt=consent/);
  });
});

describe('listAccounts — the two-phase location pick', () => {
  it('walks accounts → locations and returns composite accounts/{a}/locations/{l} ids', async () => {
    const { gbp, calls } = provider([LOCATIONS_1001, LOCATIONS_1009, ACCOUNTS]);
    const accounts = await gbp.listAccounts(FRESH);

    expect(accounts).toEqual([
      { externalId: 'accounts/1001/locations/2002', displayName: 'Meegrow Labs — Noida' },
      // No locality → the title alone, never "Meegrow Mobile — undefined".
      { externalId: 'accounts/1001/locations/2003', displayName: 'Meegrow Mobile' },
    ]);
    // Phase one first, then one locations call per account.
    expect(calls[0]!.url).toContain('mybusinessaccountmanagement.googleapis.com/v1/accounts');
    expect(calls[1]!.url).toContain(
      'mybusinessbusinessinformation.googleapis.com/v1/accounts/1001/locations',
    );
    expect(calls[2]!.url).toContain('accounts/1009/locations');
    // readMask is mandatory on locations.list.
    expect(new URL(calls[1]!.url).searchParams.get('readMask')).toBe(
      'name,title,storefrontAddress',
    );
  });

  it('sends the token as a Bearer header and never in the URL', async () => {
    const { gbp, calls } = provider([LOCATIONS_1001, LOCATIONS_1009, ACCOUNTS]);
    await gbp.listAccounts(FRESH);

    for (const call of calls) {
      expect(call.headers.Authorization).toBe('Bearer ACCESS-1');
      expect(call.url).not.toContain('ACCESS-1');
    }
  });

  it('follows nextPageToken on both phases', async () => {
    const { gbp, calls } = provider([
      {
        match: 'accounts/1001/locations?readMask=name%2Ctitle%2CstorefrontAddress&pageSize=100&',
        body: { locations: [{ name: 'locations/2004', title: 'Second page' }] },
      },
      {
        match: 'accounts/1001/locations',
        body: { locations: [{ name: 'locations/2002', title: 'First page' }], nextPageToken: 'L2' },
      },
      { match: 'accounts?pageSize=20&pageToken=A2', body: { accounts: [] } },
      {
        match: 'v1/accounts',
        body: { accounts: [{ name: 'accounts/1001' }], nextPageToken: 'A2' },
      },
    ]);
    const accounts = await gbp.listAccounts(FRESH);

    expect(accounts.map((a) => a.externalId)).toEqual([
      'accounts/1001/locations/2002',
      'accounts/1001/locations/2004',
    ]);
    expect(calls[1]!.url).toContain('pageToken=A2');
    expect(calls[3]!.url).toContain('pageToken=L2');
  });

  it('returns only ids and names — no token ends up in plain-JSON oauth_flows.accounts', async () => {
    const { gbp } = provider([LOCATIONS_1001, LOCATIONS_1009, ACCOUNTS]);
    const accounts = await gbp.listAccounts(FRESH);

    expect(JSON.stringify(accounts)).not.toContain('ACCESS-1');
    for (const account of accounts) {
      expect(Object.keys(account).sort()).toEqual(['displayName', 'externalId']);
    }
  });

  it('declares the two-phase flow and has no per-location token swap', () => {
    const { gbp } = provider([]);
    expect(gbp.identifier).toBe('gmb');
    expect(gbp.isBetweenSteps).toBe(true);
    expect(gbp.tokenModel).toBe('auto-refresh');
    // Locations publish with the user token; the connect service skips finalize when it is absent.
    expect((gbp as { finalizeAccount?: unknown }).finalizeAccount).toBeUndefined();
  });

  it('surfaces the 0-QPM gate at connect time as an operator message, not a retry', async () => {
    const { gbp } = provider([{ match: 'v1/accounts', status: 403, body: ZERO_QPM_403 }]);
    const attempt = gbp.listAccounts(FRESH);

    await expect(attempt).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(attempt).rejects.toThrow(GBP_ACCESS_NOT_GRANTED);
  });
});

describe('refreshToken', () => {
  it('mints a new access token with grant_type=refresh_token', async () => {
    const { gbp, calls } = provider([TOKEN_OK]);
    const tokens = await gbp.refreshToken('REFRESH-TOKEN');

    expect(tokens.accessToken).toBe('MINTED-ACCESS-TOKEN');
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('REFRESH-TOKEN');
    expect(form.get('client_id')).toBe('test-client.apps.googleusercontent.com');
  });

  it('returns no refresh token and no expiry — the sweeper keeps the stored one', async () => {
    const { gbp } = provider([TOKEN_OK]);
    const tokens = await gbp.refreshToken('REFRESH-TOKEN');
    // Google does not rotate refresh tokens; `?? conn.refreshToken` in the sweeper relies on this.
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt).toBeUndefined();
  });

  it('maps invalid_grant to an auth error — the 7-day Testing-mode expiry lands here', async () => {
    const { gbp } = provider([
      {
        match: 'oauth2.googleapis.com/token',
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    ]);
    await expect(gbp.refreshToken('DEAD')).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('access tokens — minted per call, because the stored one is an hour old at best', () => {
  it('mints from the refresh token and ignores the stale stored access token', async () => {
    const { gbp, calls } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    await gbp.post(TOKENS, [detail()]);

    expect(calls[0]!.url).toContain('oauth2.googleapis.com/token');
    expect(calls[1]!.headers.Authorization).toBe('Bearer MINTED-ACCESS-TOKEN');
    expect(JSON.stringify(calls)).not.toContain('STALE-ACCESS-TOKEN');
  });

  it('reuses the minted token until it nears expiry, then mints again', async () => {
    const { gbp, calls, clock } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    const mints = () => calls.filter((c) => c.url.includes('/token')).length;

    await gbp.post(TOKENS, [detail()]);
    clock.ms += 30 * 60 * 1000;
    await gbp.post(TOKENS, [detail()]);
    expect(mints()).toBe(1);

    // 59m30s in: inside the one-minute skew before Google's 3599s expiry.
    clock.ms += 29.5 * 60 * 1000;
    await gbp.post(TOKENS, [detail()]);
    expect(mints()).toBe(2);
  });

  it('flags the connection when the refresh token is dead at publish time', async () => {
    const { gbp, calls } = provider([
      {
        match: 'oauth2.googleapis.com/token',
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    ]);
    await expect(gbp.post(TOKENS, [detail()])).rejects.toBeInstanceOf(ProviderAuthError);
    // Nothing was sent to the posting host.
    expect(calls.some((c) => c.url.includes('localPosts'))).toBe(false);
  });
});

describe('assertPublishable — GBP rules, checked at create time', () => {
  const second = { ...PHOTO, mediaId: '22222222-2222-4222-8222-222222222222' };

  it.each<[string, PostDetails[]]>([
    ['plain STANDARD post', [detail()]],
    ['STANDARD without options at all', [detail({ options: undefined })]],
    ['caption exactly at the limit', [detail({ caption: 'x'.repeat(GBP_SUMMARY_MAX) })]],
    ['one photo', [detail({ media: [PHOTO] })]],
    [
      // Create-time refs may not be resolved yet (services/posts.ts) — arity only.
      'one photo with no url yet',
      [detail({ media: [{ mediaId: MEDIA_ID, kind: 'image' }] })],
    ],
    [
      'LEARN_MORE with url',
      [
        detail({
          options: gmb({ cta: { actionType: 'LEARN_MORE', url: 'https://meegrowlabs.com' } }),
        }),
      ],
    ],
    ['CALL without url', [detail({ options: gmb({ cta: { actionType: 'CALL' } }) })]],
    ['EVENT with dates', [detail({ options: gmb({ topicType: 'EVENT', event: EVENT }) })]],
    [
      'OFFER with schedule and offer',
      [
        detail({
          options: gmb({ topicType: 'OFFER', event: EVENT, offer: { couponCode: 'DIWALI10' } }),
        }),
      ],
    ],
    ['OFFER with schedule only', [detail({ options: gmb({ topicType: 'OFFER', event: EVENT }) })]],
  ])('accepts: %s', (_label, details) => {
    const { gbp } = provider([]);
    expect(() => gbp.assertPublishable(details)).not.toThrow();
  });

  it.each<[string, PostDetails[], RegExp]>([
    ['a thread', [detail(), detail()], /no thread concept/],
    ['no details', [], /exactly one post/],
    ['empty caption', [detail({ caption: '' })], /need a caption/],
    ['whitespace-only caption', [detail({ caption: '   \n' })], /need a caption/],
    [
      'caption one over the limit',
      [detail({ caption: 'x'.repeat(GBP_SUMMARY_MAX + 1) })],
      /1501 chars; the limit is 1500/,
    ],
    ['two media', [detail({ media: [PHOTO, second] })], /at most one media item/],
    [
      'CALL with a url',
      [
        detail({
          options: gmb({ cta: { actionType: 'CALL', url: 'https://meegrowlabs.com' } }),
        }),
      ],
      /CALL button takes no url/,
    ],
    [
      'LEARN_MORE without a url',
      [detail({ options: gmb({ cta: { actionType: 'LEARN_MORE' } }) })],
      /LEARN_MORE button needs a url/,
    ],
    [
      'BOOK without a url',
      [detail({ options: gmb({ cta: { actionType: 'BOOK' } }) })],
      /BOOK button needs a url/,
    ],
    [
      'EVENT without event',
      [detail({ options: gmb({ topicType: 'EVENT' }) })],
      /EVENT posts need event title and dates/,
    ],
    [
      'EVENT ending before it starts',
      [
        detail({
          options: gmb({
            topicType: 'EVENT',
            event: { ...EVENT, end: new Date('2026-11-08T04:00:00.000Z') },
          }),
        }),
      ],
      /must end after it starts/,
    ],
    [
      'EVENT with zero duration',
      [detail({ options: gmb({ topicType: 'EVENT', event: { ...EVENT, end: EVENT.start } }) })],
      /must end after it starts/,
    ],
    [
      'EVENT title over 58 chars',
      [
        detail({
          options: gmb({ topicType: 'EVENT', event: { ...EVENT, title: 'x'.repeat(59) } }),
        }),
      ],
      /event title is 59 chars; the limit is 58/,
    ],
    [
      'OFFER without its schedule',
      [detail({ options: gmb({ topicType: 'OFFER', offer: { couponCode: 'DIWALI10' } }) })],
      /OFFER posts need event title and dates/,
    ],
    [
      'offer on a STANDARD post',
      [detail({ options: gmb({ offer: { couponCode: 'DIWALI10' } }) })],
      /STANDARD posts cannot carry offer details/,
    ],
    [
      'offer on an EVENT post',
      [
        detail({
          options: gmb({ topicType: 'EVENT', event: EVENT, offer: { couponCode: 'DIWALI10' } }),
        }),
      ],
      /EVENT posts cannot carry offer details/,
    ],
    [
      'event on a STANDARD post',
      [detail({ options: gmb({ event: EVENT }) })],
      /STANDARD posts cannot carry event details/,
    ],
    ['ALERT', [detail({ options: gmb({ topicType: 'ALERT' }) })], /ALERT posts are not supported/],
  ])('rejects: %s', (_label, details, message) => {
    const { gbp } = provider([]);
    expect(() => gbp.assertPublishable(details)).toThrow(ProviderBadRequestError);
    expect(() => gbp.assertPublishable(details)).toThrow(message);
  });
});

describe('post', () => {
  it('publishes STANDARD + photo + LEARN_MORE to the v4 localPosts collection (#21 AC)', async () => {
    const { gbp, calls } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    const result = await gbp.post(TOKENS, [
      detail({
        media: [PHOTO],
        options: gmb({ cta: { actionType: 'LEARN_MORE', url: 'https://meegrowlabs.com/diwali' } }),
      }),
    ]);

    const call = calls[1]!;
    expect(call.method).toBe('POST');
    // The composite externalId round-trips straight into the v4 path.
    expect(call.url).toBe(
      'https://mybusiness.googleapis.com/v4/accounts/1001/locations/2002/localPosts',
    );
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(sentBody(call)).toEqual({
      languageCode: 'en',
      summary: 'We are open this Diwali',
      topicType: 'STANDARD',
      callToAction: { actionType: 'LEARN_MORE', url: 'https://meegrowlabs.com/diwali' },
      media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://cdn.meegrowlabs.com/m/diwali.jpg' }],
    });
    expect(result).toEqual({
      externalPostId: POST_NAME,
      releaseUrl: 'https://local.google.com/place?id=2002&use=posts&lpsid=3003',
    });
  });

  it('sends a text-only STANDARD post with no media, CTA, event or offer keys', async () => {
    const { gbp, calls } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    await gbp.post(TOKENS, [detail()]);

    expect(sentBody(calls[1]!)).toEqual({
      languageCode: 'en',
      summary: 'We are open this Diwali',
      topicType: 'STANDARD',
    });
  });

  it('sends a CALL button with no url', async () => {
    const { gbp, calls } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    await gbp.post(TOKENS, [detail({ options: gmb({ cta: { actionType: 'CALL' } }) })]);

    expect(sentBody(calls[1]!).callToAction).toEqual({ actionType: 'CALL' });
  });

  it('shapes an EVENT with a split date/time schedule (UTC wall-clock)', async () => {
    const { gbp, calls } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    await gbp.post(TOKENS, [detail({ options: gmb({ topicType: 'EVENT', event: EVENT }) })]);

    const body = sentBody(calls[1]!);
    expect(body.topicType).toBe('EVENT');
    expect(body.event).toEqual({
      title: 'Diwali open house',
      schedule: {
        startDate: { year: 2026, month: 11, day: 8 },
        startTime: { hours: 4, minutes: 30, seconds: 0, nanos: 0 },
        endDate: { year: 2026, month: 11, day: 8 },
        endTime: { hours: 12, minutes: 0, seconds: 0, nanos: 0 },
      },
    });
    expect(body).not.toHaveProperty('offer');
  });

  it('shapes an OFFER with Google’s field names, not ours', async () => {
    const { gbp, calls } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    await gbp.post(TOKENS, [
      detail({
        options: gmb({
          topicType: 'OFFER',
          event: EVENT,
          offer: {
            couponCode: 'DIWALI10',
            redeemUrl: 'https://meegrowlabs.com/redeem',
            terms: 'One per customer.',
          },
        }),
      }),
    ]);

    const body = sentBody(calls[1]!);
    expect(body.topicType).toBe('OFFER');
    expect(body.offer).toEqual({
      couponCode: 'DIWALI10',
      redeemOnlineUrl: 'https://meegrowlabs.com/redeem',
      termsConditions: 'One per customer.',
    });
    expect(body.event).toMatchObject({ title: 'Diwali open house' });
  });

  it('never sends an ALERT — it is rejected before any request', async () => {
    const { gbp, calls } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    await expect(
      gbp.post(TOKENS, [detail({ options: gmb({ topicType: 'ALERT' }) })]),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    expect(calls).toHaveLength(0);
  });

  it('treats PROCESSING as success — Google is still fetching the photo', async () => {
    const { gbp } = provider([
      TOKEN_OK,
      { match: '/localPosts', body: { name: POST_NAME, state: 'PROCESSING' } },
    ]);
    const result = await gbp.post(TOKENS, [detail({ media: [PHOTO] })]);

    expect(result.externalPostId).toBe(POST_NAME);
    // No searchUrl yet: still a real URL, because postView validates releaseUrl as one.
    expect(() => new URL(result.releaseUrl)).not.toThrow();
  });

  it('fails permanently when Google answers REJECTED', async () => {
    const { gbp } = provider([
      TOKEN_OK,
      { match: '/localPosts', body: { name: POST_NAME, state: 'REJECTED' } },
    ]);
    const attempt = gbp.post(TOKENS, [detail()]);

    await expect(attempt).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(attempt).rejects.toThrow(/REJECTED/);
  });

  it('does not retry a response with no name — the post may already exist', async () => {
    const { gbp } = provider([TOKEN_OK, { match: '/localPosts', body: { state: 'LIVE' } }]);
    await expect(gbp.post(TOKENS, [detail()])).rejects.toBeInstanceOf(ProviderBadRequestError);
  });

  it('rejects media with no public url at publish time — GBP is URL-only', async () => {
    const { gbp, calls } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    const attempt = gbp.post(TOKENS, [detail({ media: [{ mediaId: MEDIA_ID, kind: 'image' }] })]);

    await expect(attempt).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(attempt).rejects.toThrow(/URL-only/);
    expect(calls.some((c) => c.url.includes('localPosts'))).toBe(false);
  });

  it('enforces the summary limit again at publish time', async () => {
    const { gbp, calls } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    await expect(
      gbp.post(TOKENS, [detail({ caption: 'x'.repeat(GBP_SUMMARY_MAX + 1) })]),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a connection whose id is not the composite location path', async () => {
    const { gbp } = provider([TOKEN_OK, LOCAL_POST_LIVE]);
    await expect(
      gbp.post({ ...TOKENS, externalId: 'locations/2002' }, [detail()]),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
  });

  it('maps the 0-QPM 403 to a permanent failure with the operator message (#21 AC)', async () => {
    const { gbp } = provider([TOKEN_OK, { match: '/localPosts', status: 403, body: ZERO_QPM_403 }]);
    const attempt = gbp.post(TOKENS, [detail()]);

    // Bad request, not transient: BullMQ must not retry against the access gate.
    await expect(attempt).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(attempt).rejects.toThrow(GBP_ACCESS_NOT_GRANTED);
  });

  it('retries a 503 and reconnects on a 401', async () => {
    const unavailable = provider([
      TOKEN_OK,
      {
        match: '/localPosts',
        status: 503,
        body: { error: { code: 503, message: 'The service is currently unavailable.' } },
      },
    ]);
    await expect(unavailable.gbp.post(TOKENS, [detail()])).rejects.toBeInstanceOf(
      ProviderTransientError,
    );

    const revoked = provider([
      TOKEN_OK,
      {
        match: '/localPosts',
        status: 401,
        body: {
          error: {
            code: 401,
            message: 'Request had invalid authentication credentials.',
            status: 'UNAUTHENTICATED',
          },
        },
      },
    ]);
    await expect(revoked.gbp.post(TOKENS, [detail()])).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('postAnalytics', () => {
  const INSIGHTS: Recorded = {
    match: 'localPosts:reportInsights',
    body: {
      name: LOCATION,
      localPostMetrics: [
        {
          localPostName: POST_NAME,
          metricValues: [
            // int64 arrives as a string.
            {
              metric: 'LOCAL_POST_VIEWS_SEARCH',
              totalValue: { metricOption: 'AGGREGATED_TOTAL', value: '128' },
            },
            {
              metric: 'LOCAL_POST_ACTIONS_CALL_TO_ACTION',
              totalValue: { metricOption: 'AGGREGATED_TOTAL', value: '7' },
            },
          ],
        },
      ],
    },
  };

  it('asks reportInsights for the post over a trailing window', async () => {
    const { gbp, calls } = provider([TOKEN_OK, INSIGHTS]);
    await gbp.postAnalytics(TOKENS, POST_NAME);

    const call = calls[1]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(
      'https://mybusiness.googleapis.com/v4/accounts/1001/locations/2002/localPosts:reportInsights',
    );
    expect(sentBody(call)).toEqual({
      localPostNames: [POST_NAME],
      basicRequest: {
        metricRequests: [
          { metric: 'LOCAL_POST_VIEWS_SEARCH' },
          { metric: 'LOCAL_POST_ACTIONS_CALL_TO_ACTION' },
        ],
        timeRange: { startTime: '2026-09-11T09:30:00.000Z', endTime: '2026-10-11T09:30:00.000Z' },
      },
    });
  });

  it('stores Google’s metric names verbatim, as numbers', async () => {
    const { gbp } = provider([TOKEN_OK, INSIGHTS]);
    const points = await gbp.postAnalytics(TOKENS, POST_NAME);

    expect(points).toEqual([
      { metric: 'LOCAL_POST_VIEWS_SEARCH', value: 128, capturedAt: NOW },
      { metric: 'LOCAL_POST_ACTIONS_CALL_TO_ACTION', value: 7, capturedAt: NOW },
    ]);
  });

  it('skips a metric with no value rather than inventing a zero', async () => {
    const { gbp } = provider([
      TOKEN_OK,
      {
        match: 'localPosts:reportInsights',
        body: {
          localPostMetrics: [
            {
              metricValues: [
                { metric: 'LOCAL_POST_VIEWS_SEARCH', totalValue: {} },
                { metric: 'LOCAL_POST_ACTIONS_CALL_TO_ACTION' },
              ],
            },
          ],
        },
      },
    ]);
    await expect(gbp.postAnalytics(TOKENS, POST_NAME)).resolves.toEqual([]);
  });

  it('resolves empty on a permanent 4xx so one post cannot be re-polled into the gate forever', async () => {
    const { gbp } = provider([
      TOKEN_OK,
      { match: 'localPosts:reportInsights', status: 403, body: ZERO_QPM_403 },
    ]);
    await expect(gbp.postAnalytics(TOKENS, POST_NAME)).resolves.toEqual([]);
  });

  it('still propagates auth and transient errors', async () => {
    const dead = provider([
      {
        match: 'oauth2.googleapis.com/token',
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    ]);
    await expect(dead.gbp.postAnalytics(TOKENS, POST_NAME)).rejects.toBeInstanceOf(
      ProviderAuthError,
    );

    const busy = provider([
      TOKEN_OK,
      { match: 'localPosts:reportInsights', status: 429, body: { error: { code: 429 } } },
    ]);
    await expect(busy.gbp.postAnalytics(TOKENS, POST_NAME)).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });
});

describe('accountAnalytics', () => {
  const PERFORMANCE: Recorded = {
    match: ':fetchMultiDailyMetricsTimeSeries',
    body: {
      multiDailyMetricTimeSeries: [
        {
          dailyMetricTimeSeries: [
            {
              dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
              timeSeries: {
                datedValues: [
                  { date: { year: 2026, month: 10, day: 9 }, value: '41' },
                  { date: { year: 2026, month: 10, day: 10 }, value: '37' },
                ],
              },
            },
            {
              dailyMetric: 'WEBSITE_CLICKS',
              timeSeries: {
                datedValues: [
                  { date: { year: 2026, month: 10, day: 9 }, value: '3' },
                  // Google omits `value` for a zero day (and for a day it has not computed yet).
                  { date: { year: 2026, month: 10, day: 10 } },
                ],
              },
            },
            // A metric with no data at all for the window.
            { dailyMetric: 'BUSINESS_BOOKINGS', timeSeries: {} },
          ],
        },
      ],
    },
  };

  it('reads the last two complete days from the Performance API for the bare location', async () => {
    const { gbp, calls } = provider([TOKEN_OK, PERFORMANCE]);
    await gbp.accountAnalytics(TOKENS);

    const url = new URL(calls[1]!.url);
    // Performance takes locations/{l} only — the account half of the composite id is dropped.
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://businessprofileperformance.googleapis.com/v1/locations/2002:fetchMultiDailyMetricsTimeSeries',
    );
    expect(url.searchParams.getAll('dailyMetrics')).toEqual([
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'WEBSITE_CLICKS',
      'CALL_CLICKS',
      'BUSINESS_DIRECTION_REQUESTS',
      'BUSINESS_CONVERSATIONS',
      'BUSINESS_BOOKINGS',
    ]);
    // NOW is 2026-10-11 → 9 Oct through 10 Oct.
    expect(url.searchParams.get('dailyRange.start_date.year')).toBe('2026');
    expect(url.searchParams.get('dailyRange.start_date.month')).toBe('10');
    expect(url.searchParams.get('dailyRange.start_date.day')).toBe('9');
    expect(url.searchParams.get('dailyRange.end_date.day')).toBe('10');
    expect(calls[1]!.headers.Authorization).toBe('Bearer MINTED-ACCESS-TOKEN');
  });

  it('stores GBP-native names verbatim, stamped with the day each value belongs to', async () => {
    const { gbp } = provider([TOKEN_OK, PERFORMANCE]);
    const points = await gbp.accountAnalytics(TOKENS);

    expect(points).toEqual([
      {
        metric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
        value: 41,
        capturedAt: new Date('2026-10-09T00:00:00.000Z'),
      },
      {
        metric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
        value: 37,
        capturedAt: new Date('2026-10-10T00:00:00.000Z'),
      },
      { metric: 'WEBSITE_CLICKS', value: 3, capturedAt: new Date('2026-10-09T00:00:00.000Z') },
    ]);
  });

  it('never emits a follower metric — GBP has none, and a 0 would be a lie', async () => {
    const { gbp } = provider([TOKEN_OK, PERFORMANCE]);
    const points = await gbp.accountAnalytics(TOKENS);

    expect(points.some((p) => /follow/i.test(p.metric))).toBe(false);
  });

  it('returns nothing for an empty response', async () => {
    const { gbp } = provider([TOKEN_OK, { match: ':fetchMultiDailyMetricsTimeSeries', body: {} }]);
    await expect(gbp.accountAnalytics(TOKENS)).resolves.toEqual([]);
  });

  it('propagates the access gate as a bad request and a dead token as an auth error', async () => {
    const gated = provider([
      TOKEN_OK,
      { match: ':fetchMultiDailyMetricsTimeSeries', status: 403, body: ZERO_QPM_403 },
    ]);
    await expect(gated.gbp.accountAnalytics(TOKENS)).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );

    const dead = provider([
      {
        match: 'oauth2.googleapis.com/token',
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    ]);
    await expect(dead.gbp.accountAnalytics(TOKENS)).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('mapGoogleError — the taxonomy the scheduler branches on', () => {
  const quotaExceeded = {
    error: {
      code: 403,
      message: "Quota exceeded for quota metric 'Requests' of service 'mybusiness.googleapis.com'.",
      status: 'RESOURCE_EXHAUSTED',
    },
  };
  const zeroLimit429 = {
    error: {
      code: 429,
      message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'.",
      status: 'RESOURCE_EXHAUSTED',
      details: [{ reason: 'RATE_LIMIT_EXCEEDED', metadata: { quota_limit_value: '0' } }],
    },
  };
  const realLimit429 = {
    error: {
      code: 429,
      message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'.",
      status: 'RESOURCE_EXHAUSTED',
      details: [{ reason: 'RATE_LIMIT_EXCEEDED', metadata: { quota_limit_value: '300' } }],
    },
  };

  it.each<[string, number, unknown, new (m: string) => Error]>([
    [
      '401 unauthenticated',
      401,
      { error: { code: 401, status: 'UNAUTHENTICATED' } },
      ProviderAuthError,
    ],
    ['401 with no body', 401, undefined, ProviderAuthError],
    ['invalid_grant on refresh', 400, { error: 'invalid_grant' }, ProviderAuthError],
    ['403 api not used in project (0 QPM)', 403, ZERO_QPM_403, ProviderBadRequestError],
    [
      '403 bare PERMISSION_DENIED',
      403,
      {
        error: {
          code: 403,
          message: 'The caller does not have permission',
          status: 'PERMISSION_DENIED',
        },
      },
      ProviderBadRequestError,
    ],
    ['403 quota', 403, quotaExceeded, ProviderBadRequestError],
    ['403 with no body', 403, undefined, ProviderBadRequestError],
    ['429 with a quota limit of 0', 429, zeroLimit429, ProviderBadRequestError],
    ['429 real throttle', 429, realLimit429, ProviderTransientError],
    ['429 with no body', 429, undefined, ProviderTransientError],
    [
      '400 invalid argument',
      400,
      { error: { code: 400, status: 'INVALID_ARGUMENT' } },
      ProviderBadRequestError,
    ],
    ['404 not found', 404, { error: { code: 404, status: 'NOT_FOUND' } }, ProviderBadRequestError],
    [
      '409 conflict',
      409,
      { error: { code: 409, status: 'ALREADY_EXISTS' } },
      ProviderBadRequestError,
    ],
    ['500 internal', 500, { error: { code: 500, status: 'INTERNAL' } }, ProviderTransientError],
    ['503 unavailable', 503, {}, ProviderTransientError],
    // Our own misconfiguration must not flag every connection needs_reconnect.
    ['invalid_client', 401, { error: 'invalid_client' }, ProviderBadRequestError],
    ['token endpoint 5xx', 503, { error: 'temporarily_unavailable' }, ProviderTransientError],
  ])('%s -> correct kind', (_label, status, body, expected) => {
    expect(mapGoogleError(status, body)).toBeInstanceOf(expected);
  });

  it.each([
    ['api not used in project', 403, ZERO_QPM_403],
    ['quota', 403, quotaExceeded],
    ['zero-limit 429', 429, zeroLimit429],
  ])('names the access request for: %s', (_label, status, body) => {
    const err = mapGoogleError(status, body);
    expect(err.message).toContain('GBP v4 access not granted for this project');
    expect(err.message).toContain('BUILD-SPEC-V2 §A1');
  });

  it('keeps Google’s own wording alongside the operator message', () => {
    const err = mapGoogleError(403, ZERO_QPM_403);
    expect(err.message).toContain('has not been used in project 123456789012');
    expect(err.message).toContain('PERMISSION_DENIED');
  });

  it('does not blame the access gate for an ordinary 400', () => {
    const err = mapGoogleError(400, {
      error: { code: 400, message: 'Invalid sourceUrl.', status: 'INVALID_ARGUMENT' },
    });
    expect(err.message).toContain('Invalid sourceUrl.');
    expect(err.message).not.toContain('access not granted');
  });
});

describe('network failures', () => {
  it('treats a socket-level failure as transient so BullMQ retries', async () => {
    const gbp = new GbpProvider(
      new GoogleOAuthClient({
        clientId: 'a',
        clientSecret: 'b',
        fetchImpl: async () => {
          throw new Error('ECONNRESET');
        },
      }),
    );
    await expect(gbp.post(TOKENS, [detail()])).rejects.toBeInstanceOf(ProviderTransientError);
  });
});

describe('registration — env-gated like the Meta providers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is absent with no Google credentials, so dev/CI/prod are unchanged until they are set', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.resetModules();
    const registry = await import('../registry.js');

    expect(registry.tryGetProvider('gmb')).toBeUndefined();
    expect(registry.listProviders().some((p) => p.identifier === 'gmb')).toBe(false);
  });

  it('needs both halves of the credential', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'only-the-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.resetModules();
    const registry = await import('../registry.js');

    expect(registry.tryGetProvider('gmb')).toBeUndefined();
  });

  it('registers once both are present and GBP_ENABLED is true', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'secret');
    vi.stubEnv('GBP_ENABLED', 'true');
    vi.resetModules();
    const registry = await import('../registry.js');

    expect(registry.tryGetProvider('gmb')?.displayName).toBe('Google Business Profile');
  });
});
