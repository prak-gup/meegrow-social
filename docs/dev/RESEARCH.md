# RESEARCH — meegrow-social (Phase 2)

Synthesis of six research briefs (2026-07-06). Full detail lives in `docs/dev/research/`:
`meta.md`, `gbp-linkedin.md`, `x-youtube.md`, `mcp-api-architecture.md`, `blotato-templates.md`,
`postiz-providers.md` (primary source: grepped from the live Postiz container). This doc records
the **decisions and constraints** those briefs imply for the PRD + AX-PRD.

---

## 1. Headline findings that change the plan

1. **The provider interface is a solved shape — copy Postiz's.** Its `SocialProvider` splits into
   auth (`generateAuthUrl/authenticate/refreshToken/analytics/postAnalytics`) + publish
   (`post/comment`) + metadata. `post()` takes an **array** of post details → native thread/carousel.
   Typed errors (`RefreshToken` vs `BadBody`) cleanly branch "reconnect" vs "fail" in the scheduler.
   This is the single most valuable extraction; our provider contract is de-risked.

2. **Approvals are the critical path, not code** (confirms the thesis). Three external gates, each
   days–weeks, must START day one, in parallel with the build:
   - **Meta**: App Review + Business Verification (per-permission screencasts) for Advanced Access.
   - **Google GBP**: v4 API sits at **0 QPM** until a manual access request is approved (business must be verified/active 60+ days) → then 300 QPM.
   - **Google/YouTube + GBP OAuth**: unverified/"Testing" apps get **7-day refresh-token expiry** — must complete OAuth verification for durable tokens.
   - **LinkedIn**: Community Management API review (org posting) — the known long pole.
   → **PRD implication:** launch on the integrations already approved (Meta IG+FB, GBP posting
     works today); ship LinkedIn/X/YouTube providers behind flags; a milestone tracks approvals.

3. **X is now a metered cost center.** Since Feb 6 2026 X is pay-per-use: **$0.015/post, $0.20 if it
   contains a link** (13×). For a marketing publisher (mostly link posts) X is expensive.
   → **Decision:** build the X provider (cheap, interface already known) but **deprioritize** it and
     add cost-accounting; it is NOT a launch-blocking platform.

4. **Don't hardcode metric names.** Meta is mid-migration `impressions → views` (IG done; FB Page
   metrics dropping Nov 15 2025 → Jun 15 2026). Analytics schema must be **key-value/flexible**, not
   columns named `impressions`.

5. **The posts data model must be template-engine-ready NOW** (Blotato bolt-on later). Required from
   v1: first-class **drafts**, **multi-media** attach, **per-platform variants** (a post-group with
   per-platform children), **programmatic bulk creation** via API/MCP, and rich content types
   (thread/carousel/reel/story). A UI-first single-body/single-media API would make the template
   module expensive to retrofit. Postiz's array-based `post()` already points this way.

6. **Stack is effectively decided** (see §4): Fastify + Drizzle + Postgres + BullMQ, pnpm/Turborepo
   monorepo, shared `core` service layer that REST and MCP both call as thin adapters. Postgres +
   Redis only — no Temporal, no Elasticsearch (the explicit anti-goal). Postiz uses Temporal for
   durable scheduling; **BullMQ delayed jobs replicate the needed semantics** (durable timer + retries
   + per-account concurrency) without operating Temporal.

---

## 2. Per-platform reference (verbatim scopes/endpoints from Postiz + doc corrections)

Redirect convention (adopt): `${APP_URL}/integrations/social/<identifier>`. Providers with
`isBetweenSteps` do two-phase OAuth (user picks Page/Org/Channel/Location after redirect):
Facebook, Instagram(-business), LinkedIn-Page, YouTube, GMB.

