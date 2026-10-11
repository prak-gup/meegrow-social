import { SLACK_MAX_SECTION_TEXT, slackMrkdwn } from '@meegrow-social/contracts';
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
  rateLimited,
  retryAfterHeader,
  said,
  transportError,
  type ProviderFetch,
} from '../shared/http.js';

/**
 * Slack provider — posts a message into one channel through an *incoming webhook*. No Slack app
 * of ours, no OAuth, no token: the workspace's own app issues a webhook URL bound to one channel.
 * Research, sources, what a full Slack app would add, and the live bring-up checklist:
 * docs/dev/research/quick-platforms.md §4. NOTHING here has run against Slack; the tests replay
 * fixtures built from Slack's documentation.
 *
 * What a webhook cannot do shapes this provider more than what it can:
 *  - it answers `ok` and nothing else — no message id, no permalink. A published Slack post has
 *    no link and nothing to poll, and says so (`notice`).
 *  - it cannot upload a file. Images are shown by their public address (an image block); video
 *    cannot be sent at all.
 *  - it cannot be asked "do you exist?". Connecting sends an EMPTY payload, which a live webhook
 *    refuses as `no_text` (posting nothing) and a dead one as `no_service`.
 *
 * The webhook URL is the credential — treated like a password throughout.
 *
 * Token model — `one-time`, no expiry: a webhook lives until it is removed or the app uninstalled.
 */

const API_HOST = 'hooks.slack.com';
const API_TIMEOUT_MS = 30_000;
/** A message takes up to 50 blocks; one is the text. Far above what a post here can carry. */
export const SLACK_MAX_IMAGES = 10;
const LABEL_MAX = 80;

const NOT_OAUTH =
  'Slack is connected with a channel’s incoming-webhook address, entered in the dashboard.';

/**
 * The whole address, anchored, on the raw text: https, exactly `hooks.slack.com`, the
 * `/services/` path with a workspace id (T…), a webhook id (B…) and the secret. Nothing else —
 * not a workflow trigger (`/triggers/…`), not another Slack host, no port, query or fragment.
 */
const WEBHOOK_URL =
  /^https:\/\/hooks\.slack\.com\/services\/(T[A-Z0-9]{6,20})\/(B[A-Z0-9]{6,20})\/([A-Za-z0-9]{16,64})$/;

export interface SlackWebhook {
  team: string;
  hook: string;
  secret: string;
}

export function parseSlackWebhookUrl(raw: string): SlackWebhook {
  const text = raw.trim();
  const match = WEBHOOK_URL.exec(text);
  let parsed: URL | null = null;
  try {
    parsed = new URL(text);
  } catch {
    // Same answer as an address that parses but is not a webhook.
  }
  if (!match || !parsed || parsed.hostname !== API_HOST) {
    throw new CredentialFormatError(
      'That is not a Slack incoming-webhook address. It looks like ' +
        'https://hooks.slack.com/services/T…/B…/… — copy it from Incoming Webhooks in the Slack ' +
        'app’s settings.',
    );
  }
  return { team: match[1]!, hook: match[2]!, secret: match[3]! };
}

/** Always rebuilt from its three parts, on the one host — never the text a person typed. */
function webhookUrl(webhook: SlackWebhook): string {
  return `https://${API_HOST}/services/${webhook.team}/${webhook.hook}/${webhook.secret}`;
}

export function encodeSlackCredentials(webhook: SlackWebhook): string {
  return encodeStored({ ...webhook });
}

export function decodeSlackCredentials(stored: string): SlackWebhook {
  const parsed = decodeStored(stored);
  const url =
    parsed &&
    typeof parsed.team === 'string' &&
    typeof parsed.hook === 'string' &&
    typeof parsed.secret === 'string'
      ? `https://${API_HOST}/services/${parsed.team}/${parsed.hook}/${parsed.secret}`
      : '';
  const match = WEBHOOK_URL.exec(url);
  if (!match) {
    // Never include the blob: it is the secret.
    throw new ProviderAuthError('the stored Slack webhook is unreadable — reconnect');
  }
  return { team: match[1]!, hook: match[2]!, secret: match[3]! };
}

/** What a person calls the channel. Slack never tells a webhook its channel's name. */
export function parseLabel(raw: string): string {
  const label = raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (label === '') {
    throw new CredentialFormatError('Enter a name for the channel, for example #announcements.');
  }
  if (label.length > LABEL_MAX) {
    throw new CredentialFormatError(`The channel name can be at most ${LABEL_MAX} characters.`);
  }
  return label;
}

