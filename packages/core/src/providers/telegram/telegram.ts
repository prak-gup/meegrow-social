import {
  TELEGRAM_MAX_CAPTION,
  TELEGRAM_MAX_TEXT,
  telegramHtml,
  type MediaRef,
} from '@meegrow-social/contracts';
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
import type { SafeResponse } from '../../net/safe-fetch.js';
import {
  CredentialFormatError,
  decodeStored,
  encodeStored,
  field,
  fixedHostFetch,
  guardedFetch,
  maybePosted,
  parseJson,
  rateLimited,
  said,
  transportError,
  type ProviderFetch,
} from '../shared/http.js';

/**
 * Telegram provider — broadcasts a post into one channel (or group) through a bot, over the Bot
 * API. It only ever sends: no updates are read, no messages received, no webhook is set. Research,
 * sources and the live bring-up checklist: docs/dev/research/quick-platforms.md §2. NOTHING here
 * has run against Telegram; the tests replay fixtures built from the Bot API reference.
 *
 * Connect — the person makes a bot with BotFather, adds it to their channel as an administrator,
 * and pastes the bot's token and the channel's name. `getMe`, `getChat` and `getChatMember`
 * confirm the token works and the bot may post there before anything is stored.
 *
 * THE TOKEN IS PART OF EVERY REQUEST URL (`/bot<token>/<method>`). So nothing in this file ever
 * puts a URL into an error or a log: failures are worded from Telegram's `description`, passed
 * through `said(…, [token])`, and the transport's own errors name only the host.
 *
 * Token model — `one-time`, no expiry: a bot token lives until it is revoked in BotFather.
 */

const API_HOST = 'api.telegram.org';
const API_TIMEOUT_MS = 30_000;
/** `sendMediaGroup`: 2-10 items. */
export const TELEGRAM_MAX_MEDIA = 10;

/** `<bot id>:<secret>`, as BotFather issues it. Also what makes it safe to place in a URL path. */
const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{20,128}$/;
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const NUMERIC_CHAT = /^-?\d{5,20}$/;

const NOT_OAUTH = 'Telegram is connected with a bot token and a channel, entered in the dashboard.';

/** What is stored (encrypted, as the connection's access token) to post into one chat. */
export interface TelegramCredentials {
  token: string;
  chatId: string;
  /** The chat's public @username, without the @, when it has one — what a message link needs. */
  username?: string;
}

export function encodeTelegramCredentials(credentials: TelegramCredentials): string {
  return encodeStored({ ...credentials });
}

export function decodeTelegramCredentials(stored: string): TelegramCredentials {
  const parsed = decodeStored(stored);
  if (
    !parsed ||
    typeof parsed.token !== 'string' ||
    !BOT_TOKEN.test(parsed.token) ||
    typeof parsed.chatId !== 'string' ||
    !NUMERIC_CHAT.test(parsed.chatId)
  ) {
    // Never include the blob: it is the secret.
    throw new ProviderAuthError('the stored Telegram credentials are unreadable — reconnect');
  }
  return {
    token: parsed.token,
    chatId: parsed.chatId,
    ...(typeof parsed.username === 'string' && USERNAME.test(parsed.username)
      ? { username: parsed.username }
      : {}),
  };
}

export function assertBotToken(raw: string): string {
  const token = raw.trim();
  if (!BOT_TOKEN.test(token)) {
    throw new CredentialFormatError(
      'That is not a bot token. BotFather gives one that looks like 123456789:AA… — copy the ' +
        'whole line.',
    );
  }
  return token;
}

/**
 * What a person typed for "channel" → the `chat_id` Telegram takes: `@username` or a numeric id.
 * A pasted `t.me/name` link is read as the username; an invite link (`t.me/+…`) names nothing
 * the Bot API can address.
 */
export function parseChat(raw: string): string {
  let text = raw.trim();
  if (text === '') throw new CredentialFormatError('Enter the channel’s @username or numeric id.');
  if (NUMERIC_CHAT.test(text)) return text;
  const link = /^(?:https?:\/\/)?(?:t|telegram)\.me\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(text);
  if (link) text = link[1]!;
  if (text.startsWith('+') || /^joinchat$/i.test(text)) {
    throw new CredentialFormatError(
      'An invite link cannot be used. A private channel has no public name — enter its numeric ' +
        'id instead (it starts with -100).',
    );
  }
  text = text.replace(/^@/, '');
  if (!USERNAME.test(text)) {
    throw new CredentialFormatError(
      'That is not a channel name. Enter its @username (for example @yourchannel), its t.me ' +
        'link, or its numeric id.',
    );
  }
  return `@${text}`;
}

