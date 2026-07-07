import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

let _adminClient: postgres.Sql | undefined;
let _adminDb: Db | undefined;
let _appClient: postgres.Sql | undefined;
let _appDb: Db | undefined;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * Admin handle (DATABASE_URL). Used for migrations, provisioning, and the identity/routing tables
 * (workspaces, users, memberships, api_keys) that are read pre-tenant-context by the auth layer.
 * This connection may be a superuser — it deliberately does NOT carry RLS guarantees.
 */
export function db(): Db {
  if (!_adminDb) {
    _adminClient = postgres(need('DATABASE_URL'), { max: 10 });
    _adminDb = drizzle(_adminClient, { schema });
  }
  return _adminDb;
}

/**
 * Application handle (APP_DATABASE_URL). MUST be a NON-superuser role (mgs_app) so that RLS is
 * enforced — superusers bypass RLS even under FORCE. Falls back to DATABASE_URL only if unset
 * (dev convenience); in that mode the isolation test will fail loudly, which is the intended signal.
 */
function appDb(): Db {
  if (!_appDb) {
    _appClient = postgres(process.env.APP_DATABASE_URL ?? need('DATABASE_URL'), { max: 10 });
    _appDb = drizzle(_appClient, { schema });
  }
  return _appDb;
}

/**
 * The ONLY sanctioned way to read/write tenant data. Runs on the RLS-bound app role inside a
 * transaction, setting the transaction-local `app.workspace_id` via set_config (parameter-safe,
 * no SQL injection). RLS policies read that setting, so a query that forgets to filter by
 * workspace still cannot see another tenant's rows.
 */
export async function withWorkspace<T>(
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return appDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });
}

export async function closeDb(): Promise<void> {
  await _adminClient?.end({ timeout: 5 });
  await _appClient?.end({ timeout: 5 });
  _adminClient = _appClient = undefined;
  _adminDb = _appDb = undefined;
}
