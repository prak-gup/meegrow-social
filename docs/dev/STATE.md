# STATE — meegrow-social

**Project:** Bottom-up Meegrow-owned social media management platform (Zernio-class), replacing Postiz + Zernio.

**Pipeline:** /e2e-dev (Grill → Research → Prototype → PRD → AX-PRD → Issues → Implement → QA)

## Current phase

**Phase 6 — ISSUE GRAPH PUBLISHED** (2026-07-07). 31 GitHub issues on prak-gup/meegrow-social with hitl/afk + M1..M-launch labels, blocked-by graph in bodies. M1=#1-18 (minus #11 deploy=M2), M2=#11,19-23, M3=#24-27, M4=#28-30, launch=#31. QA issues per milestone (#18,#23,#27,#30).

Scaffold (Phase 5) was completed same day: AX-PRD approved; monorepo scaffolded and passing
its own gate locally: build 7/7, unit 5/5, integration 11/11 (RLS read-isolation + WITH-CHECK write
rejection against the non-superuser `mgs_app` role, publish e2e via FakeProvider, API cross-workspace
no-leak), lint/guardrails/format clean. This IS the M0 walking skeleton (create post via REST **and**
MCP → schedule → publish → record → read back).

## Next action

**Phase 7 — Implement (IN PROGRESS).**

OPEN PRs (all CI-green in isolation; NOT merged):
- **PR #32 = issue #2 OAuth connect plumbing** (HITL — awaiting human review of the state/flow security model). Branch feat/2-oauth-connect. THE foundation; merge FIRST.
- **PR #33 = issue #7 logs** (AFK). Branch feat/7-logs.
- **PR #34 = issue #4 queues** (AFK). Branch feat/4-queues.
- issue #3 media: AFK agent still building (worktree ../mgs-wt-3, branch feat/3-media-library).

MERGE SEQUENCING (conflicts are real, resolve in order):
1. Merge #32 (#2) first.
2. Then for each AFK PR: rebase onto main, REGENERATE its drizzle migration to the next ordinal (all three branched off main and made a `0001_*` — #2=oauth_flows, #4=posts.queue_id; #7 needed none), resolve `apps/api/src/server.ts` + `packages/core/src/services/posts.ts` overlaps, re-run gate, merge.
3. Worktrees to clean up after merge: `git worktree remove ../mgs-wt-{3,4,7}`.

THEN:
- Remaining M1 AFK issues: #5 post-lifecycle, #6 webhooks, #8 api-keys, #9 analytics (unblocked) → #12 token-health (needs #2 merged), #15 MCP-expansion, #16/#17 dashboard (need #10 auth).
- HITL: #10 human auth; providers #13 Instagram → #14 Facebook (real Meta creds + fixture capture) → #18 M1 QA.
- Human, no code: issue #1 approvals workstream (GBP access, Google OAuth verification, LinkedIn CMA, Meta advanced-access) — still unstarted, long pole for M2/M3.
- Still needed: Priyanshi's GitHub username (Postiz keep-alive handoff + optional QA on this repo).

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
