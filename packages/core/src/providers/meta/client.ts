import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderRateLimitError,
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
  /** Only the rate-limit usage headers are read, and only by the calls that page a listing. */
  headers?: { get(name: string): string | null };
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
/**
 * Throttling + transient upstream. 4 = app rate limit, 17 = user rate limit, 32/613 = page/API limit.
 * 80001 / 80002 are the Business Use Case limits — Pages calls made with a Page token, and the
 * Instagram Platform (RESEARCH meta.md §7.3) — which is what every call of ours runs under.
 */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002]);
/** 1 = unknown, 2 = service temporarily unavailable — Meta's own "try again" codes. */
const TRANSIENT_CODES = new Set([1, 2]);

/**
 * Map a Graph error onto the sealed taxonomy (errors.ts): auth → needs_reconnect + no retry,
 * transient → BullMQ retries with backoff, bad_request → fail the post permanently.
 * Unknown 4xx is treated as bad_request (retrying a malformed call never helps); unknown 5xx as
 * transient.
 */
/** A publish race, identified by numeric codes rather than Meta's changing wording. */
export class MetaContainerNotReadyError extends ProviderTransientError {}

export function mapMetaError(
  status: number,
  body: unknown,
  headers?: { get(name: string): string | null },
): Error {
  const raw = headers?.get('retry-after');
  const seconds = raw?.trim() ? Number(raw) : NaN;
  const headerMs =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : raw
        ? Date.parse(raw) - Date.now()
        : NaN;
  const regain = readMetaUsage(headers)?.regainAccessMinutes;
  const hints = [headerMs, regain == null ? NaN : regain * 60_000].filter(Number.isFinite);
  const retryAfterMs = hints.length > 0 ? Math.max(0, ...hints) : undefined;
  const err = (body as MetaErrorBody | undefined)?.error;
  const code = err?.code;
  const subcode = err?.error_subcode;
  const message = err?.message ?? `Meta Graph request failed (HTTP ${status})`;
  const detail = `${message}${code !== undefined ? ` [code ${code}${subcode ? `/${subcode}` : ''}]` : ''}`;

  if (code === 9007 && subcode === 2207027) return new MetaContainerNotReadyError(detail);
  if (subcode !== undefined && AUTH_SUBCODES.has(subcode)) return new ProviderAuthError(detail);
  if (code !== undefined && AUTH_CODES.has(code)) return new ProviderAuthError(detail);
  if (code !== undefined && RATE_LIMIT_CODES.has(code))
    return new ProviderRateLimitError(detail, retryAfterMs);
  if (code !== undefined && TRANSIENT_CODES.has(code)) return new ProviderTransientError(detail);
  if (status >= 500) return new ProviderTransientError(detail);
  if (status === 429) return new ProviderRateLimitError(detail, retryAfterMs);
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

  /**
   * A GET that also reports the rate-limit usage Meta put on the response. For the calls that page
   * through a listing, where the caller has to stop before the limit rather than at it.
   */
  async graphGetWithUsage<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<{ data: T; usage: MetaUsage | null }> {
    const qs = new URLSearchParams(params).toString();
    const { res, parsed } = await this.send(`${GRAPH_HOST}/${this.version}/${path}?${qs}`, 'GET');
    if (!res.ok) throw mapMetaError(res.status, parsed, res.headers);
    return { data: parsed as T, usage: readMetaUsage(res.headers) };
  }

  /**
   * Does the Graph still have this object? `missing` only for Meta's "does not exist" answer
   * (code 100, subcode 33, or a 404); every other failure is `unknown`. Meta gives that same answer
   * for an object the token may not read, so a caller must first know the token works.
   */
  async nodePresence(id: string, accessToken: string): Promise<'present' | 'missing' | 'unknown'> {
    const qs = new URLSearchParams({ fields: 'id', access_token: accessToken }).toString();
    let sent: Awaited<ReturnType<MetaClient['send']>>;
    try {
      sent = await this.send(`${GRAPH_HOST}/${this.version}/${id}?${qs}`, 'GET');
    } catch {
      return 'unknown';
    }
    if (sent.res.ok)
      return (sent.parsed as { id?: string } | undefined)?.id ? 'present' : 'unknown';
    const err = (sent.parsed as MetaErrorBody | undefined)?.error;
    if (sent.res.status === 404) return 'missing';
    return err?.code === 100 && err.error_subcode === NO_SUCH_OBJECT_SUBCODE
      ? 'missing'
      : 'unknown';
  }

  private async request<T>(url: string, method: string, body?: string): Promise<T> {
    const { res, parsed } = await this.send(url, method, body);
    if (!res.ok) throw mapMetaError(res.status, parsed, res.headers);
    return parsed as T;
  }

  private async send(
    url: string,
    method: string,
    body?: string,
  ): Promise<{ res: Awaited<ReturnType<FetchLike>>; parsed: unknown }> {
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
    return { res, parsed };
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

  /**
   * `debug_token` — drives the health cron and lets us assert a Page token really is non-expiring.
   * `granularScopes` is the per-permission asset grant of a Login-for-Business token: the ids the
   * person ticked for each permission. Meta leaves `target_ids` out when the permission was granted
   * for every asset ("all current and future"), so an empty list means "not narrowed", not "none".
   */
  async debugToken(token: string): Promise<{
    isValid: boolean;
    expiresAt: Date | null;
    scopes: string[];
    granularScopes: GranularScope[];
  }> {
    const res = await this.graphGet<{
      data?: {
        is_valid?: boolean;
        expires_at?: number;
        scopes?: string[];
        granular_scopes?: Array<{ scope?: string; target_ids?: unknown[] }>;
      };
    }>('debug_token', {
      input_token: token,
      access_token: `${this.appId}|${this.appSecret}`,
    });
    const data = res.data ?? {};
    // expires_at === 0 means "never expires" — that's what Page tokens report.
    const expiresAt = data.expires_at ? new Date(data.expires_at * 1000) : null;
    const granularScopes = (data.granular_scopes ?? []).flatMap((g) =>
      g.scope ? [{ scope: g.scope, targetIds: (g.target_ids ?? []).flatMap(targetId) }] : [],
    );
    return {
      isValid: data.is_valid ?? false,
      expiresAt,
      scopes: data.scopes ?? [],
      granularScopes,
    };
  }

  /**
   * FALLBACK page discovery for when `me/accounts` comes back empty — UNVERIFIED AGAINST META
   * (RESEARCH meta.md §2.5). A Page owned through a Meta Business portfolio is not listed by
   * `me/accounts` unless the token carries `business_management`; this reads the Page ids the person
   * ticked from the token's granular scopes and asks for each Page node by id instead.
   *
   * Never throws: this only ever runs where the answer would otherwise be "no pages", so a refused
   * call (or a Page the person holds no role on) degrades to that same answer.
   */
  async pagesFromGrantedScopes<T extends { id: string }>(
    userAccessToken: string,
    fields: string,
  ): Promise<T[]> {
    let pageIds: string[];
    try {
      const { granularScopes } = await this.debugToken(userAccessToken);
      pageIds = [
        ...new Set(
          granularScopes.filter((g) => PAGE_SCOPES.has(g.scope)).flatMap((g) => g.targetIds),
        ),
      ];
    } catch {
      return [];
    }
    const pages: T[] = [];
    for (const pageId of pageIds) {
      try {
        const page = await this.graphGet<T>(pageId, { fields, access_token: userAccessToken });
        if (page?.id) pages.push(page);
      } catch {
        // Not readable with this token — leave it out rather than fail the whole connect.
      }
    }
    return pages;
  }
}

export interface GranularScope {
  scope: string;
  targetIds: string[];
}

/** The permissions whose granular targets are Page ids (the instagram_* ones target IG account ids). */
const PAGE_SCOPES = new Set(['pages_show_list', 'pages_read_engagement', 'pages_manage_posts']);

/**
 * A granular-scope target as a decimal id string. Meta documents `target_ids` as integers; an id
 * past 2^53 parsed as a JSON number has already lost digits, so it is dropped rather than queried.
 */
function targetId(raw: unknown): string[] {
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return [raw];
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return [String(raw)];
  return [];
}

/** "Unsupported get request. Object with ID '…' does not exist, cannot be loaded due to missing permissions, …" */
const NO_SUCH_OBJECT_SUBCODE = 33;

/** Rate-limit usage as Meta reports it: the worst figure across everything on the response. */
export interface MetaUsage {
  /** Highest of `call_count`, `total_cputime`, `total_time` — each a percentage of the allowance. */
  percent: number;
  /** `estimated_time_to_regain_access`, minutes; null when Meta is not throttling. */
  regainAccessMinutes: number | null;
}

const USAGE_FIELDS = ['call_count', 'total_cputime', 'total_time'] as const;

/**
 * Read `X-Business-Use-Case-Usage` (calls made with a Page token, and the Instagram Platform) and
 * `X-App-Usage` (the app-wide limit) off a response — RESEARCH meta.md §7.3. Meta sends them only
 * once an endpoint has had enough calls, so null means "not reported", not "no usage". Malformed
 * headers are ignored: a parsing problem must never fail the call that carried them.
 */
export function readMetaUsage(
  headers: { get(name: string): string | null } | undefined,
): MetaUsage | null {
  if (!headers) return null;
  const entries: Array<Record<string, unknown>> = [];
  const parse = (name: string): unknown => {
    const raw = headers.get(name);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };
  const app = parse('x-app-usage');
  if (app && typeof app === 'object') entries.push(app as Record<string, unknown>);
  // Keyed by business object id, each holding one entry per rate-limit type.
  const buc = parse('x-business-use-case-usage');
  if (buc && typeof buc === 'object') {
    for (const list of Object.values(buc as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (entry && typeof entry === 'object') entries.push(entry as Record<string, unknown>);
      }
    }
  }
  let percent: number | null = null;
  let regain: number | null = null;
  for (const entry of entries) {
    for (const field of USAGE_FIELDS) {
      const value = entry[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        percent = Math.max(percent ?? 0, value);
      }
    }
    const wait = entry.estimated_time_to_regain_access;
    if (typeof wait === 'number' && wait > 0) regain = Math.max(regain ?? 0, wait);
  }
  if (percent === null && regain === null) return null;
  return { percent: percent ?? 0, regainAccessMinutes: regain };
}

/**
 * The query of a Graph `paging.next` link as a cursor: everything Meta says is needed for the next
 * page (cursor or time bounds, whichever the edge pages by) minus the access token, which must not
 * travel in a value that gets logged or stored. Null when there is no next page.
 */
export function nextPageCursor(next: unknown): string | null {
  if (typeof next !== 'string' || !next) return null;
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return null;
  }
  url.searchParams.delete('access_token');
  const cursor = url.searchParams.toString();
  return cursor || null;
}

/** The inverse of `nextPageCursor`: the params to send, the token added back by the caller. */
export function cursorParams(cursor: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(cursor));
}
