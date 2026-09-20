# Meegrow Social

Agency-grade, **API- and MCP-first** social publishing platform. Meegrow-owned replacement for
Zernio (rented) + self-hosted Postiz (heavy). Multi-tenant workspaces, per-workspace API keys,
durable scheduled publishing, collect-everything analytics — Postgres + Redis only, no Temporal/ES.

See `docs/dev/` for the full paper trail: `PRD.md` (what), `AX-PRD.md` (how / one-way doors),
`RESEARCH.md` (platform + stack findings), `STATE.md` (where we are),
`BUILD-SPEC-V2.md` (what is still to be built, in full).

## Monorepo layout

```
packages/contracts  Zod schemas + types — single source of truth for every boundary
packages/db         Drizzle schema, migrations, FORCE-RLS, withWorkspace() tenant helper
packages/core       Sealed business logic: SocialProvider interface + registry, posts,
                    publish, auth, api-keys, scheduler port, media (storage driver + ffprobe
                    validate-and-reject). No app/framework code.
packages/testing    Factories, DB reset, recording scheduler
apps/api            Fastify REST + stateless /mcp — thin adapters over core
apps/worker         BullMQ consumer → core.publishPost, DLQ on exhaustion
apps/web            Vite + React dashboard shell (pure API consumer)
```

## Architectural invariants (enforced in CI)

- **Tenant isolation is DB-enforced.** Every client-data table has FORCE row-level security; the app
  connects as a non-superuser role and reads/writes tenant data only through `withWorkspace()`, which
  sets `app.workspace_id` per transaction. A cross-tenant read/write is impossible-by-construction —
  see `packages/db/src/rls.integration.test.ts` (a failing RLS test blocks any merge).
- **No split-brain.** `apps/*` contain zero business logic; REST and MCP both call `core`. Guardrails
  (`scripts/guardrails.sh`) reject raw DB drivers outside `packages/db` and cross-app imports; ESLint
  bans `fetch` in apps.
- **A new platform = implement `SocialProvider` + register it.** Nothing else changes.

## Dev setup

Requires Node ≥ 22, pnpm, and `ffprobe` on PATH (ffmpeg package — used to probe media
dimensions/duration/codec; never transcodes). Postgres + Redis via Docker (or a local Postgres).

```bash
pnpm install
cp .env.example .env
pnpm dev:infra                 # docker: Postgres (5433) + Redis (6380)
pnpm --filter @meegrow-social/db db:migrate   # tables + RLS + mgs_app role

# run it
pnpm --filter @meegrow-social/api dev         # REST + /mcp on :8990
pnpm --filter @meegrow-social/worker dev      # publish worker
pnpm --filter @meegrow-social/web dev         # dashboard on :5174
```

## The gates (what CI runs)

```bash
pnpm format:check
bash scripts/guardrails.sh
pnpm lint
pnpm build            # turbo, strict tsc across all packages
pnpm test             # unit — no infra needed
pnpm test:integration # RLS + API + publish — needs Postgres (DATABASE_URL + APP_DATABASE_URL)
```

`DATABASE_URL` is the admin/migration connection; `APP_DATABASE_URL` is the non-superuser `mgs_app`
role the app uses so RLS actually enforces. Both are set for you in `docker-compose.dev.yml` land via
`.env`; CI provisions them as service containers.

## Status

M0 scaffold (walking skeleton): connect (fake) → create post via REST/MCP → schedule → publish →
record → read back, all green through CI. Real providers (Meta IG+FB, GBP, then LinkedIn/X/YouTube),
queues, media pipeline, analytics collection, and the dashboard land as tracked issues. See `STATE.md`.
