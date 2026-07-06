# X (Twitter) API & YouTube Data API — Research Brief

_Research for the Meegrow Social publishing platform. Compiled July 2026. Cites official docs where possible._

> **Headline finding:** Both platforms changed their commercial/quota model in the last ~7 months and the old assumptions in the task brief are now **out of date**:
> - **X** killed tiered pricing (Free / Basic $200 / Pro $5,000) for new developers on **6 Feb 2026** and moved to **pay-per-use credits**. There is **no free tier for new apps**. This changes the X viability calculus completely — see Part A §2.
> - **YouTube** dropped `videos.insert` from ~1,600 units to a **dedicated ~100-uploads/day bucket** (Dec 2025 → granular buckets live 1 Jun 2026). The "6 uploads/day" ceiling no longer applies — see Part B §2.

---

## PART A — X / Twitter API v2

### A1. OAuth 2.0 (PKCE, user context) + the OAuth 1.0a-for-media legacy

**Model:** X API v2 uses **OAuth 2.0 Authorization Code Flow with PKCE** for user-context actions (posting on behalf of a connected account). This is what a multi-tenant publisher needs — each client connects their own X account.

**Scopes** (space-delimited in the authorize URL):
| Scope | Purpose |
|---|---|
| `tweet.read` | Read posts (required alongside most scopes) |
| `tweet.write` | Create/delete posts — **required to publish** |
| `users.read` | Read user profile / resolve author id |
| `offline.access` | **Issues a refresh token** (without it you re-auth every 2h) |
| `media.write` | Upload media via the v2 media endpoints (newer scope, needed for image/video posts) |

- Authorize endpoint: `https://x.com/i/oauth2/authorize`; token exchange at `https://api.x.com/2/oauth2/token`.
- App must be registered as a **confidential or public client**; PKCE `code_challenge`/`code_verifier` required.

