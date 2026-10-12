# GBP + LinkedIn API Research Brief

Research brief for the Meegrow Social publishing platform. Covers Google Business Profile (post to Google Business / Maps listings) and LinkedIn (post to personal profiles + Company Pages). Current as of July 2026.

> Scope note: This is a research brief, not an implementation. Both platforms gate write access behind manual approval processes that must be started early — they are the long pole in the schedule, not the code.

---

## PART A — Google Business Profile (GBP) API

Google retired the old monolithic Google My Business API in April 2022 and split it into **five purpose-built APIs**, all still live and maintained in 2026. Confusingly, **posting, reviews, and media still live on the legacy `mybusiness.googleapis.com/v4` surface**, which is access-gated and never got a "v1" successor. Newer functions (account/location management, performance) moved to versioned `*.googleapis.com` hosts. You will touch multiple hosts.

### A1. OAuth, Cloud project setup, API enablement

- **Single OAuth scope for everything:** `https://www.googleapis.com/auth/business.manage`. This one scope covers account management, location info, local posts, reviews, and performance. It is a **sensitive scope** (triggers Google verification — see A5).
- **Cloud project setup:**
  1. Create a Google Cloud project; note the **Project Number** (not ID) — you need it for the access request.
  2. Configure the OAuth consent screen (External), add the `business.manage` scope, add test users.
  3. Create OAuth 2.0 Client credentials (Web application, with redirect URIs).
- **APIs to enable** in the Cloud console (each is a separate API you toggle on):
  - **My Business Account Management API** (`mybusinessaccountmanagement.googleapis.com`) — list accounts, manage account access. Versioned, generally available.
  - **My Business Business Information API** (`mybusinessbusinessinformation.googleapis.com`) — read/edit location data (name, hours, categories, attributes). Versioned, GA.
  - **Business Profile Performance API** (`businessprofileperformance.googleapis.com`) — metrics (see A4). Versioned, GA.
  - **Google My Business API** (`mybusiness.googleapis.com/v4`) — **the legacy v4 surface that still hosts Local Posts, Reviews, and Media.** This API is **access-restricted**: it appears in the console but returns **0 QPM quota until Google approves your access request** (see A6).