| platform | scopes | publish endpoint | media flow | analytics | notes |
|---|---|---|---|---|---|
| **instagram** (via Page) | instagram_basic, pages_show_list, pages_read_engagement, business_management, instagram_content_publish, instagram_manage_comments, instagram_manage_insights | `graph.facebook.com/v25/{ig}/media` → `/media_publish` | 2-step container; **media must be a PUBLIC URL**; carousel children | `/{id}/insights` (views not impressions) | 100 posts/24h |
| **instagram-standalone** (IG Login) | instagram_business_basic/_content_publish/_manage_comments/_manage_insights | `graph.instagram.com/{user}/media` → publish | 2-step container | graph.instagram.com insights | refreshCron token (60d) |
| **facebook** | pages_show_list, business_management, pages_manage_posts, pages_manage_engagement, pages_read_engagement, read_insights | `graph.facebook.com/v25/{page}/feed \| /photos \| /videos \| /video_reels` | direct per-type; reels/stories phased | `/{page}/insights`, `/{post}/insights` | non-expiring Page tokens via /me/accounts |
| **linkedin** (personal) | openid, profile, w_member_social, r_basicprofile | `api.linkedin.com/rest/posts` | `/rest/images \| /rest/videos` initialize→upload→attach | `/v2/socialActions/{urn}` | needs `LinkedIn-Version: YYYYMM` header |
| **linkedin-page** (org) | + rw_organization_admin, w_organization_social, r_organization_social | `/rest/posts` (author = org URN) | same | organizationalEntityShare/FollowerStatistics | **needs Community Management API approval** |
| **x / twitter** | (OAuth2+PKCE now): tweet.read/write, users.read, offline.access, media.write | `api.x.com/2/tweets` | `POST /2/media/upload` chunked (v1.1 sunset Jun 2025) | public_metrics | **metered**; 2h token; single-use rotating refresh |
| **youtube** | userinfo.profile/email, youtube, youtube.force-ssl, youtube.readonly, youtube.upload, youtubepartner, yt-analytics.readonly (all **sensitive**, no paid audit) | `videos.insert` (resumable, SDK) | resumable upload | YouTube Analytics API (`reports.query`, ~48h delay) | ~100 uploads/day; verification-gated; Brand-Account Manager path for multi-client |
| **gmb** (Google Business) | userinfo.profile/email, business.manage | `mybusiness.googleapis.com/v4/{id}/localPosts` (STANDARD/EVENT/OFFER/ALERT) | `mybusinessbusinessinformation/v1/{loc}/media` (sourceUrl) | `businessprofileperformance/v1/{loc}:fetchMultiDailyMetricsTimeSeries` | v4 at 0 QPM until access approved |
| **threads** (later) | threads_basic/_content_publish/_manage_replies/_manage_insights | `graph.threads.net/v1.0/{user}/threads` → publish | 2-step container | threads_insights | refreshCron |
| **tiktok** (later) | video.list, user.info.basic, video.publish/upload, user.info.profile/stats | `open.tiktokapis.com/v2/post/publish/{video}/init/` | creator_info query → init → status poll | video.query metrics | maxConcurrent 300 |

