import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import type { SafeResponse } from '../../net/safe-fetch.js';
import {
  CredentialFormatError,
  decodeStored,
  encodeStored,
  fixedHostFetch,
  guardedFetch,
  parseJson,
  rateLimited,
  redact,
  retryAfterHeader,
  said,
  transportError,
  type ProviderFetch,
} from '../shared/http.js';

/**
 * AT Protocol client for the bluesky provider: identity resolution (handle → DID → PDS), app
 * password sessions, XRPC calls and the error taxonomy. Endpoints, limits and sources are in
 * docs/dev/research/quick-platforms.md §1. Nothing here has run against a real PDS.
 *
 * Three kinds of address are contacted, and they are not guarded alike:
 *  - the account's PDS, and a handle's own domain (`/.well-known/atproto-did`, a `did:web`
 *    document): hosts a PERSON named, directly or through a DID document. Every such request goes
 *    through `safeFetch`'s full SSRF guard — public addresses only, https, port 443, pinned.
 *  - `plc.directory` and `public.api.bsky.app`: fixed hosts, additionally held to an allowlist.
 */

export const BLUESKY_APPVIEW = 'https://public.api.bsky.app';
const PLC_DIRECTORY = 'https://plc.directory';

const IDENTITY_TIMEOUT_MS = 8_000;
const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 90_000;
const IDENTITY_MAX_BYTES = 256 * 1024;
const API_MAX_BYTES = 2 * 1024 * 1024;
/** A session is reused until this close to its expiry. */
const SESSION_MARGIN_MS = 60_000;
const SESSION_CACHE_MAX = 500;

/** What is stored (encrypted, as the connection's access token) to post as an account. */
export interface BlueskyCredentials {
  did: string;
  handle: string;
  /** The account's PDS origin, from its DID document at connect time. */
  pds: string;
  appPassword: string;
}

export function encodeBlueskyCredentials(credentials: BlueskyCredentials): string {
  return encodeStored({ ...credentials });
}

export function decodeBlueskyCredentials(stored: string): BlueskyCredentials {
  const parsed = decodeStored(stored);
  if (
    !parsed ||
    typeof parsed.did !== 'string' ||
    typeof parsed.handle !== 'string' ||
    typeof parsed.pds !== 'string' ||
    typeof parsed.appPassword !== 'string'
  ) {
    // Never include the blob: it is the secret.
    throw new ProviderAuthError('the stored Bluesky credentials are unreadable — reconnect');
  }
  return {
    did: parsed.did,
    handle: parsed.handle,
    pds: parsed.pds,
    appPassword: parsed.appPassword,
  };
}

const HANDLE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DID_PLC = /^did:plc:[a-z2-7]{24}$/;
const DID_WEB = /^did:web:((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61})$/;
/** `xxxx-xxxx-xxxx-xxxx`, the form the AT Protocol spec gives for an app password. */
const APP_PASSWORD = /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/i;

export type BlueskyIdentifier = { kind: 'handle'; handle: string } | { kind: 'did'; did: string };

/**
 * What a person typed for "handle" → a handle or a DID. Forgiving about a leading `@` and a pasted
 * profile link, strict about the rest: a handle is a DNS name and is about to be resolved as one.
 */