interface TelegramAnswer<T> {
  ok?: unknown;
  result?: T;
  description?: unknown;
  error_code?: unknown;
  parameters?: { retry_after?: unknown; migrate_to_chat_id?: unknown } | null;
}

/** A Bot API failure, with the pieces callers branch on. */
export interface TelegramFailure {
  error: Error;
  status: number;
  description: string;
}

/**
 * Map a Bot API error onto the sealed taxonomy (errors.ts). Telegram mirrors `error_code` in the
 * HTTP status and explains itself in `description`:
 *  - 401 (and 404, which is what a token of the wrong shape gets) → auth: the token is dead.
 *  - 403 → auth: the bot was removed from the chat or blocked. Reconnecting (after adding it
 *    back) is the fix; retrying is not.
 *  - 429 → rate limited (transient), with `parameters.retry_after`.
 *  - 5xx → transient.
 *  - 400 → bad request, with Telegram's own words.
 */
export function mapTelegramError(
  status: number,
  body: TelegramAnswer<unknown> | null,
  token: string,
): TelegramFailure {
  const description = said(body?.description, [token]).replace(/^Bad Request:\s*/i, '');
  const says = description ? `Telegram says: ${description}` : `Telegram answered HTTP ${status}`;
  const fail = (error: Error): TelegramFailure => ({ error, status, description });

  if (status === 401 || status === 404) {
    return fail(
      new ProviderAuthError(
        'Telegram did not accept the bot token — it was revoked or replaced in BotFather. ' +
          'Reconnect with the bot’s current token.',
      ),
    );
  }
  if (status === 403) {
    return fail(
      new ProviderAuthError(
        `${says}. The bot was removed from the channel or lost the right to post there. Add it ` +
          'back as an administrator, then reconnect.',
      ),
    );
  }
  if (status === 429) {
    const wait = Number(body?.parameters?.retry_after);
    return fail(rateLimited('Telegram', Number.isFinite(wait) ? wait : null));
  }
  if (status >= 500) return fail(new ProviderTransientError(says));
  return fail(new ProviderBadRequestError(says));
}

interface TelegramUser {
  id?: unknown;
  is_bot?: unknown;
  username?: unknown;
}

interface TelegramChat {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  username?: unknown;
}

interface TelegramMember {
  status?: unknown;
  can_post_messages?: unknown;
  can_send_messages?: unknown;
}

interface TelegramMessage {
  message_id?: unknown;
  chat?: TelegramChat;
}

export interface TelegramConfig {
  /** The guarded fetch; held to `api.telegram.org` on top of whatever it does. */
  fetchImpl?: ProviderFetch;
}

export class TelegramProvider implements SocialProvider {
  readonly identifier = 'telegram' as const;
  readonly displayName = 'Telegram';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'one-time' as const;
  /** "In a single chat, avoid sending more than one message per second." */
  readonly maxConcurrentJobs = 1;
  readonly connectInput = 'credentials' as const;

  private readonly fetchImpl: ProviderFetch;

  constructor(config: TelegramConfig = {}) {
    this.fetchImpl = fixedHostFetch([API_HOST], config.fetchImpl ?? guardedFetch);
  }

  async generateAuthUrl(): Promise<GenerateAuthUrl> {
    throw new ProviderBadRequestError(NOT_OAUTH);
  }

  async authenticate(): Promise<AuthTokens> {
    throw new ProviderBadRequestError(NOT_OAUTH);
  }