Media specs captured in `research/meta.md` (IG 4:5–1.91:1 images ≤8MB; Reels 9:16 MP4 3–90s ~1GB;
caption 2200/30 hashtags) and `research/x-youtube.md` (Shorts = 9:16 <3min + #Shorts, no dedicated API).

---

## 3. Provider architecture patterns to adopt (from `postiz-providers.md`)

- **Explicit registry** keyed by `identifier` + `getProvider(identifier)` resolver (no decorator
  auto-discovery needed for v1).
- **`isBetweenSteps` two-phase OAuth** for Page/Org/Channel/Location selection.
- **Typed provider errors** (`RefreshToken` 401 → mark reconnect; `BadBody` → fail) decouple provider
  HTTP quirks from scheduling logic.
- **Resilient `fetch` wrapper**: 429/5xx → backoff, max 3 retries, per-provider `handleErrors` hook,
  `maxConcurrentJob` ceiling.
- **`post(details[])`** array-based → threads/carousels/per-platform variants fall out naturally.
- **Token model per provider**: `refreshCron` (IG-standalone, Threads — scheduled refresh),
  `oneTimeToken` (LinkedIn — non-refreshable, 60d re-auth), auto-refresh (Google via SDK).

---

## 4. Stack & infra decisions (feed the AX-PRD — Phase 5 will grill these to lock)

- **Language/runtime:** TypeScript / Node. **Monorepo:** pnpm + Turborepo, packages
  `core` (services+Zod contracts), `db` (Drizzle schema), `api` (Fastify REST), `mcp` (Streamable-HTTP
  MCP server), `worker` (BullMQ), `web` (dashboard — Next.js or Vite, secondary).
- **HTTP:** Fastify (chosen over NestJS = less magic → safer for AFK agents; over Next.js = dashboard-only).
- **DB:** Postgres + **Drizzle** (no codegen drift, SQL control for row-level scoping).
- **Jobs:** **BullMQ on Redis** — delayed jobs (scheduled publish), repeatable jobs (analytics poll +
  token-refresh sweeper). Reliability: backoff+jitter, idempotency keys, hand-rolled DLQ (BullMQ has none).
- **MCP:** Streamable HTTP transport (single `/mcp` endpoint), **stateless mode** to scale; auth via
  per-workspace `Authorization: Bearer sk_...`. OAuth 2.1 deferred. Verify exact SDK class names against
  installed `@modelcontextprotocol/sdk` at build time (recent package split).
- **Shared capability layer:** all logic in `core`; REST + MCP are thin adapters (no split-brain).
  MCP tools are **task-shaped**, not 1:1 CRUD.
- **Tenancy:** `workspace_id` on every row; tenant resolved from the API key, never from body;
  Drizzle app-layer scoping + Postgres **RLS via `SET LOCAL`** as defense-in-depth before GA.
- **API keys:** `sk_live_...` prefix, raw shown once, stored SHA-256 hash + plaintext prefix, `scopes[]`,
  revocation, expiry.
- **Webhooks:** Svix pattern — async BullMQ delivery, HMAC-signed (`webhook-id/timestamp/signature`),
  backoff retries, receiver idempotency, DLQ + replay.
- **Analytics:** flexible key-value metric store; workers persist per-post metrics + follower counts on
  a cadence from day 0 (history can't be backfilled).
- **Hosting:** dedicated EC2 + docker compose (app + worker + Postgres + Redis) + Caddy; S3 (+CloudFront)
  for media at `social.meegrowlabs.com`.

**Open questions carried to AX-PRD (Phase 5 grill):** (a) stateless vs stateful MCP sessions;
(b) Svix self-host vs SaaS vs hand-rolled; (c) when to turn on RLS (v1 vs pre-GA); (d) third-party MCP
exposure → OAuth 2.1 timing; (e) dashboard framework (Next.js vs Vite+Fastify-served).

---

## 5. Blotato / template engine (post-v1 module — do not build now, just don't block it)

- It's a **producer** that writes drafts into the posts API; needs no new publish/OAuth/schedule infra.
- Four parts when built: template/hook **skeleton** store (structure not copy), LLM **remix** service
  (topic + brand voice + template → drafts), **repurposing** pipeline (source ingest → canonical idea →
  fan-out to N per-platform drafts), optional **inspiration feed** (curated swipe files — NOT live
  scraping; platform ToS makes scraping a compliance risk).
- Competitors (Taplio, Tweet Hunter, Predis, Postwise) all repeat: viral swipe libraries, hook DBs,
  structural templates, voice conditioning, source→N repurposing.
- **Only real constraint on us:** the §1.5 posts-model requirements. Satisfy those and this is a clean
  bolt-on (or antidote can be the producer via the API/MCP).

---

## Phase 2 gate
Research complete; decisions above are ready to harden into the PRD (Phase 4) and the one-way-door
stack choices into the AX-PRD (Phase 5). Nothing here reopens the Phase 1 grill decisions.
