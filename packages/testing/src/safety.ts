/**
 * The integration suites TRUNCATE every table before each test. Pointed at the wrong database that
 * empties it — which is exactly what happened to a developer's local `meegrow_social` (2026-10-11):
 * the suites defaulted to it, a Postgres was listening, and nothing objected.
 *
 * So destruction is opt-in by NAME: a database is only wiped if it is unmistakably a test database.
 * This module is pure (no DB import, no connection) so the rule is unit-testable without infra.
 */

/** A database is a test database iff its name ends with this. */
export const TEST_DATABASE_SUFFIX = '_test';

export const TEST_DATABASE_NAME = 'meegrow_social_test';

/**
 * The ONE place the suites' fallback URLs live. Host/port/credentials are the dev infra from
 * `docker-compose.dev.yml` (`pnpm dev:infra`); the database is a separate one you create once —
 * see docs/dev/TESTING.md. Never the dev database `meegrow_social`.
 */
export const DEFAULT_TEST_DATABASE_URL = `postgres://mgs:mgs@localhost:5433/${TEST_DATABASE_NAME}`;
export const DEFAULT_TEST_APP_DATABASE_URL = `postgres://mgs_app:mgs_app@localhost:5433/${TEST_DATABASE_NAME}`;

/**
 * Escape hatch for a throwaway database that cannot be renamed. Its value must be the EXACT name of
 * the database to wipe — not `1` — so that exporting it once cannot unlock any other database.
 */
export const ALLOW_DESTRUCTIVE_VAR = 'MGS_ALLOW_DESTRUCTIVE_TESTS_ON';

type Env = Record<string, string | undefined>;

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDatabaseGuardError';
  }
}

export interface DatabaseTarget {
  /** Database name exactly as the driver will send it. Empty when the URL names none. */
  database: string;
  /** `host:port` — for messages only; never includes credentials. */
  host: string;
}

/**
 * Reads the target out of a connection URL the same way the `postgres` driver does (the raw path
 * after the first `/`, not percent-decoded; first host of a multi-host list), so the name checked is
 * the name connected to. Anything unparseable has no name, which the guard refuses.
 */
export function parseDatabaseTarget(url: string): DatabaseTarget {
  let hostList = url.slice(url.indexOf('://') + 3).split(/[?/]/)[0] ?? '';
  hostList = hostList.slice(hostList.indexOf('@') + 1);
  try {
    const parsed = new URL(hostList ? url.replace(hostList, hostList.split(',')[0] ?? '') : url);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      return { database: '', host: '(not a postgres URL)' };
    }
    return {
      database: parsed.pathname.slice(1),
      host: `${parsed.hostname || 'localhost'}:${parsed.port || '5432'}`,
    };
  } catch {
    return { database: '', host: '(unparseable URL)' };
  }
}

/** The rule. `_test` alone (an empty stem) does not count. */
export function isTestDatabaseName(name: string, env: Env = process.env): boolean {
  if (!name) return false;
  if (name.length > TEST_DATABASE_SUFFIX.length && name.endsWith(TEST_DATABASE_SUFFIX)) return true;
  return env[ALLOW_DESTRUCTIVE_VAR] === name;
}

function refusal(what: string, target: DatabaseTarget, env: Env): string {
  const named = target.database
    ? `database "${target.database}" on ${target.host}`
    : `the database on ${target.host} (the URL names none, so the driver would pick one for you)`;
  const override = env[ALLOW_DESTRUCTIVE_VAR]
    ? ` ${ALLOW_DESTRUCTIVE_VAR} is set to "${env[ALLOW_DESTRUCTIVE_VAR]}", which is a different name.`
    : '';
  return [
    `Refusing to TRUNCATE ${named} — ${what} does not point at a dedicated test database.`,
    `The integration suites empty every table before each test, so they only run against a database whose name ends in "${TEST_DATABASE_SUFFIX}".${override}`,
    '',
    'Point them at a safe one:',
    `  1. create it once:   createdb ${TEST_DATABASE_NAME}`,
    `  2. migrate it:       DATABASE_URL=postgres://<admin>@<host>:<port>/${TEST_DATABASE_NAME} pnpm db:migrate`,
    `  3. run the suites:   DATABASE_URL=<that url> APP_DATABASE_URL=postgres://mgs_app:mgs_app@<host>:<port>/${TEST_DATABASE_NAME} pnpm test:integration`,
    `Or unset DATABASE_URL and APP_DATABASE_URL to use the default, ${DEFAULT_TEST_DATABASE_URL.replace('mgs:mgs@', '')}.`,
    '',
    `If "${target.database || '<name>'}" really is disposable and cannot be renamed, set ${ALLOW_DESTRUCTIVE_VAR}=<its exact name>.`,
    'Details: docs/dev/TESTING.md',
  ].join('\n');
}