  /**
   * `fields.token` + `fields.chat`. Three reads confirm what posting will need: the token is a
   * bot's (`getMe`), the chat exists and is a channel or group (`getChat`), and this bot may
   * post in it (`getChatMember`). Nothing is sent to the chat.
   */
  async connectWithCredentials(fields: Readonly<Record<string, string>>): Promise<AuthTokens> {
    const token = assertBotToken(field(fields, 'token'));
    const chatRef = parseChat(field(fields, 'chat'));

    const me = await this.call<TelegramUser>(token, 'getMe', {});
    if (typeof me.id !== 'number' || me.is_bot !== true) {
      throw new ProviderAuthError('That token does not belong to a Telegram bot.');
    }

    const NOT_THERE =
      'Telegram cannot find that channel, or the bot has not been added to it. Add the bot to ' +
      'the channel as an administrator first, then try again.';
    const found = await this.tryCall<TelegramChat>(token, 'getChat', { chat_id: chatRef });
    if ('failure' in found) {
      // The token just worked for getMe, so a refusal here is about the chat, not the token.
      if (found.failure.status === 400 || found.failure.status === 403) {
        throw new ProviderBadRequestError(NOT_THERE);
      }
      throw found.failure.error;
    }
    const chat = found.data;
    if (typeof chat.id !== 'number' || !Number.isSafeInteger(chat.id)) {
      throw new ProviderBadRequestError('Telegram did not say which chat that is.');
    }
    if (chat.type !== 'channel' && chat.type !== 'supergroup' && chat.type !== 'group') {
      throw new ProviderBadRequestError(
        'That is a private chat with a person, not a channel or a group.',
      );
    }

    const membership = await this.tryCall<TelegramMember>(token, 'getChatMember', {
      chat_id: chat.id,
      user_id: me.id,
    });
    if ('failure' in membership) {
      if (membership.failure.status === 400 || membership.failure.status === 403) {
        throw new ProviderBadRequestError(NOT_THERE);
      }
      throw membership.failure.error;
    }
    assertMayPost(chat.type, membership.data);

    const username =
      typeof chat.username === 'string' && USERNAME.test(chat.username) ? chat.username : undefined;
    const title = said(chat.title).slice(0, 120);
    return {
      accessToken: encodeTelegramCredentials({
        token,
        chatId: String(chat.id),
        ...(username ? { username } : {}),
      }),
      externalId: String(chat.id),
      displayName: title || (username ? `@${username}` : `Telegram chat ${chat.id}`),
    };
  }

