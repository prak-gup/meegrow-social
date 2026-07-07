# PRD — Meegrow Social

**Status:** APPROVED 2026-07-06 (Phase 4 gate passed — client login kept in v1; X built-but-flagged)
**Owner:** Prakhar (Meegrow Labs)
**Last updated:** 2026-07-06
**Upstream:** `docs/dev/GRILL_NOTES.md`, `docs/dev/RESEARCH.md`

---

## 1. Problem statement

Meegrow runs social publishing for a growing roster of agency clients (Antidote, Ecolive, GLS,
Mlearn, Empower & Shine) primarily _programmatically_ — the antidote bot generates content and pushes
it to social platforms. Today that runs on two rented/borrowed pieces:

- **Zernio** — a paid third-party platform Meegrow drives via per-client API keys. It works, but
  Meegrow doesn't own the roadmap, the data, or the pricing, and can't extend it (e.g. MCP access,
  bespoke workflows).
- **Self-hosted Postiz** — open-source, but heavy to operate (Temporal + Elasticsearch + two Postgres
  for a scheduler), with a weak API/webhooks/logs surface and no clean per-client tenancy.

Prakhar's words: _"the current Postiz one sucks."_ The pain is concrete: **no real client tenancy,
heavy/fragile ops, a weak API + logs/observability surface, and mediocre publishing UX** — plus no
first-class way to let AI agents (Claude Code, Cowork, Codex, antidote) drive it.

**We are building a Meegrow-owned publishing platform** that replaces both, is cheap and boring to
operate, is **API- and MCP-first** (agents are first-class users), and has genuine multi-tenant client
workspaces from day one.

The hard part is not the code — the provider integration shape is well understood (we extracted it from
Postiz's source). The hard part is **platform approvals** (Meta App Review, Google GBP access + OAuth
verification, LinkedIn Community Management API), which we already partly own and must progress in
parallel with the build.

## 2. Solution overview

**Meegrow Social** — a multi-tenant social media publishing platform at `social.meegrowlabs.com`.

- **Interfaces (all equal-class):** a REST API and a hosted MCP server (both authenticated by
  per-workspace API keys) so antidote and coding agents drive it directly; plus a web dashboard for
  humans (invite-only, email+password + Google SSO).
- **Core capability (v1):** connect social accounts (with token-health visibility), organize them into
  per-client **workspaces/profiles**, compose **posts** (images + video/reels, per-platform variants,
  drafts), **schedule** them via queues / exact datetime / calendar, **publish** reliably, and
  **collect analytics** from day 0.
- **Platforms at launch:** Instagram + Facebook (Meta, already approved) and Google Business Profile
  (posting works today). LinkedIn, X, and YouTube providers are built but **flag-gated on their
  external approvals**; X is additionally deprioritized (now metered/expensive).
- **Ops principle:** Postgres + Redis only. No Temporal, no Elasticsearch. One EC2 + docker compose.
- **Design principle:** the posts data model is **template-engine-ready from v1**, so a Blotato-style
  "winning posts" module is a clean post-v1 bolt-on (a producer that writes drafts into the posts API),
  not a rebuild.

**Cutover:** antidote publishes via the new API/MCP for all five client workspaces alongside Zernio for
a **2-week parallel run**; zero missed/failed posts → cancel Zernio and decommission Postiz.

## 3. Users & personas

- **P1 — The antidote bot / AI agents (primary).** Machine clients using an API key. Create/schedule
  posts in bulk, attach media, read analytics, react to webhooks. Value: a clean, stable, well-logged
  API + MCP. This is how ~all content flows today.
- **P2 — Prakhar / Meegrow operator.** Human running the agency. Connects accounts, fixes token health,
  reviews queues/calendar, manages workspaces + API keys + team, reads analytics. Value: Zernio-level
  UX without Zernio's rent or Postiz's ops.
- **P3 — Client user (light, later in v1).** A client logging into their own workspace to view/schedule
  their content. Value: a branded, scoped view. (No self-serve signup or billing in v1.)

## 4. User stories

Connections & token health

1. As P2, I connect an Instagram/Facebook/GBP account via OAuth and see it listed as "connected" in a workspace.
2. As P2, I see each connection's **token health** (valid? expires in N days? needs reconnect?) at a glance, like Zernio's Account Health.
3. As P2, when a token is expiring or broken, the system refreshes it automatically where possible, and flags it for reconnection where not.
4. As P2, during connect I pick which Page / Organization / Channel / Location this connection targets (two-phase OAuth).

Workspaces & tenancy 5. As P2, I create a **workspace per client** and assign connections + API keys to it; data never leaks across workspaces. 6. As P2, I invite a teammate or client to a workspace with a role (owner/admin/member/viewer).

