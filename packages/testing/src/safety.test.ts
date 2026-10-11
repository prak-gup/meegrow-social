import { describe, expect, it } from 'vitest';
import {
  ALLOW_DESTRUCTIVE_VAR,
  DEFAULT_TEST_APP_DATABASE_URL,
  DEFAULT_TEST_DATABASE_URL,
  TestDatabaseGuardError,
  assertConnectedToTestDatabase,
  assertTestDatabaseEnv,
  isTestDatabaseName,
  parseDatabaseTarget,
  requireTestRedisUrl,
  useTestDatabaseEnv,
} from './safety.js';

// Pure: every case passes its own env object, so nothing here reads the ambient DATABASE_URL (CI
// sets one) and nothing connects anywhere.

/** The database that was actually emptied — the regression this guard exists for. */
const OWNER_DB = 'postgres://prakhar@localhost:5432/meegrow_social';

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TestDatabaseGuardError);
    return (err as Error).message;
  }
  throw new Error('expected the guard to refuse');
}

describe('parseDatabaseTarget', () => {
  it('reads the database name and host out of a connection URL', () => {
    expect(parseDatabaseTarget('postgres://mgs:mgs@localhost:5433/meegrow_social_test')).toEqual({
      database: 'meegrow_social_test',
      host: 'localhost:5433',
    });
    expect(parseDatabaseTarget('postgresql://u@db.internal/app_test?sslmode=require')).toEqual({
      database: 'app_test',
      host: 'db.internal:5432',
    });
  });

  it('ignores a query string that merely mentions a test name', () => {
    expect(parseDatabaseTarget('postgres://u@h/meegrow_social?x=_test').database).toBe(
      'meegrow_social',
    );
  });

  it('does not percent-decode the name (the driver does not either)', () => {
    expect(parseDatabaseTarget('postgres://u@h/prod%5Ftest').database).toBe('prod%5Ftest');
  });

  it('uses the first host of a multi-host URL', () => {
    expect(parseDatabaseTarget('postgres://u:p@a:5432,b:5433/app_test')).toEqual({
      database: 'app_test',
      host: 'a:5432',
    });
  });

  it('yields no name for a URL without one, or one that is not postgres', () => {
    expect(parseDatabaseTarget('postgres://u@localhost:5432').database).toBe('');
    expect(parseDatabaseTarget('postgres://u@localhost:5432/').database).toBe('');
    expect(parseDatabaseTarget('mysql://u@localhost/app_test').database).toBe('');
    expect(parseDatabaseTarget('not a url').database).toBe('');
  });
});

describe('isTestDatabaseName', () => {
  it('accepts only names ending in _test', () => {
    expect(isTestDatabaseName('meegrow_social_test', {})).toBe(true);
    expect(isTestDatabaseName('meegrow_social', {})).toBe(false);
    expect(isTestDatabaseName('meegrow_social_test_backup', {})).toBe(false);
    expect(isTestDatabaseName('test', {})).toBe(false);
    expect(isTestDatabaseName('contest', {})).toBe(false);
    expect(isTestDatabaseName('_test', {})).toBe(false);
    expect(isTestDatabaseName('', {})).toBe(false);
  });

  it('accepts another name only when the override names exactly that database', () => {
    expect(isTestDatabaseName('scratch', { [ALLOW_DESTRUCTIVE_VAR]: 'scratch' })).toBe(true);
    expect(isTestDatabaseName('meegrow_social', { [ALLOW_DESTRUCTIVE_VAR]: 'scratch' })).toBe(
      false,
    );
    // A blanket "on" switch unlocks nothing.
    expect(isTestDatabaseName('meegrow_social', { [ALLOW_DESTRUCTIVE_VAR]: '1' })).toBe(false);
    expect(isTestDatabaseName('meegrow_social', { [ALLOW_DESTRUCTIVE_VAR]: 'true' })).toBe(false);
    expect(isTestDatabaseName('', { [ALLOW_DESTRUCTIVE_VAR]: '' })).toBe(false);
  });
});

