import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';

/**
 * Shared Meta Graph client for the facebook + instagram providers (issues #14/#13 — "one Meta
 * client, two providers"). Holds nothing platform-specific: auth-code exchange, token extension,
 * the GET/POST verbs, and the error taxonomy. Both providers construct one of these.
 *
 * `fetchImpl` is injectable so contract tests replay recorded fixtures and CI never touches Meta.
 */

/** Pinned Graph version. Meta ships a version ~quarterly and each lives ~2 years (RESEARCH meta.md). */
export const GRAPH_VERSION = 'v21.0';
const GRAPH_HOST = 'https://graph.facebook.com';
const WWW_HOST = 'https://www.facebook.com';

export type FetchLike = (
  url: string,
  init?: { method?: string; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface MetaClientConfig {
  appId: string;
  appSecret: string;
  /** Facebook Login for Business configuration id — replaces an ad-hoc `scope` list in the dialog. */
  loginConfigId?: string;
  graphVersion?: string;
  fetchImpl?: FetchLike;
}

interface MetaErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    type?: string;
  };
}

/**
 * Token/permission failures → reconnect, never retry.
 * 190 = invalid/expired access token; the subcodes are the specific reasons the docs call out
 * (458 app unauthorized, 459/464 user checkpointed, 463 expired, 467 invalid, 492 no page role).
 */
const AUTH_CODES = new Set([102, 190, 200, 10, 2500]);
const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492]);
/** Throttling + transient upstream. 4 = app rate limit, 17 = user rate limit, 32/613 = page/API limit. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613]);
/** 1 = unknown, 2 = service temporarily unavailable — Meta's own "try again" codes. */
const TRANSIENT_CODES = new Set([1, 2]);

/**
 * Map a Graph error onto the sealed taxonomy (errors.ts): auth → needs_reconnect + no retry,
 * transient → BullMQ retries with backoff, bad_request → fail the post permanently.
 * Unknown 4xx is treated as bad_request (retrying a malformed call never helps); unknown 5xx as
 * transient.
 */
export function mapMetaError(status: number, body: unknown): Error {
  const err = (body as MetaErrorBody | undefined)?.error;
  const code = err?.code;
  const subcode = err?.error_subcode;
  const message = err?.message ?? `Meta Graph request failed (HTTP ${status})`;
  const detail = `${message}${code !== undefined ? ` [code ${code}${subcode ? `/${subcode}` : ''}]` : ''}`;

  if (subcode !== undefined && AUTH_SUBCODES.has(subcode)) return new ProviderAuthError(detail);
  if (code !== undefined && AUTH_CODES.has(code)) return new ProviderAuthError(detail);
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) return new ProviderTransientError(detail);
  if (code !== undefined && TRANSIENT_CODES.has(code)) return new ProviderTransientError(detail);
  if (status >= 500) return new ProviderTransientError(detail);
  if (status === 429) return new ProviderTransientError(detail);
  return new ProviderBadRequestError(detail);
}

export class MetaClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly loginConfigId?: string;
  private readonly version: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: MetaClientConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.loginConfigId = config.loginConfigId;
    this.version = config.graphVersion ?? GRAPH_VERSION;
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** The OAuth dialog URL. With a Login-for-Business config we pass `config_id`, never `scope`. */
  authDialogUrl(params: { redirectUri: string; state: string }): string {
    const qs = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: params.redirectUri,
      state: params.state,
      response_type: 'code',
    });
    if (this.loginConfigId) qs.set('config_id', this.loginConfigId);
    return `${WWW_HOST}/${this.version}/dialog/oauth?${qs.toString()}`;
  }

  async graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    return this.request<T>(`${GRAPH_HOST}/${this.version}/${path}?${qs}`, 'GET');
  }

  async graphPost<T>(path: string, params: Record<string, string>): Promise<T> {
    const body = new URLSearchParams(params).toString();
    return this.request<T>(`${GRAPH_HOST}/${this.version}/${path}`, 'POST', body);
  }

  /** POST to an absolute URL — the reels upload phase targets rupload.facebook.com, not the Graph host. */
  async postAbsolute<T>(url: string, params: Record<string, string>): Promise<T> {
    return this.request<T>(url, 'POST', new URLSearchParams(params).toString());
  }

  private async request<T>(url: string, method: string, body?: string): Promise<T> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, { method, ...(body !== undefined ? { body } : {}) });
    } catch (cause) {
      // Network-level failure (DNS, socket, timeout) is always worth a retry.
      throw new ProviderTransientError(
        `Meta Graph request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const parsed: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw mapMetaError(res.status, parsed);
    return parsed as T;
  }

  /**
   * Auth-code → short-lived user token → long-lived (~60d) user token. Both legs are server-side
   * (they use the app secret). The long-lived user token is what makes the Page tokens derived from
   * it effectively non-expiring (RESEARCH meta.md §2.1) — never skip the exchange.
   */
  async exchangeCodeForLongLivedUserToken(params: {
    code: string;
    redirectUri: string;
  }): Promise<{ accessToken: string; expiresIn?: number }> {
    const short = await this.graphGet<{ access_token: string }>('oauth/access_token', {
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: params.redirectUri,
      code: params.code,
    });
    const long = await this.graphGet<{ access_token: string; expires_in?: number }>(
      'oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: short.access_token,
      },
    );
    return { accessToken: long.access_token, expiresIn: long.expires_in };
  }

  /** `debug_token` — drives the health cron and lets us assert a Page token really is non-expiring. */
  async debugToken(token: string): Promise<{
    isValid: boolean;
    expiresAt: Date | null;
    scopes: string[];
  }> {
    const res = await this.graphGet<{
      data?: { is_valid?: boolean; expires_at?: number; scopes?: string[] };
    }>('debug_token', {
      input_token: token,
      access_token: `${this.appId}|${this.appSecret}`,
    });
    const data = res.data ?? {};
    // expires_at === 0 means "never expires" — that's what Page tokens report.
    const expiresAt = data.expires_at ? new Date(data.expires_at * 1000) : null;
    return { isValid: data.is_valid ?? false, expiresAt, scopes: data.scopes ?? [] };
  }
}
