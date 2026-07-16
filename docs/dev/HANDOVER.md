# HANDOVER — meegrow-social (2026-07-17)

For **@priyanshijain1**, picking this up cold. `STATE.md` is the full history; this is what you need
to be productive today. Read `docs/dev/research/meta.md` before touching anything Meta.

## What this is

A Meegrow-owned social media management platform (Postiz/Zernio-class). **It works**: it publishes
real posts to a real Facebook Page and pulls analytics back. The remaining gap between "works for
Prakhar" and "works for clients" is Meta's approval queue, not code.

- **Live:** https://social.meegrowlabs.com (owner login: prak.gup@gmail.com)
- **Box:** the Postiz EC2 `35.154.66.120`, at `/opt/meegrow-social`. Own PG17+Redis containers;
  API on `127.0.0.1:8990` behind Caddy. Secrets in `/opt/meegrow-social/.env` — **on the box only**.
- **Deploy:** automatic. Green CI on `main` → deploys. No manual step.

## Your issues

| #       | What                                                           | Blocked by                   |
| ------- | -------------------------------------------------------------- | ---------------------------- |
| **#51** | Link an IG Business account to a granted Page                  | — **start here, it's small** |
| **#52** | Live bring-up: Instagram (image/carousel/reel)                 | #51                          |
| **#53** | Meta App Review — Advanced Access for 7 scopes + Tech Provider | #52 for the IG screencasts   |
| **#54** | Replace the rejected `post_impressions_unique` metric          | —                            |
| **#1**  | Platform approvals workstream (parent)                         | —                            |
| **#37** | E2E QA on staging                                              | —                            |
| **#18** | M1 QA: Meta publishing core acceptance                         | —                            |

## Five things that will save you a day

### 1. A green test suite proved nothing about the scheduler

`jobId: 'publish:<uuid>'` shipped and **stranded every scheduled post in production** — BullMQ
rejects custom job ids containing `:`. 109 tests passed because they all inject a _fake_ scheduler
that accepts any string. **A fake defines a more permissive contract than the real adapter.**
Fixed (PR #47), and `apps/api/src/scheduler.integration.test.ts` now drives real BullMQ.
Assume the same class of gap exists elsewhere (S3 keys, provider id formats).

### 2. Fixtures lie — live bring-up is the only proof

Every provider's tests replay fixtures **hand-written from the research brief**. #14's bring-up
immediately found `post_impressions_unique` is rejected, and that **Meta 400s the whole insights
call on one bad metric name**. That is why #52 exists and why "the tests pass" is not done.

### 3. Don't trust a 200, or a git SHA

- `meegrowlabs.com` **returns 200 for every URL** (SPA catch-all). `/terms/` looked live and was
  serving the homepage. Compare content hashes against the homepage, not status codes.
- `git reset --hard` is the **first** step of `deploy.yml`, so the box's SHA advances at deploy
  _start_. Polling it looks exactly like "deploy silently serving stale code". **Probe the
  behaviour** — hit the endpoint the new build adds. (`POST /v1/posts` returns **201**, not 200.)

### 4. `api_keys` has NO row-level security

Every other table is RLS-protected. `api_keys` is deliberately excluded (the auth layer reads it
before any tenant context exists), so **the `workspaceId` predicate in `listApiKeys`/`revokeApiKey`
is the only thing between workspaces**. Don't remove it while refactoring. `apikeys.integration.test.ts`
is the tripwire.

### 5. Meta token scopes bite

`/me/accounts` needs a **user** token. With a **Page** token, `/me` resolves to the _Page_ — which
has no `accounts` edge — so you get `(#100) Tried accessing nonexisting field (accounts)`, which
reads like your bug. We store Page tokens. To read a connected Page later, query its own node:
`GET /{page-id}?fields=...`. More in `meta.md §2.4`.

## Facts you'd otherwise rediscover

- **Business Verification is DONE** — MEEGROW.COM PRIVATE LIMITED, verified 2025-12-18. Don't redo it.
- **None of the 7 scopes has Advanced Access.** `GET /{app-id}/permissions` returns only `email` +
  `public_profile`. The app has never passed App Review.
- **One role holder on the app** (Prakhar, admin). No testers. So Standard Access only covers him.
- **Meta app** `2214641422606935`; FLB login config `1379559764274124` (General + **User access
  token** — deliberately not System-user; see #1's comments for why).
- **The FB Page token has no expiry** — `health` reads `healthy` forever and the refresh sweeper
  skips it. That's correct, not a bug.
- **The "Become a Tech Provider" doc you'll find by searching is WhatsApp-only.** Wrong door.

## Running it locally

```bash
pnpm install
# integration tests need Postgres; some suites hardcode :5432, others :5433 (docker-compose.dev)
pnpm --filter @meegrow-social/db db:migrate
npx vitest run --exclude "**/*.integration.test.ts"   # unit only, no infra
```

Known: `rls.integration.test.ts` + `publish.integration.test.ts` hardcode `:5433` while their
siblings use `:5432`. With Docker down they fail locally and pass in CI. **Not your bug** — worth
tidying if it annoys you.

## House rules (learned the hard way — see STATE.md)

- **Serialize** anything touching `apps/api/src/server.ts`, `packages/core/src/services/posts.ts`,
  or migrations. Wave 1's parallel worktrees produced 4 green PRs and painful merges.
- Providers are sealed: a new platform = implement `SocialProvider` + `registerProvider`.
  Real providers only register when their env credentials exist, so dev/CI run on the fakes.
- Never hardcode metric names as a closed set. Platforms rename them; we've already been bitten.
