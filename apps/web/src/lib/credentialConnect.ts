/**
 * Connecting a platform that gives people a credential to paste — no login window, no redirect
 * (`connectInput: 'credentials'` on the provider). What each platform asks for, where a person
 * finds it, and the checks worth making before the server is asked. Pure, so it is unit-tested in
 * node; `ConnectCredentialDialog` only lays it out.
 *
 * The server is the authority on every field (each provider re-validates and then verifies the
 * credential against the platform). The checks here exist to catch a paste of the wrong thing
 * before it is sent — and, for a password field, to refuse a main account password outright.
 */

export interface CredentialField {
  /** The key the provider reads (`fields[name]` on `POST …/:provider/credentials`). */
  name: string;
  label: string;
  /** A secret is masked while typed and never pre-filled. */
  secret: boolean;
  placeholder: string;
  hint: string;
  /** What is wrong with a value, in words, or null. An empty value is handled by the caller. */
  problem: (value: string) => string | null;
}

export interface CredentialGuide {
  /** Dialog title, e.g. "Connect a Telegram channel". */
  title: string;
  /** Where the credential comes from: short, exact, in order. */
  steps: string[];
  /** The platform's own page for the first step. */
  link: { href: string; label: string };
  fields: CredentialField[];
  /** What is kept and how to take the access away again, in a sentence or two. */
  keeping: string;
  /** What this kind of connection cannot do, said before it is made. Empty when nothing. */
  limits: string[];
  /** Non-secret values worth carrying into a reconnect, from the connection being reconnected. */
  prefill?: (connection: { displayName: string; externalId: string }) => Record<string, string>;
}

const BLUESKY_HANDLE =
  /^@?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const BLUESKY_APP_PASSWORD = /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/i;

const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{20,128}$/;
const TELEGRAM_CHAT =
  /^(-?\d{5,20}|(?:(?:https?:\/\/)?(?:t|telegram)\.me\/|@)?[A-Za-z][A-Za-z0-9_]{3,31}\/?)$/;

const DISCORD_WEBHOOK =
  /^https:\/\/(discord\.com|discordapp\.com)\/api\/(v\d{1,2}\/)?webhooks\/\d{17,20}\/[A-Za-z0-9_-]{20,200}\/?$/;

const SLACK_WEBHOOK =
  /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,20}\/B[A-Z0-9]{6,20}\/[A-Za-z0-9]{16,64}$/;

