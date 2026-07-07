import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TENANT_TABLES } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Applies the RLS layer. Lives here (not in generated migrations) because we need FORCE ROW LEVEL
 * SECURITY — without it the table owner bypasses policies and the isolation test passes vacuously.
 */
async function applyRls(sqlClient: postgres.Sql): Promise<void> {
  for (const table of TENANT_TABLES) {
    await sqlClient.unsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
    await sqlClient.unsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    await sqlClient.unsafe(`DROP POLICY IF EXISTS tenant_isolation ON "${table}";`);
    await sqlClient.unsafe(
      `CREATE POLICY tenant_isolation ON "${table}"
         USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
         WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);`,
    );
  }
}

/**
 * Creates the NON-superuser application role the app connects as. RLS only constrains non-superuser,
 * non-owner roles, so tenant isolation depends on this role existing and the app using it.
 */
async function ensureAppRole(sqlClient: postgres.Sql): Promise<void> {
  const pw = process.env.APP_DB_PASSWORD ?? 'mgs_app';
  await sqlClient.unsafe(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mgs_app') THEN
         CREATE ROLE mgs_app LOGIN NOSUPERUSER;
       END IF;
     END $$;`,
  );
  await sqlClient.unsafe(`ALTER ROLE mgs_app WITH PASSWORD '${pw}';`);
  await sqlClient.unsafe(`GRANT USAGE ON SCHEMA public TO mgs_app;`);
  await sqlClient.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mgs_app;`,
  );
  await sqlClient.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mgs_app;`,
  );
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sqlClient = postgres(url, { max: 1 });
  const dbi = drizzle(sqlClient);
  await migrate(dbi, { migrationsFolder: join(here, '..', 'migrations') });
  await ensureAppRole(sqlClient);
  await applyRls(sqlClient);
  await sqlClient.end();
  console.log('✅ migrations + RLS + app role applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
