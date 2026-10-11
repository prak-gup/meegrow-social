import { describe, expect, it } from 'vitest';
import {
  connectFailure,
  credentialFields,
  credentialGuide,
  credentialProblems,
  type CredentialGuide,
} from './credentialConnect';

const guide = (provider: string): CredentialGuide => {
  const found = credentialGuide(provider);
  if (!found) throw new Error(`no guide for ${provider}`);
  return found;
};

/** Every guide, whichever platforms this build carries. */
const PROVIDERS = ['bluesky', 'telegram', 'discord', 'slack'].filter((p) => credentialGuide(p));

describe('credentialGuide', () => {
  it('has nothing for a platform that connects through a login window', () => {
    for (const p of ['facebook', 'instagram', 'wordpress', 'fake', '']) {
      expect(credentialGuide(p)).toBeNull();
    }
  });

  it.each(PROVIDERS)(
    '%s: says where the credential comes from and links the platform’s own page',
    (p) => {
      const g = guide(p);
      expect(g.steps.length).toBeGreaterThanOrEqual(2);
      expect(g.steps.length).toBeLessThanOrEqual(4);
      expect(g.link.href).toMatch(/^https:\/\//);
      expect(g.keeping).toMatch(/encrypted/);
      expect(g.fields.some((f) => f.secret)).toBe(true);
      expect(new Set(g.fields.map((f) => f.name)).size).toBe(g.fields.length);
    },
  );

  it.each(PROVIDERS)('%s: asks for every field before anything is sent', (p) => {
    const g = guide(p);
    const problems = credentialProblems(g, {});
    expect(Object.keys(problems).sort()).toEqual(g.fields.map((f) => f.name).sort());
    for (const message of Object.values(problems)) expect(message).toMatch(/^Enter the /);
  });

  it.each(PROVIDERS)('%s: a reconnect never pre-fills a secret', (p) => {
    const g = guide(p);
    const filled = g.prefill?.({ displayName: '@acme.bsky.social', externalId: 'T1/B1' }) ?? {};
    for (const f of g.fields.filter((x) => x.secret)) expect(filled[f.name]).toBeUndefined();
  });
});

describe('credentialFields', () => {
  it('sends exactly the guide’s fields, trimmed', () => {
    const g = guide(PROVIDERS[0]!);
    const values = Object.fromEntries(g.fields.map((f) => [f.name, `  ${f.name}-value \n`]));
    expect(credentialFields(g, { ...values, extra: 'not sent' })).toEqual(
      Object.fromEntries(g.fields.map((f) => [f.name, `${f.name}-value`])),
    );
  });
});

describe('connectFailure', () => {
  it('explains the attempt limit instead of repeating the terse server text', () => {
    expect(connectFailure(429, 'too many attempts, try again later')).toMatch(/15 minutes/);
  });

  it('shows the provider’s own sentence for everything else', () => {
    expect(connectFailure(422, 'Bluesky did not accept that handle and app password.')).toBe(
      'Bluesky did not accept that handle and app password.',
    );
    expect(connectFailure(undefined, '')).toBe('Could not connect.');
  });
});

describe('bluesky', () => {
  const g = guide('bluesky');
  const ok = { handle: 'acme.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' };

  it('accepts a handle (with or without @), a custom domain, and an app password', () => {
    expect(credentialProblems(g, ok)).toEqual({});
    expect(credentialProblems(g, { ...ok, handle: '@acme.com' })).toEqual({});
  });

  it('asks for the full handle when only the name was typed', () => {
    expect(credentialProblems(g, { ...ok, handle: 'acme' }).handle).toMatch(/name\.bsky\.social/);
  });

  it('refuses anything that is not shaped like an app password — a main password above all', () => {
    for (const typed of ['hunter2', 'Correct-Horse-Battery-Staple', 'abcd efgh ijkl mnop']) {
      expect(credentialProblems(g, { ...ok, appPassword: typed }).appPassword).toMatch(
        /main password/,
      );
    }
  });

  it('carries the handle, and only the handle, into a reconnect', () => {
    expect(g.prefill?.({ displayName: '@acme.bsky.social', externalId: 'did:plc:x' })).toEqual({
      handle: 'acme.bsky.social',
    });
  });
});

describe('telegram', () => {
  const g = guide('telegram');
  const ok = { token: '123456789:AAF-secret_bot_token_value_0123456789abc', chat: '@acme_news' };

  it.each([
    '@acme_news',
    'acme_news',
    'https://t.me/acme_news',
    't.me/acme_news/',
    '-1001234567890',
  ])('accepts the channel written as %s', (chat) => {
    expect(credentialProblems(g, { ...ok, chat })).toEqual({});
  });

  it('explains that an invite link is not an address a bot can use', () => {
    expect(credentialProblems(g, { ...ok, chat: 'https://t.me/+AbCdEfGh' }).chat).toMatch(
      /invite link/,
    );
  });

  it('refuses something that is not a token, without sending it anywhere', () => {
    for (const token of ['acme_bot', '123456789', 'https://t.me/acme_bot']) {
      expect(credentialProblems(g, { ...ok, token }).token).toMatch(/BotFather/);
    }
  });

  it('carries the verified chat id into a reconnect, never the token', () => {
    expect(g.prefill?.({ displayName: 'Acme News', externalId: '-1001234567890' })).toEqual({
      chat: '-1001234567890',
    });
  });
});

describe('discord', () => {
  const g = guide('discord');
  const url = `https://discord.com/api/webhooks/199737254929760256/${'t'.repeat(68)}`;

  it('accepts a webhook address on discord.com or discordapp.com', () => {
    expect(credentialProblems(g, { webhookUrl: url })).toEqual({});
    expect(
      credentialProblems(g, { webhookUrl: url.replace('discord.com', 'discordapp.com') }),
    ).toEqual({});
  });

  it.each([
    'https://evil.example/api/webhooks/199737254929760256/tttttttttttttttttttttttt',
    'https://discord.com.evil.example/api/webhooks/199737254929760256/tttttttttttttttttttttttt',
    'http://discord.com/api/webhooks/199737254929760256/tttttttttttttttttttttttt',
    'https://discord.com/channels/1/2',
    'https://hooks.slack.com/services/T0/B0/x',
  ])('refuses %s before it is sent anywhere', (webhookUrl) => {
    expect(credentialProblems(g, { webhookUrl }).webhookUrl).toMatch(/Copy Webhook URL/);
  });

  it('has nothing to carry into a reconnect: its one field is the secret', () => {
    expect(g.prefill).toBeUndefined();
  });
});

describe('slack', () => {
  const g = guide('slack');
  const ok = {
    webhookUrl: ['https://hooks.slack.com/services', 'T00000000', 'B00000000', 'X'.repeat(24)].join(
      '/',
    ),
    label: '#announcements',
  };

  it('accepts an incoming-webhook address and a channel label', () => {
    expect(credentialProblems(g, ok)).toEqual({});
  });

  it.each([
    'https://evil.example/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    'https://hooks.slack.com.evil.example/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    'https://hooks.slack.com/triggers/T00000000/123/XXXXXXXXXXXXXXXXXXXXXXXX',
    'https://acme.slack.com/archives/C123',
    'https://discord.com/api/webhooks/199737254929760256/tttttttttttttttttttttttt',
  ])('refuses %s before it is sent anywhere', (webhookUrl) => {
    expect(credentialProblems(g, { ...ok, webhookUrl }).webhookUrl).toMatch(/Incoming Webhooks/);
  });

  it('says before connecting that Slack gives back no link and no numbers', () => {
    expect(g.limits.join(' ')).toMatch(/no link to the message/);
  });

  it('carries the label, and only the label, into a reconnect', () => {
    expect(
      g.prefill?.({ displayName: '#announcements', externalId: 'T00000000/B00000000' }),
    ).toEqual({
      label: '#announcements',
    });
  });
});
