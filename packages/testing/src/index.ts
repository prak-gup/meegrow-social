import { db, withWorkspace, schema } from '@meegrow-social/db';
import { encryptToken, setScheduler, type Scheduler } from '@meegrow-social/core';
import { sql } from 'drizzle-orm';

/** Truncate every table — call in beforeEach for isolated integration tests. */
export async function resetDb(): Promise<void> {
  const tables = [
    'oauth_flows',
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

export async function createWorkspace(name = 'Test WS'): Promise<string> {
  const slug = `${name.toLowerCase().replace(/\s+/g, '-')}-${Math.floor(performance.now())}`;
  const [ws] = await db().insert(schema.workspaces).values({ name, slug }).returning();
  if (!ws) throw new Error('failed to create workspace');
  return ws.id;
}

export async function createConnection(
  workspaceId: string,
  provider = 'fake',
  displayName = 'Fake Account',
): Promise<string> {
  return withWorkspace(workspaceId, async (tx) => {
    const [conn] = await tx
      .insert(schema.connections)
      .values({
        workspaceId,
        provider,
        externalId: 'ext-1',
        displayName,
        accessToken: encryptToken('secret-access-token'),
        tokenModel: 'auto-refresh',
      })
      .returning();
    if (!conn) throw new Error('failed to create connection');
    return conn.id;
  });
}

/** A scheduler that records calls instead of enqueuing. */
export function useRecordingScheduler(): { calls: Array<{ postId: string; when: Date | 'now' }> } {
  const calls: Array<{ postId: string; when: Date | 'now' }> = [];
  const scheduler: Scheduler = {
    async schedulePublish({ postId, when }) {
      calls.push({ postId, when });
    },
  };
  setScheduler(scheduler);
  return { calls };
}
