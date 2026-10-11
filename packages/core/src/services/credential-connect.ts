import { schema, withWorkspace } from '@meegrow-social/db';
import { and, eq } from 'drizzle-orm';
import type { ConnectCredentialsResult, ProviderIdentifier } from '@meegrow-social/contracts';
import { encryptToken } from '../crypto.js';
import { ProviderAuthError, ProviderBadRequestError } from '../errors.js';
import { tryGetProvider } from '../providers/registry.js';
import { CredentialFormatError } from '../providers/shared/http.js';
import { beginAuthAttempt } from './auth-throttle.js';
import { initialImportState } from './post-import.js';

/**
 * Connecting a platform that hands people a credential to paste instead of a login to approve
 * (`connectInput: 'credentials'` — a Bluesky app password, a Telegram bot token, a Discord or
 * Slack webhook address). One request does it all: verify the credential against the platform,
 * then store it. There is no flow row, no redirect and no callback.
 *
 * The credential arrives in the body of a session- or key-authenticated POST over this app's own
 * HTTPS, is handed to the provider, and is stored encrypted as the connection's access token
 * (`encryptToken`, like every other token). It is never returned, logged or put in an error.
 *
 * Every attempt is counted (`beginAuthAttempt`, scope `connect`) per client address and per
 * workspace + platform BEFORE the platform is asked: this endpoint makes our server present a
 * token to somebody else's API, and without a limit it is a free oracle for guessing them.
 */
export type CredentialConnectResult =
  | ({ ok: true } & ConnectCredentialsResult)
  | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number };

/**
 * Throws `ProviderBadRequestError` (input a person can correct, or a platform that said no for a
 * stated reason), `ProviderAuthError` (the platform refused the credential) or
 * `ProviderTransientError` (the platform could not be reached). Nothing is stored unless the
 * provider returned.
 *
 * A second connect to the same account of the same platform in this workspace replaces the stored
 * credential on the EXISTING connection and clears its needs-reconnect flag, so "Reconnect" keeps
 * the connection's scheduled posts and history instead of starting a new, empty one.
 */
export async function connectWithCredentials(
  workspaceId: string,
  provider: ProviderIdentifier,
  fields: Readonly<Record<string, string>>,
  clientIp: string,
): Promise<CredentialConnectResult> {
  const impl = tryGetProvider(provider);
  if (!impl?.connectWithCredentials) {
    throw new ProviderBadRequestError(`"${provider}" does not connect with a pasted credential`);
  }

  const gate = await beginAuthAttempt('connect', {
    ip: clientIp,
    account: `${workspaceId}:${provider}`,
  });
  if (!gate.allowed) {
    return { ok: false, reason: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds };
  }

  let tokens: Awaited<ReturnType<NonNullable<typeof impl.connectWithCredentials>>>;
  try {
    tokens = await impl.connectWithCredentials(fields);
  } catch (err) {
    // Only an answer from the platform about THIS credential is a guess. A typo caught here, or
    // a platform that could not be reached, must not use up anybody's attempts.
    const guess =
      err instanceof ProviderAuthError ||
      (err instanceof ProviderBadRequestError && !(err instanceof CredentialFormatError));
    await gate.settle(guess ? 'failed' : 'not_a_guess');
    throw err;
  }

  let stored: { connectionId: string; reconnected: boolean };
  try {
    stored = await withWorkspace(workspaceId, async (tx) => {
      const accessToken = encryptToken(tokens.accessToken);
      const [existing] = await tx
        .select({ id: schema.connections.id })
        .from(schema.connections)
        .where(
          and(
            eq(schema.connections.provider, provider),
            eq(schema.connections.externalId, tokens.externalId),
          ),
        )
        .limit(1)
        .for('update');
      if (existing) {
        await tx
          .update(schema.connections)
          .set({
            accessToken,
            refreshToken: null,
            displayName: tokens.displayName,
            tokenModel: impl.tokenModel,
            expiresAt: tokens.expiresAt ?? null,
            needsReconnect: false,
          })
          .where(eq(schema.connections.id, existing.id));
        return { connectionId: existing.id, reconnected: true };
      }
      const [created] = await tx
        .insert(schema.connections)
        .values({
          workspaceId,
          provider,
          externalId: tokens.externalId,
          displayName: tokens.displayName,
          accessToken,
          refreshToken: null,
          tokenModel: impl.tokenModel,
          expiresAt: tokens.expiresAt ?? null,
          importState: initialImportState(provider, new Date()),
        })
        .returning({ id: schema.connections.id });
      if (!created) throw new Error('failed to create connection');
      return { connectionId: created.id, reconnected: false };
    });
  } catch (err) {
    await gate.settle('not_a_guess');
    throw err;
  }
  await gate.settle('succeeded');
  return { ok: true, ...stored, displayName: tokens.displayName };
}