export function parseBlueskyIdentifier(raw: string): BlueskyIdentifier {
  let text = raw.trim().toLowerCase();
  const profile = /^https?:\/\/bsky\.app\/profile\/([^/?#]+)/.exec(text);
  if (profile) text = profile[1]!;
  text = text.replace(/^@/, '');
  if (text === '') throw new CredentialFormatError('Enter the Bluesky handle.');
  if (text.startsWith('did:')) {
    if (!DID_PLC.test(text) && !DID_WEB.test(text)) {
      throw new CredentialFormatError('That is not a valid Bluesky DID.');
    }
    return { kind: 'did', did: text };
  }
  if (text.length > 253 || !HANDLE.test(text)) {
    throw new CredentialFormatError(
      text.includes('.')
        ? 'That is not a valid Bluesky handle.'
        : `Enter the full handle, for example ${text.replace(/[^a-z0-9-]/g, '') || 'name'}.bsky.social.`,
    );
  }
  return { kind: 'handle', handle: text };
}

/**
 * Only an app password is accepted. The main password would work against the API just the same,
 * which is exactly why its shape is refused here: this app must never be handed one, and an app
 * password can be revoked on its own without touching the account.
 */
export function assertAppPassword(raw: string): string {
  const password = raw.trim();
  if (!APP_PASSWORD.test(password)) {
    throw new CredentialFormatError(
      'That is not an app password. An app password looks like xxxx-xxxx-xxxx-xxxx and is made ' +
        'in Bluesky under Settings → Privacy and security → App passwords. Do not enter the ' +
        'account’s main password here.',
    );
  }
  return password.toLowerCase();
}

interface XrpcErrorBody {
  error?: unknown;
  message?: unknown;
}

/** An XRPC failure, with the machine-readable `error` name kept for callers that branch on it. */
export interface BlueskyFailure {
  error: Error;
  name: string | null;
  status: number;
}

/**
 * Map an XRPC error answer onto the sealed taxonomy (errors.ts):
 *  - 401, 403, and the token/account error names → auth: the app password was revoked, or the
 *    account is deactivated, suspended or taken down. Reconnecting is the fix; retrying never is.
 *  - 429 → rate limited (transient), with the server's own wait when it gave one.
 *  - 5xx → transient.
 *  - any other 4xx → bad request, with Bluesky's own message.
 */
export function mapBlueskyError(
  response: SafeResponse,
  secrets: readonly string[],
): BlueskyFailure {
  const { status } = response;
  const parsed = parseJson(response);
  const body = parsed !== null && typeof parsed === 'object' ? (parsed as XrpcErrorBody) : null;
  const name = typeof body?.error === 'string' ? body.error.slice(0, 60) : null;
  const message = said(body?.message, secrets);
  const suffix = name ? ` [${redact(name, secrets)}]` : '';
  const says = message ? `Bluesky says: ${message}${suffix}` : `HTTP ${status}${suffix}`;
  const fail = (error: Error): BlueskyFailure => ({ error, name, status });

  if (status === 429) {
    // draft-polli rate limit headers: `ratelimit-reset` is the UNIX time the window reopens.
    const reset = Number(response.headers['ratelimit-reset']);
    const wait =
      retryAfterHeader(response) ??
      (Number.isFinite(reset) && reset > 0 ? Math.max(0, reset - Date.now() / 1000) : null);
    return fail(rateLimited('Bluesky', wait));
  }
  if (name === 'AuthFactorTokenRequired') {
    return fail(
      new ProviderAuthError(
        'Bluesky asked for an email sign-in code, which means that was the account’s main ' +
          'password. Create an app password in Bluesky (Settings → Privacy and security → App ' +
          'passwords) and connect with that.',
      ),
    );
  }
  if (
    status === 401 ||
    status === 403 ||
    name === 'ExpiredToken' ||
    name === 'InvalidToken' ||
    name === 'AuthenticationRequired' ||
    name === 'AccountTakedown' ||
    name === 'AccountDeactivated'
  ) {
    return fail(
      new ProviderAuthError(
        `Bluesky did not accept the saved app password. ${says}. Reconnect the account with a ` +
          'new app password.',
      ),
    );
  }
  if (status >= 500) return fail(new ProviderTransientError(says));
  return fail(new ProviderBadRequestError(says));
}

export interface BlueskySession {
  did: string;
  handle: string;
  accessJwt: string;
}

export interface XrpcRequest {
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  json?: unknown;
  /** Raw body (`com.atproto.repo.uploadBlob`). */
  upload?: { body: Buffer; contentType: string };
  accessJwt?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** See `TransportContext.posts`: set for the one call that creates the post. */
  posts?: string;
  secrets?: readonly string[];
}

export type TxtResolver = (name: string) => Promise<string[][]>;

export interface BlueskyClientConfig {
  /** The guarded fetch. Requests to the fixed hosts are additionally allowlisted on top of it. */
  fetchImpl?: ProviderFetch;
  resolveTxt?: TxtResolver;
  now?: () => number;
}

/** `exp` of a JWT in ms, or null. Read, never verified: it only decides how long to reuse it. */
export function jwtExpiryMs(jwt: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** The PDS origin a DID document names, or null. Per the DID spec: scheme and host, nothing more. */
export function pdsFromDidDocument(doc: unknown): string | null {
  const services = (doc as { service?: unknown } | null)?.service;
  if (!Array.isArray(services)) return null;
  for (const entry of services as Array<Record<string, unknown>>) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!id.endsWith('#atproto_pds') || entry.type !== 'AtprotoPersonalDataServer') continue;
    // The first matching entry is the one; a bad one is not skipped in favour of a later one.
    if (typeof entry.serviceEndpoint !== 'string') return null;
    let url: URL;
    try {
      url = new URL(entry.serviceEndpoint);
    } catch {
      return null;
    }
    const bare =
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '/' || url.pathname === '') &&
      url.search === '' &&
      url.hash === '';
    return bare ? url.origin : null;
  }
  return null;
}

