# STATE — meegrow-social

**Project:** Bottom-up Meegrow-owned social media management platform (Zernio-class), replacing Postiz + Zernio.

**Pipeline:** /e2e-dev (Grill → Research → Prototype → PRD → AX-PRD → Issues → Implement → QA)

## Current phase

**Phase 5 — SCAFFOLD COMPLETE + GREEN** (2026-07-07). AX-PRD approved; monorepo scaffolded and passing
its own gate locally: build 7/7, unit 5/5, integration 11/11 (RLS read-isolation + WITH-CHECK write
rejection against the non-superuser `mgs_app` role, publish e2e via FakeProvider, API cross-workspace
no-leak), lint/guardrails/format clean. This IS the M0 walking skeleton (create post via REST **and**
MCP → schedule → publish → record → read back).

## Next action

1. Push repo to GitHub; confirm CI green (service containers).
2. **Switch to Fable 5** → Phase 6: /to-issues on PRD → real GitHub issues, hitl/afk labels,
   blocked-by graph, milestone labels (M1 Meta core → M-launch). Quiz Prakhar on granularity/tags first.
3. Phase 7 tracer bullet is effectively done (scaffold = walking skeleton); first real issue = the
   Instagram or Facebook provider (HITL, Opus) replacing FakeProvider.

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