/** Answers that mean the webhook itself is gone, whatever status they arrive with. */
const DEAD = new Set([
  'no_service',
  'no_active_hooks',
  'no_service_id',
  'no_team',
  'invalid_token',
]);
/** Answers that mean an administrator's rule forbids the post. The webhook is not broken. */
const FORBIDDEN_BY_ADMIN: Record<string, string> = {
  action_prohibited:
    'A Slack administrator has restricted posting this way. Ask them to allow the app to post, ' +
    'then try again.',
  posting_to_general_channel_denied:
    'This Slack workspace restricts who may post in #general, and the person who made the ' +
    'webhook is not one of them. Make a webhook for another channel.',
};

/**
 * Map a webhook error answer onto the sealed taxonomy (errors.ts). Slack answers in plain text —
 * one of a short documented vocabulary — with a matching HTTP status:
 *  - the webhook is gone (`no_service`, `no_active_hooks`, `invalid_token`, …, or any 403/404/410
 *    Slack does not explain) or its channel is archived → auth: a new webhook is the fix.
 *  - an administrator's restriction → bad request, in words.
 *  - 429 → rate limited (transient), with `Retry-After`.
 *  - 5xx → transient.
 *  - anything else (`invalid_payload`, `no_text`) → bad request, with Slack's own word.
 */
export function mapSlackError(response: SafeResponse, secrets: readonly string[]): Error {
  const { status } = response;
  const word = said(response.body.toString('utf8'), secrets).slice(0, 80);
  const restricted = FORBIDDEN_BY_ADMIN[word];
  if (restricted) return new ProviderBadRequestError(restricted);
  if (word === 'channel_is_archived') {
    return new ProviderAuthError(
      'The Slack channel this webhook posts to has been archived. Make a webhook for another ' +
        'channel and reconnect.',
    );
  }
  if (status === 429) return rateLimited('Slack', retryAfterHeader(response));
  if (DEAD.has(word) || status === 403 || status === 404 || status === 410) {
    return new ProviderAuthError(
      'Slack no longer accepts this webhook — it was removed, or the app was uninstalled. ' +
        'Create a new incoming webhook and reconnect.',
    );
  }
  const says = /^[a-z_]{3,60}$/.test(word)
    ? `Slack says: ${word}`
    : `Slack answered HTTP ${status}`;
  if (status >= 500) return new ProviderTransientError(says);
  return new ProviderBadRequestError(
    word === 'invalid_payload' ? `${says} — it could not read the message as sent.` : says,
  );
}

export interface SlackConfig {
  /** The guarded fetch; held to `hooks.slack.com` on top of whatever it does. */
  fetchImpl?: ProviderFetch;
}

export class SlackProvider implements SocialProvider {
  readonly identifier = 'slack' as const;
  readonly displayName = 'Slack';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'one-time' as const;
  /** "Apps may post no more than one message per second per channel." */
  readonly maxConcurrentJobs = 1;
  readonly connectInput = 'credentials' as const;

  private readonly fetchImpl: ProviderFetch;

  constructor(config: SlackConfig = {}) {
    this.fetchImpl = fixedHostFetch([API_HOST], config.fetchImpl ?? guardedFetch);
  }

  async generateAuthUrl(): Promise<GenerateAuthUrl> {
    throw new ProviderBadRequestError(NOT_OAUTH);
  }

  async authenticate(): Promise<AuthTokens> {
    throw new ProviderBadRequestError(NOT_OAUTH);
  }

  /**
   * `fields.webhookUrl` + `fields.label`. Slack has no way to look a webhook up, so the check is
   * a deliberately EMPTY payload: a live webhook refuses it for having no text — and so posts
   * nothing — while a removed one says it does not exist.
   */
  async connectWithCredentials(fields: Readonly<Record<string, string>>): Promise<AuthTokens> {
    const webhook = parseSlackWebhookUrl(field(fields, 'webhookUrl'));
    const label = parseLabel(field(fields, 'label'));
    const secrets = [webhookUrl(webhook), webhook.secret];

    const response = await this.send(webhook, {}, { secrets });
    const word = said(response.body.toString('utf8'), secrets);
    // 400 with a complaint about the payload is the proof of life. (A 200 would mean Slack took
    // an empty message, which it is documented not to; the webhook is alive either way.)
    const alive =
      response.status === 200 ||
      (response.status === 400 && !DEAD.has(word) && word !== 'channel_is_archived');
    if (!alive) {
      const mapped = mapSlackError(response, secrets);
      if (mapped instanceof ProviderAuthError && word !== 'channel_is_archived') {
        throw new ProviderAuthError(
          'Slack does not know that webhook. It may have been removed, or the address is ' +
            'incomplete — copy it again from Incoming Webhooks in the Slack app’s settings.',
        );
      }
      throw mapped;
    }
    return {
      accessToken: encodeSlackCredentials(webhook),
      // Identifiers, not the secret: the workspace and webhook ids are in every Slack URL.
      externalId: `${webhook.team}/${webhook.hook}`,
      displayName: label,
    };
  }

