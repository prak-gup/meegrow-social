# AX-PRD — Meegrow Social

**Status:** APPROVED 2026-07-06 — building scaffold (Phase 5 gate = repo scaffold passes its own CI)
**Last updated:** 2026-07-06
**Upstream:** `PRD.md` (approved), `RESEARCH.md` §4, grill round 2026-07-06 (Fable 5)

"You can't sacrifice AX for UX." This document fixes the one-way doors so that AFK agents can
build features safely. After the scaffold ships, we are back in brownfield: every issue is an
increment inside these walls.

---

## 1. Tech choices (one-way doors — LOCKED)

| Door                | Choice                                                                                           | Why (short)                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Language            | **TypeScript, strict** (Node 22 LTS)                                                             | End-to-end types = the #1 AFK-agent guardrail                                                                                   |
| Package mgmt        | **pnpm + Turborepo** monorepo                                                                    | Shared contracts, per-package CI caching                                                                                        |
| HTTP server         | **Fastify**                                                                                      | Less framework magic than Nest; plain functions = predictable diffs                                                             |
| DB                  | **Postgres 17 + Drizzle ORM**                                                                    | No codegen drift; SQL control needed for RLS                                                                                    |
| Tenancy enforcement | **RLS from M0** (`SET LOCAL app.workspace_id` per request/job)                                   | Cross-tenant leak = impossible-by-construction; chosen against app-layer-only scoping due to prior antidote isolation-leak scar |
| Jobs                | **BullMQ on Redis 7**                                                                            | Delayed jobs (publish), repeatables (analytics poll, token sweeper); hand-rolled DLQ table                                      |
| MCP                 | **Streamable HTTP, STATELESS**, single `/mcp` on the api service                                 | Headless agents reconnect cheaply; no session affinity behind Caddy                                                             |
| API auth (machine)  | Per-workspace keys `sk_live_…` — SHA-256 at rest, prefix shown, scopes[], revocable              | Same key authorizes REST + MCP                                                                                                  |
| Human auth          | Email+password + Google SSO, invite-only (Lucia-style session pattern, no auth SaaS)             | No external auth dependency                                                                                                     |
| Webhooks            | **Hand-rolled on BullMQ** (~300 lines): HMAC svix-compatible headers, backoff, DLQ + replay      | Light-ops principle; consumers are antidote + n8n                                                                               |
| Media               | S3 + public URLs; **ffprobe validate-and-reject**, NO transcoding in v1                          | antidote already emits correct formats                                                                                          |
| Dashboard           | **Vite + React SPA** (Tailwind + shadcn), static via Caddy, pure API consumer                    | No SSR traps; dogfoods the API                                                                                                  |
| Analytics store     | Key-value metric rows (`metric` text, `value` numeric, `captured_at`)                            | Survives platform metric renames (impressions→views)                                                                            |
| Deploy              | 1 EC2 · docker compose: `api` (REST+MCP), `worker`, `postgres`, `redis`; Caddy on host; S3 media | Proven ops pattern; ≤$30/mo                                                                                                     |
| CI                  | GitHub Actions + pre-commit (lint-staged)                                                        | Same gates local and remote                                                                                                     |

Deliberately NOT chosen: NestJS, Prisma, Temporal, Elasticsearch, Svix (any form), Next.js,
auth SaaS, tRPC (REST + OpenAPI is the public contract; internal dashboard uses the same API).

## 2. Module shape

```
meegrow-social/
├── packages/
│   ├── contracts/    # Zod schemas + inferred types for EVERY boundary (API bodies, MCP tools,
│   │                 #   webhook payloads, provider DTOs). SINGLE SOURCE OF TRUTH.
│   ├── db/           # Drizzle schema, migrations, RLS policies, tenant-context helper
│   ├── core/         # SEALED CORE. All business logic as plain async services:
│   │   ├── workspaces/ auth/ connections/ posts/ scheduling/ media/ analytics/
│   │   ├── webhooks/ apikeys/ logs/
│   │   └── providers/  # SEALED CORE #2: SocialProvider interface + registry + per-platform impls
│   └── testing/      # fixtures, provider HTTP recordings, test-db harness, factories
├── apps/
│   ├── api/          # Fastify: REST routes + /mcp endpoint. THIN — parse → call core → serialize
│   ├── worker/       # BullMQ processors. THIN — resolve job → call core
│   └── web/          # Vite React SPA. THIN — API consumer only
└── docs/dev/         # GRILL_NOTES, RESEARCH, PRD, AX-PRD, STATE
```

**Deep modules (sealed cores — HITL changes only):**

- `core/providers` — the `SocialProvider` interface (Postiz-derived):
  `generateAuthUrl / authenticate / refreshToken / post(details[]) / analytics / postAnalytics`
  - metadata (`identifier`, `isBetweenSteps`, `maxConcurrentJobs`, `tokenModel`). Typed errors:
    `ProviderAuthError` (→ mark needsReconnect) vs `ProviderBadRequestError` (→ fail post) vs
    `ProviderTransientError` (→ retry). Resilient fetch wrapper (429/5xx backoff) lives here.
