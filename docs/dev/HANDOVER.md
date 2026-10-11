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

## Current sequence (as of 2026-07-21)

✅ **#51 + #52 DONE** — IG account linked, and image/carousel/reel all published live with resolving
permalinks; all 6 IG metric names accepted (unlike FB, none rejected). Verified against the prod DB.

**The plan now runs two tracks in parallel — submit the slow external review, then fill the wait
with QA + code:**

1. **NOW → #53 Meta App Review.** The priority. It's a weeks-long external review, so start the
   clock today. You already have everything it needs: working FB _and_ IG flows + the screen
   recording. Submit, then it's Meta's queue, not yours. **One thing to prove:** the issue's
   hypothesis that App Review is what unlocks the Tech Provider "access verification" panel — after
   you submit, check whether that panel activates, and record the answer either way.
2. **WHILE #53 sits — QA the base.** #18 (M1 Meta publishing acceptance) and #37 (E2E staging).
   Lock down FB+IG before any client touches it.
3. **WHILE #53 sits — #54, your first code issue.** Small, self-contained, and you already did the
   metric verification for IG. Workflow + the one non-obvious rule are in the issue comment.
4. **Then, if #54 goes smoothly — #6 webhooks** is teed up as the next coding stretch. Bigger, but
   the hard part (the outbox) already exists: #12 writes `webhook_deliveries` rows and #9 feeds
   `analytics.updated`. #6 is the delivery drainer + CRUD + DLQ replay on top.

Read **§Five things that will save you a day** below before the code issues.

## All your issues

| #       | What                                                           | State / blocked by        |
| ------- | -------------------------------------------------------------- | ------------------------- |
| **#51** | Link an IG Business account to a granted Page                  | ✅ done                   |
| **#52** | Live bring-up: Instagram (image/carousel/reel)                 | ✅ done                   |
| **#53** | Meta App Review — Advanced Access for 7 scopes + Tech Provider | ▶ **now — the priority**  |
| **#18** | M1 QA: Meta publishing core acceptance                         | ▶ while #53 waits         |
| **#37** | E2E QA on staging                                              | ▶ while #53 waits         |
| **#54** | Replace the rejected `post_impressions_unique` metric (code)   | ▶ your first coding issue |
| **#6**  | Webhooks: delivery + DLQ replay (code)                         | queued — after #54        |
| **#1**  | Platform approvals workstream (parent)                         | tracks #53                |

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
pnpm --filter @meegrow-social/db db:migrate
pnpm test   # unit only, no infra
```

Integration tests **truncate every table** of the database they run against. They only run through
`pnpm test:integration`, default to a separate `meegrow_social_test` database, and refuse any
database not named `*_test`. Read `docs/dev/TESTING.md` before running them locally.

## House rules (learned the hard way — see STATE.md)

- **Serialize** anything touching `apps/api/src/server.ts`, `packages/core/src/services/posts.ts`,
  or migrations. Wave 1's parallel worktrees produced 4 green PRs and painful merges.
- Providers are sealed: a new platform = implement `SocialProvider` + `registerProvider`.
  Real providers only register when their env credentials exist, so dev/CI run on the fakes.
- Never hardcode metric names as a closed set. Platforms rename them; we've already been bitten.
