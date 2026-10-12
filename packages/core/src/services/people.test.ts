import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { schema } from '@meegrow-social/db';
import type * as DbModule from '@meegrow-social/db';
import {
  addClientPerson,
  listClientPeople,
  PersonExistsError,
  removeClientPerson,
} from './people.js';
import { AccessDeniedError, requireWorkspaceCreator, requireWorkspaceRole } from './access.js';
import { verifyPassword } from './password.js';
import { AUTH_ATTEMPT_LIMITS, resetAttemptStore } from './auth-throttle.js';
import { manageWorkspaceApiKeys } from './auth.js';
import { createClientWorkspace } from './overview.js';

// Queries keep their real SQL predicates; this double cannot open a database connection.
const state = {
  role: 'owner',
  existing: false,
  removed: true,
  failMembership: false,
  committed: [] as Array<{ table: unknown; values?: Record<string, unknown>; params?: unknown[] }>,
};
const predicates: Array<{ table: unknown; text: string; params: unknown[] }> = [];
const dialect = new PgDialect();
function condition(table: unknown, where: SQL) {
  const query = dialect.sqlToQuery(where);
  predicates.push({ table, text: query.sql, params: query.params });
  return query.params;
}
function query(table: unknown) {
  let params: unknown[] = [];
  const rows = () =>
    table === schema.memberships
      ? params.includes('workspace-b') || (params.includes('owner') && state.role !== 'owner')
        ? []
        : [{ id: 'membership', role: state.role }]
      : table === schema.users && state.existing
        ? [{ id: 'existing-user' }]
        : [];
  const q = {
    where: (where: SQL) => {
      params = condition(table, where);
      return q;
    },
    limit: async () => rows(),
    innerJoin: () => q,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
  };
  return q;
}
function handle(pending: typeof state.committed) {
  return {
    select: () => ({ from: query }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === schema.memberships && state.failMembership)
          throw new Error('test write failed');
        pending.push({ table, values });
        const result = [{ id: 'new-user', email: values.email, name: null }];
        return {
          returning: async () => result,
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: (where: SQL) => {
        const params = condition(table, where);
        const result = table === schema.memberships && !state.removed ? [] : [{ id: 'removed' }];
        pending.push({ table, params });
        return {
          returning: async () => result,
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
        };
      },
    }),
  };
}
vi.mock('@meegrow-social/db', async (original) => ({
  ...(await original<typeof DbModule>()),
  db: () => ({
    ...handle(state.committed),
    transaction: async <T>(fn: (tx: ReturnType<typeof handle>) => Promise<T>) => {
      const pending: typeof state.committed = [];
      const result = await fn(handle(pending));
      state.committed.push(...pending);
      return result;
    },
  }),
}));
const actor = { userId: 'owner-user', sessionId: 'test-session', workspaceId: 'workspace-a' };
const input = { email: 'reviewer@example.invalid', role: 'member' };
const add = (body: unknown = input) => addClientPerson(actor, 'workspace-a', body, '192.0.2.1');
beforeEach(() => {
  Object.assign(state, {
    role: 'owner',
    existing: false,
    removed: true,
    failMembership: false,
    committed: [],
  });
  predicates.length = 0;
  resetAttemptStore();
});

