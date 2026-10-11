import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, withWorkspace, schema } from '@meegrow-social/db';
import {
  DiskStorageDriver,
  encryptToken,
  hashPassword,
  resetAttemptStore,
  setScheduler,
  setStorageDriver,
  type Scheduler,
} from '@meegrow-social/core';
import type { WeeklySlot } from '@meegrow-social/contracts';
import { sql } from 'drizzle-orm';

/**
 * Truncate every table — call in beforeEach for isolated integration tests. Also forgets the
 * login/password attempt counts: they are keyed on email and client address, which tests reuse, so
 * without this one test's wrong passwords would rate-limit the next.
 */
export async function resetDb(): Promise<void> {
  resetAttemptStore();
  const tables = [
    'oauth_flows',
    'sessions',
    'jobs_dlq',
    'event_logs',
    'metrics',
    'webhook_deliveries',
    'webhook_endpoints',
    'queues',
    'posts',
    'post_groups',
    'media',
    'connections',
    'api_keys',
    'memberships',
    'users',
    'workspaces',
  ];
  await db().execute(sql.raw(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE;`));
}

/**
 * Monotonic suffix source. `Math.floor(performance.now())` alone is millisecond-resolution, so two
 * createWorkspace() calls in the same millisecond produced the same slug and the second blew up on
 * `workspaces_slug_unique` — a latent flake for any test needing two workspaces (e.g. asserting RLS
 * isolation). A counter makes uniqueness independent of timer resolution.
 */
let wsCounter = 0;

export async function createWorkspace(name = 'Test WS'): Promise<string> {
  const slug = `${name.toLowerCase().replace(/\s+/g, '-')}-${Math.floor(performance.now())}-${++wsCounter}`;
  const [ws] = await db().insert(schema.workspaces).values({ name, slug }).returning();
  if (!ws) throw new Error('failed to create workspace');
  return ws.id;
}

/** Create a human user (issue #10) with an argon2id-hashed password. Returns id + the plaintext. */
export async function createUser(
  email = `user-${Math.floor(performance.now() * 1000)}@test.local`,
  password = 'password123',
  name = 'Test User',
): Promise<{ id: string; email: string; password: string }> {
  const [u] = await db()
    .insert(schema.users)
    .values({ email, passwordHash: await hashPassword(password), name })
    .returning();
  if (!u) throw new Error('failed to create user');
  return { id: u.id, email, password };
}

/** Link a user to a workspace with a role (owner | admin | member | viewer). */
export async function createMembership(
  userId: string,
  workspaceId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner',
): Promise<void> {
  await db().insert(schema.memberships).values({ userId, workspaceId, role });
}

export interface ConnectionOpts {
  expiresAt?: Date | null;
  refreshToken?: string | null;
  tokenModel?: 'auto-refresh' | 'refresh-cron' | 'one-time';
  needsReconnect?: boolean;
  externalId?: string;
  accessToken?: string;
}

export async function createConnection(
  workspaceId: string,
  provider = 'fake',
  displayName = 'Fake Account',
  opts: ConnectionOpts = {},
): Promise<string> {
  return withWorkspace(workspaceId, async (tx) => {
    const [conn] = await tx
      .insert(schema.connections)
      .values({
        workspaceId,
        provider,
        externalId: opts.externalId ?? 'ext-1',
        displayName,
        accessToken: encryptToken(opts.accessToken ?? 'secret-access-token'),
        refreshToken: opts.refreshToken ? encryptToken(opts.refreshToken) : null,
        tokenModel: opts.tokenModel ?? 'auto-refresh',
        expiresAt: opts.expiresAt ?? null,
        needsReconnect: opts.needsReconnect ?? false,
      })
      .returning();
    if (!conn) throw new Error('failed to create connection');
    return conn.id;
  });
}

/** Points the media storage driver at a fresh temp dir — disk-only, never touches AWS in tests. */
export function useTempDiskStorage(): { rootDir: string; publicBaseUrl: string } {
  const rootDir = mkdtempSync(join(tmpdir(), 'mgs-media-'));
  const publicBaseUrl = 'http://localhost:8990/media';
  setStorageDriver(new DiskStorageDriver({ rootDir, publicBaseUrl }));
  return { rootDir, publicBaseUrl };
}

export async function createQueue(
  workspaceId: string,
  opts: { name?: string; timezone?: string; slots?: WeeklySlot[]; active?: boolean } = {},
): Promise<string> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .insert(schema.queues)
      .values({
        workspaceId,
        name: opts.name ?? 'Test Queue',
        timezone: opts.timezone ?? 'Asia/Kolkata',
        slots: opts.slots ?? [{ dow: 1, time: '09:00' }],
        active: opts.active ?? true,
      })
      .returning();
    if (!row) throw new Error('failed to create queue');
    return row.id;
  });
}

/** A scheduler that records calls instead of enqueuing. */
export function useRecordingScheduler(): {
  calls: Array<{ postId: string; when: Date | 'now' }>;
  cancels: string[];
} {
  const calls: Array<{ postId: string; when: Date | 'now' }> = [];
  const cancels: string[] = [];
  const scheduler: Scheduler = {
    async schedulePublish({ postId, when }) {
      calls.push({ postId, when });
    },
    async cancelPublish({ postId }) {
      cancels.push(postId);
    },
  };
  setScheduler(scheduler);
  return { calls, cancels };
}
