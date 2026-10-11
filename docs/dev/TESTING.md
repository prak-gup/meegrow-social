# Running the tests

```bash
pnpm test              # unit — no database, no Redis, safe anywhere
pnpm test:integration  # everything, including *.integration.test.ts — needs Postgres + Redis
```

## The integration suites are destructive

**Every integration suite TRUNCATEs every table before each test** (`resetDb()` in
`packages/testing`), and the scheduler suite obliterates the `publish` BullMQ queue. Pointed at a
database you care about, they empty it. That happened on 2026-10-11: the suites defaulted to a
developer's local `meegrow_social`, a Postgres was listening there, and one `npx vitest run
packages/core` wiped it.

Three things now stand in the way:

1. **A bare `vitest run` does not run them.** `vitest.config.ts` excludes `*.integration.test.ts`
   unless `MGS_RUN_INTEGRATION_TESTS=1`, which only the `test:integration` scripts set. Do not set
   it by hand or export it in your shell.
2. **The default is a separate database.** With `DATABASE_URL` unset the suites use
   `postgres://mgs:mgs@localhost:5433/meegrow_social_test` (the `pnpm dev:infra` Postgres, a
   different database from the dev one). The single definition is `useTestDatabaseEnv()` in
   `packages/testing/src/safety.ts`; a suite must not carry its own fallback URL.
3. **`resetDb()` refuses anything that is not a test database.** The name in `DATABASE_URL` (and
   `APP_DATABASE_URL`, which must be the same database on the same host) has to end in `_test`, and
   the open connection is then asked `current_database()` and held to the same rule. Otherwise it
   throws `TestDatabaseGuardError` naming the database it refused and nothing is truncated.

## One-time setup

Create a dedicated database next to the dev one and migrate it. With the dev infra
(`pnpm dev:infra`):

```bash
docker exec mgs-postgres createdb -U mgs meegrow_social_test
DATABASE_URL=postgres://mgs:mgs@localhost:5433/meegrow_social_test pnpm db:migrate
```

`db:migrate` also creates the `mgs_app` role the suites write through (it is per-server, so it
already exists if you migrated the dev database) and grants it on the new database's tables.
Re-run that `db:migrate` line whenever a migration is added — the test database does not follow the
dev one.

With a host Postgres instead, `createdb meegrow_social_test` and use your own admin URL in both
steps, e.g. `postgres://<you>@localhost:5432/meegrow_social_test`.

## Running them

```bash
# dev infra defaults — DATABASE_URL / APP_DATABASE_URL unset
REDIS_URL=redis://localhost:6390 pnpm test:integration

# or an explicit test database
DATABASE_URL=postgres://<you>@localhost:5432/meegrow_social_test \
APP_DATABASE_URL=postgres://mgs_app:mgs_app@localhost:5432/meegrow_social_test \
REDIS_URL=redis://localhost:6390 \
pnpm test:integration
```

`REDIS_URL` has **no default**: the Redis suites fail fast without it rather than guess at whatever
is on `localhost:6379`. Give them a throwaway instance, not the one holding your scheduled posts —
`docker run --rm -d -p 6390:6379 redis:7.2-alpine` is enough.

Check your shell before you run: if `DATABASE_URL` is already exported (from a `.env` loader, say)
it wins over the default. The guard will still refuse it unless it names a `_test` database.

## The escape hatch

If a database really is disposable but cannot be renamed, set
`MGS_ALLOW_DESTRUCTIVE_TESTS_ON=<its exact name>`. It takes the name, not `1`, so it unlocks that
one database and nothing else. CI does not use it — CI's database is simply called
`meegrow_social_test`.