describe('client people authority and provisioning', () => {
  it('stores only a hash and exactly one membership; credentials verify through the existing hasher', async () => {
    const result = await add();
    expect('temporaryPassword' in result).toBe(true);
    if (!('temporaryPassword' in result)) return;
    const stored = state.committed.find((w) => w.table === schema.users)!.values!;
    expect(stored).not.toHaveProperty('temporaryPassword');
    expect(await verifyPassword(String(stored.passwordHash), result.temporaryPassword)).toBe(true);
    expect(JSON.stringify(state.committed.map((w) => w.values))).not.toContain(
      result.temporaryPassword,
    );
    expect(state.committed.filter((w) => w.table === schema.memberships)).toEqual([
      {
        table: schema.memberships,
        values: { userId: 'new-user', workspaceId: 'workspace-a', role: 'member' },
      },
    ]);
  });
  it.each(['admin', 'member', 'viewer', 'unknown'])(
    'refuses %s for people and workspace creation, without writes',
    async (role) => {
      state.role = role;
      await expect(add()).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(listClientPeople(actor, 'workspace-a')).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(removeClientPerson(actor, 'workspace-a', 'other-user')).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(createClientWorkspace(actor.userId, 'Escape')).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      expect(state.committed).toEqual([]);
    },
  );
  it('requires the actor AND target membership, and a session rather than an API key', async () => {
    await expect(listClientPeople(actor, 'workspace-b')).rejects.toBeInstanceOf(AccessDeniedError);
    expect(predicates[0]!.params).toEqual(['owner-user', 'workspace-b']);
    await expect(
      requireWorkspaceRole({ workspaceId: 'workspace-a', apiKeyId: 'test-key' }, 'workspace-a', [
        'owner',
      ]),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(predicates).toHaveLength(1);
  });
  it('refuses existing identities without changing their credentials or memberships', async () => {
    state.existing = true;
    await expect(add()).rejects.toBeInstanceOf(PersonExistsError);
    expect(state.committed).toEqual([]);
  });
  it('validates role itself so nobody can grant ownership', async () => {
    await expect(add({ ...input, role: 'owner' })).rejects.toThrow();
    expect(state.committed).toEqual([]);
  });
  it('rolls back the identity if creating its membership fails', async () => {
    state.failMembership = true;
    await expect(add()).rejects.toThrow('test write failed');
    expect(state.committed).toEqual([]);
  });
  it('limits successful issuance before hashing or inserting another user', async () => {
    for (let i = 0; i < AUTH_ATTEMPT_LIMITS.people.perAccount; i++) await add();
    const writes = state.committed.length;
    expect(await add()).toEqual({ rateLimited: true, retryAfterSeconds: expect.any(Number) });
    expect(state.committed).toHaveLength(writes);
  });
  it('removes only a non-owner in the target client, revoking all that user’s sessions in the transaction', async () => {
    expect(await removeClientPerson(actor, 'workspace-a', 'other-user')).toBe(true);
    expect(state.committed.map((w) => [w.table, w.params])).toEqual([
      [schema.memberships, ['workspace-a', 'other-user', 'owner']],
      [schema.sessions, ['other-user']],
    ]);
    await expect(removeClientPerson(actor, 'workspace-a', actor.userId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });
  it('does not revoke sessions when no removable membership exists', async () => {
    state.removed = false;
    expect(await removeClientPerson(actor, 'workspace-a', 'other-user')).toBe(false);
    expect(state.committed.some((w) => w.table === schema.sessions)).toBe(false);
  });
  it.each(['member', 'viewer', 'unknown'])(
    'refuses %s for all API key management actions in core',
    async (role) => {
      state.role = role;
      for (const action of ['list', 'create', 'revoke'] as const)
        await expect(manageWorkspaceApiKeys(actor, action, 'test-value')).rejects.toBeInstanceOf(
          AccessDeniedError,
        );
      expect(state.committed).toEqual([]);
    },
  );
  it.each(['owner', 'admin'])(
    'permits %s in the key-management authority check, only for its own workspace',
    async (role) => {
      state.role = role;
      await expect(
        requireWorkspaceRole(actor, 'workspace-a', ['owner', 'admin']),
      ).resolves.toBeUndefined();
      await expect(
        requireWorkspaceRole(actor, 'workspace-b', ['owner', 'admin']),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    },
  );
  it('permits workspace provisioning only for an existing owner', async () => {
    await expect(requireWorkspaceCreator(actor.userId)).resolves.toBeUndefined();
    expect(predicates[0]!.params).toEqual(['owner-user', 'owner']);
  });
});
