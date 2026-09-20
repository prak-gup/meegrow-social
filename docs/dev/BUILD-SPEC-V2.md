# BUILD SPEC v2 — completing meegrow-social

**Date:** 2026-09-21 · **Status:** authoritative build spec for everything still to be developed
**Reads with:** `PRD.md` (what/why) · `AX-PRD.md` (one-way doors) · `RESEARCH.md` + `research/*` (platform facts) · `STATE.md` (running log)
**Replaces:** nothing. `PRD.md` stays the product contract; this file is the *implementation* contract for M2 → cutover.

Written after a full audit of the code as it stands on `main@a62d9f5` and a full read of the
Mixpost feature surface (docs.mixpost.app sitemap + mixpost.app/features + /pricing + /mcp/tools),
which is the closest thing to a reference implementation of "the whole product" in this category.

---

## 0. Where we actually are

Verified by reading the code, not the docs.

| Layer | State on `main` | Evidence |
|---|---|---|
| Spine | pnpm+Turborepo; `contracts`/`db`/`core`/`testing` + `api`/`worker`/`web` | repo root |
| Tenancy | FORCE RLS on 10 tenant tables, app runs as non-superuser `mgs_app`, CI test blocks merge | `packages/db/src/schema.ts` `TENANT_TABLES`, `rls.integration.test.ts` |
| Providers | **facebook + instagram live**; `gmb/linkedin/linkedin-page/x/youtube` are reserved identifiers with **zero implementation** | `providers/registry.ts`, `providers/meta/*` |
| Provider contract | sealed and complete (auth → listAccounts → finalizeAccount → refresh → assertPublishable → post → postAnalytics → accountAnalytics) | `providers/types.ts` |
| Per-platform options | `meta` / `gmb` / `youtube` arms shipped in contracts + stored in `posts.options` | `contracts/src/posts.ts` (#44/#59) |
| Publishing | create → schedule (BullMQ) → worker → provider → `releaseUrl`/`externalPostId`; cancel/edit; DST-correct queues | `services/{posts,publish,queues,scheduler}.ts` |
| Media | upload + register-from-URL, disk/S3 drivers, ffprobe validate-and-reject | `services/media.ts` |
| Analytics | sweeper + flexible key-value `metrics` table + read APIs. **No UI** | `services/analytics.ts` (#9), #28 open |
| Webhooks | outbox rows written; **no signed delivery drainer** | `services/webhooks.ts`, #6 open |
| Agent surface | REST `/v1` (36 paths) + API keys + **MCP with 5 tools** | `apps/api/src/{server,mcp}.ts` |
| Dashboard | Airbnb-DLS; Overview / Clients / Connections / Composer / Posts / Invite | `apps/web/src/pages/*` |
| Dead code found | `posts.idempotency_key` column exists and is **never written or read** | grep: only hit is a comment in `fake.ts` |

**One line:** M1 (Meta) is ~85% done and live; M2/M3 is 0% and has been 0% for eight weeks because
every item in it is downstream of external approvals that nobody is pushing.

---

## 1. Scope

**In scope (this spec builds all of it):**
A. External approvals · B. Providers: GBP (+reviews), LinkedIn, YouTube, X · C. Content-ops parity
(tags, templates, first comment, hashtag groups, variables) · D. Agent surface (MCP 5→22, idempotency,
webhook delivery) · E. Antidote cutover · F. Dashboard completion + approval gate · G. Hardening.

### Decisions taken 2026-09-21 (do not re-litigate without a reason)

- **Clients log in. Reversed 21 Sep, same day** — the first call was operator-only; it lasted an hour.
  What this binds:
  - **#20 gains a `client` role**, scoped to exactly one workspace. Default permissions: read the
    calendar, read published content, read analytics. Never: connections, API keys, logs, review
    replies, other workspaces. The matrix is data-driven, so widening a client's rights later is a
    row, not a migration.
  - **#68's approver is a permission, not a person.** `workspaces.approver_role` decides whether an
    internal member or the client clears the gate. Build the gate against the permission from the
    start — retrofitting "who may approve" into a shipped approval flow is the expensive version.
  - **A client-facing view of the dashboard is now in scope**: the same screens with a stripped nav
    and no operator affordances. It is not a second app and not a second auth surface — one login,
    one session table, one set of pages, role-gated.
  - **Basic white-label returns** (workspace name + logo in the client view). Full theming stays out.
  - **Consequence to watch, stated plainly:** if the client is the approver, *their* response time
    becomes our publishing latency. Keep an internal override so a post can still go out when the
    client goes quiet, and make the queue show who it is waiting on.

- **The UI is locked** to the seven screens in the design canvas (Overview, Composer, Calendar,
  Content, Analytics, Reviews, Connections). Build against them; iterate on real screens with real
  client data, not on mockups.
- **Ownership split:** Anshul takes #63, #15, #28, #69 — the four that teach the layers he has to own
  (migrations+RLS, the core/MCP seam, read models, the options contract). An agent run takes the three
  mechanical ones (#57, #36, #66) in isolated worktrees with cross-vendor review. #6 and the GBP work
  (#21, #62) stay with Prakhar's session: they touch `server.ts`/the worker, or need a human holding
  the Google account.

**Out of scope, deliberately, with the reason:**

| Not building | Why |
|---|---|
| In-app AI assistant / image gen | antidote owns generation and brand voice (`ContextBuilder` → `workspace/*.md`). Duplicating it here would create a second voice store. |
| Engagement inbox (comments/mentions/DMs) | PRD v2. Nothing in the cutover needs it. Revisit when Empower & Shine's DM volume forces it. |
| Billing / subscriptions / customer dashboard | Only needed if meegrow-social is *sold*. Schema stays compatible; nothing is built. |
| SSO (OIDC), 2FA, i18n (17 languages) | Single-tenant operator team of 2–3. Cost ≫ value. |
| White-label branding | We *are* the brand. |
| Mastodon, Bluesky, Pixelfed, Threads, TikTok, Pinterest | No client demand. Each is ~1 day once wanted — the provider interface is the whole point. |
| URL shortener integrations (Bitly/Shlink/YOURLS) | UTM tagging at content-generation time in antidote already covers attribution. |

---

## 2. Invariants — these constrain every item below

1. **A new platform = implement `SocialProvider` + `registerProvider`.** Nothing else changes. If an
   item in this spec seems to require editing `contracts/src/posts.ts` for a platform, re-read it:
   shape lives in contracts, *semantics* live in the provider's `assertPublishable`.
2. **`apps/*` hold zero business logic.** REST and MCP both call `core`. Enforced by
   `scripts/guardrails.sh` + the ESLint no-`fetch` rule.
3. **Tenant isolation is DB-enforced.** Every new tenant table goes in `TENANT_TABLES` and gets RLS in
   `migrate.ts`, plus a case in `rls.integration.test.ts`. A new table without an RLS test is a bug.
4. **A fake must not define a more permissive contract than the real adapter.** The BullMQ colon bug
   (PR #47) survived 109 green tests because the recording scheduler accepted ids the real one
   rejected. Every new port gets one integration test against the real thing.
5. **Serialize anything touching `apps/api/src/server.ts`, `core/services/posts.ts`, or migrations.**
   Wave 1's four parallel worktrees produced green PRs and ugly merges. Fan out only disjoint work.
6. **Approval is a `gate` field, not a store.** (Doctrine imported from antidote's architecture freeze:
   a vocabulary difference is a `type`/`gate` field, never a new table.)
7. **Metric names stay provider-native.** Never normalise into an enum; platforms rename
   (`impressions`→views, `page_fans`→`followers_count`).
8. **Media for GBP/IG is URL-only.** Public S3 URL, never a binary upload. Already true of our storage.
9. **Every consolidation ships a kill.** Nothing in §7 is "done" until the thing it replaces is off.

---

## 3. Workstream A — External approvals (blocks everything; zero code)

This is the entire reason the project has not moved since July. Nothing in B/E can be verified live
without it, and **buying a different product would not skip a single item here** — Mixpost, Postiz and
Late all run on *your own* platform apps too.

### A1 · Google Business Profile v4 access grant — **do this first**
The legacy v4 host (`mybusiness.googleapis.com`) that owns Local Posts, Reviews and Media ships at
**0 QPM**, not "low quota". Enabling the API in Cloud Console does nothing on its own.

1. In Cloud project **"Meegrow Social"**, enable all four: `Google My Business API` (appears only
   after approval), `My Business Account Management API`, `My Business Business Information API`,
   `Business Profile Performance API`.
2. Submit the [GBP API access request](https://developers.google.com/my-business/content/prereqs)
   with the **Project Number** (not ID), from an account that is owner/manager on a GBP that is
   verified and 60+ days old with a website → use a Meegrow-owned or JEDH profile.
3. Approval flips 0 → 300 QPM, project-wide across read+write. Turnaround: days to weeks.
- **Owner:** human. **Evidence of done:** a `localPosts.list` call returns 200 rather than 403.
- Draft text is already written in **PR #60** (mergeable, CI green, open since 28 Jul). Merge it.

### A2 · Google OAuth verification (sensitive scope) — blocks GBP *and* YouTube
`business.manage` is a sensitive scope. While the consent screen is unverified/Testing, **Google
expires every refresh token after 7 days** — every client GBP connection dies weekly. Publish the app
and pass verification (app details, domain ownership, demo video). Weeks of lead time.
- **Until verified:** GBP connections are usable only for test users and only for 7-day stretches. The
  `token-health` sweeper will surface them as `needs_reconnect`; that is correct behaviour, not a bug.
- One OAuth client serves both GBP and YouTube — register both redirect URIs on it
  (`https://social.meegrowlabs.com/connect/callback`).

### A3 · Meta: Advanced Access for 7 scopes + Tech Provider verification (#53)
Business verification is **already done** (portfolio Meegrowlabs.com, ID 785314568581019, Verified).
The open gate is Tech Provider access verification + App Review for advanced access. Without it we are
limited to Pages/IG accounts whose admins are app testers — fine for the 5 current clients, fatal for
client #6.

### A4 · LinkedIn Community Management API (#24 dependency)
Vetting application for the LinkedIn app. Longest, least predictable. Start it and forget it.

**Blocking map:** A1+A2 → B1 (GBP) → E (cutover, since GBP is why 3 of the 5 clients exist).
A2 → B4 (YouTube). A3 → client #6 onward. A4 → B3 (LinkedIn).

---

## 4. Workstream B — Platform providers

### B1 · Google Business Profile (`gmb`) — issue #21

The contract half is **already shipped** (`gmbOptions` in `contracts/src/posts.ts`: `topicType`
STANDARD/EVENT/OFFER/ALERT, `cta`, `event`, `offer`). What is missing is the provider and the Google
OAuth client. Our options schema is already richer than Mixpost's (they lack `ALERT`, and they carry
dates as loose strings).

#### Files

```
packages/core/src/providers/google/client.ts   NEW  GoogleOAuthClient + error mapping (shared with YouTube)
packages/core/src/providers/google/gbp.ts      NEW  GbpProvider implements SocialProvider
packages/core/src/providers/google/gbp.test.ts NEW  unit: options rules, request shaping, error mapping
packages/core/src/providers/registry.ts        EDIT register when GOOGLE_CLIENT_ID/SECRET present
packages/core/src/index.ts                     EDIT export the two new modules
.env.production.example                        EDIT GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
```

#### `GoogleOAuthClient`

| Method | Call |
|---|---|
| `authUrl({redirectUri, state, scopes})` | `https://accounts.google.com/o/oauth2/v2/auth` + `response_type=code`, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, `state` |
| `exchangeCode({code, redirectUri})` | `POST https://oauth2.googleapis.com/token` (`grant_type=authorization_code`) |
| `refresh(refreshToken)` | same endpoint, `grant_type=refresh_token` |
| `authed<T>(host, path, init, token)` | typed fetch + `mapGoogleError` |

`mapGoogleError(status, body)` — the taxonomy the scheduler branches on:
- `401`, or `400 invalid_grant` on refresh → **`ProviderAuthError`** (→ `needs_reconnect`, no retry)
- `403` whose message matches `has not been used in project|PERMISSION_DENIED|quota` → **`ProviderBadRequestError`**
  with the message *"GBP v4 access not granted for this project — see BUILD-SPEC-V2 §A1"*.
  **This case matters:** the 0-QPM gate returns 403, and a naive mapping treats it as transient and
  retries forever against a wall.
- `400`/`404`/`409` → `ProviderBadRequestError` · `429`/`5xx` → `ProviderTransientError`

#### `GbpProvider` fields

```ts
identifier = 'gmb'; displayName = 'Google Business Profile';
isBetweenSteps = true;          // user picks a location
tokenModel = 'auto-refresh';    // refresh token mints access tokens (long-lived only once A2 clears)
maxConcurrentJobs = 2;          // 300 QPM is shared project-wide across read+write
```

#### Methods

- **`generateAuthUrl`** — scope `https://www.googleapis.com/auth/business.manage` (one scope covers
  posts, reviews, locations, performance).
- **`authenticate`** — returns `{accessToken, refreshToken, expiresAt: now+expires_in, externalId:'pending', displayName:'pending'}`.
  If `refresh_token` is absent (user re-consenting), throw `ProviderAuthError` naming `prompt=consent`.
- **`listAccounts`** —
  `GET mybusinessaccountmanagement.googleapis.com/v1/accounts` → for each,
  `GET mybusinessbusinessinformation.googleapis.com/v1/{account}/locations?readMask=name,title,storefrontAddress`.
  **`externalId` is the composite resource path `accounts/{a}/locations/{l}`** — v4 needs both ids and
  we get exactly one string to keep. `displayName` = `title` + locality.
- **`finalizeAccount`** — *omitted*. Locations publish with the user token; there is no per-location
  token swap (unlike Facebook Pages).
- **`refreshToken`** — via the shared client. After A2 these are effectively non-expiring.
- **`assertPublishable(details)`** — all of it, at create time:

| Rule | Error |
|---|---|
| `details.length === 1` | "GBP has no thread concept" |
| `caption` non-empty, ≤ **1500** chars | keep the actionable text in the first ~100 (Google truncates the card) |
| ≤ 1 media item, and it **must** carry a public `url` | "GBP media is URL-only (`sourceUrl`)" |
| `cta.actionType === 'CALL'` → `cta.url` absent | "the CALL button uses the location's phone number" |
| any other `actionType` → `cta.url` required | |
| `topicType === 'EVENT'` → `event` required, `end > start`, `title` ≤ 58 | |
| `topicType === 'OFFER'` → `event` required (offers carry the schedule); `offer.*` allowed | |
| `offer` present on a non-OFFER post | reject |

- **`post`** — `POST https://mybusiness.googleapis.com/v4/{externalId}/localPosts`

```jsonc
{
  "languageCode": "en",
  "summary": "<caption>",
  "topicType": "STANDARD|EVENT|OFFER|ALERT",
  "callToAction": { "actionType": "LEARN_MORE", "url": "https://…" },
  "media": [{ "mediaFormat": "PHOTO", "sourceUrl": "https://…s3…" }],
  "event": { "title": "…", "schedule": { "startDate": {…}, "startTime": {…}, "endDate": {…}, "endTime": {…} } },
  "offer": { "couponCode": "…", "redeemOnlineUrl": "…", "termsConditions": "…" }
}
```
  Response `name` (`accounts/*/locations/*/localPosts/*`) → **`externalPostId`**; `searchUrl` →
  `releaseUrl`. A response `state` of `PROCESSING` is success, not an error. `REJECTED` is a
  `ProviderBadRequestError` — surface Google's reason verbatim into `posts.error`.

- **`postAnalytics`** — `POST /v4/{parent}/localPosts:reportInsights` with `localPostNames:[…]` and
  `basicRequest.metricRequests` = `LOCAL_POST_VIEWS_SEARCH`, `LOCAL_POST_ACTIONS_CALL_TO_ACTION`, over a
  trailing window. Store names verbatim.

- **`accountAnalytics`** —
  `GET businessprofileperformance.googleapis.com/v1/{location}:fetchMultiDailyMetricsTimeSeries`
  with `dailyMetrics=` `BUSINESS_IMPRESSIONS_DESKTOP_MAPS`, `BUSINESS_IMPRESSIONS_DESKTOP_SEARCH`,
  `BUSINESS_IMPRESSIONS_MOBILE_MAPS`, `BUSINESS_IMPRESSIONS_MOBILE_SEARCH`, `WEBSITE_CLICKS`,
  `CALL_CLICKS`, `BUSINESS_DIRECTION_REQUESTS`, `BUSINESS_CONVERSATIONS`, `BUSINESS_BOOKINGS`,
  daily granularity, trailing 2 days (idempotent re-sweep).
  ⚠ **GBP has no follower count.** The Overview card and `/v1/connections/:id/followers` must render
  "—" for `gmb` rather than 0. Fix in `services/overview.ts` at the same time.

#### Tests
Unit with recorded fixtures for: every `assertPublishable` row (table test), request-body shaping for
all four `topicType`s, the 0-QPM 403 mapping, `invalid_grant` → auth error, composite-`externalId`
round-trip. No CI integration test (no live creds in CI) — live bring-up is the HITL gate below.

#### Live bring-up (HITL, after A1+A2) — mirrors the IG bring-up that caught real bugs
1. Connect one real location via the dashboard; confirm the location picker lists it.
2. Publish `STANDARD` + CTA → confirm the card on Google Search/Maps; confirm `releaseUrl` opens it.
3. Publish `EVENT` and `OFFER` → confirm dates render.
4. Run the analytics sweeper → confirm which `DailyMetric` names actually return data, and **record
   real fixtures from that traffic** (the Meta lesson: `post_impressions_unique` was rejected live
   while every fixture said it was fine).
5. Leave a connection idle 8 days → confirm the 7-day refresh-token trap is gone post-verification.

**Effort:** ~2 days code + tests, once A1/A2 land. Estimated 450–600 LOC.

### B2 · GBP Reviews — new issue, "the thing Mixpost doesn't have"

Same host, same scope, no extra approval beyond A1. This is the highest-value GEO surface we could
own and no competitor product in this category ships it.

- `GET /v4/{parent}/reviews` · `POST /v4/{accountId}/locations:batchGetReviews` ·
  `PUT /v4/{parent}/reviews/{id}/reply {comment}` (upsert) · `DELETE …/reply`
- Reviews are **not posts** — do not force them into `posts`. New tenant table `gbp_reviews`
  (`id, workspace_id, connection_id, external_id UNIQUE, star_rating, comment, reviewer_name,
  created_time, updated_time, reply_comment, reply_updated_time, replied_by, synced_at`).
- Sweeper: extend the analytics worker with a daily `syncReviews` pass (batch reads).
- API: `GET /v1/reviews?connectionId&unreplied=true`, `POST /v1/reviews/:id/reply`.
- MCP: `list_reviews`, `reply_to_review` → **this is what makes antidote able to draft review replies
  in the client's voice and leave them for human approval.** Gate replies behind §6's approval field.
- **Effort:** ~1.5 days. **Do it immediately after B1** while the v4 surface is fresh.

### B3 · LinkedIn (`linkedin`, `linkedin-page`) — issue #24
Blocked on A4. `POST /rest/posts` (`author` = person or org URN), media via
`initializeUpload → PUT binary → attach asset URN`, `visibility` PUBLIC/CONNECTIONS mapped from a new
`linkedin` options arm. 60-day tokens, refresh **requires** approved CMA → `tokenModel: 'refresh-cron'`
if granted, `'one-time'` if not — decide at bring-up, not now. Two identifiers share one class with a
`variant` constructor flag. ~2 days.

### B4 · YouTube (`youtube`) — issue #25
Blocked on A2 only (same OAuth client as GBP). Options arm **already shipped**. `videos.insert`
resumable upload; quota is 1,600 units per upload against a 10,000/day default → **max ~6 videos/day
project-wide**; make that a hard pre-flight check with a clear error, not a 403 at publish. Note the
compliance caveat already in the contract: uploads lock to `private` until the audit clears, so the
provider must read the status back rather than trust the request. Retention: issue #61 (YouTube
Developer Policies III.E.4 — metrics rows must not outlive 30 days) → add a retention job in the same
PR. ~2 days.

### B5 · X (`x`) — issue #26, deprioritized
Metered ($0.20/link-post). Build only with cost-accounting: a per-workspace monthly cap in
`workspaces.meta`, checked in `assertPublishable`. Not a launch dependency. ~1 day.

---

## 5. Workstream C — Content-ops parity

The five things an operator opens Zernio for that our composer cannot do. All are small; all are
pure additions; none touches a provider.

### C1 · Tags / labels
```sql
CREATE TABLE tags (id uuid pk, workspace_id uuid not null, name text not null,
                   hex_color text not null, created_at timestamptz not null default now(),
                   UNIQUE (workspace_id, name));
CREATE TABLE post_group_tags (group_id uuid references post_groups(id) on delete cascade,
                              tag_id uuid references tags(id) on delete cascade,
                              workspace_id uuid not null, PRIMARY KEY (group_id, tag_id));
```
Both into `TENANT_TABLES` + RLS + an `rls.integration.test.ts` case.
Contracts: `contracts/src/tags.ts` (`tagView`, `createTagInput`, `updateTagInput`).
Core: `services/tags.ts` — `createTag`, `listTags`, `updateTag`, `deleteTag`, `attachTags`, `detachTags`.
API: `POST/GET /v1/tags`, `PATCH/DELETE /v1/tags/:id`, `POST/DELETE /v1/post-groups/:id/tags`.
`listPostsQuery` gains `tagId`. Tags attach to the **group**, not the per-platform child — one
campaign label across all platforms is the whole point.

### C2 · Post templates
```sql
CREATE TABLE post_templates (id uuid pk, workspace_id uuid not null, name text not null,
  caption text not null default '', media jsonb not null default '[]'::jsonb,
  options jsonb, provider text, created_by uuid, created_at timestamptz not null default now());
```
`POST /v1/templates`, `GET /v1/templates`, `POST /v1/templates/:id/instantiate` → returns a
`createPostInput` body (does **not** create the post — the caller still composes and schedules).
Keeping instantiate pure is what stops this becoming a second posting path.

### C3 · First comment
`posts.first_comment text` (nullable). Published by the provider **after** the main post, in the same
`post()` call, best-effort: a failed first comment logs a warning and does **not** fail the post
(the post is live; failing it would be a lie). Supported on `facebook`, `instagram`, `linkedin*`;
`assertPublishable` rejects it elsewhere.

### C4 · Hashtag groups
```sql
CREATE TABLE hashtag_groups (id uuid pk, workspace_id uuid not null, name text not null,
  tags text[] not null default '{}', created_at timestamptz not null default now());
```
Pure convenience: CRUD + the composer inserts the joined string. No publish-path involvement.

### C5 · Dynamic variables
`core/services/variables.ts` — one pure function
`renderVariables(text: string, ctx: VariableContext): string`, supporting `{date}`, `{time}`,
`{weekday}`, `{month}`, `{workspace}`, `{custom.key}`.

**Resolved at PUBLISH time, not create time** — a post scheduled on Monday for Friday must say Friday.
Consequence to document in the UI: the composer preview renders against *now* and is labelled
"preview". `workspaces.meta.variables` holds the custom map. Unknown variable → left verbatim (never
throw at publish).

---

## 6. Workstream D — Agent surface (our actual differentiator)

Mixpost ships **26 MCP tools**; we ship 5. This is the one module where a competitor is ahead of us on
the axis we claim as our own, and it is also the cheapest gap to close — every tool is a thin wrapper
over a `core` service that already exists.

### D1 · MCP expansion 5 → 22 (#15)

| Tool | Core call | Notes |
|---|---|---|
| `list_workspaces` / `get_workspace` | `overview` | key-scoped: returns the one workspace |
| `list_connections` ✅ / `get_connection` | `connections` | include health + `expiresInDays` |
| `list_posts` ✅ (+ filters) | `listPosts` | expose status/provider/connectionId/from/to/limit/offset |
| `get_post` / `get_post_group` | `getPost`, `getPostGroup` | |
| `create_post` ✅ (+ media, multi-variant) | `createPost` | today it hardcodes `media: []` and one variant — fix both |
| `update_post` | `updatePost` | |
| `schedule_post` / `unschedule_post` | `updatePost` | tri-state `publishAt` already supports it |
| `cancel_post` / `delete_post` | `cancelPost` | |
| `duplicate_post` | new thin core fn | |
| `add_to_queue` ✅ / `list_queues` | `queues` | |
| `calendar` | `calendarPosts` | tz-aware buckets |
| `list_media` / `get_media` / `register_media_from_url` ✅ | `media` | |
| `post_metrics` / `connection_followers` | `analytics` | |
| `list_tags` / `create_tag` / `tag_post` | C1 | |
| `list_reviews` / `reply_to_review` | B2 | |

**Still deliberately absent: API-key management.** An agent authenticating *with* a key must not be
able to mint more (the existing comment in `mcp.ts` states the reasoning; keep it).

`apps/api/src/mcp.ts` is ~140 lines today and will be ~600. Split into `apps/api/src/mcp/` with one
file per noun (`posts.ts`, `media.ts`, `connections.ts`, `tags.ts`, `reviews.ts`) + `index.ts`. Still
zero logic — every handler is parse → `core` → JSON.

### D2 · Idempotency (kills a whole bug class) — ✅ SHIPPED (migration 0007)
- `POST /v1/posts` reads an `Idempotency-Key` header (≤255 chars); MCP `create_post` /
  `add_to_queue` take an `idempotencyKey` argument.
- **The key lives on `post_groups`, not `posts`** — corrected during implementation: one create makes
  one group and N per-platform children, so a unique key on `posts` collides with itself the moment a
  post targets two platforms. `posts.idempotency_key` (dead since 0000) was dropped.
- Partial `UNIQUE (workspace_id, idempotency_key)` + a 23505 rescue for the concurrent case; the
  pre-check runs *before* queue slotting so a replay cannot consume a second slot.
- A replay returns the **original** posts and writes nothing.

Why this matters more than it looks: on 2026-04-13 antidote's autopost loop published the same
creative to JEDH Instagram 8+ times in 6 minutes. Today the only guard is an **in-memory set** in
`antidote/tools/social.py` (`_AUTOPOST_RUN_ACTIVE`), which dies with the process. Moving the guarantee
into the platform makes it survive restarts, and makes *any* agent safe by construction — which is the
whole premise of an API-first product.

### D3 · Webhook delivery drainer (#6)
Outbox rows are already written by `services/webhooks.ts`. Build the drainer:
- BullMQ repeatable job (every 30s) → claim `pending` deliveries with `next_attempt_at <= now`
  (`FOR UPDATE SKIP LOCKED`) → POST with header
  `X-MGS-Signature: t=<unix>,v1=<hmac_sha256(secret, "t.body")>`.
- Retries 5×: 1m, 5m, 30m, 2h, 12h → then `status='failed'` + a `jobs_dlq` row.
- Events: `post.published`, `post.failed`, `post.scheduled`, `connection.needs_reconnect` (defined),
  `analytics.updated` (defined), `review.received` (new, from B2).
- `POST/GET/DELETE /v1/webhooks` endpoint CRUD + `POST /v1/webhooks/:id/test`.
- **Job-id rule:** `webhook-<deliveryId>`. No colons. (PR #47.)

---

## 7. Workstream E — Antidote cutover (#22, #31)

### E1 · The adapter
Antidote already has the seam: `antidote/antidote/antidote/social_providers.py` with
`get_social_provider_name()` returning `late` (default) / `postiz` / `zernio`, read from
`~/.antidote/clients/{slug}/client.json` → `social.provider`.

Add a fourth:
```python
class MeegrowSocialProvider:
    """meegrow-social via /v1 with a per-workspace API key."""
    # client.json:
    # "social": {"provider": "meegrow",
    #            "mgs_url": "https://social.meegrowlabs.com",
    #            "mgs_api_key": "sk_live_…"}
```
Methods mirroring `PostizProvider`: `list_accounts()` → `GET /v1/connections` ·
`post(...)` → `POST /v1/posts` with `Idempotency-Key: f"{client_id}:{run_id}"` ·
`upload_media(url)` → `POST /v1/media/register`.

**The `postiz_integration_ids` allowlist hack disappears.** Postiz needed it because one org held
every client's channels and a mis-scoped post could fan out across clients. Here the API key *is* the
workspace and RLS enforces it in the database — cross-client fan-out is impossible by construction.
Deleting that allowlist is the clearest single proof the new platform is better than the old one.

Alternative path, same key: antidote can talk to `/mcp` instead of `/v1`. Build the REST adapter
first (deterministic, testable); MCP is for the conversational surface.

### E2 · Provision the 5 workspaces
`Antidote`, `Ecolive`, `GLs`, `Mlearn`, `Empower and Shine` — each via `POST /v1/workspaces`, each
with its own API key, each connection re-authorised through the per-platform invite link
(`/v1/connections/:provider/invite`) so the client consents against *our* app.

### E3 · Parallel run (14 days) and the kills
Both systems post for 14 days across all 5 workspaces. Pass = zero missed or failed scheduled posts.
Then, per invariant 9 — **every consolidation ships a kill**:
- **Kill Zernio** — cancel the subscription (prakhar@meegrowlabs.com).
- **Kill Postiz** — decommission the container on 35.154.66.120; `prak-gup/meegrow-social-postiz`
  gets a final README pointing here and is archived (its 9 issues are all still open and unassigned).
- **Late (getlate.dev)** — *not* killed at cutover, and this is the one honest exception: it carries
  Reddit, Threads and X, which we will not support for months. Keep it **only** for those platforms,
  with a written sunset condition: Late dies when B5 (X) ships or when the last Reddit/Threads client
  stops. Note it in `client.json` per client so it is never ambiguous which backend posted what.

---
## 8. Workstream F — Dashboard completion

### F1 · Per-platform options in the Composer (the missing half of #44/#58)
The `gmb` and `youtube` option arms are API-only today — a human cannot create a GBP EVENT post in
the UI. Build a `<PlatformOptions provider>` panel that renders from the selected connection's
provider: meta → format radio (feed/reel/story) + shareToFeed; gmb → topicType select, CTA
action+url, event/offer field groups; youtube → title (counted to 100), privacy, madeForKids.
Validation mirrors `assertPublishable` client-side for feedback, **never instead of** the server.

### F2 · Approval gate (PRD v1.1 → now; invariant 6)
No new store. Two columns on `posts`:
```sql
ALTER TABLE posts ADD COLUMN approval_state text NOT NULL DEFAULT 'not_required';
       -- not_required | pending | approved | rejected
ALTER TABLE posts ADD COLUMN approved_by uuid, ADD COLUMN approved_at timestamptz,
                  ADD COLUMN approval_note text;
ALTER TABLE workspaces ADD COLUMN requires_approval boolean NOT NULL DEFAULT false;
```
- `createPost` sets `pending` when the workspace requires approval.
- **The scheduler must refuse to enqueue a post whose `approval_state = 'pending'`** — this is the
  single line that makes the gate real rather than decorative. Add the integration test against real
  BullMQ (invariant 4).
- `POST /v1/posts/:id/approve|reject` (+ MCP `approve_post` — agents propose, humans dispose).
- UI: an "Awaiting approval" filter on Posts + an approve/reject bar.

### F3 · Analytics UI (#28)
Per-post metrics table + follower/impressions trend per connection, cross-platform comparison on
Overview. Renders whatever metric names came back — **no hardcoded metric list** (invariant 7), and
"—" where a platform has no such metric (GBP has no followers).

### F4 · Bugs and polish
- **#57** `publishAt` epoch sentinel rendering as `01/01/1970` on publish-now posts — fix the sentinel
  at the source (`null`, not `new Date(0)`), not in the formatter.
- **#56** Content page content-first pass · **#58** Connections/Composer design pass.
- **#17** logs + webhooks + API-keys pages (webhooks page lands with D3).

---

## 9. Workstream G — Hardening

- **#20 roles matrix** — `owner | admin | member | viewer` × actions, enforced in `core` (not routes),
  one table-driven test. Viewers cannot publish; members cannot approve unless `can_approve`.
- **#36** atomic OAuth-flow consume (close the concurrent-callback race).
- **DLQ replay** — `GET /v1/dlq`, `POST /v1/dlq/:id/replay` + a page. (#29)
- **Backups** — nightly `pg_dump` → S3 with a **restore drill** recorded in `DEPLOY.md`. A backup
  nobody has restored is not a backup.
- **Rate limiting** — per API key, per route class; 429 with `Retry-After`.
- **#54** replace the Meta-rejected `post_impressions_unique` metric + re-record FB fixtures from live
  traffic.
- **#61** YouTube 30-day metrics retention (ships with B4).

---

## 10. Migrations (consolidated, in order)

| # | Contents | Workstream |
|---|---|---|
| 0008 | `tags`, `post_group_tags` (+RLS, +TENANT_TABLES) | C1 |
| 0009 | `post_templates`, `hashtag_groups` (+RLS) | C2, C4 |
| 0010 | `posts.first_comment` | C3 |
| 0011 | `posts.approval_state/approved_by/approved_at/approval_note`, `workspaces.requires_approval` | F2 |
| ~~0011~~ **0007** | `post_groups.idempotency_key` + partial unique index; drop dead `posts.idempotency_key` — **shipped** | D2 |
| 0012 | `gbp_reviews` (+RLS) | B2 |

Migrations are the #1 merge-collision surface (invariant 5) — **one open migration PR at a time.**
Generate against `main`, never against a sibling feature branch.

---

## 11. Sequencing

Effort is developer-days for a session that already knows this codebase, excluding waiting on Google.

### Wave 0 — today, human, no code
Merge **PR #60** · submit **A1** GBP access · start **A2** OAuth verification · push **A3** (#53) ·
file **A4**. Nothing below B is blocked by these; everything in B and E is.
→ *Parallel with Wave 1, because it is all waiting time.*

### Wave 1 — unblocked now, no approvals needed (~6 days)
| Item | Days | Touches | Parallel-safe? |
|---|---|---|---|
| ~~D2 idempotency~~ ✅ done | — | `posts.ts`, `server.ts`, migration 0007 | shipped 2026-09-21 |
| D3 webhook drainer | 1.5 | worker, `server.ts` | no (server.ts) |
| D1 MCP expansion | 2 | `mcp/` only | **yes** |
| C1 tags | 1 | migration, `server.ts` | no |
| F4 #57 epoch bug | 0.25 | web + `posts.ts` | yes |
| F3 analytics UI | 1.5 | web only | **yes** |

Order: ~~D2~~ → C1 → D3 (those touching `server.ts`/migrations, serialized), with D1 + F3 + #57
running alongside in their own worktrees.

### Wave 2 — the moment A1+A2 land (~5 days)
B1 GBP provider (2) → B1 live bring-up (HITL, 0.5) → B2 reviews (1.5) → F1 composer options (1).
B1 is **not parallelizable** and not delegable: it is one sealed surface and the bring-up needs a
human holding the Google account.

### Wave 3 — cutover (~4 days + 14 days of calendar)
E1 adapter (1) → E2 provision 5 workspaces (0.5) → F2 approval gate (1.5) → G roles (1) →
**E3 parallel run (14 days)** → the three kills.

### Wave 4 — as approvals land, no deadline
B4 YouTube (A2) · B3 LinkedIn (A4) · C2/C3/C5 templates, first comment, variables · G hardening ·
B5 X (only with cost-accounting).

**Critical path:** A1/A2 → B1 → E3 → cutover. Everything else is float. If Google takes six weeks,
Waves 1 and 4 fill them; the project should never again be *blocked* while also *idle*.

---

## 12. Definition of done

| Gate | Criterion |
|---|---|
| **Any PR** | `pnpm format:check && bash scripts/guardrails.sh && pnpm lint && pnpm build && pnpm test` green; integration green in CI |
| **Any new tenant table** | in `TENANT_TABLES`, RLS forced in `migrate.ts`, a case in `rls.integration.test.ts` |
| **Any new port/adapter** | one integration test against the **real** adapter, not only the fake (invariant 4) |
| **B1 GBP** | a real local post visible on a real Google listing, `releaseUrl` opens it, metrics land, fixtures re-recorded from live traffic |
| **D1 MCP** | antidote (or Claude with the key) completes draft → schedule → publish → read-back entirely over `/mcp` |
| **D2** | replaying the same `Idempotency-Key` returns the original post and creates nothing |
| **F2** | a `pending` post is provably never enqueued (integration test against real BullMQ) |
| **E3 cutover** | 14 days × 5 workspaces, zero missed/failed scheduled posts; Zernio cancelled; Postiz box decommissioned; Late scoped to Reddit/Threads/X only |
| **Cost** | ≤ ~$30/month infra (one EC2 + S3) |

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| **Google approvals slip again** (the actual failure mode of the last 8 weeks) | Wave 0 goes out before any code. Wave 1 is approval-free by construction, so waiting ≠ idle. Put a calendar check on the request every 10 days. |
| GBP 7-day refresh-token trap bites before A2 clears | Expected, not a bug: connections surface as `needs_reconnect`. Do not onboard a client to GBP before verification is done. |
| 300 QPM shared project-wide across posts + reviews + metrics | `maxConcurrentJobs = 2`; batch review reads via `batchGetReviews`; back off on 429 as transient. |
| YouTube 10k units/day ≈ 6 uploads | Pre-flight quota check with a clear error; never discover it as a publish-time 403. |
| Scope creep to full Mixpost parity | §1's out-of-scope table is the answer. AI, inbox, billing, SSO and i18n are *decisions*, not backlog. |
| Solo-maintainer bus factor | Every item here is specified to be implementable from this file alone by a session that has never seen the repo. |

---

## 14. Answering the obvious question: why not just buy Mixpost?

Because it does not remove the blocker. Mixpost (Pro $299 / Enterprise $1,199, self-hosted Laravel)
requires **your own** Meta app, Google Cloud project, LinkedIn app — §3 is unchanged by buying it. On
top of that: its Pro licence forbids SaaS use and all redistribution, so it can never become a Meegrow
product; its tenancy is app-level where ours is database-enforced (FORCE RLS as a non-superuser); and
we have already built the expensive 85% — providers, durable publishing, queues, media, analytics
collection, RLS, MCP.

What it genuinely has that we do not: 12 platforms, 26 MCP tools, approval flow, templates, tags,
i18n. This spec builds the five of those that matter (§5, §6, §8-F2) in about a week of work, and
skips the rest on purpose.

**Recommendation: keep building. Merge #60 today.**