Composing & scheduling 7. As P1/P2, I compose a post with text + media and choose one or more connected accounts; I can set **per-platform variants** (different caption/media per platform) in one post-group. 8. As P1/P2, I attach **images or video/reels**; the system validates format/specs and stores media (public URL for platforms that require it). 9. As P1/P2, I save a post as a **draft**, schedule it for an exact datetime, or **add it to a queue** that fills the next open time-slot. 10. As P2, I manage per-profile **queues** with timezone-aware weekly slots. 11. As P2, I view scheduled/published/failed posts in **grid, list, and calendar** views and filter by profile/platform/status/date. 12. As P1/P2, I bulk-create posts programmatically via API/MCP (e.g. a month of content in one call / import CSV).

Publishing engine 13. As the system, I publish each post at its scheduled time to each target platform, handling multi-step flows (IG container→publish, LinkedIn upload→attach, YouTube resumable upload). 14. As the system, on failure I **retry with backoff**; on unrecoverable auth failure I mark the connection "needs reconnect" and stop, surfacing why. 15. As P2, I see the outcome of every publish (success + live URL, or failure + reason).

Analytics 16. As the system, I poll per-post metrics + follower counts on a cadence from day 0 and store them (history compounds). 17. As P1/P2, I read a post's metrics (likes/comments/views/reach — flexible per platform) and a workspace's follower trend, via dashboard and API.

API, MCP, keys, webhooks, logs 18. As P2, I create/revoke **per-workspace API keys** (scoped, prefixed, shown once) for the API + MCP. 19. As P1, I connect a coding agent (Claude Code/Cowork/Codex) to the **MCP server** with an API key and perform the same capabilities as the REST API. 20. As P1, I register **webhooks** and receive signed events (post.published, post.failed, connection.needs_reconnect, analytics.updated) with retries. 21. As P2, I inspect a filterable **logs** view of API requests + publishing/connection/webhook events (status, route, account, duration, error).

Cutover 22. As P2, I run the new platform in parallel with Zernio across all 5 client workspaces and confirm zero missed/failed posts before cancelling Zernio.

## 5. Functional requirements

### F1 — Connections & OAuth

- F1.1 OAuth connect flow per provider; store tokens encrypted; support two-phase (`isBetweenSteps`) Page/Org/Channel/Location selection.
- F1.2 Token-health model: validity, expiry, `needsReconnect`; surfaced in dashboard + API; computed via provider token-debug where available.
- F1.3 Automatic token refresh (scheduled sweeper) for refreshable providers; flag non-refreshable (LinkedIn) before expiry; mark broken tokens on 401.
- F1.4 Disconnect / reconnect.
- F1.5 Provider set: **v1 live** = Instagram (via Page), Facebook Pages, Google Business (gmb). **v1 flag-gated** = LinkedIn (personal + page), X, YouTube. Provider interface must make adding one = implement one interface + register.

### F2 — Workspaces, teams, auth

- F2.1 Multi-tenant workspaces; every row scoped by `workspace_id`; tenant resolved from API key/session, never from request body.
- F2.2 Human auth: email+password + Google SSO; **invite-only** (no public signup).
- F2.3 Roles: owner / admin / member / viewer, enforced per workspace.
- F2.4 (Non-goal for v1: billing, self-serve signup — but schema leaves the door open.)

### F3 — Posts, media, scheduling

- F3.1 **Post-group** model with **per-platform child variants** (per-platform caption/media/settings); first-class **draft** state.
- F3.2 Content types: single image, multi-image/carousel, video/reel/short, text, thread (array-based), link; per-platform character/media limits validated pre-publish.
- F3.3 **Media library**: upload images + video to S3; validate format/aspect/size/length per target platform; expose public URLs (required by IG/GBP); basic transcode/format check (no editing).
- F3.4 Scheduling modes: exact datetime; **queue** with per-profile timezone-aware weekly slots (add-to-queue → next slot); immediate publish.
- F3.5 Post states: draft / scheduled / publishing / published / failed / cancelled; edit/cancel a scheduled post (interrupt the pending job).
- F3.6 Views: grid, list, calendar; filters (profile/platform/status/date/user).
- F3.7 Bulk creation via API/MCP + CSV import.

### F4 — Publishing engine (durable jobs)

- F4.1 Durable scheduled publish via BullMQ delayed jobs (timer survives restarts); per-account concurrency isolation; idempotent (no double-post).
- F4.2 Retry policy with exponential backoff + jitter; max attempts; typed provider errors branch retry vs reconnect-and-fail; dead-letter for exhausted jobs.
- F4.3 Per-provider publish adapters implementing the shared `SocialProvider` interface (multi-step flows handled internally).
- F4.4 Record publish result (live URL or error) on the post; emit webhook.

### F5 — Analytics