function handlesFromDidDocument(doc: unknown): string[] {
  const aka = (doc as { alsoKnownAs?: unknown } | null)?.alsoKnownAs;
  if (!Array.isArray(aka)) return [];
  return aka
    .filter((a): a is string => typeof a === 'string' && a.startsWith('at://'))
    .map((a) => a.slice('at://'.length).toLowerCase())
    .filter((h) => HANDLE.test(h));
}

export class BlueskyClient {
  private readonly open: ProviderFetch;
  private readonly plc: ProviderFetch;
  private readonly appview: ProviderFetch;
  private readonly resolveTxt: TxtResolver;
  private readonly now: () => number;
  private readonly sessions = new Map<string, BlueskySession & { key: string; until: number }>();

  constructor(config: BlueskyClientConfig = {}) {
    this.open = config.fetchImpl ?? guardedFetch;
    this.plc = fixedHostFetch([new URL(PLC_DIRECTORY).hostname], this.open);
    this.appview = fixedHostFetch([new URL(BLUESKY_APPVIEW).hostname], this.open);
    this.resolveTxt = config.resolveTxt ?? dnsResolveTxt;
    this.now = config.now ?? Date.now;
  }

  /**
   * Handle → DID, by both methods the handle spec defines: the `_atproto` DNS TXT record
   * (preferred when the two disagree) and `https://<handle>/.well-known/atproto-did`. The HTTPS
   * request goes to a domain a person typed, so it is the fully guarded fetch.
   */
  async resolveHandle(handle: string): Promise<string | null> {
    try {
      const records = await this.resolveTxt(`_atproto.${handle}`);
      const dids = new Set(
        records
          .map((chunks) => chunks.join(''))
          .filter((value) => value.startsWith('did='))
          .map((value) => value.slice(4).trim()),
      );
      // "If multiple valid records with different DIDs are present, resolution should fail."
      if (dids.size > 1) return null;
      const [did] = dids;
      if (did && (DID_PLC.test(did) || DID_WEB.test(did))) return did;
    } catch {
      // No record (the common case for *.bsky.social) or no DNS: the HTTPS method decides.
    }
    let response: SafeResponse;
    try {
      response = await this.open(`https://${handle}/.well-known/atproto-did`, {
        timeoutMs: IDENTITY_TIMEOUT_MS,
        maxResponseBytes: 2048,
        headers: { accept: 'text/plain' },
      });
    } catch {
      return null;
    }
    if (response.status !== 200) return null;
    const did = response.body.toString('utf8').trim();
    return DID_PLC.test(did) || DID_WEB.test(did) ? did : null;
  }

  /** DID → its document: `plc.directory` for `did:plc`, the domain itself for `did:web`. */
  async didDocument(did: string): Promise<unknown> {
    const web = DID_WEB.exec(did);
    let response: SafeResponse;
    try {
      response = web
        ? await this.open(`https://${web[1]}/.well-known/did.json`, {
            timeoutMs: IDENTITY_TIMEOUT_MS,
            maxResponseBytes: IDENTITY_MAX_BYTES,
            headers: { accept: 'application/json' },
          })
        : await this.plc(`${PLC_DIRECTORY}/${did}`, {
            timeoutMs: IDENTITY_TIMEOUT_MS,
            maxResponseBytes: IDENTITY_MAX_BYTES,
            headers: { accept: 'application/json' },
          });
    } catch (err) {
      throw transportError(err, { platform: 'The Bluesky identity directory', secrets: [] });
    }
    if (response.status === 404 || response.status === 410) return null;
    if (response.status >= 500 || response.status === 429) {
      throw new ProviderTransientError(
        `The Bluesky identity directory is not answering (HTTP ${response.status}).`,
      );
    }
    const doc = parseJson(response);
    if (response.status !== 200 || doc === null || typeof doc !== 'object') return null;
    return (doc as { id?: unknown }).id === did ? doc : null;
  }