- **Access request (the gate):** Submit the [GBP API access request form](https://developers.google.com/my-business/content/prereqs) with your Project Number, from an email that is an **owner/manager on the target GBP**. Requirements: manage a GBP that has been **verified and active for 60+ days**, with a website. Approval flips quota from 0 → 300 QPM. Turnaround is often slow (days to weeks; community reports of no response are common).

Docs: [Prerequisites](https://developers.google.com/my-business/content/prereqs) · [API basic setup](https://developers.google.com/my-business/content/basic-setup)

### A2. Posting — Local Posts

Local Posts are the "posts" that surface on a Google Business listing / Maps. **Endpoint (legacy v4):**

```
POST https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/localPosts
      list / get / patch / delete on the same resource path
      reportInsights  (per-post views/clicks)
```

- **Current state:** The `accounts.locations.localPosts` resource is **still active in 2026** (create/list/get/patch/delete). It lives on the legacy v4 host and there is no v1 replacement — this is the only official way to post. Because it's behind the v4 access gate, a 403 here almost always means access/quota not yet granted (a very common integration snag — see the [Make community 403 thread](https://community.make.com/t/google-my-business-business-profile-creating-posts-via-api-fails-403-mybusiness-googleapis-com-legacy-api-confusion/99258)).
- **Post types (`topicType`):**
  - `STANDARD` — summary + media + optional CTA.
  - `EVENT` — adds `event` (title + schedule with start/end).
  - `OFFER` — adds `offer` (coupon code, redemption URL, terms) + event fields.
  - `ALERT` — high-priority timely announcement (e.g. COVID-style alerts).
- **Fields:** `summary` (the post body text), `media` (image/video — **`sourceUrl` only**, i.e. you pass a public URL, not a binary upload), `callToAction` (`{actionType, url}`), `event`, `offer`, `topicType`, plus read-only `state` (LIVE / PROCESSING / SCHEDULED / RECURRING / REJECTED).
- **CTA action types:** `BOOK`, `ORDER`, `SHOP`, `LEARN_MORE`, `SIGN_UP`, `CALL` (CALL uses the location's phone, not a URL).
- **Character limit:** `summary` max **1,500 chars** (practically ~1,000 shown; Google truncates the preview). The official reference does not print the exact number in the resource page — treat 1,500 as the hard cap and keep the actionable text in the first ~100 chars. Validate before send.
- **Media:** single image or video per post via `mediaItems[].sourceUrl` (publicly reachable URL). Recommended image ≥ 720×540 px, JPG/PNG.

Docs: [localPosts resource](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts) · [localPosts.create](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/create) · [Create Posts guide](https://developers.google.com/my-business/content/posts-data)

### A3. Reviews — read + reply

Reviews also live on the **legacy v4 host** (`mybusiness.googleapis.com/v4`), under the same `business.manage` scope:

- **List reviews:** `GET /v4/accounts/{accountId}/locations/{locationId}/reviews`
- **Get one:** `GET .../reviews/{reviewId}`
- **Multi-location batch:** `POST /v4/accounts/{accountId}/locations:batchGetReviews`
- **Reply (create/update — upsert):** `PUT /v4/accounts/{accountId}/locations/{locationId}/reviews/{reviewId}/reply` with `{ "comment": "..." }`
- **Delete reply:** `DELETE .../reviews/{reviewId}/reply`
- **Fields:** review id, `starRating` (enum `ONE`..`FIVE`), `comment`, reviewer name/photo, `createTime`, `updateTime`, `reviewReply`.
- **Note:** There is no supported way to *read reviews without ownership/API access* — the deprecated Places API review snippet (max 5) is the only unauthenticated alternative and is not equivalent. Reviews require the v4 access grant.

Docs: [Work with review data](https://developers.google.com/my-business/content/review-data)

### A4. Metrics — Business Profile Performance API

Host: `https://businessprofileperformance.googleapis.com/v1`. Same `business.manage` scope. **Daily granularity** (plus a monthly search-keywords endpoint).

- **Single metric time series:** `GET /v1/{name=locations/*}:getDailyMetricsTimeSeries?dailyMetric=...&dailyRange...`
- **Multiple metrics at once:** `GET /v1/{location=locations/*}:fetchMultiDailyMetricsTimeSeries?dailyMetrics=...`
- **Search keywords (monthly):** `GET /v1/{parent=locations/*}/searchkeywords/impressions/monthly`
- **`DailyMetric` enum values** (the useful ones):
  - Impressions: `BUSINESS_IMPRESSIONS_DESKTOP_MAPS`, `BUSINESS_IMPRESSIONS_DESKTOP_SEARCH`, `BUSINESS_IMPRESSIONS_MOBILE_MAPS`, `BUSINESS_IMPRESSIONS_MOBILE_SEARCH`
  - Actions: `WEBSITE_CLICKS`, `CALL_CLICKS`, `BUSINESS_DIRECTION_REQUESTS`, `BUSINESS_CONVERSATIONS` (messages), `BUSINESS_BOOKINGS`, `BUSINESS_FOOD_ORDERS`, `BUSINESS_FOOD_MENU_CLICKS`
- **Granularity:** daily buckets over a requested date range; search keywords are monthly and return a **threshold-bucketed** impression count (Google fuzzes low numbers).
- Per-post view/click metrics come from `localPosts` `reportInsights` (legacy v4), separate from this API.

Docs: [Business Profile Performance API](https://developers.google.com/my-business/reference/performance/rest)

### A5. Token model — Google refresh tokens & the 7-day trap

- **Standard OAuth 2.0** authorization-code flow with `access_type=offline` + `prompt=consent` to receive a **refresh token**. Access tokens last ~1 hour; refresh tokens auto-mint new access tokens.
- **THE 7-DAY TRAP:** While the OAuth app's consent screen is in **"Testing"** status (or otherwise unverified), Google **expires every refresh token after 7 days**. Any per-client GBP connection silently dies weekly and the client must re-consent. This is the single biggest operational hazard for a multi-tenant publisher.
- **Fix = publish + verify:** Move the consent screen to **"In production"** and complete **Google's OAuth verification** for the sensitive `business.manage` scope (app details, domain ownership, demo video, possibly brand/security review). Once verified & published, refresh tokens become **long-lived (effectively non-expiring** until revoked/unused for 6 months / password change / 50-token-per-client limit).
- Plan for verification lead time (can be weeks). Until then, only test users work and only for 7 days at a stretch.

Docs: [Using OAuth 2.0](https://developers.google.com/identity/protocols/oauth2) · [Unverified apps](https://support.google.com/cloud/answer/7454865) · [Refresh token expiry explainer](https://www.unipile.com/google-oauth-refresh-token/)

### A6. Gotchas & quotas

- **Default quota is 0, not low.** The legacy v4 API (posts/reviews/media) ships at **0 QPM** — it's fully blocked until the access request is approved, at which point you get **300 QPM** (and 10 edits/min per profile on Business Information). See [Usage limits](https://developers.google.com/my-business/content/limits).
- **Quota-increase requests** (beyond 300 QPM) are commonly **denied** unless you're consistently >50% of the current limit with a smooth (non-spiky) request pattern.
- **Two-stage gate:** you need (1) Cloud APIs enabled AND (2) the manual v4 access grant. Enabling the API alone gives 0 quota — a frequent "why do I get 403" confusion.
- **Q&A API was shut down Nov 3, 2025** — don't build on it.
- **Media on posts is URL-only** (`sourceUrl`) — you must host images somewhere publicly reachable first.
- Rate-limit defensively: 300 QPM shared across all read+write calls per project; batch review reads via `batchGetReviews`.

### A7. Provider build (#21) — fixture provenance and the live bring-up checklist

Added 2026-10-11 with `packages/core/src/providers/google/{client,gbp}.ts`.

**Provenance, stated plainly.** The GBP provider was built with **no API access and no credentials**. Nothing in it has been run against Google. Every fixture in `gbp.test.ts` is **hand-built from the documented shapes in A1–A6 above — not recorded from live traffic**, and Google's reference pages were not re-fetched during the build (no network access to Google was permitted), so the shapes are only as good as this note. The 95 tests prove the code agrees with the documentation. They do not prove the documentation agrees with Google. Meta taught us the difference: `post_impressions_unique` passed every fixture and was rejected live.

Registration is env-gated on `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` **and** `GBP_ENABLED=true` (`providers/registry.ts`); the credentials are shared with YouTube, which has its own switch. With either unset, `gmb` is not registered and nothing changes anywhere.

**Decisions taken in the build that differ from BUILD-SPEC-V2 §4 B1** (each is a one-line change if the call is reversed):

| Spec says | Built | Why |
| --- | --- | --- |
| `authenticate` returns `expiresAt: now + expires_in` | No `expiresAt` stored | `computeHealth` uses a 7-day window; a 1-hour expiry would show every GBP connection as `expiring` forever and count it in Overview's "tokens expiring". #21 asks for non-expiring health. |
| Sweeper refreshes the token | Provider mints an access token from the refresh token on every call (in-memory cache, 60s skew) | With no stored expiry the sweeper's candidate filter skips the row. A stored access token is stale within the hour anyway, so a scheduled post could not rely on it. |
| The `token-health` sweeper surfaces the 7-day trap | The next publish or analytics sweep surfaces it (`invalid_grant` → auth error → `needs_reconnect`) | Same consequence, detected within a day by the daily account sweep rather than within the hour. |
| `assertPublishable` requires the media to carry a public `url` | Arity only at create time; the URL is required in `post()` | `services/posts.ts` passes unresolved refs at create time and says a provider must not key off `url`. |
| Body shaping for all four `topicType`s | `ALERT` is rejected at create time | Google requires `alertType` on ALERT posts and documents one value, `COVID_19`. The options contract has no such field, and defaulting it would label a client's post a COVID-19 update. |
| (not stated) | `event` on a STANDARD post is rejected | Same reasoning as the spec's "offer on a non-OFFER post". |
| Scope `business.manage` only | `business.manage` + `userinfo.email` + `userinfo.profile` | #21 names userinfo. Nothing reads it — drop the two before the A2 verification submission unless something will. |
| `401` → auth error | `401 invalid_client` from the token endpoint → bad request | That is our own bad secret; calling it an auth error would flag every connection `needs_reconnect` on a bad deploy. |
| 403 gate only | Also: `429` whose ErrorInfo carries `quota_limit_value: "0"` → bad request, same message | A limit of zero may surface as 429 rather than 403, and that is the retry-storm the spec is trying to prevent. Unconfirmed — see below. |
| trailing 2 days is an "idempotent re-sweep" | Points are stamped with the day they belong to (UTC midnight) | `metrics` is append-only with no unique key, so each day is still stored twice. Read models must take the latest row per `(connection, metric, captured_at)` or they will double-count. |
| Fix `services/overview.ts` for follower "—" | Not touched | The provider emits no follower metric, and Overview already yields `null` when there is no row. |

**Bring-up checklist — every item is an assumption a live run must confirm.** Re-record the fixtures from this traffic.

1. **Token endpoint.** `expires_in` is present and ~3599; a refresh response carries no `refresh_token`; a dead refresh token answers `400 {"error":"invalid_grant"}`.
2. **Re-consent returns a refresh token** with `prompt=consent` + `access_type=offline`. `authenticate` refuses the connection otherwise.
3. **The 0-QPM response.** Capture the real status and body before access is granted. Assumed: `403` with status `PERMISSION_DENIED` and/or "has not been used in project". If it is `429`, confirm the ErrorInfo metadata key is `quota_limit_value` and its value is `"0"`.
4. **`accounts.list`** returns `accounts[].name` as `accounts/{id}`; a personal account with no locations returns `{}` on `locations.list` rather than an error. A 403 on one account currently fails the whole picker.
5. **`locations.list`** returns `name` as `locations/{id}` (no account prefix) and accepts `readMask=name,title,storefrontAddress` with `pageSize=100`. The composite `accounts/{a}/locations/{l}` is assembled from the two.
6. **`localPosts.create`** accepts the composite path, returns `name`, `state` and `searchUrl`. If `searchUrl` is missing (assumed possible while `PROCESSING`) the stored `releaseUrl` is `https://business.google.com/` — a placeholder, not a link to the post.
7. **`REJECTED`** — the spec asks for Google's reason verbatim, but no reason field is documented on `LocalPost`. Only the state is surfaced today. Capture a real rejection and see what it carries.
8. **`languageCode` is hardcoded `"en"`.** Confirm Google accepts it for a Hindi-language caption, or carry the location's language.
9. **Event times are sent as UTC wall-clock.** Google's schedule has no zone and is read as the location's local time, so an IST event will show 5h30 early. **This needs a decision before EVENT/OFFER ship** — the options contract carries an instant and no zone.
10. **OFFER** — whether Google accepts an offer post with no `offer` object, and whether it tolerates a `callToAction` on one.
11. **Video.** `kind: 'video'` is sent as `mediaFormat: "VIDEO"`. Unconfirmed that local posts accept video at all.
12. **`localPosts:reportInsights`** — the least certain endpoint here; the v4 insights surface has been progressively retired. Confirm it still answers, that `metricRequests` needs no `options`, that the 30-day `timeRange` is accepted, and that `totalValue.value` is a string. A permanent 4xx currently resolves to no metrics (silently) so one post cannot be re-polled forever.
13. **Performance API.** Confirm the `dailyRange.start_date.year` query spelling, which of the nine `DailyMetric` names return data, and **how many days the data lags**. If the lag exceeds two days the 2-day window records nothing — widen `DAILY_WINDOW_DAYS`.
14. **Zero days.** Google omits `value` for a zero count. Those days are skipped, not stored as 0, because a not-yet-computed day looks identical. Decide whether charts should treat a gap as zero.
15. **The 7-day trap (A5).** Leave a connection idle 8 days before and after OAuth verification.
16. **`.env.production.example`** still needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` added by hand — the build session was not permitted to open env files.

---

## PART B — LinkedIn API

LinkedIn's API is **date-versioned** and documented on Microsoft Learn. Organization (Company Page) posting requires the **Community Management API** product, whose approval is the gate. Everything is Rest.li-flavored (`X-Restli-Protocol-Version: 2.0.0`, quirky `List(...)` param encoding, `PARTIAL_UPDATE` patch semantics).

### B1. OAuth products & scopes — and what needs Community Management API

LinkedIn scopes are granted **per product** you add to your app. The three relevant products and their scopes:

| Product | Scopes | Grants | Approval |
|---|---|---|---|
| **Sign In with LinkedIn using OpenID Connect** | `openid`, `profile`, `email` | Auth + basic member identity (userinfo) | Self-serve |
| **Share on LinkedIn** | `w_member_social` (+ `r_member_social` restricted) | Post to the **authenticated member's personal profile** | Self-serve |
| **Community Management API** | `r_organization_social`, `w_organization_social`, `rw_organization_admin`, `r_organization_admin`, `r_organization_social_feed`, etc. | Post to / read / manage **Company (Organization) Pages** + org analytics | **Manual review (gated)** |

- `r_basicprofile` is a legacy/restricted scope from the older "Marketing Developer Platform" flow; new apps use `openid`/`profile` for identity.
- **Personal-profile posting is easy** (Share on LinkedIn is self-serve). **Company Page posting is hard** — it needs Community Management API approval.
- **Community Management API approval process:**
  1. Only **legal registered entities** (LLC/Corp/etc.) — not individual developers. You supply legal name, registered address, website, privacy policy, business email.
  2. Your app must be **verified against a LinkedIn Company Page** (an admin of that Page clicks a verification link).
  3. Apply for **Development Tier** access via My Apps → Products → Community Management API access form; LinkedIn reviews it.
  4. For production scale, apply for **Standard Tier** — requires submitting a **screen recording of your app** demonstrating usage (this is the "LinkedIn Marketing Developer Platform / Microsoft vetting" step).
- **Incompatibility gotcha:** Community Management API scopes (`w_organization_social`, `rw_organization_admin`) **cannot coexist on the same app** with "Share on LinkedIn" / "Sign In with OpenID Connect" in a way that always resolves cleanly — mixing product scopes in one auth request is the #1 cause of the "Bummer" error (see B6). Design your app's product set deliberately.

Docs: [Community Management API overview](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview) · [Product catalog](https://developer.linkedin.com/product-catalog/marketing/community-management-api)

### B2. Publishing — Posts API (`/rest/posts`)

- **Use the Posts API** (`https://api.linkedin.com/rest/posts`). It **replaces the legacy `ugcPosts` and `shares`** APIs (those still exist but are deprecated — don't build new on them). The Posts API is a superset.
- **Required headers on every call:**
  - `Authorization: Bearer {token}`
  - `LinkedIn-Version: YYYYMM` (e.g. `202606`) — **omitting or using a sunset version breaks the call.** Versions sunset ~1 year after release; pin a recent one and bump quarterly.
  - `X-Restli-Protocol-Version: 2.0.0`
  - `Content-Type: application/json`
- **Author = URN**, and this determines personal vs. Page:
  - Personal: `"author": "urn:li:person:{id}"` (needs `w_member_social`; get `{id}` from the OpenID `userinfo` / profile endpoint).
  - Company Page: `"author": "urn:li:organization:{id}"` (needs `w_organization_social` + the member must have an **ADMINISTRATOR / DIRECT_SPONSORED_CONTENT_POSTER / CONTENT_ADMIN** role on that Page).
- **Create** (`POST /rest/posts`) — returns `201`; the new post URN is in the **`x-restli-id` response header** (e.g. `urn:li:share:...`). Body core fields: `author`, `commentary` (the text), `visibility` (`PUBLIC`/`CONNECTIONS`/`LOGGED_IN`), `distribution` (`feedDistribution: MAIN_FEED`, plus `targetEntities` for follower targeting), `lifecycleState: PUBLISHED` (or `DRAFT`), `isReshareDisabledByAuthor`.
- **Content types & how to attach:**
  - **Text only:** just `commentary`.
  - **Image:** upload first (B3) → `content.media.{id: "urn:li:image:...", altText, title}`.
  - **Video:** upload first (B3) → `content.media.{id: "urn:li:video:...", title}`.
  - **Document (PDF/slides):** upload → `content.media.id: "urn:li:document:..."`.
  - **Article:** `content.article.{source, thumbnail(image URN), title, description}`. **No URL scraping** — you must supply title/description/thumbnail yourself.
  - **MultiImage:** organic only, via MultiImage API. **Carousel:** sponsored only. **Poll / Celebration:** organic only.
- **Mentions/hashtags** go inside `commentary` with `@[Name](urn:li:organization:{id})` annotation syntax; text must exactly match the entity name.
- **Update:** `POST /rest/posts/{urn}` with `X-RestLi-Method: PARTIAL_UPDATE` and a `{patch:{$set:{...}}}` body — only `commentary`, `contentCallToActionLabel`, `contentLandingPage`, `lifecycleState`, `adContext` are updatable → `204`.
- **Delete:** `DELETE /rest/posts/{urn}` with `X-RestLi-Method: DELETE` → `204` (idempotent). **No batch delete.**
- **Commentary length:** ~3,000 chars; exceeding it returns `400 FIELD_LENGTH_TOO_LONG`. Validate before send.

Docs: [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) · [Migration guide (ugcPosts → Posts)](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide)

### B3. Media — the initializeUpload → upload → attach flow

Images (`/rest/images`), Videos (`/rest/videos`), Documents (`/rest/documents`) all follow the same 3-step pattern:

1. **Initialize:** `POST /rest/images?action=initializeUpload` with `{"initializeUploadRequest":{"owner":"urn:li:organization:{id}"}}` → returns `{ value: { uploadUrl, image: "urn:li:image:{id}", uploadUrlExpiresAt } }`. (Owner can be a person or organization URN.)
2. **Upload:** `PUT`/`POST` the **raw binary** to the returned `uploadUrl` (this is a LinkedIn `dms-uploads` URL, expires quickly). Video and large files use a **chunked/multipart upload** with a `finalizeUpload` action to stitch parts.
3. **Attach:** reference the returned URN (`urn:li:image:...` / `urn:li:video:...`) in the post's `content.media.id`. Poll the asset `status` until `AVAILABLE` before publishing (video processing is async: `PROCESSING` → `AVAILABLE`).
- **Image specs:** < 36,152,320 total pixels; JPG / PNG / GIF (GIF ≤ 250 frames). `altText` ≤ 4,086 chars (≤120 recommended).
- **Permissions:** uploading for an org owner requires ADMIN/DSC on that Page. `w_member_social` is write-only (can't GET the image back).
- Images are reusable across post formats once uploaded.

Docs: [Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api) · [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api)

### B4. Analytics

- **Post/share stats — `organizationalEntityShareStatistics`:** returns `impressionCount`, `uniqueImpressionsCount`, `clickCount`, `likeCount`, `commentCount`, `shareCount`, `engagement`. Can query lifetime, by-share, or time-bound. **Rolling 12-month window only** — older data isn't returned. Requires `r_organization_social`.
- **Live like/comment counts — `socialActions`:** `GET /rest/socialActions/{shareUrn}` gives real-time like & comment counts + threaded comments matching what shows in-feed.
- **Follower stats — `organizationalEntityFollowerStatistics`:** lifetime + time-bound follower counts, segmented by geo, industry, function, seniority, staff-count; organic vs. paid split. Requires `r_organization_social` / admin.
- All analytics endpoints need Community Management API approval; personal-profile analytics are effectively unavailable to third parties.

Docs: [Organization Share Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics) · [Follower Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/follower-statistics)

### B5. Token model — 60-day tokens, refresh needs approval

- **Access token = 60-day expiry** (much longer than Google's ~1h). Standard 3-legged authorization-code flow.
- **Refresh tokens exist but are gated:** "Programmatic refresh tokens" (which let you mint a new 60-day access token without user re-consent) are **only enabled for approved apps** — refresh token TTL is **365 days**; using it re-issues a 60-day access token but the refresh token's clock does not reset (still 365 days from original grant). Requires the Community Management / Marketing product approval.
- **No long-lived / non-expiring tokens.** Without refresh-token approval, you must have the **member re-authorize every 60 days** — a real operational cost for a publisher. Track token issue dates per connection and prompt re-auth before expiry.

Docs: [Refresh Tokens with OAuth 2.0](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens) · [3-legged OAuth flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)

### B6. Gotchas

- **"Bummer, something went wrong"** — LinkedIn's generic OAuth failure page. Causes: (1) requesting a scope your app's products don't grant (`unauthorized_scope_error`) — e.g. asking for `w_organization_social` before Community Management API is approved; (2) **redirect_uri** not matching the registered value exactly; (3) mixing incompatible product scopes in one request; (4) `prompt=none` on a first-time auth with no existing grant. Always request only scopes your approved products cover, and match redirect URIs precisely.
- **`LinkedIn-Version` header is mandatory** and must be a currently-supported `YYYYMM` value; sunset versions fail. Bump on a schedule.
- **Rest.li quirks:** URNs in URL params must be URL-encoded (`urn%3Ali%3A...`); batch/finder calls need `X-RestLi-Method` headers; list params use `List(...)` syntax; updates are `$set` patches.
- **Rate limits:** Community Management API is roughly **~100 posting calls/day per member** and per-app daily throttles; `429 TOO_MANY_REQUESTS` on breach. Analytics endpoints have separate throttles.
- **Page role requirement:** even with `w_organization_social`, the authenticated member must hold an admin/content role on the target Company Page or you get `403 ACCESS_DENIED`.
- **12-month analytics window** and **60-day token churn** are the two things that most affect a long-running publisher.

---

## Cross-cutting takeaways for the build

1. **The gates are the schedule.** GBP v4 access (0→300 QPM) and LinkedIn Community Management API (dev then standard tier) are both manual, multi-week approvals. Start both on day one.
2. **Token durability differs sharply.** Google: verify the OAuth app or refresh tokens die every 7 days; once verified they're near-permanent. LinkedIn: 60-day access tokens, refresh only for approved apps, otherwise 60-day re-auth churn. Build per-connection token lifecycle tracking + proactive re-auth prompts for both.
3. **Media handling differs.** GBP posts take a **public image URL** (host it yourself). LinkedIn requires a **3-step initializeUpload→upload→attach** producing an asset URN. Abstract these behind one "attach media" interface.
4. **Author identity is a first-class concept on both.** GBP = account/location path; LinkedIn = person vs organization URN. Model "which listing/page am I posting as" explicitly per connection.
5. **Validate before send.** GBP summary ~1,500 chars; LinkedIn commentary ~3,000 chars; both reject overlong bodies. Enforce client-side.

---

## Source index

**Google Business Profile**
- Prerequisites / access request — https://developers.google.com/my-business/content/prereqs
- Local Posts resource — https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts
- localPosts.create — https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/create
- Create Posts guide — https://developers.google.com/my-business/content/posts-data
- Work with review data — https://developers.google.com/my-business/content/review-data
- Business Profile Performance API — https://developers.google.com/my-business/reference/performance/rest
- Usage limits / quota — https://developers.google.com/my-business/content/limits
- OAuth 2.0 — https://developers.google.com/identity/protocols/oauth2
- Unverified apps (7-day token) — https://support.google.com/cloud/answer/7454865
- Refresh token expiry explainer — https://www.unipile.com/google-oauth-refresh-token/
- 403 / legacy-API confusion (community) — https://community.make.com/t/google-my-business-business-profile-creating-posts-via-api-fails-403-mybusiness-googleapis-com-legacy-api-confusion/99258

**LinkedIn**
- Community Management API overview — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
- Community Management API product — https://developer.linkedin.com/product-catalog/marketing/community-management-api
- Posts API — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
- Migration guide (ugcPosts→Posts) — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide
- Images API — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
- Organization Share Statistics — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics
- Organization Follower Statistics — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/follower-statistics
- Refresh Tokens with OAuth 2.0 — https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
- 3-legged OAuth flow — https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