  /** A bot token has no refresh; reaching here means a real reconnect is needed. */
  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError('A Telegram bot token cannot be refreshed — reconnect the channel');
  }

  assertPublishable(details: PostDetails[]): void {
    if (details.length !== 1) {
      throw new ProviderBadRequestError(`Telegram expects exactly one post, got ${details.length}`);
    }
    const [detail] = details as [PostDetails];
    const { length } = detail.caption;
    if (detail.media.length > TELEGRAM_MAX_MEDIA) {
      throw new ProviderBadRequestError(
        `Telegram takes at most ${TELEGRAM_MAX_MEDIA} photos or videos per post, got ${detail.media.length}`,
      );
    }
    if (detail.media.length > 0) {
      if (length > TELEGRAM_MAX_CAPTION) {
        throw new ProviderBadRequestError(
          `The text is ${length} characters; beside a photo or video Telegram takes at most ` +
            `${TELEGRAM_MAX_CAPTION} (${TELEGRAM_MAX_TEXT} without media)`,
        );
      }
      return;
    }
    if (detail.caption.trim() === '') {
      throw new ProviderBadRequestError('A Telegram post needs text, a photo or a video');
    }
    if (length > TELEGRAM_MAX_TEXT) {
      throw new ProviderBadRequestError(
        `The text is ${length} characters; Telegram takes at most ${TELEGRAM_MAX_TEXT}`,
      );
    }
  }

  async post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    this.assertPublishable(details);
    const [detail] = details as [PostDetails];
    const credentials = decodeTelegramCredentials(tokens.accessToken);
    const text = telegramHtml(detail.caption);
    const base = { chat_id: credentials.chatId };
    // Telegram fetches media itself from the stored public URL; no bytes pass through here.
    const urls = detail.media.map(mediaUrl);

    let message: TelegramMessage | undefined;
    if (detail.media.length === 0) {
      message = await this.send<TelegramMessage>(credentials, 'sendMessage', {
        ...base,
        text,
        parse_mode: 'HTML',
      });
    } else if (detail.media.length === 1) {
      const video = detail.media[0]!.kind === 'video';
      message = await this.send<TelegramMessage>(credentials, video ? 'sendVideo' : 'sendPhoto', {
        ...base,
        [video ? 'video' : 'photo']: urls[0],
        ...(text ? { caption: text, parse_mode: 'HTML' } : {}),
      });
    } else {
      // An album shows the caption of its first item as the album's caption.
      const sent = await this.send<TelegramMessage[]>(credentials, 'sendMediaGroup', {
        ...base,
        media: detail.media.map((m, i) => ({
          type: m.kind === 'video' ? 'video' : 'photo',
          media: urls[i],
          ...(i === 0 && text ? { caption: text, parse_mode: 'HTML' } : {}),
        })),
      });
      message = Array.isArray(sent) ? sent[0] : undefined;
    }

    if (typeof message?.message_id !== 'number') {
      throw new ProviderBadRequestError(
        'Telegram accepted the post but did not say which message it is — check the channel ' +
          'before retrying, so it is not posted twice.',
      );
    }
    const link = messageLink(credentials, message);
    return {
      externalPostId: String(message.message_id),
      ...(link ? { releaseUrl: link } : {}),
      ...(link
        ? {}
        : { notice: 'Posted. This kind of Telegram group has no link to a single message.' }),
    };
  }

  /**
   * The Bot API gives a bot no numbers about a channel post — no views, no reactions, no forwards
   * (those live in the client apps and the separate MTProto statistics API). Returning nothing
   * keeps the analytics pages honest ("no data") rather than showing invented figures.
   */
  async postAnalytics(): Promise<MetricPoint[]> {
    return [];
  }

  async accountAnalytics(): Promise<MetricPoint[]> {
    return [];
  }

  /** A call that posts: failures are reworded for publish time, and a lost answer is final. */
  private async send<T>(
    credentials: TelegramCredentials,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.tryCall<T>(credentials.token, method, params, 'the channel');
    if (!('failure' in result)) return result.data;
    const { status, description, error } = result.failure;
    // At publish time the chat was verified once already: if Telegram can no longer find it, or
    // the bot may no longer write to it, the connection is what needs fixing.
    if (
      status === 400 &&
      /chat not found|not enough rights|need administrator rights|have no rights|bot is not a member|chat_write_forbidden|group chat was upgraded/i.test(
        description,
      )
    ) {
      throw new ProviderAuthError(
        `Telegram says: ${description}. The bot can no longer post to this channel. Add it back ` +
          'as an administrator, then reconnect.',
      );
    }
    throw error;
  }

  private async call<T>(
    token: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.tryCall<T>(token, method, params);
    if ('failure' in result) throw result.failure.error;
    return result.data;
  }

  /** One Bot API method. `posts` is set (to where to look) for the calls that send something. */
  private async tryCall<T>(
    token: string,
    method: string,
    params: Record<string, unknown>,
    posts?: string,
  ): Promise<{ data: T } | { failure: TelegramFailure }> {
    let response: SafeResponse;
    try {
      response = await this.fetchImpl(`https://${API_HOST}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
        body: JSON.stringify(params),
        timeoutMs: API_TIMEOUT_MS,
      });
    } catch (err) {
      throw transportError(err, { platform: 'Telegram', secrets: [token], posts });
    }
    const parsed = parseJson(response);
    const body =
      parsed !== null && typeof parsed === 'object' ? (parsed as TelegramAnswer<T>) : null;
    if (response.status >= 400 || body?.ok !== true) {
      if (response.status < 400) {
        // A 2xx that is not `{"ok":true}`: something between us and Telegram answered instead.
        throw new ProviderBadRequestError(
          posts ? maybePosted('Telegram', posts) : 'Telegram’s answer could not be read.',
        );
      }
      return { failure: mapTelegramError(response.status, body, token) };
    }
    return { data: body.result as T };
  }
}

/** A channel needs an administrator who may post; a group needs a member who may write. */
function assertMayPost(chatType: string, member: TelegramMember): void {
  const status = typeof member.status === 'string' ? member.status : '';
  if (chatType === 'channel') {
    if (status === 'creator') return;
    if (status === 'administrator' && member.can_post_messages === true) return;
    throw new ProviderBadRequestError(
      status === 'administrator'
        ? 'The bot is an administrator of the channel but is not allowed to post. In the ' +
            'channel’s Administrators, open the bot and switch on “Post messages”.'
        : 'The bot is not an administrator of that channel. In the channel, open ' +
            'Administrators → Add admin, pick the bot, and allow “Post messages”.',
    );
  }
  if (status === 'creator' || status === 'administrator' || status === 'member') return;
  if (status === 'restricted' && member.can_send_messages === true) return;
  throw new ProviderBadRequestError(
    'The bot is not a member of that group, or is not allowed to write in it. Add the bot to ' +
      'the group, then try again.',
  );
}

function mediaUrl(media: MediaRef): string {
  if (!media.url) throw new ProviderBadRequestError(`media ${media.mediaId} has no stored url`);
  if (!media.url.startsWith('https://')) {
    throw new ProviderBadRequestError(
      'Telegram fetches photos and videos itself, so they must be at a public https address.',
    );
  }
  return media.url;
}

/**
 * Where a person can open the message: `t.me/<username>/<id>` for a public chat. A private
 * channel or supergroup (id `-100…`) has a `t.me/c/…` link that opens only for its members; a
 * basic group has none.
 */
function messageLink(credentials: TelegramCredentials, message: TelegramMessage): string | null {
  const id = message.message_id as number;
  const live = message.chat?.username;
  const username = typeof live === 'string' && USERNAME.test(live) ? live : credentials.username;
  if (username) return `https://t.me/${username}/${id}`;
  if (credentials.chatId.startsWith('-100')) {
    return `https://t.me/c/${credentials.chatId.slice(4)}/${id}`;
  }
  return null;
}