  /**
   * Who is this, and where is their account hosted? A handle must point at a DID whose document
   * names that same handle back — one direction alone lets anybody claim to be `example.com`.
   * Every failure is the person's to fix, so each is a bad request that says what to check.
   */
  async identify(input: BlueskyIdentifier): Promise<{ did: string; handle: string; pds: string }> {
    let did: string;
    if (input.kind === 'did') {
      did = input.did;
    } else {
      const resolved = await this.resolveHandle(input.handle);
      if (!resolved) {
        throw new ProviderBadRequestError(
          `No Bluesky account was found for the handle ${input.handle}. Check the spelling — ` +
            'the handle is shown under the name on the profile.',
        );
      }
      did = resolved;
    }
    const doc = await this.didDocument(did);
    if (!doc) {
      throw new ProviderBadRequestError('That Bluesky account’s identity record was not found.');
    }
    const handles = handlesFromDidDocument(doc);
    if (input.kind === 'handle' && !handles.includes(input.handle)) {
      throw new ProviderBadRequestError(
        `The handle ${input.handle} does not belong to the account it points to. If the handle ` +
          'was changed recently, enter the current one.',
      );
    }
    const pds = pdsFromDidDocument(doc);
    if (!pds) {
      throw new ProviderBadRequestError(
        'That Bluesky account does not name a usable server (PDS) to post through.',
      );
    }
    return { did, handle: input.kind === 'handle' ? input.handle : (handles[0] ?? did), pds };
  }

  /** One XRPC call. Throws from the provider error taxonomy; never returns a failure. */
  async xrpc<T>(origin: string, nsid: string, request: XrpcRequest = {}): Promise<T> {
    const result = await this.tryXrpc<T>(origin, nsid, request);
    if ('failure' in result) throw result.failure.error;
    return result.data;
  }

  /** `xrpc`, but an error answer is returned (with its name) instead of thrown. */
  async tryXrpc<T>(
    origin: string,
    nsid: string,
    request: XrpcRequest = {},
  ): Promise<{ data: T } | { failure: BlueskyFailure }> {
    const secrets = request.secrets ?? [];
    const url = new URL(`/xrpc/${nsid}`, origin);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      url.searchParams.append(name, value);
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (request.accessJwt) headers.authorization = `Bearer ${request.accessJwt}`;
    let body: Buffer | string | undefined;
    if (request.upload) {
      headers['content-type'] = request.upload.contentType;
      body = request.upload.body;
    } else if (request.json !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(request.json);
    }
    const fetchImpl = origin === BLUESKY_APPVIEW ? this.appview : this.open;

    let response: SafeResponse;
    try {
      // Redirects stay off: a request carrying a password or a token is never replayed elsewhere.
      response = await fetchImpl(url.toString(), {
        method: request.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
        timeoutMs: request.timeoutMs ?? (request.upload ? UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS),
        maxResponseBytes: request.maxResponseBytes ?? API_MAX_BYTES,
        maxRedirects: 0,
      });
    } catch (err) {
      throw transportError(err, { platform: 'Bluesky', secrets, posts: request.posts });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ProviderBadRequestError(
        'The account’s Bluesky server answered with a redirect, so it has moved. Reconnect the ' +
          'account.',
      );
    }
    if (response.status >= 400) return { failure: mapBlueskyError(response, secrets) };
    const parsed = parseJson(response);
    if (parsed === undefined) {
      throw new ProviderBadRequestError(
        request.posts
          ? 'Bluesky accepted the post but its answer could not be read — check ' +
              `${request.posts} before retrying, so it is not posted twice.`
          : 'Bluesky’s answer could not be read.',
      );
    }
    return { data: parsed as T };
  }

