import { randomBytes } from 'node:crypto';
import type { MediaRef } from '@meegrow-social/contracts';
import {
  ProviderBadRequestError,
  ProviderRateLimitError,
  ProviderTransientError,
} from '../../errors.js';
import {
  safeFetch,
  SafeFetchError,
  SsrfBlockedError,
  type SafeFetchOptions,
  type SafeResponse,
} from '../../net/safe-fetch.js';

/**
 * What the providers that connect with a pasted credential (Bluesky, Telegram, Discord, Slack)
 * share: the guarded way out, the wording of a failure that may have posted, and the rule that a
 * secret never reaches a message. docs/dev/research/quick-platforms.md has the per-platform detail.
 *
 * `ProviderFetch` has `safeFetch`'s signature so tests replay fixtures through the same seam the
 * WordPress client uses, and can see the options (redirects, byte cap, deadline) each call asked for.
 */
export type ProviderFetch = (url: string, options: SafeFetchOptions) => Promise<SafeResponse>;

export const guardedFetch: ProviderFetch = (url, options) => safeFetch(url, options);

/**
 * Input that was refused before anything was sent anywhere — a token of the wrong shape, an
 * address that is not this platform's. A bad request like any other to the caller; kept apart so
 * the attempt limiter does not count a typo as a guess at a credential.
 */
export class CredentialFormatError extends ProviderBadRequestError {}

/**
 * A fetch that will only ever talk to the named hosts, and never follows a redirect. For a
 * platform whose API lives at one address this is the whole allowlist: `safeFetch` still resolves
 * and pins the name underneath, but nothing a person typed can steer the request elsewhere.
 */
export function fixedHostFetch(
  hosts: readonly string[],
  fetchImpl: ProviderFetch = guardedFetch,
): ProviderFetch {
  return async (url, options) => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new SsrfBlockedError('invalid_url', 'That is not a valid web address.');
    }
    if (!hosts.includes(host)) {
      // Never the URL: for Telegram and the webhook platforms the URL is the secret.
      throw new SsrfBlockedError('hostname', 'The request was not to an address of this platform.');
    }
    return fetchImpl(url, { ...options, maxRedirects: 0 });
  };
}

/**
 * `text` with every secret (and its URL-encoded form) blotted out. Applied to anything a platform
 * or the transport said before it becomes an error message: none of them is known to echo a
 * credential, and none of them is trusted not to.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join('[redacted]');
    }
  }
  return out;
}

/** Text a platform sent, trimmed to something that fits in a sentence. */
export function said(value: unknown, secrets: readonly string[] = []): string {
  if (typeof value !== 'string') return '';
  return redact(value.replace(/\s+/g, ' ').trim().slice(0, 300), secrets);
}