describe('assertTestDatabaseEnv', () => {
  it('refuses the database that was wiped, naming it and saying how to run safely', () => {
    const msg = refusalOf(() => assertTestDatabaseEnv({ DATABASE_URL: OWNER_DB }));
    expect(msg).toContain('Refusing to TRUNCATE database "meegrow_social" on localhost:5432');
    expect(msg).toContain('DATABASE_URL');
    expect(msg).toContain('createdb meegrow_social_test');
    expect(msg).toContain('pnpm db:migrate');
    expect(msg).toContain('pnpm test:integration');
    expect(msg).toContain(ALLOW_DESTRUCTIVE_VAR);
    expect(msg).toContain('docs/dev/TESTING.md');
  });

  it('never prints credentials', () => {
    const msg = refusalOf(() =>
      assertTestDatabaseEnv({ DATABASE_URL: 'postgres://admin:hunter2@db.example:6543/live' }),
    );
    expect(msg).toContain('"live" on db.example:6543');
    expect(msg).not.toContain('hunter2');
  });

  it('refuses when DATABASE_URL is missing or names no database', () => {
    expect(refusalOf(() => assertTestDatabaseEnv({}))).toContain('DATABASE_URL is not set');
    expect(
      refusalOf(() => assertTestDatabaseEnv({ DATABASE_URL: 'postgres://u@localhost:5432' })),
    ).toContain('the URL names none');
  });

  it('passes a test database and returns the target', () => {
    expect(assertTestDatabaseEnv({ DATABASE_URL: DEFAULT_TEST_DATABASE_URL })).toEqual({
      database: 'meegrow_social_test',
      host: 'localhost:5433',
    });
    // What CI sets.
    expect(
      assertTestDatabaseEnv({
        DATABASE_URL: 'postgres://mgs:mgs@localhost:5432/meegrow_social_test',
        APP_DATABASE_URL: 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social_test',
      }).database,
    ).toBe('meegrow_social_test');
  });

  it('refuses when the app handle points at a non-test database', () => {
    const msg = refusalOf(() =>
      assertTestDatabaseEnv({
        DATABASE_URL: 'postgres://mgs:mgs@localhost:5432/meegrow_social_test',
        APP_DATABASE_URL: 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social',
      }),
    );
    expect(msg).toContain('APP_DATABASE_URL');
    expect(msg).toContain('"meegrow_social" on localhost:5432');
  });

  it('refuses when the two handles point at different test databases or servers', () => {
    expect(
      refusalOf(() =>
        assertTestDatabaseEnv({
          DATABASE_URL: 'postgres://mgs:mgs@localhost:5432/a_test',
          APP_DATABASE_URL: 'postgres://mgs_app:mgs_app@localhost:5432/b_test',
        }),
      ),
    ).toContain('Both must be the same test database');
    expect(
      refusalOf(() =>
        assertTestDatabaseEnv({
          DATABASE_URL: 'postgres://mgs:mgs@localhost:5432/a_test',
          APP_DATABASE_URL: 'postgres://mgs_app:mgs_app@localhost:5433/a_test',
        }),
      ),
    ).toContain('Both must be the same test database');
  });

  it('honours the override only for the database it names', () => {
    expect(
      assertTestDatabaseEnv({
        DATABASE_URL: 'postgres://u@localhost:5432/scratch',
        [ALLOW_DESTRUCTIVE_VAR]: 'scratch',
      }).database,
    ).toBe('scratch');
    const msg = refusalOf(() =>
      assertTestDatabaseEnv({ DATABASE_URL: OWNER_DB, [ALLOW_DESTRUCTIVE_VAR]: 'scratch' }),
    );
    expect(msg).toContain('Refusing to TRUNCATE database "meegrow_social"');
    expect(msg).toContain(
      `${ALLOW_DESTRUCTIVE_VAR} is set to "scratch", which is a different name`,
    );
  });
});

describe('assertConnectedToTestDatabase', () => {
  it('passes when the connection reports a test database', async () => {
    await expect(
      assertConnectedToTestDatabase(async () => 'meegrow_social_test', {}),
    ).resolves.toBeUndefined();
  });

  it('refuses when the connection is really somewhere else, whatever the URL said', async () => {
    await expect(assertConnectedToTestDatabase(async () => 'meegrow_social', {})).rejects.toThrow(
      /Refusing to TRUNCATE database "meegrow_social"/,
    );
    await expect(assertConnectedToTestDatabase(async () => undefined, {})).rejects.toBeInstanceOf(
      TestDatabaseGuardError,
    );
  });
});

describe('useTestDatabaseEnv', () => {
  it('defaults both handles to the dedicated test database when nothing is set', () => {
    const env: Record<string, string | undefined> = {};
    expect(useTestDatabaseEnv(env).database).toBe('meegrow_social_test');
    expect(env.DATABASE_URL).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(env.APP_DATABASE_URL).toBe(DEFAULT_TEST_APP_DATABASE_URL);
  });

  it('the defaults are never the dev database', () => {
    for (const url of [DEFAULT_TEST_DATABASE_URL, DEFAULT_TEST_APP_DATABASE_URL]) {
      expect(parseDatabaseTarget(url).database).toBe('meegrow_social_test');
    }
  });

  it('keeps a supplied URL — and refuses it if it is not a test database', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: OWNER_DB };
    expect(refusalOf(() => useTestDatabaseEnv(env))).toContain(
      '"meegrow_social" on localhost:5432',
    );
    expect(env.DATABASE_URL).toBe(OWNER_DB);
  });

  it('does not invent an app URL on another server when DATABASE_URL is supplied', () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: 'postgres://me@localhost:5432/meegrow_social_test',
    };
    useTestDatabaseEnv(env);
    expect(env.APP_DATABASE_URL).toBeUndefined();
  });
});

describe('requireTestRedisUrl', () => {
  it('has no default', () => {
    expect(refusalOf(() => requireTestRedisUrl({}))).toContain('REDIS_URL is not set');
  });

  it('returns the URL it was given', () => {
    expect(requireTestRedisUrl({ REDIS_URL: 'redis://localhost:6390' })).toBe(
      'redis://localhost:6390',
    );
  });
});
