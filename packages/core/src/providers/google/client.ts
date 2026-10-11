import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';

/**
 * Shared Google OAuth + REST client (BUILD-SPEC-V2 §4 B1). Built for the GBP provider (#21) and
 * meant to be reused by YouTube — one OAuth client serves both. Holds nothing GBP-specific: the
 * consent URL, auth-code exchange, refresh, an access-token cache, the authed JSON verb and the
 * error taxonomy.
 *
 * `fetchImpl` is injectable so contract tests replay fixtures and CI never touches Google.
 *
 * NOT LIVE-VERIFIED. Google had not granted GBP API access when this was written (BUILD-SPEC-V2
 * §A1), so every request/response shape here comes from Google's published reference as summarised
 * in docs/dev/research/gbp-linkedin.md — never from a recorded call. §A7 of that note lists what a
 * live run must confirm.
 */

const AUTH_HOST = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Refresh this long before Google's stated expiry so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * The operator-facing message for the 0-QPM gate. The wording is load-bearing: it lands verbatim in
 * `posts.error`, and it has to say "this is an approvals problem", not "try again".
 */
export const GBP_ACCESS_NOT_GRANTED =
  'GBP v4 access not granted for this project — see BUILD-SPEC-V2 §A1';

/** Unlike Meta's Graph (token in the query string), Google wants a Bearer header and JSON bodies. */
export type GoogleFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  fetchImpl?: GoogleFetchLike;
  /** Injectable clock (ms) so the access-token cache is testable. */
  now?: () => number;
}

export interface GoogleTokens {
  accessToken: string;
  /** Present on the first consent only — Google does not re-issue it on refresh. */
  refreshToken?: string;
  /** Seconds, straight from Google (~3600). */
  expiresIn?: number;
}

interface GoogleErrorBody {
  // REST APIs nest the error; the OAuth token endpoint returns it as a bare string.
  error?:
    | string
    | {
        code?: number;
        message?: string;
        status?: string;
        details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
      };
  error_description?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/** The 0-QPM gate and its neighbours — every one of them is "retrying will not help". */
const ACCESS_GATE = /has not been used in project|PERMISSION_DENIED|quota/i;

/**
 * Map a Google error onto the sealed taxonomy (errors.ts): auth → needs_reconnect + no retry,
 * transient → BullMQ retries with backoff, bad_request → fail permanently.
 *
 * The 403 branch is the one that matters. Until Google approves the access request the legacy v4
 * host sits at 0 QPM and answers 403; treating that as transient retries forever against a wall.
 */
export function mapGoogleError(status: number, body: unknown): Error {
  const parsed = body as GoogleErrorBody | undefined;
  const err = parsed?.error;

  // OAuth token endpoint: { error: 'invalid_grant', error_description }.
  if (typeof err === 'string') {
    const detail = `${parsed?.error_description ?? 'Google OAuth request failed'} [${err}]`;
    // The refresh token is dead — revoked, unused for 6 months, or the 7-day Testing-mode expiry.
    if (err === 'invalid_grant') return new ProviderAuthError(detail);
    // invalid_client & co. are OUR misconfiguration. Calling that an auth error would flag every
    // connection needs_reconnect over a bad deploy secret, so it stays a bad request.
    if (status >= 500) return new ProviderTransientError(detail);
    return new ProviderBadRequestError(detail);
  }

  const message = err?.message ?? `Google API request failed (HTTP ${status})`;
  const detail = `${message}${err?.status ? ` [${err.status}]` : ''}`;

  if (status === 401) return new ProviderAuthError(detail);
  if (status === 403 && ACCESS_GATE.test(`${err?.status ?? ''} ${message}`)) {
    return new ProviderBadRequestError(`${GBP_ACCESS_NOT_GRANTED} (Google said: ${detail})`);
  }
  // Belt and braces for the same gate: a quota whose limit is literally 0 can surface as 429
  // RESOURCE_EXHAUSTED rather than 403, and no amount of backoff clears a limit of zero.
  if (status === 429 && hasZeroQuotaLimit(err?.details)) {
    return new ProviderBadRequestError(`${GBP_ACCESS_NOT_GRANTED} (Google said: ${detail})`);
  }
  if (status === 429 || status >= 500) return new ProviderTransientError(detail);
  return new ProviderBadRequestError(detail);
}

function hasZeroQuotaLimit(
  details: Array<{ metadata?: Record<string, string> }> | undefined,
): boolean {
  return (details ?? []).some((d) => d.metadata?.quota_limit_value === '0');
}

export class GoogleOAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: GoogleFetchLike;
  private readonly now: () => number;
  /** Minted access tokens keyed by the refresh token that minted them. In-memory, per process. */
  private readonly minted = new Map<string, { accessToken: string; expiresAtMs: number }>();

  constructor(config: GoogleClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as GoogleFetchLike);
    this.now = config.now ?? Date.now;
  }

  /**
   * The consent URL. `access_type=offline` + `prompt=consent` is what makes Google hand back a
   * refresh token — and hand it back again on a re-consent, where it otherwise stays silent.
   */
  authUrl(params: { redirectUri: string; state: string; scopes: string[] }): string {
    const qs = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: params.redirectUri,
      response_type: 'code',
      scope: params.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: params.state,
    });
    return `${AUTH_HOST}?${qs.toString()}`;
  }

  async exchangeCode(params: { code: string; redirectUri: string }): Promise<GoogleTokens> {
    const tokens = await this.token({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
    });
    if (tokens.refreshToken) this.remember(tokens.refreshToken, tokens);
    return tokens;
  }

  async refresh(refreshToken: string): Promise<GoogleTokens> {
    const tokens = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    this.remember(refreshToken, tokens);
    return tokens;
  }

  /**
   * A live access token for this refresh token, minting one only when the cached one is spent.
   * Google access tokens last about an hour, so a stored one is stale by the time a scheduled post
   * fires; callers that hold a refresh token should always come through here.
   */
  async accessTokenFor(refreshToken: string): Promise<string> {
    const hit = this.minted.get(refreshToken);
    if (hit && hit.expiresAtMs - EXPIRY_SKEW_MS > this.now()) return hit.accessToken;
    return (await this.refresh(refreshToken)).accessToken;
  }

  /** Authenticated JSON call to an absolute Google API URL. */
  async authed<T>(
    url: string,
    init: { method?: 'GET' | 'POST'; body?: unknown },
    accessToken: string,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return this.request<T>(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  private async token(params: Record<string, string>): Promise<GoogleTokens> {
    const res = await this.request<TokenResponse>(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...params,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    });
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresIn: res.expires_in,
    };
  }

  private remember(refreshToken: string, tokens: GoogleTokens): void {
    // No expires_in means nothing safe to cache against — mint again next time.
    if (tokens.expiresIn === undefined) return;
    this.minted.set(refreshToken, {
      accessToken: tokens.accessToken,
      expiresAtMs: this.now() + tokens.expiresIn * 1000,
    });
  }

  private async request<T>(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<T> {
    let res: Awaited<ReturnType<GoogleFetchLike>>;
    try {
      res = await this.fetchImpl(url, init);
    } catch (cause) {
      // Network-level failure (DNS, socket, timeout) is always worth a retry.
      throw new ProviderTransientError(
        `Google API request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const parsed: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw mapGoogleError(res.status, parsed);
    return parsed as T;
  }
}
