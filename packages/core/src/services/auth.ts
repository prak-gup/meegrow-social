import { db, schema } from '@meegrow-social/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { ApiKeyView, CreatedApiKeyView } from '@meegrow-social/contracts';
import { requireWorkspaceRole } from './access.js';
import { generateApiKey, hashKey } from './apikeys.js';

/**
 * How stale `lastUsedAt` may get before we write it again (#8). Every authenticated request would
 * otherwise hammer the same row — the value only needs to answer "is this key still in use?", so a
 * minute's granularity is plenty and keeps the hot path off a write.
 */
const LAST_USED_THROTTLE_MS = 60_000;

export interface AuthContext {
  workspaceId: string;
  /** Present when authed via API key (`sk_live_…`). */
  apiKeyId?: string;
  /** Present when authed via a login session cookie (#10). */
  userId?: string;
  sessionId?: string;
  role?: string;
}

/** Resolve a raw `sk_live_…` key to its workspace. Returns null if unknown/revoked/expired. */
export async function authenticateApiKey(fullKey: string): Promise<AuthContext | null> {
  const [row] = await db()
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.hash, hashKey(fullKey)), isNull(schema.apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  // Throttled last-used stamp (#8). Awaited rather than fire-and-forget: it runs at most once a
  // minute per key, and an unawaited write here would be an unhandled rejection waiting to happen.
  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
    await db()
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(schema.apiKeys.id, row.id));
  }

  return { workspaceId: row.workspaceId, apiKeyId: row.id };
}

/**
 * Keys for one workspace, oldest first. Never selects `hash` — the projection is the guard: a
 * `select()` here would put the hash one careless `return` away from the wire.
 *
 * SECURITY: `api_keys` is deliberately NOT in TENANT_TABLES (the auth layer reads it before any
 * tenant context exists), so **RLS does not scope this** — the `workspaceId` predicate is the only
 * thing standing between workspaces. Same for `revokeApiKey`.
 */
export async function listApiKeys(workspaceId: string): Promise<ApiKeyView[]> {
  const rows = await db()
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      prefix: schema.apiKeys.prefix,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      expiresAt: schema.apiKeys.expiresAt,
      revokedAt: schema.apiKeys.revokedAt,
      createdAt: schema.apiKeys.createdAt,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.workspaceId, workspaceId))
    .orderBy(asc(schema.apiKeys.createdAt));
  return rows;
}

/**
 * Revoke a key. Idempotent-ish: revoking an already-revoked key is a no-op that still reports true,
 * so a retried call doesn't look like a failure. Returns false only when the key isn't this
 * workspace's — a cross-workspace attempt is indistinguishable from "not found", by design.
 */
export async function revokeApiKey(workspaceId: string, id: string): Promise<boolean> {
  const revoked = await db()
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.apiKeys.id, id),
        eq(schema.apiKeys.workspaceId, workspaceId), // NOT covered by RLS — see listApiKeys
        isNull(schema.apiKeys.revokedAt),
      ),
    )
    .returning({ id: schema.apiKeys.id });
  if (revoked.length > 0) return true;

  // Already revoked? Then the caller's intent is satisfied. Anything else is a genuine 404.
  const [existing] = await db()
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.workspaceId, workspaceId)))
    .limit(1);
  return Boolean(existing);
}

/**
 * Issue a new key for a workspace. The returned `secret` is the ONLY time it exists outside the
 * caller — only its sha-256 is stored, so it cannot be re-shown. A lost key is revoked + reissued.
 */
export async function createApiKeyForWorkspace(
  workspaceId: string,
  name: string,
): Promise<CreatedApiKeyView> {
  const key = generateApiKey();
  const [row] = await db()
    .insert(schema.apiKeys)
    .values({ workspaceId, name, prefix: key.prefix, hash: key.hash })
    .returning();
  if (!row) throw new Error('failed to create api key');
  return { id: row.id, name: row.name, secret: key.secret, prefix: key.prefix };
}

/** Session-authorized key management; low-level functions above are for trusted provisioning. */
export async function manageWorkspaceApiKeys(
  ctx: AuthContext,
  action: 'list' | 'create' | 'revoke',
  value?: string,
) {
  await requireWorkspaceRole(ctx, ctx.workspaceId, ['owner', 'admin']);
  if (action === 'create') return createApiKeyForWorkspace(ctx.workspaceId, value!);
  if (action === 'revoke') return revokeApiKey(ctx.workspaceId, value!);
  return listApiKeys(ctx.workspaceId);
}
