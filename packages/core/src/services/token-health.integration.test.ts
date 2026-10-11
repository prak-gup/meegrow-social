import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { decryptToken } from '../crypto.js';
import { refreshExpiringTokens } from './token-health.js';
import { CONNECTION_NEEDS_RECONNECT_EVENT } from './webhooks.js';

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const soon = (ms: number) => new Date(Date.now() + ms);

type ConnectionRow = {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  needsReconnect: boolean;
};

async function getConnection(wsId: string, connId: string): Promise<ConnectionRow> {
  return withWorkspace(wsId, async (tx) => {
    const [row] = await tx
      .select({
        id: schema.connections.id,
        accessToken: schema.connections.accessToken,
        refreshToken: schema.connections.refreshToken,
        expiresAt: schema.connections.expiresAt,
        needsReconnect: schema.connections.needsReconnect,
      })
      .from(schema.connections)
      .where(eq(schema.connections.id, connId));
    return row as ConnectionRow;
  });
}

async function createWebhookEndpoint(wsId: string, events: string[]): Promise<string> {
  return withWorkspace(wsId, async (tx) => {
    const [e] = await tx
      .insert(schema.webhookEndpoints)
      .values({
        workspaceId: wsId,
        url: 'https://example.local/hook',
        secret: 'whsec-test',
        events,
      })
      .returning({ id: schema.webhookEndpoints.id });
    if (!e) throw new Error('failed to create webhook endpoint');
    return e.id;
  });
}

async function deliveries(wsId: string, eventType: string) {
  return withWorkspace(wsId, async (tx) =>
    tx
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.eventType, eventType)),
  );
}

async function connectionEventLogs(wsId: string) {
  return withWorkspace(wsId, async (tx) =>
    tx.select().from(schema.eventLogs).where(eq(schema.eventLogs.kind, 'connection')),
  );
}

describe('token-health sweeper', () => {
  it('refreshes an expiring refreshable token, persists the new encrypted token + expiry, and is idempotent', async () => {
    const ws = await createWorkspace();
    const connId = await createConnection(ws, 'fake', 'Fake', {
      refreshToken: 'initial-refresh',
      expiresAt: soon(HOUR), // within the 7d refresh window → candidate
    });

    const before = await getConnection(ws, connId);
    expect(before.needsReconnect).toBe(false);

    const r1 = await refreshExpiringTokens();
    expect(r1).toEqual({ refreshed: 1, flagged: 0 });

    const after = await getConnection(ws, connId);
    expect(decryptToken(after.accessToken!)).toBe('fake-token-refreshed');
    expect(decryptToken(after.refreshToken!)).toBe('fake-refresh');
    expect(after.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * DAY); // beyond window now
    expect(after.needsReconnect).toBe(false);

    // Idempotent: the refreshed expiry is beyond the window, so the next sweep finds no candidate.
    const r2 = await refreshExpiringTokens();
    expect(r2).toEqual({ refreshed: 0, flagged: 0 });
  });

  it('flags needs_reconnect + enqueues connection.needs_reconnect delivery on an auth refresh failure', async () => {
    const ws = await createWorkspace();
    await createWebhookEndpoint(ws, [CONNECTION_NEEDS_RECONNECT_EVENT]);
    const connId = await createConnection(ws, 'fake_fail_refresh', 'Failing', {
      refreshToken: 'some-refresh',
      expiresAt: soon(HOUR),
    });

    const r = await refreshExpiringTokens();
    expect(r).toEqual({ refreshed: 0, flagged: 1 });

    const after = await getConnection(ws, connId);
    expect(after.needsReconnect).toBe(true);

    const dels = await deliveries(ws, CONNECTION_NEEDS_RECONNECT_EVENT);
    expect(dels).toHaveLength(1);
    expect(dels[0]?.status).toBe('pending');
    expect(dels[0]?.payload).toMatchObject({ connectionId: connId, provider: 'fake_fail_refresh' });
  });

  it('still flags needs_reconnect when no endpoint is subscribed (delivery simply has nowhere to go)', async () => {
    const ws = await createWorkspace(); // no webhook endpoint
    const connId = await createConnection(ws, 'fake_fail_refresh', 'Failing', {
      refreshToken: 'some-refresh',
      expiresAt: soon(HOUR),
    });

    const r = await refreshExpiringTokens();
    expect(r.flagged).toBe(1);
    expect(await getConnection(ws, connId)).toMatchObject({ needsReconnect: true });
    expect(await deliveries(ws, CONNECTION_NEEDS_RECONNECT_EVENT)).toHaveLength(0);
  });

  it('never refreshes a one-time token, even when its health is expiring', async () => {
    const ws = await createWorkspace();
    const connId = await createConnection(ws, 'fake_onetime', 'OneTime', {
      tokenModel: 'one-time',
      refreshToken: 'one-time-rt',
      expiresAt: soon(10 * DAY), // within the 14d one-time window → 'expiring', but not refreshable
    });
    const before = await getConnection(ws, connId);

    const r = await refreshExpiringTokens();
    expect(r).toEqual({ refreshed: 0, flagged: 0 });

    const after = await getConnection(ws, connId);
    expect(after.accessToken).toBe(before.accessToken);
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.needsReconnect).toBe(false);
  });

  it('logs (but does NOT flag) a non-auth refresh failure so the next sweep retries', async () => {
    const ws = await createWorkspace();
    const connId = await createConnection(ws, 'fake_transient_refresh', 'Transient', {
      refreshToken: 'some-refresh',
      expiresAt: soon(HOUR),
    });

    const r = await refreshExpiringTokens();
    expect(r).toEqual({ refreshed: 0, flagged: 0 });

    const after = await getConnection(ws, connId);
    expect(after.needsReconnect).toBe(false); // transient must not permanently flag

    const logs = await connectionEventLogs(ws);
    expect(logs.some((l) => /token refresh failed/.test(l.message ?? ''))).toBe(true);
  });

  it('refreshes each workspace independently and never leaks across tenants', async () => {
    const wsA = await createWorkspace('A');
    const wsB = await createWorkspace('B');
    const cA = await createConnection(wsA, 'fake', 'A', {
      refreshToken: 'a-rt',
      expiresAt: soon(HOUR),
    });
    const cB = await createConnection(wsB, 'fake', 'B', {
      refreshToken: 'b-rt',
      expiresAt: soon(HOUR),
    });

    const r = await refreshExpiringTokens();
    expect(r.refreshed).toBe(2);

    const aA = await getConnection(wsA, cA);
    const aB = await getConnection(wsB, cB);
    expect(decryptToken(aA.accessToken!)).toBe('fake-token-refreshed');
    expect(decryptToken(aB.accessToken!)).toBe('fake-token-refreshed');

    // RLS: wsB's connection is invisible from wsA's tenant context.
    const cross = await withWorkspace(wsA, async (tx) =>
      tx.select().from(schema.connections).where(eq(schema.connections.id, cB)),
    );
    expect(cross).toHaveLength(0);
  });
});