  /** A webhook has no refresh; reaching here means a real reconnect is needed. */
  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError('A Slack webhook cannot be refreshed — reconnect the channel');
  }

  assertPublishable(details: PostDetails[]): void {
    if (details.length !== 1) {
      throw new ProviderBadRequestError(`Slack expects exactly one post, got ${details.length}`);
    }
    const [detail] = details as [PostDetails];
    const { length } = slackMrkdwn(detail.caption);
    if (length > SLACK_MAX_SECTION_TEXT) {
      throw new ProviderBadRequestError(
        `The text is ${length} characters as Slack receives it; it takes at most ` +
          `${SLACK_MAX_SECTION_TEXT}. (Each link and each &, < or > adds a few.)`,
      );
    }
    if (detail.media.some((m) => m.kind !== 'image')) {
      throw new ProviderBadRequestError(
        'A Slack webhook cannot send video or any other file — only images, shown from their ' +
          'public address. Remove the video for Slack.',
      );
    }
    if (detail.media.length > SLACK_MAX_IMAGES) {
      throw new ProviderBadRequestError(
        `Slack is sent at most ${SLACK_MAX_IMAGES} images per message, got ${detail.media.length}`,
      );
    }
    if (detail.caption.trim() === '' && detail.media.length === 0) {
      throw new ProviderBadRequestError('A Slack message needs text or an image');
    }
  }

  async post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    this.assertPublishable(details);
    const [detail] = details as [PostDetails];
    const webhook = decodeSlackCredentials(tokens.accessToken);
    const secrets = [webhookUrl(webhook), webhook.secret];
    const text = slackMrkdwn(detail.caption);

    const blocks: unknown[] = [];
    if (text.trim() !== '') {
      // `verbatim`: Slack must not guess at names or links in the text — links are explicit.
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text, verbatim: true } });
    }
    for (const [index, media] of detail.media.entries()) {
      if (!media.url || !media.url.startsWith('https://') || media.url.length > 3000) {
        throw new ProviderBadRequestError(
          'Slack shows an image from its public https address, and this one has none it can use.',
        );
      }
      blocks.push({
        type: 'image',
        image_url: media.url,
        alt_text: detail.media.length > 1 ? `Image ${index + 1}` : 'Image',
      });
    }

    const response = await this.send(
      webhook,
      // `text` is what notifications and screen readers get when blocks are present.
      { text: text.trim() !== '' ? text : 'Image', blocks },
      { secrets, posts: 'the channel' },
    );
    if (response.status >= 400) throw mapSlackError(response, secrets);
    if (response.body.toString('utf8').trim() !== 'ok') {
      throw new ProviderBadRequestError(maybePosted('Slack', 'the channel'));
    }
    // No id and no link: an incoming webhook reports neither.
    return {
      notice:
        'Posted to Slack. An incoming webhook reports no link to the message, so there is none ' +
        'to open from here.',
    };
  }

  /**
   * An incoming webhook returns no message id, so there is nothing a post's reactions or replies
   * could be read by — and it could not read them if there were. Returning nothing keeps the
   * analytics pages honest ("no data") rather than showing invented figures.
   */
  async postAnalytics(): Promise<MetricPoint[]> {
    return [];
  }

  async accountAnalytics(): Promise<MetricPoint[]> {
    return [];
  }

  /** One POST to the webhook. The URL is built here and goes no further than `safeFetch`. */
  private async send(
    webhook: SlackWebhook,
    payload: unknown,
    context: { secrets: readonly string[]; posts?: string },
  ): Promise<SafeResponse> {
    try {
      return await this.fetchImpl(webhookUrl(webhook), {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        timeoutMs: API_TIMEOUT_MS,
        maxResponseBytes: 64 * 1024,
      });
    } catch (err) {
      throw transportError(err, { platform: 'Slack', ...context });
    }
  }
}
