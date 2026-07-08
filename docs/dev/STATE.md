# STATE — meegrow-social

**Project:** Bottom-up Meegrow-owned social media management platform (Zernio-class), replacing Postiz + Zernio.

**Pipeline:** /e2e-dev (Grill → Research → Prototype → PRD → AX-PRD → Issues → Implement → QA)

## Current phase

**Phase 7 — Implement (IN PROGRESS). Wave 1 MERGED to main + CI green.** (2026-07-08)

Merged to main (squash), each CI-green, then integrated locally (111 tests / 19 files green on main):

- **#2 OAuth connect plumbing** (HITL, PR #32) — start/callback/two-phase-finish, opaque-flow-id state, connections API/MCP.
- **#7 logs** (AFK, PR #33) — request-logging hook + filterable /v1/logs + aggregate + retention job.
- **#4 queues** (AFK, PR #34) — CRUD + DST-correct next-free-slot (Luxon) + add_to_queue.
- **#3 media** (AFK, PR #35) — disk+S3 storage drivers, ffprobe validate-and-reject, /v1/media + register_media_from_url, publish resolves mediaId→url.

Migrations on main: 0000 base · 0001 oauth_flows · 0002 posts.queue_id (parallel `0001_*` collision resolved by regenerating #4's as 0002). Worktrees removed; merged branches deleted.
Filed follow-up **#36** (atomic oauth-flow consume — non-blocking hardening).

Scaffold (Phase 5) = M0 walking skeleton; issue graph (Phase 6) = 31 issues (M1=#1-18 minus #11; M2=#11,19-23; M3=#24-27; M4=#28-30; launch=#31; QA #18/#23/#27/#30).

## Next action

**Wave 2.** LESSON FROM WAVE 1: parallel worktrees produced 4 green PRs but heavy `server.ts`/migration merge friction. Preference going forward — SERIALIZE issues that touch `apps/api/src/server.ts`, `packages/core/src/services/posts.ts`, or migrations; only fan out truly disjoint work.

- Unblocked AFK now: **#8 api-keys** (server.ts — serialize), **#6 webhooks** (server.ts + publish.ts — serialize), **#5 post-lifecycle** (server.ts + posts.ts — serialize), **#9 analytics collection** (adds accountAnalytics to SocialProvider — touches sealed core, lean HITL). **#36** hardening (db only — safe to parallelize).
- Needs #2 (now merged): **#12 token-health/refresh sweeper** (AFK).
- HITL next: **#10 human auth** (sessions), then providers **#13 Instagram → #14 Facebook** (real Meta creds + live fixture capture) → **#18 M1 QA**. **#15 MCP-expansion**, **#16/#17 dashboard** after #10.
- Human, no code: **issue #1 approvals** (GBP access, Google OAuth verification, LinkedIn CMA, Meta advanced-access) — STILL UNSTARTED, long pole for M2/M3.
- Still needed: **Priyanshi's GitHub username** (Postiz keep-alive handoff + optional QA here).

RLS note for resuming: app connects as non-superuser `mgs_app` (APP_DATABASE_URL); admin conn = DATABASE_URL. Integration tests share one DB → Vitest `fileParallelism:false`; parallel AFK agents must NOT run integration locally (per-PR CI validates it). Local dev used host Postgres 14 on :5432 (Docker Desktop was down).

## Key scaffold facts (for any resuming session)

- Repo: `~/Desktop/Meegrow/meegrow-social` → GitHub `prak-gup/meegrow-social` (private).
- Stack realized: pnpm+Turborepo; packages contracts/db/core/testing; apps api/worker/web.
  Fastify + Drizzle + postgres.js + BullMQ + MCP SDK 1.29 (stateless Streamable HTTP at `/mcp`).
- **RLS model (critical):** admin conn = `DATABASE_URL` (migrations/provisioning/auth on non-RLS
  identity tables); app conn = `APP_DATABASE_URL` = non-superuser `mgs_app` role (created by db:migrate).
  Superusers bypass RLS even under FORCE — the app MUST use mgs_app or isolation is void.
- Integration tests need Postgres only (recording scheduler, no Redis). Run serially
  (`fileParallelism:false`) because they share one DB + TRUNCATE in beforeEach.
- Local dev used host Postgres 14 on :5432 (Docker Desktop was down); docker-compose.dev maps :5433/:6380.
- `SocialProvider` interface + registry live in `packages/core/src/providers`; `FakeProvider` is the
  only impl so far. Add a platform = implement interface + `registerProvider`.

## Phase 2 outputs

- `docs/dev/RESEARCH.md` — synthesis + decisions
- `docs/dev/research/{meta,gbp-linkedin,x-youtube,mcp-api-architecture,blotato-templates,postiz-providers}.md`
- Key locks: provider interface = copy Postiz's; stack = Fastify+Drizzle+Postgres+BullMQ monorepo; approvals are critical path (start day 1); X deprioritized (metered); posts model must be template-ready; analytics metrics flexible key-value.

## Model routing

- Grill / issues / architecture: Fable 5
- HITL implementation / tracer bullet: Opus
- AFK issues: Sonnet

## Context that predates this repo

- Current stack being replaced: self-hosted Postiz on EC2 35.154.66.120 (handoff repo: prak-gup/meegrow-social-postiz, 9 issues, being handed to Priyanshi) + paid Zernio account (prakhar@meegrowlabs.com).
- Zernio is the design reference — 27 screenshots reviewed 2026-07-06 (Connections/profiles, Posts+Queues, Inbox incl. Comments/Reviews/Campaigns/Workflows/Contacts, Ads, Numbers/WhatsApp, API Keys, Users/Teams, Webhooks, Logs, Analytics, Settings).
- KEY USAGE SIGNAL: Prakhar drives Zernio via per-client API keys (Antidote, Ecolive, GLs, Mlearn, Empower and shine) from the antidote bot — API-first is the real product core.
- Existing platform developer-app assets that carry over: Meta app 2214641422606935 (IG+FB working), Google Cloud "Meegrow Social" project (GBP working + YouTube creds, OAuth verification in progress), LinkedIn app (Community Mgmt API vetting pending), X API keys.
