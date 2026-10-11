import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@meegrow-social/db';
import type * as DbModule from '@meegrow-social/db';
import { hashPassword, verifyPassword } from './password.js';
import { changePassword } from './users.js';

/**
 * `changePassword` against a stand-in for the admin db handle (no Postgres in unit tests). The fake
 * records writes per table and only "commits" them when the transaction callback returns, so these
 * tests can assert what a failed change leaves behind. It does not evaluate WHERE clauses — which
 * rows a predicate hits is covered by apps/api/src/password.integration.test.ts.
 */
interface Write {
  op: 'update' | 'delete';
  table: unknown;
  values?: Record<string, unknown>;
}

const state = {
  userRow: undefined as { passwordHash: string | null } | undefined,
  /** Rows the `users` compare-and-swap UPDATE reports. Empty = someone changed the hash first. */
  userUpdateRows: [{ id: 'user-1' }] as Array<{ id: string }>,
  /** Rows the current-session rotate UPDATE reports. Empty = the session is gone. */
  sessionUpdateRows: [{ expiresAt: new Date('2026-11-01T00:00:00.000Z') }] as Array<{
    expiresAt: Date;
  }>,
  committed: [] as Write[],
  rolledBack: 0,
};

function fakeTx(pending: Write[]) {
  return {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            pending.push({ op: 'update', table, values });
            return table === schema.users ? state.userUpdateRows : state.sessionUpdateRows;
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        pending.push({ op: 'delete', table });
      },
    }),
  };
}

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => (state.userRow ? [state.userRow] : []) }),
    }),
  }),
  transaction: async <T>(fn: (tx: ReturnType<typeof fakeTx>) => Promise<T>): Promise<T> => {
    const pending: Write[] = [];
    try {
      const out = await fn(fakeTx(pending));
      state.committed.push(...pending);
      return out;
    } catch (err) {
      state.rolledBack += 1;
      throw err;
    }
  },
};

vi.mock('@meegrow-social/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  db: () => fakeDb,
}));

const CURRENT = 'current-password-1';
const NEXT = 'a-brand-new-password';

beforeEach(async () => {
  state.userRow = { passwordHash: await hashPassword(CURRENT) };
  state.userUpdateRows = [{ id: 'user-1' }];
  state.sessionUpdateRows = [{ expiresAt: new Date('2026-11-01T00:00:00.000Z') }];
  state.committed = [];
  state.rolledBack = 0;
});

const change = (current = CURRENT, next = NEXT) =>
  changePassword('user-1', 'sess-1', current, next);

describe('changePassword', () => {
  it('stores an argon2id hash of the new password, revokes other sessions and rotates this one', async () => {
    const res = await change();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // One transaction: users UPDATE, sessions DELETE (the others), sessions UPDATE (rotate).
    expect(state.committed.map((w) => [w.op, w.table])).toEqual([
      ['update', schema.users],
      ['delete', schema.sessions],
      ['update', schema.sessions],
    ]);

    const stored = state.committed[0]!.values!.passwordHash as string;
    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(stored).not.toContain(NEXT);
    expect(await verifyPassword(stored, NEXT)).toBe(true);
    expect(await verifyPassword(stored, CURRENT)).toBe(false);

    // The cookie token is returned once; only its sha-256 is written.
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(state.committed[2]!.values).toEqual({
      tokenHash: createHash('sha256').update(res.token).digest('hex'),
    });
    expect(res.expiresAt).toEqual(new Date('2026-11-01T00:00:00.000Z'));
  });

  it('rejects a wrong current password and writes nothing', async () => {
    expect(await change('not-my-password')).toEqual({
      ok: false,
      reason: 'invalid_current_password',
    });
    expect(state.committed).toEqual([]);
    expect(state.rolledBack).toBe(0); // never even opened a transaction
  });

  it('treats an unknown user or a user with no password as a wrong current password', async () => {
    state.userRow = undefined;
    expect(await change()).toEqual({ ok: false, reason: 'invalid_current_password' });
    state.userRow = { passwordHash: null };
    expect(await change()).toEqual({ ok: false, reason: 'invalid_current_password' });
    expect(state.committed).toEqual([]);
  });

  it('enforces the length policy itself, whatever the caller validated', async () => {
    expect(await change(CURRENT, 'short')).toEqual({ ok: false, reason: 'invalid_new_password' });
    expect(await change(CURRENT, 'x'.repeat(129))).toEqual({
      ok: false,
      reason: 'invalid_new_password',
    });
    expect(state.committed).toEqual([]);
  });

  it('refuses a new password equal to the current one', async () => {
    expect(await change(CURRENT, CURRENT)).toEqual({ ok: false, reason: 'same_password' });
    expect(state.committed).toEqual([]);
  });

  it('does not reveal "same password" to a caller who has not proven the current one', async () => {
    const guess = 'a-guess-at-the-pass';
    expect(await change(guess, guess)).toEqual({ ok: false, reason: 'invalid_current_password' });
  });

  it('rolls back when the hash changed underneath it (concurrent change)', async () => {
    state.userUpdateRows = [];
    expect(await change()).toEqual({ ok: false, reason: 'invalid_current_password' });
    expect(state.rolledBack).toBe(1);
    expect(state.committed).toEqual([]);
  });

  it('rolls the password change back when the current session has gone', async () => {
    state.sessionUpdateRows = [];
    expect(await change()).toEqual({ ok: false, reason: 'session_not_found' });
    expect(state.rolledBack).toBe(1);
    expect(state.committed).toEqual([]);
  });

  it('lets an unexpected database error surface instead of reporting a failure reason', async () => {
    const boom = new Error('connection lost');
    const original = fakeDb.transaction;
    fakeDb.transaction = async () => {
      throw boom;
    };
    try {
      await expect(change()).rejects.toBe(boom);
    } finally {
      fakeDb.transaction = original;
    }
  });
});