- `core/scheduling` — job orchestration semantics: idempotency keys, delayed-job lifecycle,
  cancel/edit interruption, DLQ writes.
- `db` tenant context — the ONLY way to get a DB handle is `withWorkspace(workspaceId, fn)`
  which wraps a transaction in `SET LOCAL app.workspace_id`. No raw pool export.

**Thin modules (AFK-agent territory):** individual provider implementations (interface is fixed),
REST routes, MCP tool adapters, worker processors, dashboard pages, analytics pollers.

**The no-split-brain rule:** `apps/*` contain ZERO business logic. Any logic in a route/processor/
component is a review-rejection. REST and MCP both call the same `core` service with the same
`contracts` schema; OpenAPI and MCP tool schemas are both derived from `contracts`.

## 3. Feedback loops from day 0 (the merge gates)

1. `tsc --noEmit` strict, zero errors — workspace-wide
2. ESLint (typescript-eslint strict) + Prettier — enforced via pre-commit (lint-staged) AND CI
3. **Vitest** unit + integration suites green
4. `turbo build` succeeds (all packages)
5. Drizzle migration check: schema ↔ migrations in sync; **RLS policy test** (cross-tenant read
   MUST fail) runs in the integration suite — a failing RLS test blocks any merge
6. Custom lint rule / grep gate: no `db.` access outside `withWorkspace`, no `fetch(` in apps/*
   (must go through core), no business logic imports from apps into apps

GitHub Actions runs 1–6 on every PR; branch protection requires green + no direct pushes to main.
An AFK agent's definition of done = "PR open, CI green, acceptance criteria demonstrated in PR body."

## 4. Testing strategy

- **Unit (Vitest):** core services with in-memory fakes for DB-adjacent seams where cheap.
- **Integration (Vitest + real Postgres in docker):** service ↔ db paths, RLS enforcement suite,
  API-key auth, scheduling lifecycle (with BullMQ against real Redis).
- **Provider contract tests:** each provider gets recorded real HTTP fixtures (captured during HITL
  bring-up); tests assert request shape + response parsing. NO live platform calls in CI.
  Live smoke-tests are a manual QA-issue step per milestone.
- **API surface tests:** REST routes exercised via Fastify inject; MCP tools exercised via SDK
  client against the same process. Both must round-trip `contracts` schemas.
- **No evals needed** (no LLM features in v1 — template engine later will add evalite).
- Factories in `packages/testing`; every table gets a factory from day 0.

## 5. Where AFK agents run

**Local git worktrees on Prakhar's Mac** (existing agents-meegrow pattern):

- Each AFK agent = headless Claude Code (Sonnet) in its own worktree, pulls ONE unblocked
  `afk`-labeled GitHub issue, implements, opens PR, CI gates merge. Sentinel: `NO MORE TASKS`.
- HITL issues (`hitl` label) are NEVER touched by AFK agents — worked in the main session (Opus).
- Mac-sleep caveat accepted (caffeinate during runs). Escalation path to an EC2 build box exists
  if runs need to survive overnight unattended.
- Secrets: AFK agents get `.env.test` only (fixtures, test DB). Real platform creds live only in
  the main HITL session + production box. An AFK agent never needs a live token.

## 6. Scaffold definition (the Phase 5 gate)

The scaffold PR must contain, and pass CI with:

- Turborepo + pnpm workspaces wired (`contracts`, `db`, `core`, `testing`, `api`, `worker`, `web`)
- Strict tsconfig base, ESLint+Prettier config, pre-commit hooks, GitHub Actions workflow (gates §3)
- Drizzle setup + initial migration: `workspaces`, `users`, `memberships`, `api_keys`,
  `connections`, `post_groups`, `posts` (per-platform children), `media`, `jobs_dlq`,
  `webhook_endpoints`, `webhook_deliveries`, `metrics`, `event_logs` — ALL with RLS policies
- `withWorkspace` tenant helper + the failing-cross-tenant-read test
- `SocialProvider` interface + registry + a `FakeProvider` used by tests
- Fastify app with healthz, API-key auth middleware, one real vertical stub (`POST /v1/posts`
  validate→persist→enqueue), `/mcp` endpoint exposing one tool (`create_post`) over the same core
- BullMQ worker skeleton with the publish processor calling `FakeProvider`
- Vite React shell with login screen scaffold
- docker-compose.dev (postgres+redis) + compose.prod skeleton; README dev-setup that works

**Gate check:** fresh clone → `pnpm i && pnpm test && pnpm build` green + CI green on GitHub.

## 7. Open items deferred (not doors)

- OAuth 2.1 on MCP (only if third-party MCP consumers ever appear)
- EC2 build box for AFK (only if local worktree runs prove insufficient)
- Transcoding pipeline (only on real client need)
- evalite (arrives with the template engine)