**OAuth 1.0a legacy for media:** Historically media upload lived on the v1.1 endpoint (`upload.twitter.com/1.1/media/upload.json`) and required **OAuth 1.0a user context** even when the tweet itself was posted with OAuth 2.0 — a painful dual-auth situation. As of **Jan 2025** X shipped **v2 media upload** (`POST /2/media/upload`) which works with **OAuth 2.0 + `media.write`**, and the **v1.1 media endpoints sunset on 9 Jun 2025**. Net: for a greenfield build you use **OAuth 2.0 only** — the dual OAuth 1.0a dance is no longer needed. (Docs: [OAuth 2.0 Auth Code + PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), [v1.1 media deprecation](https://devcommunity.x.com/t/deprecating-the-v1-1-media-upload-endpoints/238196))

### A2. Pricing tiers (CRITICAL — this is now pay-per-use)

**Current model (default for all new developers since 6 Feb 2026): pay-per-usage credits.** No subscription, no monthly cap, no free tier. You pre-purchase credits in the Developer Console and are debited per request. ([docs.x.com pricing](https://docs.x.com/x-api/getting-started/pricing), [Announcing Pay-Per-Use](https://devcommunity.x.com/t/announcing-the-launch-of-x-api-pay-per-use-pricing/256476))

**Per-request credit costs:**
| Action | Cost |
|---|---|
| Post created (standard) | **$0.015** |
| Post created **containing a URL/link** | **$0.20** ⚠️ 13× more expensive |
| "Summoned" post (reply to a mention of the app) | $0.010 |
| Post read | $0.005 |
| User read | $0.010 |
| Like read | $0.001 |
- Reads are **capped at 2M/month**. **Deduplication**: fetching the same resource twice inside a 24h UTC window is charged once.
- Balance can go slightly negative, after which requests are **blocked until you top up**. Spending limits + auto-recharge are configurable.
- Bonus: pay-per-use apps can earn up to 20% back in xAI/Grok credits per dollar spent.

**Legacy tiers — closed to new signups, retained only for existing subscribers:**
| Tier | Price/mo | Post (write) cap | Read cap |
|---|---|---|---|
| Free | $0 | ~1,500 posts/mo (app-level), write-only | effectively none (login + post + media only) |
| Basic | **$200** | 3,000/mo user-level + 50,000/mo app-level | ~10,000–15,000 posts/mo |
| Pro | **$5,000** | 300,000 posts/mo | ~1,000,000 posts/mo |
| Enterprise | from ~$42,000 | custom | full firehose |

**Viability implication for Meegrow Social:**
- The old "post ~1,500 tweets/mo free" plan is **gone for new apps**. Budget must assume **real per-post cost**.
- Cost is dominated by the **$0.20 link penalty** — a social scheduler that posts links (blog promos, product URLs) pays 13× the linkless rate. **Design consideration:** consider first-comment link placement, or surface per-client posting cost. Pure text/media posts are cheap ($0.015).
- At $0.015/post, ~1,000 linkless posts/mo ≈ $15; ~1,000 posts each with a link ≈ $200. Reads are cheap but capped at 2M/mo.
- If you can inherit/keep a **legacy Basic ($200) seat**, it may still beat pay-per-use for high link-post volume — but new accounts cannot buy it.

### A3. Publishing

- **Create post:** `POST /2/tweets` — body `{ "text": "..." }`. Returns tweet `id`.
- **Threads:** post the root, then each subsequent post with `reply.in_reply_to_tweet_id` = previous id. No native "thread" object; you chain replies.
- **Replies:** `reply.in_reply_to_tweet_id`.
- **Quote tweets:** `quote_tweet_id` field.
- **Attach media:** `media.media_ids` array (up to 4 images, or 1 video/GIF).
- **Delete:** `DELETE /2/tweets/:id`.
- **Media upload flow (v2, chunked):** `POST /2/media/upload` with 4 steps —
  1. **INIT** — declare `total_bytes`, `media_type`, `media_category` (`tweet_image` / `tweet_video` / `tweet_gif`); returns `media_id`.
  2. **APPEND** — upload the file in **≤5 MB segments** (`segment_index` 0..n) to `/2/media/upload/{id}/append`.
  3. **FINALIZE** — `/2/media/upload/{id}/finalize`.
  4. **STATUS** — for video/GIF, poll `processing_info` until `state=succeeded` before attaching to a post. ([Chunked upload docs](https://docs.x.com/x-api/media/quickstart/media-upload-chunked))
- **Media specs / limits (typical):** images ≤5 MB (PNG/JPG/WEBP), GIF ≤15 MB, **video ≤512 MB / ≤140 s** on standard access (larger with elevated access; 1 GB+ requires special access), MP4 H.264 + AAC. Up to 4 images OR 1 video/GIF per post. Images can carry alt text via `POST /2/media/metadata`.

### A4. Analytics / metrics

- Post metrics come from **field expansions** on `GET /2/tweets`: request `tweet.fields=public_metrics,non_public_metrics,organic_metrics`.
- **`public_metrics`** (available broadly): `retweet_count`, `reply_count`, `like_count`, `quote_count`, `bookmark_count`, `impression_count`.
- **`non_public_metrics` / `organic_metrics`** (impressions breakdown, URL/profile/detail clicks, video views/quartiles): only for the **authenticated author's own posts**, and historically gated behind **higher access** (these were Basic+/Pro on the old tiers; on pay-per-use they are billed per read but availability still tracks account permissions). Plan for `public_metrics` as the reliable baseline; treat detailed engagement (clicks, video quartiles) as best-effort.
- Every metric pull is a **billed read** ($0.005/post) under pay-per-use — batch by requesting up to 100 ids per call and respect the 24h dedup window.

### A5. Token model

- **Access token: expires in 2 hours.**
- **Refresh token** (only if `offline.access` requested): **single-use, rotating** — each refresh returns a *new* access token **and a new refresh token**; the old refresh token is invalidated. You must persist the latest refresh token every cycle. Historically valid ~6 months of inactivity window.
- **Storage design:** per-client encrypted token store keyed by X user id; a background refresher must run < 2h cadence or refresh lazily on 401, and **atomically swap** the rotated refresh token (a lost rotation = client must re-auth).

### A6. Gotchas

- **Tier confusion:** most blog posts still describe Free/Basic/Pro; the live model for new apps is **pay-per-use credits** (Feb 2026). Do not architect around a free write allowance.
- **The $0.20 link tax** dominates cost for a marketing publisher — the single biggest budget line.
- **Media upload complexity:** chunked INIT/APPEND/FINALIZE/STATUS is fiddly; the new v2 chunked endpoints had documented 500-error teething issues through mid-2025. Add retries + status polling.
- **Rate limits** still apply *on top of* credit billing (per-endpoint windows, e.g. posting caps per 15 min / 24h) — a 429 is separate from running out of credits.
- **Refresh-token rotation race:** concurrent workers refreshing the same client token will invalidate each other — serialize refreshes per account.

---

## PART B — YouTube Data API v3

### B1. OAuth scopes (all SENSITIVE, not restricted — confirmed)

| Scope | Use |
|---|---|
| `.../auth/youtube.upload` | Upload videos (`videos.insert`) |
| `.../auth/youtube` | Manage account (playlists, metadata, etc.) |
| `.../auth/youtube.readonly` | Read channel/video data |
| `.../auth/youtube.force-ssl` | Full read/write incl. comments (superset used by most tools) |
| `.../auth/yt-analytics.readonly` | YouTube Analytics API (view stats) |

**Confirmed: these are classified "sensitive," not "restricted."** Restricted = Gmail/Drive-class scopes that trigger a mandatory **paid third-party CASA security assessment** (~$15k–$75k/yr). YouTube scopes require Google **OAuth verification** (brand review) but **no paid security audit**. ([Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification))

### B2. Quota (materially changed — no longer "6 uploads/day")

- **Default: 10,000 units/day** shared pool per Google Cloud project. Every call (even failing ones) costs ≥1 unit. ([Quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost))
- **`videos.insert` — the big change:** it used to cost **~1,600 units** (→ ~6 uploads/day). **Dec 2025** Google cut it to ~100 units; **since 1 Jun 2026 it bills to its own dedicated bucket of ~100 calls/day** (cost 1 unit in the "Video Uploads" bucket), **independent** of the 10,000-unit pool. **You can now do ~100 uploads/day on the free default**, and uploads no longer starve reads.
- **`search.list`** likewise moved to its **own ~100-calls/day bucket** — a 403 on search can happen even with 9,000 general units left. Avoid `search.list` for anything you can do with cheaper direct reads.
- Other costs: reads (`videos.list`, `channels.list`, `playlistItems.list`) = **1 unit**; **`thumbnails.set` = 50 units**; `captions.insert` = 400, `captions.update` = 450.
- **Requesting more:** submit a **Quota Extension Request** in Cloud Console → triggers a **Compliance/API Services audit** (ToS + branding + usage justification). Free but can take weeks and requires a working, verified app. ([Quota & compliance audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits))

### B3. Uploading

- **`videos.insert`** — **resumable upload** protocol (recommended for reliability): first request sends metadata JSON + gets an upload URL, then the bytes stream in chunks; supports resume on interruption.
- **Metadata** (`snippet` + `status` parts): `snippet.title` (≤100 chars), `snippet.description` (≤5,000 chars), `snippet.tags[]`, `snippet.categoryId`, `snippet.defaultLanguage`; `status.privacyStatus` (`private`/`unlisted`/`public`), `status.publishAt` (schedule, requires `private`), `status.selfDeclaredMadeForKids`.
- **`thumbnails.set`** — separate call (50 units) after upload; requires the channel to be **verified** to set custom thumbnails. JPG/PNG, ≤2 MB, 1280×720 recommended.
- **Specs:** MP4 (H.264/AAC) preferred; up to 256 GB / 12 h; formats incl. MOV, AVI, WMV, FLV, WebM.

### B4. OAuth verification requirement (the real operational pain)

- **Testing mode** (default when the OAuth consent screen is unverified):
  - **≤100 test users** (must be added by email to the consent screen).
  - **Refresh tokens expire after exactly 7 days** — brutal for an unattended publisher; every client would silently disconnect weekly.
  - Users see an **"unverified app" / Google-hasn't-verified warning** screen.
- **Production / verified:** removes the 100-user cap, the 7-day expiry, and the warning. Google verification for sensitive scopes requires:
  - Public **homepage** describing the app,
  - **Privacy policy** URL on the same domain,
  - **Domain ownership verified** in Google Search Console **under the same Google account** that owns the Cloud project,
  - A **demo video** showing the OAuth flow and how each scope is used,
  - Consistent app name/logo. Review typically takes days to a few weeks. ([Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [Manage app audience / test users](https://support.google.com/cloud/answer/15549945))
- **Multi-client model (recommended):** rather than each client OAuth-connecting (and each hitting verification/7-day limits), add **Meegrow's Google account as a Manager on the client's YouTube Brand Account** (via channel permissions). Then Meegrow's single verified app + single OAuth grant can `videos.insert` to the client's channel. Simpler consent, one verified app, one token to maintain per managed channel. Trade-off: relies on Brand Account (not personal-channel) structure and the client granting Manager access.

### B5. Analytics

- Separate **YouTube Analytics API** (`yt-analytics.readonly`) — `reports.query` with `metrics`, `dimensions`, `filters`, `startDate`/`endDate`.
- **Metrics:** `views`, `estimatedMinutesWatched`, `averageViewDuration`, `averageViewPercentage`, `subscribersGained`/`subscribersLost`, `likes`, `comments`, `shares`, plus monetized `estimatedRevenue`/ad metrics.
- **Dimensions:** `day`/`month`, `video`, `country`, `deviceType`, `trafficSource`, `ageGroup`, `gender`, `insightPlaybackLocationType`.
- **Reporting delay: ~48 hours** (Google withholds recent data for quality). For a dashboard, don't promise same-day stats — surface data as "through T-2 days." ([Analytics metrics](https://developers.google.com/youtube/analytics/metrics))
- For bulk/scheduled pulls there's also the **Reporting API** (pre-generated bulk CSV reports) — better for large historical backfills than per-query Analytics calls.

### B6. Gotchas

- **Quota exhaustion:** even at the improved ~100 uploads/day, `thumbnails.set` (50 units) + reads still draw the 10,000 pool; a chatty analytics/read loop can exhaust it. Cache reads; prefer direct id lookups over `search.list` (its own tiny bucket).
- **Shorts:** **no dedicated API.** A Short is just a normal `videos.insert` of a **vertical (9:16) video ≤3 min** (formerly ≤60s); add **`#Shorts`** in title/description to bias classification. Nothing else to do.
- **Verification pain:** the 7-day testing-mode token expiry is the #1 gotcha — you **must** get the app verified before onboarding real clients, or reconsider the Manager-account model.
- **Custom thumbnails** require channel verification (phone) on the target channel — will fail silently otherwise.
- **Resumable upload** is strongly preferred; simple uploads fail on large files / flaky networks with no resume.

---

## Build recommendation (one-liner each)
- **X:** Viable but **metered** — architect for pay-per-use credit accounting per client, minimize link-posts ($0.20 each), OAuth 2.0-only (no more OAuth 1.0a media dance), 2h access token + rotating single-use refresh token.
- **YouTube:** Viable and **quota-generous now** (~100 uploads/day free) — but **OAuth verification is mandatory** before real clients (7-day token expiry in testing kills unattended posting); prefer the **Brand Account Manager** model over per-client OAuth; expect a 48h analytics delay.