export function parseJson(response: SafeResponse): unknown {
  try {
    return JSON.parse(response.body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The sentence for a post that was sent and never answered: it may be there, so it is not retried. */
export function maybePosted(platform: string, where: string): string {
  return (
    `${platform} did not answer in time. The post may or may not have been published — check ` +
    `${where} before retrying, so it is not posted twice.`
  );
}

export interface TransportContext {
  platform: string;
  secrets: readonly string[];
  /**
   * Set (to where a person should look) for a call that posts and cannot be told "this is a
   * retry". A failure after the request left is then final rather than retried into a duplicate —
   * the rule the WordPress provider applies to creating an article.
   */
  posts?: string;
}

/** A failure of the request itself (never an answer from the platform) → the provider taxonomy. */
export function transportError(err: unknown, context: TransportContext): Error {
  const { platform, secrets } = context;
  if (err instanceof SsrfBlockedError) {
    // A name that stops resolving is a blip; an address that is refused will be refused again.
    return err.reason === 'dns'
      ? new ProviderTransientError(`${platform}'s address could not be looked up.`)
      : new ProviderBadRequestError(
          `${platform} could not be contacted: ${redact(err.message, secrets)}`,
        );
  }
  if (err instanceof SafeFetchError) {
    if (context.posts && err.requestSent) {
      return new ProviderBadRequestError(maybePosted(platform, context.posts));
    }
    if (err.kind === 'timeout' || err.kind === 'network') {
      return new ProviderTransientError(
        `${platform} could not be reached: ${redact(err.message, secrets)}`,
      );
    }
    return new ProviderBadRequestError(
      `${platform}'s answer could not be used: ${redact(err.message, secrets)}`,
    );
  }
  return new ProviderTransientError(
    `${platform} request failed: ${redact(err instanceof Error ? err.message : String(err), secrets)}`,
  );
}

/**
 * "Slow down" from a platform. Preserve its wait as a typed delay for the publish worker.
 */
export function rateLimited(platform: string, retryAfterSeconds: number | null): Error {
  const wait =
    retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? ` It asked for a ${Math.ceil(retryAfterSeconds)} second wait.`
      : '';
  return new ProviderRateLimitError(
    `${platform} is rate limiting this connection.${wait}`,
    retryAfterSeconds === null ? undefined : retryAfterSeconds * 1000,
  );
}

/** A `Retry-After` delta or HTTP date, expressed in seconds, or null. */
export function retryAfterHeader(response: SafeResponse): number | null {
  const raw = response.headers['retry-after'];
  if (raw === undefined || raw.trim() === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : null;
}

export interface DownloadedMedia {
  body: Buffer;
  /** Lower-cased, parameters dropped. Empty when the server sent none. */
  contentType: string;
}

/**
 * Fetch a stored media item this app is about to upload. The URL comes from a media row, which
 * `register_media_from_url` lets a caller point anywhere — so it goes through the full SSRF guard,
 * whichever platform the bytes are for.
 */
export async function downloadMedia(
  media: MediaRef,
  limits: { maxBytes: number; platform: string; timeoutMs?: number },
  fetchImpl: ProviderFetch = guardedFetch,
): Promise<DownloadedMedia> {
  const what = media.kind === 'video' ? 'video' : 'image';
  if (!media.url) throw new ProviderBadRequestError(`media ${media.mediaId} has no stored url`);
  const megabytes = (limits.maxBytes / 1_000_000).toFixed(limits.maxBytes < 10_000_000 ? 1 : 0);
  let response: SafeResponse;
  try {
    response = await fetchImpl(media.url, {
      maxRedirects: 3,
      maxResponseBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs ?? 60_000,
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError && err.reason !== 'dns') {
      throw new ProviderBadRequestError(
        `The ${what} is not at a public https address, so it cannot be sent to ${limits.platform}.`,
      );
    }
    if (err instanceof SafeFetchError && err.kind === 'too_large') {
      throw new ProviderBadRequestError(
        `The ${what} is larger than ${megabytes} MB, the most ${limits.platform} takes.`,
      );
    }
    throw new ProviderTransientError(
      `The ${what} could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (response.status >= 500) {
    throw new ProviderTransientError(`The ${what} could not be fetched (HTTP ${response.status}).`);
  }
  if (response.status !== 200) {
    throw new ProviderBadRequestError(
      `The ${what} could not be fetched (HTTP ${response.status}).`,
    );
  }
  const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  return { body: response.body, contentType };
}

/** File extension for the media types these platforms take; null for anything else. */
export function mediaExtension(contentType: string): string | null {
  return (
    (
      {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'video/quicktime': 'mov',
        'video/webm': 'webm',
      } as Record<string, string>
    )[contentType] ?? null
  );
}

export interface MultipartPart {
  name: string;
  body: Buffer | string;
  /** Present for a file part. Reduced to a safe token: it is placed in a header. */
  filename?: string;
  contentType?: string;
}

/** A `multipart/form-data` body (RFC 7578), built by hand: there is no FormData under `safeFetch`. */
export function multipartBody(parts: readonly MultipartPart[]): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `mgs-${randomBytes(16).toString('hex')}`;
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._[\]-]/g, '_');
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${safe(part.name)}"`;
    if (part.filename !== undefined) head += `; filename="${safe(part.filename)}"`;
    if (part.contentType) head += `\r\nContent-Type: ${part.contentType.replace(/[\r\n]/g, '')}`;
    chunks.push(Buffer.from(`${head}\r\n\r\n`, 'utf8'));
    chunks.push(typeof part.body === 'string' ? Buffer.from(part.body, 'utf8') : part.body);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A trimmed form field, or '' — `fields` is whatever a client sent. */
export function field(fields: Readonly<Record<string, string>>, name: string): string {
  const value = fields[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** One credential blob per connection, versioned, stored encrypted as its access token. */
export function encodeStored(value: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, ...value });
}

export function decodeStored(stored: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stored) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
