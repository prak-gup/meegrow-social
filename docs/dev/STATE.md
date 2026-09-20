# STATE — meegrow-social

**Project:** Bottom-up Meegrow-owned social media management platform (Zernio-class), replacing Postiz + Zernio.

**Pipeline:** /e2e-dev (Grill → Research → Prototype → PRD → AX-PRD → Issues → Implement → QA)

**Build spec for everything remaining (M2 → cutover): `docs/dev/BUILD-SPEC-V2.md`** — providers (GBP
in full), content-ops parity, MCP 5→22, antidote cutover, approvals workstream, migrations, waves.

## 🎨 UI REDESIGN SHIPPED (2026-07-21, PR #55)

**The dashboard was rebuilt on the Airbnb design system and is LIVE + QA'd in prod.** Replaced the
untouched shadcn zinc starter (the root cause a design workflow diagnosed) with a full token layer
(`apps/web/src/index.css` + `tailwind.config.js`; spec committed at `docs/dev/DESIGN-airbnb.md`):
Rausch `#ff385c` as the single scarce accent, warm ink, hairlines, 8/14/full radii, one shadow
tier, semantic status tokens, Inter Variable (self-hosted), Phosphor icons. Light-only (matches Airbnb).

**IA change that solves the 10+ clients problem:** killed the left rail. Client scope now lives in a
searchable **Airbnb pill switcher** (`ClientSwitcher.tsx`) + top-nav tabs; "All clients" → the new
**Overview** control tower (`GET /v1/overview` cross-workspace rollup in `core/services/overview.ts`);
**Clients** page has **Add client** (`POST /v1/workspaces` → `createClientWorkspace`) and
**Invite-to-connect** (the connect-grant link — external self-serve is #53-gated, operator path works).

Process: design judge-panel workflow (Control Tower won) → Airbnb mockup artifacts → user picked
direction → phased e2e build → **4-agent adversarial review workflow** (caught a real HIGH bug:
switching client on a same route didn't rescope — fixed by keying `<main>` on activeWorkspaceId to
force remount; plus a11y + slug-race + token-fidelity fixes) → merge → deploy → live browser QA.

**Known follow-ups (filed):** #56 Content page full content-first pass, #57 the `01/01/1970` epoch
`publishAt` sentinel showing on now-posts, #58 Connections/Composer design pass. The two hero screens
(Overview, Clients) got the full treatment; the other pages are token-migrated (correct, not fully
re-laid-out).

## 🎉 FIRST REAL POST PUBLISHED (2026-07-16)

**Meegrow Social published to a live Facebook Page.** `prakgup` (110548613724876) → post
`110548613724876_1038920145164880`. Composer → API → BullMQ → worker → FacebookPagesProvider →
Graph `/feed` → a real story. Analytics then flowed back from live Graph (`followers: 1`).

Shipped today: **#11 deploy** (social.meegrowlabs.com + CI auto-deploy), **#14 Facebook provider**,
**#45 connect UX**, **#9 analytics collection**, **#13 Instagram provider**, plus a critical
scheduler fix. Issues #44/#45 filed.

**#13 Instagram is merged + live in prod but NOT bring-up-verified** — `prakgup` has **no linked
Instagram Business account** (Meta omits `instagram_business_account` from the Page node, no error).
Live bring-up needs an IG Business account linked to one of the three granted Pages (`prakgup`,
`Com Com`, `Meegrow Labs - Zero to AI Hero`). Until then the IG picker will correctly show its
empty state. See `docs/dev/research/meta.md` §2.4 for the token-scope and permalink gotchas the
live bring-up taught us.

### 🔴 THE FINDING OF THE DAY — scheduled publishing had NEVER worked

`apps/api/src/scheduler.ts` built its job id as `publish:<postId>`. **BullMQ rejects custom job ids
containing a colon** ("Custom Id cannot contain :", verified in bullmq 5.79.2 source — it applies to
queue names too). `createPost` commits the post row and _then_ calls `schedulePublish`, so every
scheduled post ever created was persisted as `scheduled` and **stranded with no job behind it** —
not `failed`, so nothing surfaced; not queued, so no worker saw it. Publish-now, schedule-at and
add-to-queue were all dead in production.

**109 green tests missed it** because every test touching scheduling injects the recording
scheduler from `packages/testing`, which accepts any id. **A fake defines a more permissive
contract than the real adapter** — green tests only proved we satisfied the fake. Fixed in PR #47
(now `publish-<postId>`) + `apps/api/src/scheduler.integration.test.ts` drives real BullMQ (CI has
Redis). Same class of gap likely exists for other adapters (S3 keys, provider id formats).

Extracted to skills: `bullmq-jobid-colon-and-fake-adapter-blindspot`, `http-200-is-not-page-exists`.

### Live-verified facts that fixtures could not have told us

- **`post_impressions_unique` is REJECTED by Meta** — only `post_video_views` + `post_clicks`
  returned. Drop it from `POST_METRICS` and find the views-era replacement. The per-metric fetch
  saved us: one call with all three would have errored and yielded **zero** post metrics.
- `followers_count` node field works (the deprecated `page_fans` decision was right).
- FB Page token stores with **no expiry** → `health: healthy` forever, sweeper skips it. The
  `finalizeAccount` hook (added to the sealed provider contract in #14) does the user→Page swap.

### Deploy gotcha

`git reset --hard` is the **first** step of deploy.yml, so the box's SHA advances at deploy
_start_. Polling it (or reading container age) looks exactly like "deploy silently serving stale
code". **Probe the behaviour** — hit the endpoint the new build adds. Note `POST /v1/posts` returns
**201**, not 200.

## Current phase

**Phase 7 — Implement (IN PROGRESS). Wave 1 + #12 + #10 + #5 + #16 MERGED to main + CI green.** (2026-07-09)

Wave 2:

- **#16 dashboard** (AFK-intent, done HITL/inline) — Vite+React SPA built out from the bare shell: Tailwind v3 + shadcn-idiom primitives (Button/Card/Input/Label/Textarea/Badge/Select/Modal on cva+clsx+radix-slot/label), react-router, a cookie-authed typed API client (`apps/web/src/lib/api.ts`, the ONLY fetch site — eslint no-fetch rule lifted for `apps/web` since the SPA is the documented API consumer), AuthProvider + login shell + workspace switcher, Connections (health badges + Account-Health modal + FakeProvider connect via popup + disconnect), Composer (caption/media-upload/all 4 schedule modes), Posts (grid/list/calendar tabs + status filters + cancel + edit). Vite dev proxy → :8990; prod = static via Caddy (no SSR). All response types flow from `contracts`. **Runtime browser QA is a separate step (#18/#37)** — the gate here is build+lint green + correct endpoint wiring. FakeProvider `generateAuthUrl` now carries a fake `code` so the dev connect round-trip completes through the public callback.
- **#12 token-health + refresh sweeper** (AFK-intent, done HITL/inline, PR #39 MERGED) — token-model-aware health (7d refreshable / 14d one-time windows), `expiresInDays` on ConnectionView, hourly BullMQ sweeper (`refreshExpiringTokens`, optimistic-CAS idempotency), auth-failure → `needs_reconnect` + webhook **outbox** (`core/services/webhooks.ts` → `webhook_deliveries` rows; #6 builds the signed-delivery drainer). No migration, no `server.ts` change. Webhook-outbox handoff logged for #6.
- **#10 human auth** (HITL/inline, PR #40 MERGED) — argon2id (`@node-rs/argon2` napi prebuild; variant locked by `$argon2id$`-prefix test — the Algorithm const-enum can't be referenced under `verbatimModuleSyntax`), opaque sha-256-hashed sessions (migration **0003** `sessions`, non-tenant), httpOnly+SameSite=Lax+Secure(env) cookie, login/logout/me/rotate/switch-workspace, CSRF = SameSite=Lax + Origin check on cookie-authed mutations, seed script `pnpm --filter @meegrow-social/api seed:owner`. Session-authed requests hit the same `/v1` as key-authed.
- **#5 post-lifecycle** (AFK-intent, done HITL/inline) — DELETE/PATCH `/v1/posts/:id` (cancel interrupts the BullMQ job via a new `Scheduler.cancelPublish` port; edit reschedules/demotes/promotes; rejected past `scheduled`), filterable `GET /v1/posts` (status/provider/connectionId/from/to + stable order + offset paging), `GET /v1/posts/calendar` (tz-aware day buckets via Luxon), `GET /v1/post-groups/:id`. No migration. 156 tests green. **This unblocks #16's Posts edit/cancel.**

Merged to main (squash), each CI-green, then integrated locally (111 tests / 19 files green on main):

- **#2 OAuth connect plumbing** (HITL, PR #32) — start/callback/two-phase-finish, opaque-flow-id state, connections API/MCP.
- **#7 logs** (AFK, PR #33) — request-logging hook + filterable /v1/logs + aggregate + retention job.
- **#4 queues** (AFK, PR #34) — CRUD + DST-correct next-free-slot (Luxon) + add_to_queue.
- **#3 media** (AFK, PR #35) — disk+S3 storage drivers, ffprobe validate-and-reject, /v1/media + register_media_from_url, publish resolves mediaId→url.

Migrations on main: 0000 base · 0001 oauth_flows · 0002 posts.queue_id (parallel `0001_*` collision resolved by regenerating #4's as 0002) · 0003 sessions (#10, non-tenant). Worktrees removed; merged branches deleted.
Filed follow-up **#36** (atomic oauth-flow consume — non-blocking hardening).

**GOTCHA — AFK subagent dispatch is environmentally blocked in this session:** `Agent`/`general-purpose` subagents inherit this session's huge MCP tool-schema set (plane×2, dataforseo, firecrawl, stitch, antidote×6, …) which alone exceeds the subagent context budget → "Prompt is too long" even on a 1-line prompt. #12 was therefore implemented inline (HITL) against a written brief. For #16 etc.: either go inline, or open a fresh session without the heavy MCP servers attached, or use a restricted-tool agent type.

Scaffold (Phase 5) = M0 walking skeleton; issue graph (Phase 6) = 31 issues (M1=#1-18 minus #11; M2=#11,19-23; M3=#24-27; M4=#28-30; launch=#31; QA #18/#23/#27/#30).

## Deploy — LIVE (2026-07-16)

**https://social.meegrowlabs.com is up** (issue #11 CLOSED, PR #38 merged after a follow-up commit).

- Box: Postiz EC2 35.154.66.120, `/opt/meegrow-social` (cloned via read-only deploy key `~/.ssh/mgs_deploy` on the box). Own PG17+Redis containers, API on 127.0.0.1:8990 behind Caddy (LE cert auto-provisioned; DNS A record already existed).
- **PR #38 gap fixed pre-merge:** it predated #16, so nothing served the SPA. Caddy now routes `/v1 /connect /mcp /media /healthz` → API and serves the SPA from `/opt/meegrow-social/web-dist`, which each deploy extracts from the image (`docker create` + `docker cp` — see deploy.yml / DEPLOY.md).
- Migrations + RLS + mgs_app applied; `.env` secrets generated on-box (mode 600, never left the box). Owner seeded: prak.gup@gmail.com / workspace "Meegrow"; login smoke-tested 200 through Caddy.
- CI auto-deploy ARMED: repo secrets DEPLOY_HOST/DEPLOY_USER/DEPLOY_SSH_KEY set (dedicated GHA keypair; private key only in the secret). Every green CI on main deploys.
- **OAuth callback now registerable: `https://social.meegrowlabs.com/connect/callback`** → issue #1 approvals is UNBLOCKED (still unstarted, still the long pole).

## Team + deploy (2026-07-08, added mid-Phase-7)

- **Priyanshi = GitHub `priyanshijain1`** (from Meegrowlabs/au-auto-news-console). INVITED (write) to prak-gup/meegrow-social + prak-gup/meegrow-social-postiz — **pending her acceptance** (can't assign issues until she accepts). Her mission = issue **#1** (platform approvals) + **#37** (E2E QA staging). Assign both once she accepts.
- **Deploy (#11) = PR #38 open** — Dockerfile + compose.prod + Caddy snippet + CI deploy workflow + docs/dev/DEPLOY.md. Target: REUSE the Postiz box **35.154.66.120** (own isolated PG/Redis, API 127.0.0.1:8990, Caddy → social.meegrowlabs.com). CODE done; HUMAN half = DNS A record + clone to /opt/meegrow-social + fill .env + Caddy reload + first `docker compose up`. Docker image build UNTESTED locally (daemon down) — first deploy validates. This unblocks the OAuth callback URL → approvals.
- **#12 token-health = DONE** (PR #39 merged 2026-07-08). Was parked on feat/12-token-health; resumed + shipped.

## Next action

**Wave 2.** LESSON FROM WAVE 1: parallel worktrees produced 4 green PRs but heavy `server.ts`/migration merge friction. Preference going forward — SERIALIZE issues that touch `apps/api/src/server.ts`, `packages/core/src/services/posts.ts`, or migrations; only fan out truly disjoint work.

- Unblocked AFK now: **#8 api-keys** (server.ts — serialize), **#6 webhooks** (server.ts + publish.ts — serialize; consumes #12's webhook_deliveries outbox), **#9 analytics collection** (adds accountAnalytics to SocialProvider — touches sealed core, lean HITL). **#36** hardening (db only — safe to parallelize).
- **#12, #10, #5 = DONE (PRs #39/#40/#5).** #5 unblocks #16's Posts edit/cancel.
- NEXT: **#16 dashboard** (large SPA build — Vite+React today has NO Tailwind/shadcn/router/typed-client yet; must add all of that + Connections/Composer/Posts pages). afk-label but dispatch is env-blocked (see GOTCHA above) → inline. All blockers (#2/#3/#4/#5/#10) now merged.
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
