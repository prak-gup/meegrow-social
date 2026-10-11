import { DISCORD_MAX_CONTENT, discordContent, type MediaRef } from '@meegrow-social/contracts';
import type {
  AuthTokens,
  GenerateAuthUrl,
  MetricPoint,
  PostDetails,
  PostResult,
  SocialProvider,
} from '../types.js';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import type { SafeFetchOptions, SafeResponse } from '../../net/safe-fetch.js';
import {
  CredentialFormatError,
  decodeStored,
  downloadMedia,
  encodeStored,
  field,
  fixedHostFetch,
  guardedFetch,
  mediaExtension,
  multipartBody,
  parseJson,
  rateLimited,
  retryAfterHeader,
  said,
  transportError,
  type MultipartPart,
  type ProviderFetch,
} from '../shared/http.js';

/**
 * Discord provider — posts a message into one channel through that channel's *incoming webhook*.
 * No bot, no OAuth, no gateway: a webhook can post and nothing else, so nothing is ever read from
 * the server. Research, sources and the live bring-up checklist:
 * docs/dev/research/quick-platforms.md §3. NOTHING here has run against Discord; the tests replay
 * fixtures built from Discord's API documentation.
 *
 * Connect — a person with "Manage Webhooks" creates a webhook on the channel and pastes its
 * address. That address IS the credential (id + token, no other authentication), so it is treated
 * exactly like a password: shape-checked strictly, verified with one `GET`, stored encrypted,
 * never shown again and never put in an error.
 *
 * Token model — `one-time`, no expiry: a webhook lives until someone deletes it or resets its
 * address, which surfaces as a 404/401 → `ProviderAuthError` → needs_reconnect.
 */

const API_HOSTS = ['discord.com', 'discordapp.com'] as const;
const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const API_MAX_BYTES = 2 * 1024 * 1024;
/** A message takes up to 10 attachments. */
export const DISCORD_MAX_FILES = 10;
/** "The default limit is 20 MiB" per uploaded file. */
export const DISCORD_FILE_MAX_BYTES = 20 * 1024 * 1024;
/**
 * OUR ceiling for one post's files together, not Discord's: every file is held in memory to build
 * the upload, and ten 20 MiB files at once is more than a worker should be asked to carry.
 */
export const DISCORD_POST_MAX_BYTES = 50 * 1024 * 1024;

const NOT_OAUTH =
  'Discord is connected with a channel’s webhook address, entered in the dashboard.';

/**
 * The whole address, anchored, and nothing else: https, exactly `discord.com` (or its
 * `discordapp.com` alias), no port, no userinfo, the webhook path (optionally versioned), a
 * numeric id, a URL-safe token, no query and no fragment. Matched against the RAW text — a parser
 * is forgiving in ways an allowlist must not be (`https:discord.com`, `discord.com\@evil.example`,
 * `%2e%2e`), so nothing that needs normalising is accepted.
 */
const WEBHOOK_URL =
  /^https:\/\/(discord\.com|discordapp\.com)\/api\/(?:v\d{1,2}\/)?webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{20,200})\/?$/;

export interface DiscordWebhook {
  id: string;
  token: string;
}

/** What is stored (encrypted, as the connection's access token) to post into one channel. */
export interface DiscordCredentials extends DiscordWebhook {
  /** For the link to a posted message; absent when Discord did not report them. */
  guildId?: string;
  channelId?: string;
}

const SNOWFLAKE = /^\d{17,20}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

export function parseWebhookUrl(raw: string): DiscordWebhook {
  const text = raw.trim();
  const match = WEBHOOK_URL.exec(text);
  let parsed: URL | null = null;
  try {
    parsed = new URL(text);
  } catch {
    // Same answer as an address that parses but is not a webhook.
  }
  // Both must agree: the pattern on the text as typed, and the host as a URL parser reads it.
  if (!match || !parsed || !(API_HOSTS as readonly string[]).includes(parsed.hostname)) {
    throw new CredentialFormatError(
      'That is not a Discord webhook address. It looks like ' +
        'https://discord.com/api/webhooks/… — in Discord, open the webhook and press “Copy ' +
        'Webhook URL”.',
    );
  }
  return { id: match[2]!, token: match[3]! };
}