- F5.1 Scheduled workers poll per-post metrics + account follower counts on a cadence (respecting each platform's data-lag), from day 0.
- F5.2 **Flexible key-value metric store** (no hardcoded `impressions`); per-platform metric sets; time-series retained.
- F5.3 Read APIs + dashboard: per-post metrics, follower trend per workspace. (Rich dashboards = post-v1.)

### F6 — API + MCP + keys

- F6.1 REST API over a shared `core` service layer; versioned; OpenAPI derived from shared contracts.
- F6.2 Hosted **MCP server** (Streamable HTTP) exposing task-shaped tools over the same `core`; authenticated by API key bearer.
- F6.3 Per-workspace API keys: `sk_live_...` prefix, SHA-256 hashed at rest, shown once, scoped, revocable, expiry; keys authorize both REST + MCP.
- F6.4 REST and MCP are thin adapters — **no business logic** outside `core` (no split-brain).

### F7 — Webhooks

- F7.1 Register/manage webhook endpoints per workspace; event types (post.published/failed, connection.needs_reconnect, analytics.updated, etc.).
- F7.2 Signed payloads (HMAC, id+timestamp+signature headers), async delivery, backoff retries, DLQ + replay (Svix pattern).

### F8 — Logs & observability

- F8.1 API request log + event log (publishing, connections, webhooks) persisted and queryable.
- F8.2 Filterable logs UI: time, status, route/activity, platform, account, duration, error message — Zernio's Logs screen is the bar.

### F9 — Antidote integration (cutover)

- F9.1 A `SocialProvider` adapter in antidote targets the new API/MCP (clean new contract, not Zernio-shaped).
- F9.2 Map the 5 existing Zernio API keys → 5 workspaces; verify parity; support the 2-week parallel run.

## 6. Non-goals (v1)

- Unified **Inbox** (messages/comments/reviews) — **v2** (Empower & Shine's DM volume justifies it next).
- **Ads**, **WhatsApp/Numbers**, **Workflows**, **Broadcasts/Sequences**, **Contacts/CRM** — later or never.
- **Blotato-style template/winning-posts engine** — post-v1 module (v1 only guarantees the posts model doesn't block it).
- **Self-serve signup + billing** — not in v1 (schema-compatible, not built).
- **Client approval workflow** (client approves draft before publish) — v1.1 (antidote has its own approval loop).
- **In-app AI content/image generation** — stays in antidote; platform accepts media, doesn't create it.
- Platforms beyond the 8 named (Threads, TikTok, Pinterest, Reddit, Bluesky, Telegram, Discord) — later, cheap to add via the provider interface.

## 7. Milestones

- **M0 — Tracer bullet (walking skeleton, HITL).** One vertical slice through every architectural layer:
  connect one Instagram (or FB) account → create a post via API → schedule via BullMQ → publish to the
  real platform → record result → read it back via API + MCP. Proves the monorepo, provider interface,
  job engine, tenancy, and API/MCP seam on a tiny codebase. **Also validates the AX-PRD decisions.**
- **M1 — Publishing core (Meta).** Full IG + FB providers (images + video/reels, per-platform variants,
  drafts), queues + calendar + all post states, media library, token-health + refresh, logs, webhooks,
  API keys, dashboard for connections + posts. Analytics collection running.
- **M2 — GBP + multi-workspace + team.** Google Business provider; workspaces/roles/invites; Google SSO;
  the 5 client workspaces provisioned; antidote adapter built.
- **M3 — Flag-gated providers + approvals.** LinkedIn + YouTube providers behind flags, turned on as
  approvals land; X provider with cost-accounting (deprioritized). Approval workstream tracked from M0.
- **M4 — Analytics UI + hardening.** Per-post metrics + follower trend UI; RLS on; DLQ/replay; load/QA.
- **M-launch — Parallel run & cutover.** 2-week parallel run across 5 workspaces → cancel Zernio,
  decommission Postiz.
- **Post-v1:** ① Blotato-style template engine ② unified Inbox ③ richer analytics dashboards.

Each milestone = a label on the issue tracker (not a phase doc). Each ships behind passing feedback
loops (types, tests, CI) and ends with a QA issue.

## 8. Success metrics

- **Cutover:** Zernio cancelled + Postiz decommissioned with zero missed/failed scheduled posts during a
  14-day parallel run across all 5 workspaces.
- **Cost:** monthly infra ≤ ~$30 (one EC2 + S3) vs current Zernio subscription + Postiz box.
- **Ops:** services = {app, worker, Postgres, Redis, Caddy}; no Temporal/ES.
- **AX:** antidote + a coding agent can perform the full create→schedule→publish→read loop via API and
  via MCP with an API key.
- **Extensibility:** adding a new platform = implement the `SocialProvider` interface + register (no core
  changes); adding the template engine later requires no posts-schema migration.

## 9. Key risks

- **External approvals slip** (Meta review, GBP access/QPM, Google OAuth verification, LinkedIn CMA).
  _Mitigation:_ launch on already-approved integrations; flag-gate the rest; start all approval requests
  at M0.
- **IG public-URL + 24h container expiry** and **metric-name deprecations** (`impressions→views`).
  _Mitigation:_ S3 public media URLs; flexible key-value metric store.
- **X economics** (metered, $0.20/link-post). _Mitigation:_ deprioritize; cost-accounting; not a launch dep.
- **Scope creep toward full Zernio parity.** _Mitigation:_ v1 is publishing-core only; non-goals explicit.
