import { db, schema } from '@meegrow-social/db';
import { and, eq, isNull } from 'drizzle-orm';
import { generateApiKey, hashKey } from './apikeys.js';

export interface AuthContext {
  workspaceId: string;
  apiKeyId: string;
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
  return { workspaceId: row.workspaceId, apiKeyId: row.id };
}

/** Issue a new key for a workspace. Returns the one-time secret. */
export async function createApiKeyForWorkspace(
  workspaceId: string,
  name: string,
): Promise<{ id: string; secret: string; prefix: string }> {
  const key = generateApiKey();
  const [row] = await db()
    .insert(schema.apiKeys)
    .values({ workspaceId, name, prefix: key.prefix, hash: key.hash })
    .returning();
  if (!row) throw new Error('failed to create api key');
  return { id: row.id, secret: key.secret, prefix: key.prefix };
}
