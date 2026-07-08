import { db, schema, withWorkspace } from '@meegrow-social/db';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { ProviderIdentifier } from '@meegrow-social/contracts';
import { getProvider } from '../providers/registry.js';
import { ProviderAuthError } from '../errors.js';
import { decryptToken, encryptToken } from '../crypto.js';
import { EXPIRING_WINDOW_MS } from './connections.js';
import { CONNECTION_NEEDS_RECONNECT_EVENT, enqueueDeliveriesInTx } from './webhooks.js';

/** Token models that the sweeper is allowed to refresh. `one-time` is deliberately excluded. */
const REFRESHABLE_MODELS = ['auto-refresh', 'refresh-cron'] as const;

export interface SweepResult {
  refreshed: number;
  flagged: number;
}

/**
 * Refresh expiring tokens across every workspace (PRD F1.3). THIN-ish orchestrator: it enumerates
 * workspaces on the admin handle (the `workspaces` table is non-tenant) and delegates the per-tenant
 * refresh to {@link refreshExpiringTokensForWorkspace} under `withWorkspace` so RLS isolates each.
 * Idempotent under concurrent runs via optimistic concurrency (see the per-connection CAS below).
 */
export async function refreshExpiringTokens(): Promise<SweepResult> {
  const workspaces = await db().select({ id: schema.workspaces.id }).from(schema.workspaces);
  let refreshed = 0;
  let flagged = 0;
  for (const ws of workspaces) {
    const r = await refreshExpiringTokensForWorkspace(ws.id);
    refreshed += r.refreshed;
    flagged += r.flagged;
  }
  return { refreshed, flagged };
}

/**
 * Sweeps one workspace. A connection is a candidate when its token is refreshable, not already
 * flagged, has a refresh token + an expiry within the refresh window (i.e. health === 'expiring').
 * On a refresh failure the connection is marked needs_reconnect and the
 * `connection.needs_reconnect` webhook event is enqueued atomically.
 */
export async function refreshExpiringTokensForWorkspace(workspaceId: string): Promise<SweepResult> {
  const threshold = new Date(Date.now() + EXPIRING_WINDOW_MS);
  return withWorkspace(workspaceId, async (tx) => {
    const candidates = await tx
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.needsReconnect, false),
          isNotNull(schema.connections.refreshToken),
          isNotNull(schema.connections.expiresAt),
          inArray(schema.connections.tokenModel, [...REFRESHABLE_MODELS]),
          lt(schema.connections.expiresAt, threshold),
        ),
      );

    let refreshed = 0;
    let flagged = 0;
    for (const conn of candidates) {
      // NOTE: the provider refresh runs inside the tenant tx. Fine for the instant FakeProvider; real
      // providers (M1+) may need this moved out of the tx with optimistic CAS on a version column.
      const provider = getProvider(conn.provider as ProviderIdentifier);
      try {
        const fresh = await provider.refreshToken(decryptToken(conn.refreshToken!));
        // Optimistic concurrency: only persist if the row's expiry hasn't changed since we read it —
        // a concurrent sweep that already refreshed it loses the CAS (0 rows) instead of double-writing.
        const updated = await tx
          .update(schema.connections)
          .set({
            accessToken: encryptToken(fresh.accessToken),
            refreshToken: fresh.refreshToken ? encryptToken(fresh.refreshToken) : conn.refreshToken,
            expiresAt: fresh.expiresAt ?? null,
            needsReconnect: false,
          })
          .where(
            and(
              eq(schema.connections.id, conn.id),
              // The candidate filter guarantees expiresAt is non-null at read time.
              eq(schema.connections.expiresAt, conn.expiresAt!),
            ),
          )
          .returning({ id: schema.connections.id });
        if (updated.length > 0) refreshed += 1;
      } catch (err) {
        if (err instanceof ProviderAuthError) {
          await tx
            .update(schema.connections)
            .set({ needsReconnect: true })
            .where(eq(schema.connections.id, conn.id));
          // Atomic with the flag flip — the outbox row + the state change commit together.
          await enqueueDeliveriesInTx(tx, workspaceId, CONNECTION_NEEDS_RECONNECT_EVENT, {
            connectionId: conn.id,
            provider: conn.provider,
            externalId: conn.externalId,
          });
          flagged += 1;
        } else {
          // Transient / unexpected: log, do NOT flag (so the next sweep retries), do NOT throw.
          await tx.insert(schema.eventLogs).values({
            workspaceId,
            kind: 'connection',
            platform: conn.provider,
            account: conn.externalId,
            message: `token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
    return { refreshed, flagged };
  });
}
