import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import { createUser, createWorkspace, resetDb, useTestDatabaseEnv } from '@meegrow-social/testing';
import { signConnectFlow } from '../crypto.js';
import { finishInviteConnect, handleCallback, listConnections } from './connections.js';
import {
  createConnectInvite,
  getConnectInvite,
  listConnectInvites,
  revokeConnectInvite,
  startInviteConnect,
} from './invites.js';

/**
 * Per-platform connect invites (client onboarding). A minted invite is redeemable by its opaque
 * token — publicly, with no session — until it expires or is consumed.
 */

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const APP = 'http://localhost:8990';
const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

describe('connect invites', () => {
  it('mints a link redeemable by token, carrying workspace + provider', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Ecolive');

    const invite = await createConnectInvite(ws, 'fake', uid);
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(invite.provider).toBe('fake');

    const redeemed = await getConnectInvite(invite.token);
    expect(redeemed).not.toBeNull();
    expect(redeemed!.workspaceId).toBe(ws);
    expect(redeemed!.workspaceName).toBe('Ecolive');
    expect(redeemed!.provider).toBe('fake');
    expect(redeemed!.providerDisplayName).toBe('Fake Provider');
  });

  it('rejects an unknown token', async () => {
    expect(await getConnectInvite('nope-not-a-real-token')).toBeNull();
  });

  it('rejects a consumed invite', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Mlearn');
    const invite = await createConnectInvite(ws, 'fake', uid);

    await db()
      .update(schema.connectInvites)
      .set({ consumedAt: new Date() })
      .where(eq(schema.connectInvites.token, invite.token));

    expect(await getConnectInvite(invite.token)).toBeNull();
  });

  it('rejects an expired invite', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('GLs');
    const invite = await createConnectInvite(ws, 'fake', uid);

    await db()
      .update(schema.connectInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.connectInvites.token, invite.token));

    expect(await getConnectInvite(invite.token)).toBeNull();
  });

  it('refuses to mint for an unregistered provider', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('X');
    await expect(createConnectInvite(ws, 'gmb', uid)).rejects.toThrow();
  });

  it('rejects a cancelled invite', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Cancelled');
    const invite = await createConnectInvite(ws, 'fake', uid);
    const [listed] = await listConnectInvites(ws);

    expect(await revokeConnectInvite(ws, listed!.id)).toBe(true);
    expect(await getConnectInvite(invite.token)).toBeNull();
    expect(await startInviteConnect(invite.token, APP)).toBeNull();
    expect(await listConnectInvites(ws)).toEqual([]);
    // Already cancelled: nothing left to cancel.
    expect(await revokeConnectInvite(ws, listed!.id)).toBe(false);
  });

  it("cannot cancel another workspace's invite, even knowing its id", async () => {
    const { id: uid } = await createUser();
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const invite = await createConnectInvite(theirs, 'fake', uid);
    const [listed] = await listConnectInvites(theirs);

    expect(await revokeConnectInvite(mine, listed!.id)).toBe(false);
    expect(await getConnectInvite(invite.token)).not.toBeNull();
    expect(await listConnectInvites(mine)).toEqual([]);
  });

  it('lists only links that still work, newest first, with when each was last started', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Listed');
    const older = await createConnectInvite(ws, 'fake', uid);
    const newer = await createConnectInvite(ws, 'fake_2step', uid);
    const expired = await createConnectInvite(ws, 'fake', uid);
    await db()
      .update(schema.connectInvites)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.connectInvites.token, older.token));
    await db()
      .update(schema.connectInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.connectInvites.token, expired.token));
    await startInviteConnect(newer.token, APP);

    const listed = await listConnectInvites(ws);
    expect(listed.map((i) => i.token)).toEqual([newer.token, older.token]);
    expect(listed[0]).toMatchObject({ provider: 'fake_2step' });
    expect(listed[0]!.lastStartedAt).toBeInstanceOf(Date);
    expect(listed[1]!.lastStartedAt).toBeNull();
  });

  it('is used up by the first successful connection, not by a start or an abandoned pick', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Consumed');
    const invite = await createConnectInvite(ws, 'fake_2step', uid);

    const abandoned = await startInviteConnect(invite.token, APP);
    await handleCallback(abandoned!.flowId, 'auth-code', abandoned!.proof);
    expect(await getConnectInvite(invite.token)).not.toBeNull();

    const started = await startInviteConnect(invite.token, APP);
    await handleCallback(started!.flowId, 'auth-code', started!.proof);
    const done = await finishInviteConnect(started!.flowId, started!.proof, 'page-1');
    expect(done.status).toBe('connected');

    expect(await getConnectInvite(invite.token)).toBeNull();
    expect(await listConnectInvites(ws)).toEqual([]);
    // The pick that was left open on the same link is closed with it.
    expect(await finishInviteConnect(abandoned!.flowId, abandoned!.proof, 'page-2')).toEqual({
      status: 'used',
    });
    expect(await listConnections(ws)).toHaveLength(1);
  });

  it('refuses an invite-started callback without the starting browser’s proof', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Forwarded');
    const invite = await createConnectInvite(ws, 'fake', uid);
    const started = await startInviteConnect(invite.token, APP);

    await expect(handleCallback(started!.flowId, 'auth-code')).rejects.toThrow(/different browser/);
    await expect(
      handleCallback(started!.flowId, 'auth-code', signConnectFlow(NONEXISTENT)),
    ).rejects.toThrow();
    // Burned: the real proof arriving afterwards (a replayed redirect) connects nothing either.
    await expect(handleCallback(started!.flowId, 'auth-code', started!.proof)).rejects.toThrow();
    expect(await listConnections(ws)).toHaveLength(0);
    // Nothing connected, so the link survives for an honest retry.
    expect(await getConnectInvite(invite.token)).not.toBeNull();
  });
});
