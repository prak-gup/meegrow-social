import type { ProviderIdentifier } from '@meegrow-social/contracts';
import type { SocialProvider } from './types.js';
import {
  FakeBetweenStepsProvider,
  FakeFailingAnalyticsProvider,
  FakeFailingRefreshProvider,
  FakeOneTimeProvider,
  FakeProvider,
  FakeTransientAnalyticsProvider,
  FakeTransientRefreshProvider,
} from './fake.js';
import { FacebookPagesProvider } from './meta/facebook.js';
import { InstagramProvider } from './meta/instagram.js';
import { GbpProvider } from './google/gbp.js';
import { YouTubeProvider } from './google/youtube.js';
import { WordPressProvider } from './wordpress/wordpress.js';
import { BlueskyProvider } from './bluesky/bluesky.js';
import { TelegramProvider } from './telegram/telegram.js';
import { DiscordProvider } from './discord/discord.js';
import { SlackProvider } from './slack/slack.js';

/**
 * Explicit registry (Postiz pattern — no decorator auto-discovery). Real providers get added to
 * this array as they land (M1: instagram, facebook; M2: gmb; M3: linkedin, x, youtube).
 */
const providers = new Map<ProviderIdentifier, SocialProvider>();

export function registerProvider(provider: SocialProvider): void {
  providers.set(provider.identifier, provider);
}

export function getProvider(identifier: ProviderIdentifier): SocialProvider {
  const p = providers.get(identifier);
  if (!p) throw new Error(`No provider registered for "${identifier}"`);
  return p;
}

/**
 * Non-throwing lookup. Used by create-time validation (#44), which must not start rejecting posts
 * for providers that simply aren't configured in this environment — CI and local dev run with only
 * the fakes registered, and a missing platform secret must not change what the API accepts.
 */
export function tryGetProvider(identifier: ProviderIdentifier): SocialProvider | undefined {
  return providers.get(identifier);
}

export function listProviders(): SocialProvider[] {
  return [...providers.values()];
}

/**
 * The `fake*` family (contracts/providers.ts) exists for tests and the no-secrets scaffold. The
 * fakes are registered in every environment, production included, so that a row naming one never
 * fails a `getProvider` lookup — which means "is it registered" cannot answer "is it real".
 */
export function isTestOnlyProvider(identifier: string): boolean {
  return identifier.startsWith('fake');
}

/**
 * May this provider — or a connection or post on it — be offered or counted? Test-only providers
 * are hidden in production (`NODE_ENV=production`, which the deployed image sets) unless
 * `SHOW_FAKE_PROVIDERS=true`; dev and CI keep them. The server-side twin of the dashboard's
 * `providerVisible` (`VITE_SHOW_FAKE_PROVIDERS`). Read per call, so it follows the environment.
 *
 * This governs what is advertised and aggregated, never what is stored or listed: a hidden
 * provider's connections and posts stay readable and deletable by id.
 */
export function providerVisible(identifier: string): boolean {
  if (!isTestOnlyProvider(identifier)) return true;
  return process.env.NODE_ENV !== 'production' || process.env.SHOW_FAKE_PROVIDERS === 'true';
}

/** The providers this environment offers for connecting (`GET /v1/providers`). */
export function listConnectableProviders(): SocialProvider[] {
  return listProviders().filter((p) => providerVisible(p.identifier));
}

// Scaffold defaults: fake providers (single-step + two-step + #12 health fixtures) are always
// available for tests.
registerProvider(new FakeProvider());
registerProvider(new FakeBetweenStepsProvider());
registerProvider(new FakeOneTimeProvider());
registerProvider(new FakeFailingRefreshProvider());
registerProvider(new FakeTransientRefreshProvider());
registerProvider(new FakeFailingAnalyticsProvider());
registerProvider(new FakeTransientAnalyticsProvider());

/**
 * Register the real, env-configured providers. A provider whose credentials are absent is simply
 * skipped, so CI and local dev run on the fakes without any platform secrets — only the deployed
 * box has them (see .env.production.example). Exported and called here at module load to mirror the
 * fakes above; re-callable from tests.
 */
export function registerConfiguredProviders(): void {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (appId && appSecret) {
    // One Meta app, two providers (#14 + #13) — instagram-via-page authorises through the same
    // Facebook Login config, so it needs no credentials of its own.
    const config = { appId, appSecret, loginConfigId: process.env.FACEBOOK_LOGIN_CONFIG_ID };
    registerProvider(new FacebookPagesProvider(config));
    registerProvider(new InstagramProvider(config));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    // GBP (#21). Built against Google's documented shapes only — the API sits at 0 QPM until the
    // access request clears (BUILD-SPEC-V2 §A1). It shares the OAuth client with YouTube, so the
    // credentials alone must not put a provider that cannot work yet in the connect list. Exact
    // opt-in, like SHOW_FAKE_PROVIDERS.
    if (process.env.GBP_ENABLED === 'true') {
      registerProvider(new GbpProvider({ clientId, clientSecret }));
    }

    // YouTube (#25) shares the OAuth client but not the switch. Exact opt-in as well.
    if (process.env.YOUTUBE_ENABLED === 'true') {
      const limit = Number(process.env.YOUTUBE_DAILY_UPLOAD_LIMIT);
      registerProvider(
        new YouTubeProvider(
          { clientId, clientSecret },
          Number.isInteger(limit) && limit > 0 ? { dailyUploadLimit: limit } : {},
        ),
      );
    }
  }

  // WordPress needs no credentials of ours at all — each site issues its own — so nothing but
  // this switch keeps it out of the connect list. Exact opt-in, off by default: it has never run
  // against a real site (docs/dev/research/wordpress.md has the bring-up checklist).
  if (process.env.WORDPRESS_ENABLED === 'true') {
    registerProvider(new WordPressProvider());
  }

  // The platforms connected with a pasted credential need nothing of ours either: each account
  // or channel brings its own token. One exact opt-in each, off by default — none has run against
  // the real service (docs/dev/research/quick-platforms.md has a bring-up checklist per platform).
  if (process.env.BLUESKY_ENABLED === 'true') registerProvider(new BlueskyProvider());
  if (process.env.TELEGRAM_ENABLED === 'true') registerProvider(new TelegramProvider());
  if (process.env.DISCORD_ENABLED === 'true') registerProvider(new DiscordProvider());
  if (process.env.SLACK_ENABLED === 'true') registerProvider(new SlackProvider());
}

registerConfiguredProviders();