/** Always rebuilt from the two parts, on the one host — never the text a person typed. */
function webhookUrl(webhook: DiscordWebhook): string {
  return `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
}

export function encodeDiscordCredentials(credentials: DiscordCredentials): string {
  return encodeStored({ ...credentials });
}

export function decodeDiscordCredentials(stored: string): DiscordCredentials {
  const parsed = decodeStored(stored);
  if (
    !parsed ||
    typeof parsed.id !== 'string' ||
    !SNOWFLAKE.test(parsed.id) ||
    typeof parsed.token !== 'string' ||
    !TOKEN.test(parsed.token)
  ) {
    // Never include the blob: it is the secret.
    throw new ProviderAuthError('the stored Discord webhook is unreadable — reconnect');
  }
  const snowflake = (value: unknown): string | undefined =>
    typeof value === 'string' && SNOWFLAKE.test(value) ? value : undefined;
  const guildId = snowflake(parsed.guildId);
  const channelId = snowflake(parsed.channelId);
  return {
    id: parsed.id,
    token: parsed.token,
    ...(guildId ? { guildId } : {}),
    ...(channelId ? { channelId } : {}),
  };
}

interface DiscordErrorBody {
  message?: unknown;
  code?: unknown;
  retry_after?: unknown;
}

/**
 * Map a Discord error answer onto the sealed taxonomy (errors.ts):
 *  - 401, 403, 404 → auth: the webhook was deleted (10015 Unknown Webhook) or its token reset
 *    (50027). A new webhook and a reconnect is the fix; retrying never is.
 *  - 429 → rate limited (transient), with `retry_after` (or the `Retry-After` header).
 *  - 5xx → transient.
 *  - any other 4xx → bad request, with Discord's own message and code.
 */
export function mapDiscordError(response: SafeResponse, secrets: readonly string[]): Error {
  const { status } = response;
  const parsed = parseJson(response);
  const body = parsed !== null && typeof parsed === 'object' ? (parsed as DiscordErrorBody) : null;
  const code = typeof body?.code === 'number' ? body.code : null;
  const message = said(body?.message, secrets);
  const suffix = code !== null ? ` [${code}]` : '';
  const says = message ? `Discord says: ${message}${suffix}` : `Discord answered HTTP ${status}`;

  if (status === 429) {
    const wait = Number(body?.retry_after);
    return rateLimited('Discord', Number.isFinite(wait) ? wait : retryAfterHeader(response));
  }
  if (status === 401 || status === 403 || status === 404) {
    return new ProviderAuthError(
      'Discord no longer accepts this webhook — it was deleted, or its address was reset. ' +
        'Create a webhook on the channel again and reconnect with its new address.',
    );
  }
  if (status >= 500) return new ProviderTransientError(says);
  if (status === 413 || code === 40005) {
    return new ProviderBadRequestError(
      'A file is too large for this Discord server. The limit is 20 MB per file unless the ' +
        'server is boosted.',
    );
  }
  if (code === 220001) {
    return new ProviderBadRequestError(
      'This webhook belongs to a forum or media channel, where every post needs a thread. Use ' +
        'a webhook of a text or announcement channel.',
    );
  }
  return new ProviderBadRequestError(says);
}

export interface DiscordConfig {
  /** The guarded fetch. Calls to Discord are held to its two hosts on top of whatever it does. */
  fetchImpl?: ProviderFetch;
}

export class DiscordProvider implements SocialProvider {
  readonly identifier = 'discord' as const;
  readonly displayName = 'Discord';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'one-time' as const;
  readonly maxConcurrentJobs = 2;
  readonly connectInput = 'credentials' as const;

  private readonly api: ProviderFetch;
  private readonly fetchMedia: ProviderFetch | undefined;

  constructor(config: DiscordConfig = {}) {
    this.api = fixedHostFetch(API_HOSTS, config.fetchImpl ?? guardedFetch);
    this.fetchMedia = config.fetchImpl;
  }

  async generateAuthUrl(): Promise<GenerateAuthUrl> {
    throw new ProviderBadRequestError(NOT_OAUTH);
  }

  async authenticate(): Promise<AuthTokens> {
    throw new ProviderBadRequestError(NOT_OAUTH);
  }

  /**
   * `fields.webhookUrl`. The address is taken apart and rebuilt before use; one `GET` (which
   * posts nothing) confirms the webhook exists, is this one, and is of the kind that can post.
   */
  async connectWithCredentials(fields: Readonly<Record<string, string>>): Promise<AuthTokens> {
    const webhook = parseWebhookUrl(field(fields, 'webhookUrl'));
    // The whole address first, so an echo of it is blotted out as one piece, id and path too.
    const secrets = [webhookUrl(webhook), webhook.token];
    const response = await this.request(webhook, '', { method: 'GET' }, { secrets });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new ProviderAuthError(
        'Discord does not know that webhook. It may have been deleted, or the address is ' +
          'incomplete — copy it again with “Copy Webhook URL”.',
      );
    }
    if (response.status >= 400) throw mapDiscordError(response, secrets);
    const info = parseJson(response) as {
      id?: unknown;
      type?: unknown;
      name?: unknown;
      channel_id?: unknown;
      guild_id?: unknown;
    } | null;
    if (!info || typeof info !== 'object' || info.id !== webhook.id) {
      throw new ProviderBadRequestError('Discord’s answer about that webhook could not be read.');
    }
    // 1 = Incoming. A Channel Follower (2) or Application (3) webhook cannot be posted through.
    if (info.type !== 1) {
      throw new ProviderBadRequestError(
        'That webhook cannot post messages (it follows another channel, or belongs to an app). ' +
          'Create a new webhook on the channel under Integrations → Webhooks.',
      );
    }
    const snowflake = (value: unknown): string | undefined =>
      typeof value === 'string' && SNOWFLAKE.test(value) ? value : undefined;
    const guildId = snowflake(info.guild_id);
    const channelId = snowflake(info.channel_id);
    return {
      accessToken: encodeDiscordCredentials({
        ...webhook,
        ...(guildId ? { guildId } : {}),
        ...(channelId ? { channelId } : {}),
      }),
      externalId: webhook.id,
      displayName: said(info.name).slice(0, 80) || 'Discord webhook',
    };
  }

  /** A webhook has no refresh; reaching here means a real reconnect is needed. */
  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError('A Discord webhook cannot be refreshed — reconnect the channel');
  }

  assertPublishable(details: PostDetails[]): void {
    if (details.length !== 1) {
      throw new ProviderBadRequestError(`Discord expects exactly one post, got ${details.length}`);
    }
    const [detail] = details as [PostDetails];
    const { length } = discordContent(detail.caption);
    if (length > DISCORD_MAX_CONTENT) {
      throw new ProviderBadRequestError(
        `The text is ${length} characters as Discord receives it; it takes at most ` +
          `${DISCORD_MAX_CONTENT}. (Formatting characters such as * and _ are escaped, which ` +
          'adds to the count.)',
      );
    }
    if (detail.media.length > DISCORD_MAX_FILES) {
      throw new ProviderBadRequestError(
        `Discord takes at most ${DISCORD_MAX_FILES} files per message, got ${detail.media.length}`,
      );
    }
    if (detail.caption.trim() === '' && detail.media.length === 0) {
      throw new ProviderBadRequestError('A Discord message needs text, an image or a video');
    }
  }

  async post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    this.assertPublishable(details);
    const [detail] = details as [PostDetails];
    const credentials = decodeDiscordCredentials(tokens.accessToken);
    const secrets = [webhookUrl(credentials), credentials.token];
    const content = discordContent(detail.caption);

    // Fetched before anything is sent, so a missing or oversized file leaves nothing posted.
    const files = await this.collectFiles(detail.media);
    const payload = {
      ...(content.trim() !== '' ? { content } : {}),
      // No mention may notify anyone: not @everyone / @here, not a role, not a user.
      allowed_mentions: { parse: [] },
      ...(files.length > 0
        ? { attachments: files.map((f, id) => ({ id, filename: f.filename })) }
        : {}),
    };

    let options: SafeFetchOptions;
    if (files.length === 0) {
      options = {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        timeoutMs: API_TIMEOUT_MS,
      };
    } else {
      const parts: MultipartPart[] = [
        { name: 'payload_json', body: JSON.stringify(payload), contentType: 'application/json' },
        ...files.map((f, i) => ({
          name: `files[${i}]`,
          filename: f.filename,
          contentType: f.contentType,
          body: f.body,
        })),
      ];
      const form = multipartBody(parts);
      options = {
        method: 'POST',
        headers: { 'content-type': form.contentType },
        body: form.body,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      };
    }

    // `wait=true`: Discord answers with the message it created, and reports a failure to save it.
    const response = await this.request(credentials, '?wait=true', options, {
      secrets,
      posts: 'the channel',
    });
    if (response.status >= 400) throw mapDiscordError(response, secrets);
    const message = parseJson(response) as { id?: unknown; channel_id?: unknown } | null;
    if (!message || typeof message.id !== 'string' || !SNOWFLAKE.test(message.id)) {
      throw new ProviderBadRequestError(
        'Discord accepted the message but did not say which one it is — check the channel ' +
          'before retrying, so it is not posted twice.',
      );
    }
    const channelId =
      typeof message.channel_id === 'string' && SNOWFLAKE.test(message.channel_id)
        ? message.channel_id
        : credentials.channelId;
    return {
      externalPostId: message.id,
      ...(credentials.guildId && channelId
        ? {
            releaseUrl: `https://discord.com/channels/${credentials.guildId}/${channelId}/${message.id}`,
          }
        : { notice: 'Posted. Discord did not report enough to link to the message.' }),
    };
  }

  /**
   * A webhook can post and nothing else: it cannot read the message back, so there are no
   * reactions or replies to count, and Discord has no view counts at all. Returning nothing keeps
   * the analytics pages honest ("no data") rather than showing invented figures.
   */
  async postAnalytics(): Promise<MetricPoint[]> {
    return [];
  }

  async accountAnalytics(): Promise<MetricPoint[]> {
    return [];
  }

  private async collectFiles(
    media: readonly MediaRef[],
  ): Promise<Array<{ filename: string; contentType: string; body: Buffer }>> {
    const files: Array<{ filename: string; contentType: string; body: Buffer }> = [];
    let total = 0;
    for (const [index, item] of media.entries()) {
      const fetched = await downloadMedia(
        item,
        { maxBytes: DISCORD_FILE_MAX_BYTES, platform: 'Discord', timeoutMs: UPLOAD_TIMEOUT_MS },
        this.fetchMedia,
      );
      const extension = mediaExtension(fetched.contentType);
      if (!extension) {
        throw new ProviderBadRequestError(
          `A file is ${fetched.contentType || 'of an unknown type'}; from here Discord is sent ` +
            'JPEG, PNG, GIF or WebP images and MP4, MOV or WebM videos.',
        );
      }
      total += fetched.body.byteLength;
      if (total > DISCORD_POST_MAX_BYTES) {
        throw new ProviderBadRequestError(
          `The files of this post add up to more than ${DISCORD_POST_MAX_BYTES / (1024 * 1024)} MB, ` +
            'the most this app sends to Discord in one message. Attach fewer or smaller files.',
        );
      }
      files.push({
        filename: `${item.kind}-${index + 1}.${extension}`,
        contentType: fetched.contentType,
        body: fetched.body,
      });
    }
    return files;
  }

  /** One request to the webhook. The URL is built here and goes no further than `safeFetch`. */
  private async request(
    webhook: DiscordWebhook,
    query: '' | '?wait=true',
    options: SafeFetchOptions,
    context: { secrets: readonly string[]; posts?: string },
  ): Promise<SafeResponse> {
    let response: SafeResponse;
    try {
      response = await this.api(`${webhookUrl(webhook)}${query}`, {
        timeoutMs: API_TIMEOUT_MS,
        maxResponseBytes: API_MAX_BYTES,
        ...options,
        headers: { accept: 'application/json', ...options.headers },
      });
    } catch (err) {
      throw transportError(err, { platform: 'Discord', ...context });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ProviderBadRequestError(
        'Discord answered with a redirect, which a webhook never does. Nothing was posted.',
      );
    }
    return response;
  }
}