/**
 * Throws unless the env the db handles will be built from targets a test database:
 *  - DATABASE_URL (admin handle — the one that truncates) must be set and name a test database;
 *  - APP_DATABASE_URL (the handle tests write through), when set, must name the SAME database on
 *    the same host, so a suite can never truncate one database while writing into another.
 * Returns the admin target.
 */
export function assertTestDatabaseEnv(env: Env = process.env): DatabaseTarget {
  const adminUrl = env.DATABASE_URL;
  if (!adminUrl) {
    throw new TestDatabaseGuardError(
      'DATABASE_URL is not set — call useTestDatabaseEnv() in beforeAll before touching the database.',
    );
  }
  const admin = parseDatabaseTarget(adminUrl);
  if (!isTestDatabaseName(admin.database, env)) {
    throw new TestDatabaseGuardError(refusal('DATABASE_URL', admin, env));
  }
  const appUrl = env.APP_DATABASE_URL;
  if (appUrl) {
    const app = parseDatabaseTarget(appUrl);
    if (!isTestDatabaseName(app.database, env)) {
      throw new TestDatabaseGuardError(refusal('APP_DATABASE_URL', app, env));
    }
    if (app.database !== admin.database || app.host !== admin.host) {
      throw new TestDatabaseGuardError(
        `DATABASE_URL targets "${admin.database}" on ${admin.host} but APP_DATABASE_URL targets "${app.database}" on ${app.host}. ` +
          'Both must be the same test database: one is truncated, the other is written through.',
      );
    }
  }
  return admin;
}

/**
 * Second, authoritative check: asks the connection that is about to truncate which database it is
 * actually in. Catches anything URL parsing cannot see (a handle built before the env changed, a
 * driver fallback such as PGDATABASE).
 */
export async function assertConnectedToTestDatabase(
  currentDatabase: () => Promise<string | undefined>,
  env: Env = process.env,
): Promise<void> {
  const name = (await currentDatabase()) ?? '';
  if (!isTestDatabaseName(name, env)) {
    throw new TestDatabaseGuardError(
      refusal('the open connection', { database: name, host: 'the connected server' }, env),
    );
  }
}

/**
 * Every integration suite calls this first in `beforeAll`. Fills in the default test database when
 * the env names none, then refuses to continue unless the result is a test database — before any
 * handle is opened. When DATABASE_URL is supplied without APP_DATABASE_URL the app handle is left to
 * fall back to it (packages/db `appDb`), rather than being pointed at a different server.
 */
export function useTestDatabaseEnv(env: Env = process.env): DatabaseTarget {
  if (!env.DATABASE_URL) {
    env.DATABASE_URL = DEFAULT_TEST_DATABASE_URL;
    env.APP_DATABASE_URL ??= DEFAULT_TEST_APP_DATABASE_URL;
  }
  return assertTestDatabaseEnv(env);
}

/**
 * Redis-backed suites obliterate the `publish` queue, so they get no default at all: a developer
 * machine may have a real Redis on the usual port. CI sets REDIS_URL to its service container.
 */
export function requireTestRedisUrl(env: Env = process.env): string {
  const url = env.REDIS_URL;
  if (!url) {
    throw new TestDatabaseGuardError(
      'REDIS_URL is not set. The Redis integration suites obliterate the "publish" BullMQ queue on ' +
        'whatever Redis they are given, so there is no default — set REDIS_URL to a throwaway ' +
        'instance (never one holding scheduled posts you care about). Details: docs/dev/TESTING.md',
    );
  }
  return url;
}