const GUIDES: Record<string, CredentialGuide> = {
  bluesky: {
    title: 'Connect a Bluesky account',
    steps: [
      'In Bluesky, open Settings → Privacy and security → App passwords.',
      'Choose “Add App Password”, name it (for example “Meegrow Social”) and create it. Leave access to direct messages off.',
      'Copy the password it shows — Bluesky shows it only once — and paste it below with the account’s handle.',
    ],
    link: {
      href: 'https://bsky.app/settings/app-passwords',
      label: 'Open App passwords in Bluesky',
    },
    fields: [
      {
        name: 'handle',
        label: 'Handle',
        secret: false,
        placeholder: 'name.bsky.social',
        hint: 'The @handle shown under the name on the profile. A custom domain works too.',
        problem: (v) =>
          BLUESKY_HANDLE.test(v) || v.startsWith('did:')
            ? null
            : v.includes('.')
              ? 'That is not a valid handle.'
              : 'Enter the full handle, for example name.bsky.social.',
      },
      {
        name: 'appPassword',
        label: 'App password',
        secret: true,
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
        hint: 'An app password — never the account’s main password.',
        problem: (v) =>
          BLUESKY_APP_PASSWORD.test(v)
            ? null
            : 'An app password looks like xxxx-xxxx-xxxx-xxxx. Do not enter the account’s main password.',
      },
    ],
    keeping:
      'The app password is stored encrypted and used only to post. Take the access away at any time by deleting it under App passwords in Bluesky.',
    limits: ['Posts text, links and up to 4 images of 2 MB each. Video is not posted yet.'],
    prefill: (c) => ({ handle: c.displayName.replace(/^@/, '') }),
  },
  telegram: {
    title: 'Connect a Telegram channel',
    steps: [
      'In Telegram, open a chat with @BotFather, send /newbot and follow it. It replies with the bot’s token.',
      'Open your channel → Administrators → Add admin, pick the bot, and allow “Post messages”.',
      'Paste the token and the channel’s @username below. A private channel has no username: use its numeric id, which starts with -100.',
    ],
    link: { href: 'https://t.me/BotFather', label: 'Open BotFather in Telegram' },
    fields: [
      {
        name: 'token',
        label: 'Bot token',
        secret: true,
        placeholder: '123456789:AA…',
        hint: 'From BotFather. Whoever holds it controls the bot, so treat it like a password.',
        problem: (v) =>
          TELEGRAM_TOKEN.test(v)
            ? null
            : 'A bot token looks like 123456789:AA… — copy the whole line BotFather sent.',
      },
      {
        name: 'chat',
        label: 'Channel',
        secret: false,
        placeholder: '@yourchannel',
        hint: 'The channel’s @username, its t.me link, or its numeric id.',
        problem: (v) =>
          /t\.me\/(\+|joinchat)/i.test(v)
            ? 'An invite link cannot be used. Enter the channel’s @username or its numeric id.'
            : TELEGRAM_CHAT.test(v)
              ? null
              : 'Enter the channel’s @username (for example @yourchannel), its t.me link, or its numeric id.',
      },
    ],
    keeping:
      'The token is stored encrypted and is only ever sent to Telegram. Take the access away by removing the bot from the channel, or with /revoke in BotFather.',
    limits: [
      'Posts text, photos and videos into the channel. Nothing is read from it.',
      'Photos up to 5 MB and videos up to 20 MB; beside media the text is limited to 1,024 characters.',
      'Telegram gives bots no view or reaction counts, so Analytics stays empty for this channel.',
    ],
    // The numeric id is what was verified; the title is not an address.
    prefill: (c) => ({ chat: c.externalId }),
  },
  discord: {
    title: 'Connect a Discord channel',
    steps: [
      'In Discord, open the server’s Server Settings → Integrations → Webhooks. You need the “Manage Webhooks” permission.',
      'Choose “New Webhook”, pick the channel it should post in, and name it — messages appear under that name.',
      'Press “Copy Webhook URL” and paste it below.',
    ],
    link: {
      href: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
      label: 'Discord’s guide to webhooks',
    },
    fields: [
      {
        name: 'webhookUrl',
        label: 'Webhook URL',
        secret: true,
        placeholder: 'https://discord.com/api/webhooks/…',
        hint: 'Anyone holding this address can post in the channel, so it is kept like a password.',
        problem: (v) =>
          DISCORD_WEBHOOK.test(v)
            ? null
            : 'A Discord webhook address looks like https://discord.com/api/webhooks/… — use “Copy Webhook URL” on the webhook.',
      },
    ],
    keeping:
      'The address is stored encrypted and is only ever sent to Discord. Take the access away by deleting the webhook in Discord.',
    limits: [
      'Posts text (2,000 characters as sent) with up to 10 images or videos of 20 MB each. Use a text or announcement channel, not a forum.',
      'Nobody is pinged: @everyone, @here and role or user mentions go out as plain text.',
      'A webhook cannot read anything back, so Analytics stays empty for this channel.',
    ],
  },
  slack: {
    title: 'Connect a Slack channel',
    steps: [
      'Open api.slack.com/apps, choose “Create New App” → “From scratch”, name it and pick your workspace.',
      'In the app, open “Incoming Webhooks”, switch it on, and press “Add New Webhook to Workspace”.',
      'Pick the channel it should post in and allow it. Copy the Webhook URL and paste it below.',
    ],
    link: { href: 'https://api.slack.com/apps', label: 'Open your Slack apps' },
    fields: [
      {
        name: 'webhookUrl',
        label: 'Webhook URL',
        secret: true,
        placeholder: 'https://hooks.slack.com/services/…',
        hint: 'Anyone holding this address can post in the channel, so it is kept like a password.',
        problem: (v) =>
          SLACK_WEBHOOK.test(v)
            ? null
            : 'A Slack webhook address looks like https://hooks.slack.com/services/T…/B…/… — copy it from Incoming Webhooks in the app’s settings.',
      },
      {
        name: 'label',
        label: 'Channel name',
        secret: false,
        placeholder: '#announcements',
        hint: 'Only a label for this dashboard. The webhook already knows its channel; Slack does not tell us its name.',
        problem: (v) => (v.length > 80 ? 'Keep the name under 80 characters.' : null),
      },
    ],
    keeping:
      'The address is stored encrypted and is only ever sent to Slack. Take the access away by removing the webhook under Incoming Webhooks in the Slack app.',
    limits: [
      'Posts text (3,000 characters as sent) and images, which Slack shows from their public address. Video and other files cannot be sent through a webhook.',
      'Slack gives back no link to the message and no numbers: a Slack post has no “open” link here, and Analytics stays empty for it.',
      'Mentions never fire, but Slack has no way to switch formatting off: *bold*, _italic_ and ~strike~ still show as formatting if typed.',
    ],
    prefill: (c) => ({ label: c.displayName }),
  },
};

/** The guide for a provider, or null for one that does not connect this way. */
export function credentialGuide(provider: string): CredentialGuide | null {
  return GUIDES[provider] ?? null;
}

/** Per-field problems for what was typed. Empty = ready to send. */
export function credentialProblems(
  guide: CredentialGuide,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const f of guide.fields) {
    const value = (values[f.name] ?? '').trim();
    const problem = value === '' ? `Enter the ${f.label.toLowerCase()}.` : f.problem(value);
    if (problem) problems[f.name] = problem;
  }
  return problems;
}

/** The body of the connect call: every field, trimmed. */
export function credentialFields(
  guide: CredentialGuide,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(guide.fields.map((f) => [f.name, (values[f.name] ?? '').trim()]));
}

/**
 * The words for a failed connect. A 429 is this app's own attempt limit, which the server words
 * tersely; everything else is the provider's sentence and is shown as it came.
 */
export function connectFailure(status: number | undefined, message: string): string {
  if (status === 429) {
    return 'Too many attempts. Wait about 15 minutes, check the details, and try again.';
  }
  return message || 'Could not connect.';
}
