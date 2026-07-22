import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import { createUser, createWorkspace, resetDb } from '@meegrow-social/testing';
import { createConnectInvite, getConnectInvite } from './invites.js';

/**
 * Per-platform connect invites (client onboarding). A minted invite is redeemable by its opaque
 * token — publicly, with no session — until it expires or is consumed.
 */

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://prakhar@localhost:5432/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

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
});
