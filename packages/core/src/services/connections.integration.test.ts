import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@meegrow-social/db';
import { createWorkspace, resetDb } from '@meegrow-social/testing';
import {
  deleteConnection,
  finishConnect,
  handleCallback,
  listConnections,
  startConnect,
} from './connections.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://prakhar@localhost:5432/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const APP = 'http://localhost:8990';
const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

describe('OAuth connect flow', () => {
  it('single-step provider connects directly on callback', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake', APP);
    const result = await handleCallback(flowId, 'auth-code');
    expect(result.status).toBe('connected');

    const conns = await listConnections(ws);
    expect(conns).toHaveLength(1);
    expect(conns[0]?.displayName).toBe('Fake Account');
    expect(conns[0]?.health).toBe('healthy');
  });

  it('two-step provider requires an account pick, then finishes', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake_2step', APP);
    const result = await handleCallback(flowId, 'auth-code');
    expect(result.status).toBe('choose_account');
    if (result.status !== 'choose_account') throw new Error('unreachable');
    expect(result.accounts.map((a) => a.externalId)).toEqual(['page-1', 'page-2']);

    await finishConnect(ws, flowId, 'page-2');
    const conns = await listConnections(ws);
    expect(conns).toHaveLength(1);
    expect(conns[0]?.displayName).toBe('Page Two');
    expect(conns[0]?.externalId).toBe('page-2');
  });

  it('rejects an unknown/tampered state', async () => {
    await expect(handleCallback(NONEXISTENT, 'auth-code')).rejects.toThrow();
  });

  it('rejects replay of a consumed flow', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake', APP);
    await handleCallback(flowId, 'auth-code'); // consumes it
    await expect(handleCallback(flowId, 'auth-code')).rejects.toThrow();
  });

  it('rejects finishing an account pick for the wrong workspace', async () => {
    const wsA = await createWorkspace('A');
    const wsB = await createWorkspace('B');
    const { flowId } = await startConnect(wsA, 'fake_2step', APP);
    await handleCallback(flowId, 'auth-code');
    await expect(finishConnect(wsB, flowId, 'page-1')).rejects.toThrow();
  });

  it('rejects an account not in the offered list', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake_2step', APP);
    await handleCallback(flowId, 'auth-code');
    await expect(finishConnect(ws, flowId, 'page-999')).rejects.toThrow();
  });

  it('disconnect removes the connection', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake', APP);
    const result = await handleCallback(flowId, 'auth-code');
    if (result.status !== 'connected') throw new Error('unreachable');
    expect(await deleteConnection(ws, result.connectionId)).toBe(true);
    expect(await listConnections(ws)).toHaveLength(0);
  });
});