  /**
   * Log in with the app password (`com.atproto.server.createSession`) at the account's own PDS.
   * The answer must be for the DID that was asked about and for an active account; the refresh
   * token it carries is deliberately dropped — see `session`.
   */
  async createSession(credentials: Omit<BlueskyCredentials, 'handle'>): Promise<BlueskySession> {
    const secrets = [credentials.appPassword];
    const data = await this.xrpc<{
      accessJwt?: unknown;
      refreshJwt?: unknown;
      handle?: unknown;
      did?: unknown;
      active?: unknown;
      status?: unknown;
    }>(credentials.pds, 'com.atproto.server.createSession', {
      json: { identifier: credentials.did, password: credentials.appPassword },
      secrets,
    });
    if (typeof data.accessJwt !== 'string' || data.did !== credentials.did) {
      throw new ProviderAuthError(
        'Bluesky signed in a different account than the one named. Reconnect the account.',
      );
    }
    if (data.active === false) {
      const why = typeof data.status === 'string' ? said(data.status).slice(0, 40) : 'not active';
      throw new ProviderAuthError(
        `That Bluesky account is ${why}, so nothing can be posted to it.`,
      );
    }
    return {
      did: credentials.did,
      handle: typeof data.handle === 'string' ? data.handle.toLowerCase() : credentials.did,
      accessJwt: data.accessJwt,
    };
  }

  /**
   * A session for these credentials: a cached one while its access token has time left, else a
   * fresh login.
   *
   * Why the app password is what is stored, and not the refresh token: a refresh token is
   * single-use and rotates on every refresh, and `post()` has nowhere to write the new one back
   * (the publish service owns the row, and the token sweeper works on a 7-day horizon, not a
   * two-hour one). One lost response, or two workers refreshing at once, would strand the
   * connection. The app password is the stable, separately revocable credential the platform
   * designed for this; sessions made from it are kept in memory only and never written anywhere.
   * Logins are limited by Bluesky to 30 per 5 minutes and 300 per day per account, which the cache
   * keeps this app far below.
   */
  async session(credentials: BlueskyCredentials, fresh = false): Promise<BlueskySession> {
    const cached = this.sessions.get(credentials.did);
    if (
      !fresh &&
      cached &&
      cached.key === credentials.appPassword &&
      cached.until - SESSION_MARGIN_MS > this.now()
    ) {
      return cached;
    }
    this.sessions.delete(credentials.did);
    const session = await this.createSession(credentials);
    const until = jwtExpiryMs(session.accessJwt);
    if (until !== null && until - SESSION_MARGIN_MS > this.now()) {
      if (this.sessions.size >= SESSION_CACHE_MAX) this.sessions.clear();
      this.sessions.set(credentials.did, { ...session, key: credentials.appPassword, until });
    }
    return session;
  }

  /**
   * An authenticated call to the account's PDS. A cached session the server no longer accepts is
   * replaced by one fresh login and the call repeated once — but never the call that creates the
   * post after it was answered with anything other than "that token is no good".
   */
  async authed<T>(
    credentials: BlueskyCredentials,
    nsid: string,
    request: Omit<XrpcRequest, 'accessJwt' | 'secrets'> = {},
  ): Promise<{ data: T; session: BlueskySession }> {
    let session = await this.session(credentials);
    for (let attempt = 0; ; attempt++) {
      const secrets = [credentials.appPassword, session.accessJwt];
      const result = await this.tryXrpc<T>(credentials.pds, nsid, {
        ...request,
        accessJwt: session.accessJwt,
        secrets,
      });
      if (!('failure' in result)) return { data: result.data, session };
      const stale =
        result.failure.name === 'ExpiredToken' ||
        result.failure.name === 'InvalidToken' ||
        result.failure.status === 401;
      if (!stale || attempt > 0) throw result.failure.error;
      session = await this.session(credentials, true);
    }
  }

  /** Unauthenticated read from Bluesky's public AppView (`public.api.bsky.app`). */
  async publicRead<T>(nsid: string, query: Record<string, string>): Promise<T> {
    return this.xrpc<T>(BLUESKY_APPVIEW, nsid, { query });
  }

  /** `publicRead` for callers that treat "not found" as an answer. */
  async tryPublicRead<T>(
    nsid: string,
    query: Record<string, string>,
  ): Promise<{ data: T } | { failure: BlueskyFailure }> {
    return this.tryXrpc<T>(BLUESKY_APPVIEW, nsid, { query });
  }
}
