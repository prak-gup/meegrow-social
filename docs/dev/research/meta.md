# Meta Graph API — Research Brief (Publishing + Analytics for IG & FB Pages)

> Scope: what a Postiz/Buffer-style platform needs to **publish** to Instagram Business/Creator accounts and Facebook Pages, and to **pull** analytics. Focused on the current API surface (mid-2026). Do not treat version numbers as frozen — Meta ships a new Graph API version ~quarterly and each version lives ~2 years.

**Current version:** Graph API / Instagram Platform is at **v25.0** in Meta's live docs (as of this writing). Always pin an explicit version in the path (e.g. `https://graph.facebook.com/v25.0/...`); un-versioned calls silently hit the oldest still-supported version. Instagram Login calls go to `graph.instagram.com`; Facebook Login + all FB Page calls go to `graph.facebook.com`.

---

## 0. The single most important architectural decision: which Instagram API

Since the **July 2024 relaunch**, there are **two distinct ways** to reach an Instagram professional account. They use different hosts, different login flows, and **different permission scope names**. Pick one (or support both).

| | **Instagram API with Instagram Login** (aka Instagram Business Login / "Direct Login") | **Instagram API with Facebook Login for Business** |
|---|---|---|
| Best for | IG-only businesses/creators with **no Facebook Page** | Accounts where IG is linked to a Facebook Page (and you also manage the Page) |
| Login product | **Business Login for Instagram** | **Facebook Login for Business** |
| Host | `graph.instagram.com` | `graph.facebook.com` |
| Token | Instagram User access token (IG-native, 60-day, refreshable) | Facebook User/Page token |
| Publish scope | `instagram_business_content_publish` | `instagram_content_publish` |
| Basic scope | `instagram_business_basic` | `instagram_basic` (+ `pages_show_list`, `pages_read_engagement`) |
| Needs a Page? | **No** | **Yes** — IG must be linked to a FB Page |

**Recommendation for a multi-tenant publisher:** support **both**. Most agency clients have IG↔Page linkage (use Facebook Login for Business — one login grabs both FB Pages and IG). But offer Instagram Login as a fallback for IG-only clients who refuse to connect a Page. Note the older `instagram_manage_*` scope names were **deprecated Jan 27, 2025** for the new products — the granular `instagram_business_*` names are the ones to use with Instagram Login.

Docs:
- Overview: https://developers.facebook.com/docs/instagram-platform/overview/
- Instagram API with Instagram Login: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
- Instagram API with Facebook Login: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login
- Business Login for Instagram: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/

---

## 1. OAuth & Permissions

### 1.1 Login flow
- **Facebook Login for Business** is the flow for FB Pages + IG-via-Page. You pre-build a **Configuration** in the App Dashboard (which permissions, which asset types) and get a **Configuration ID**. Your login dialog passes `config_id` instead of an ad-hoc `scope` list. Users go through Meta's Business asset picker and grant your app access to specific Pages/IG accounts/ad accounts.
  - https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
- **Business Login for Instagram** is the equivalent for Instagram Login (IG-only). Returns an IG user access token directly.

### 1.2 Exact scopes you need

**To publish + read insights via Facebook Login for Business:**
| Scope | Why |
|---|---|
| `pages_show_list` | Enumerate the Pages the user manages (`GET /me/accounts`) |
| `pages_read_engagement` | Read Page content/engagement; required alongside publish |
| `pages_manage_posts` | Create/delete Page feed posts, photos, videos, reels |
| `pages_read_user_content` | (optional) read user comments/posts on the Page |
| `read_insights` | Page-level insights (`/{page-id}/insights`) |
| `instagram_basic` | Read the linked IG account, its media, profile |
| `instagram_content_publish` | Publish to IG (container → publish) |
| `instagram_manage_insights` | IG account + media insights |
| `instagram_manage_comments` | Read/reply/hide/delete IG comments |
| `business_management` | (optional) manage assets via Business Manager; often needed for agency/multi-client asset access |

**To publish + read insights via Instagram Login (IG-only, no Page):**
- `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`, `instagram_business_manage_comments`.

### 1.3 App Review (the real bottleneck)
- Every publish/insights scope above requires **Advanced Access**, granted only after **App Review**. **Standard Access** (no review) only works for users who have a **Role on the app** (admins/devs/testers) — fine for dev, useless for real customers.
- **App Review requires a screencast** demonstrating each requested permission being used in your real flow, plus a test user Meta can reproduce with.
- **Business Verification is mandatory** for Advanced Access (verify your legal business entity via Business Manager). Apps built purely on Facebook Login for Business / Business Login for Instagram have **reduced ongoing-review** burden because they're limited to business permissions.
- Advanced Access apps are subject to **Ongoing/Data Use Checkup** to retain access.
- Budget **1–4 weeks** for review; rejections for insufficient screencast detail are common.
- Docs: https://developers.facebook.com/docs/instagram-platform/app-review/ · https://developers.facebook.com/docs/permissions/

---

## 2. Token model

### 2.1 Facebook side
1. **Short-lived user token** (~1–2 hrs) comes out of the login dialog.
2. **Exchange for long-lived user token (~60 days):**
   `GET /v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-token}` — **server-side only** (uses app secret).
3. **Get a Page access token:** `GET /v25.0/{user-id}/accounts?access_token={long-lived-user-token}` — the Page tokens returned from a **long-lived** user token are themselves **long-lived and effectively non-expiring** (they only die if the user changes password, deauthorizes, loses the Page role, or Meta invalidates them). This is what you store per-Page for autoposting.
   - https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
   - https://developers.facebook.com/docs/facebook-login/access-tokens/expiration-and-extension/

### 2.2 Instagram Login side
- IG user tokens from Business Login are **short-lived (1 hr)**; exchange for a **long-lived IG token (60 days)** and **refresh** it before expiry with the IG refresh endpoint (`GET /refresh_access_token?grant_type=ig_refresh_token`). Refreshing requires the token be at least 24 hrs old and still valid.

### 2.3 Health-check pattern ("expires in 29 days" like Zernio)
- Inspect any token with **`GET /debug_token?input_token={token}&access_token={app-id}|{app-secret}`** → returns `expires_at`, `data_access_expires_at`, `is_valid`, `scopes`, `granular_scopes`.
- Store `expires_at` per connected account. Run a daily cron that flags accounts where `expires_at - now < 7 days` and surfaces a "Reconnect account" prompt. FB **Page** tokens read as non-expiring (`expires_at: 0`); the thing that actually expires and needs reconnect is usually the **60-day user token** and the IG long-lived token — the countdown you show ("29 days left") is `data_access_expires_at` / `expires_at` on the user/IG token.
- Also handle **error subcode 458/463/467** (app unauthorized / token expired / invalid) at publish time by forcing reconnect.


### 2.4 Token scope gotchas (learned the hard way, 2026-07-16/17 live bring-up)
- **`/me/accounts` requires a USER token.** With a **Page** token `/me` resolves to the *Page*, which
  has no `accounts` edge — you get the baffling `(#100) Tried accessing nonexisting field (accounts)`
  rather than an auth error. We store the Page token, so pages cannot be re-enumerated after connect;
  `listAccounts`/`finalizeAccount` must run while the user token still exists (during the OAuth flow).
  To read a connected Page later, query its own node: `GET /{page-id}?fields=...` works with the Page token.
- **`post_impressions_unique` is REJECTED** (confirmed live 2026-07-16). Only `post_video_views` and
  `post_clicks` returned. Meta **400s the entire insights call** on one unknown metric name rather
  than omitting it — so request metrics ONE AT A TIME and skip failures, or a single retired name
  costs you every metric. This is §6's deprecation risk, live.
- **An IG permalink is an opaque shortcode** (`/p/CxYz123/`), NOT the numeric media id that
  `media_publish` returns. `instagram.com/p/{media-id}` 404s — fetch `?fields=permalink` instead.
- **A Page with no linked IG Business account** simply omits `instagram_business_account` from the
  response (no error). Filter those out of the account picker rather than offering one that fails at
  publish. `prakgup` (110548613724876) has no linked IG account — #13 needs one for live bring-up.

---

## 3. Publishing to Instagram (container → publish, 2 steps)

Instagram has **no direct upload** — media must be fetched by Meta from a **publicly accessible URL** (see gotchas). Two steps:

**Step 1 — create a media container:**
`POST /v25.0/{ig-user-id}/media`
- Image: `image_url=<public JPEG url>&caption=<text>` (default `media_type=IMAGE`)
- Reel/Video: `media_type=REELS&video_url=<public url>&caption=<text>&cover_url=<optional>&share_to_feed=true`
- Story: `media_type=STORIES&image_url=...` or `video_url=...`
- Carousel child: `is_carousel_item=true&image_url=...` (or video)
- Optional: `user_tags`, `location_id`, `alt_text` (image alt text added Mar 24 2025), `product_tags`
- Returns a **container id** (`creation_id`).

**Step 1b — for video/Reels, poll status:**
`GET /v25.0/{container-id}?fields=status_code,status` → wait until `status_code = FINISHED` (states: `IN_PROGRESS`, `FINISHED`, `ERROR`, `EXPIRED`). Containers **expire after 24 hrs** if unpublished.

**Step 2 — publish:**
`POST /v25.0/{ig-user-id}/media_publish?creation_id={container-id}` → returns the published **IG media id**.

**Carousels:** create 2–10 child containers (`is_carousel_item=true`), then one parent `POST /media` with `media_type=CAROUSEL&children=<comma-separated child ids>`, then publish the parent. All slides are cropped to the **first** image's aspect ratio.

### 3.1 Media specs (API)
**Images:** JPEG is the format the publishing API officially supports (feeds sometimes accept PNG but standardize on **JPEG** to avoid failures). Aspect ratio **4:5 → 1.91:1** (portrait to landscape); max file size **8 MB**; width 320–1440 px (1080 px wide is the sweet spot). Squares 1080×1080, portrait 1080×1350.

**Reels/Video:** container **MOV or MP4**; codec **H.264 or HEVC**, audio **AAC** (48 kHz); recommended aspect **9:16** (accepts ~0.01:1–10:1); duration **3 s to 15 min** technically accepted but **only 3–90 s @ 9:16** is eligible to surface in the Reels tab; max file size **~1 GB** (some Meta docs cite up to 4 GB for large-file resumable upload); frame rate **23–60 fps**; bitrate ≤ 25 Mbps; recommended res **1080×1920**. Cover/thumbnail: **JPEG, ≤ 8 MB, 9:16**.

**Caption / hashtags:** caption max **2,200 characters**, up to **30 hashtags**, up to **20 `@` user tags** (Meta enforces these platform-wide; the publishing docs don't restate the numbers but the app should validate client-side to avoid opaque failures).

### 3.2 Rate limit
- **Instagram accounts are limited to 100 API-published posts per rolling 24-hour window** (older docs/blogs say 25 — the current documented figure is **100/24h**; **carousels count as 1**). Check remaining quota: `GET /v25.0/{ig-user-id}/content_publishing_limit?fields=quota_usage,config`.
- Content publishing is **Business accounts only** for some paths — historically Creator accounts were unsupported for publishing; current guidance says both Business and Creator work under the new products, but **Business is the safe default**. Validate account type on connect.
- https://developers.facebook.com/docs/instagram-platform/content-publishing/
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit

---

## 4. Publishing to Facebook Pages

All calls use `graph.facebook.com` with the **Page access token**.

- **Text / link post:** `POST /v25.0/{page-id}/feed` with `message=<text>` and optional `link=<url>`. (Note: since 2018 you cannot customize link previews / `picture`,`name`,`caption` params — Meta strips them; the link's own OG tags render.)
- **Photo:** `POST /v25.0/{page-id}/photos` with `url=<public image url>` (or multipart `source`) + `caption`. For a **multi-photo** post: upload each photo with `published=false` to get media ids, then `POST /{page-id}/feed` with `attached_media[0]={media_fbid:...}` etc.
- **Video:** `POST /v25.0/{page-id}/videos` with `file_url=<public url>` or resumable upload; params `description`, `title`. Large files should use the **Resumable Upload API**.
- **Reels:** 3-phase flow via the **Video API** — `POST /v25.0/{page-id}/video_reels` with `upload_phase=start` → upload the binary to the returned `upload_url` (or pass `video_url`) → `POST /{page-id}/video_reels?upload_phase=finish&video_id=...&video_state=PUBLISHED&description=...`.
- **Scheduling (native):** add `published=false&scheduled_publish_time=<unix ts>` to feed/photo posts (10 min–75 days out) — lets you offload scheduling to Meta, though most schedulers manage timing themselves.
- **Stories:** `POST /{page-id}/photo_stories` and `/{page-id}/video_stories` (video stories use a start/finish upload session).

Required scopes: `pages_manage_posts` + `pages_read_engagement` (+ `pages_show_list`).

Docs:
- Page feed / publishing: https://developers.facebook.com/docs/pages-api/posts
- Page videos: https://developers.facebook.com/docs/graph-api/reference/page/videos/
- Page reels: https://developers.facebook.com/docs/graph-api/reference/page/video_reels/
- Video API (resumable + reels): https://developers.facebook.com/docs/video-api/

---

## 5. Analytics / Insights

### 5.1 Instagram
- **Per-media metrics:** `GET /v25.0/{ig-media-id}/insights?metric=reach,likes,comments,saved,shares,views,total_interactions`
- **Account-level:** `GET /v25.0/{ig-user-id}/insights?metric=reach,follower_count,profile_views&period=day&metric_type=total_value`
- **Follower total (current):** read `followers_count` as a **field** on the user node: `GET /v25.0/{ig-user-id}?fields=followers_count,follows_count,media_count`.
- **Deprecations (critical):** As of **Apr 21 / Mar 25 2025**, **`impressions`** is deprecated across IG media/story/carousel/profile and **replaced by `views`** (Meta maps old impressions → views). Also deprecated earlier (Graph v21, Jan 2025): `video_views` for non-Reels, `profile_views`, `website_clicks`, `email_contacts`, `phone_call_clicks`, `text_message_clicks`. **Migrate all reporting to `views` + `reach` + `total_interactions`.** Calling a deprecated metric returns an error, not a silent null.
- Scope: `instagram_manage_insights` (or `instagram_business_manage_insights`).
- https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/
- https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-media/insights/

### 5.2 Facebook Pages
- **Per-post:** `GET /v25.0/{post-id}/insights?metric=post_impressions,post_reactions_by_type_total,...` — **but** `post_impressions` (and organic/paid breakdowns) are being removed; migrate to **`post_media_view`** / views-based metrics.
- **Page-level:** `GET /v25.0/{page-id}/insights?metric=page_impressions,page_fans,...&period=day` — again, **`page_impressions` and `page_fans` are deprecated Nov 15 2025**, replaced by **`page_media_view`** (views) and **Page followers** (`followers_count` field / `page_follows`). A larger sweep of Page Insights metrics is scheduled to drop for **all versions by June 15 2026**.
- **Current follower/like counts:** read as fields — `GET /v25.0/{page-id}?fields=followers_count,fan_count`.
- Scope: `read_insights`.
- https://developers.facebook.com/docs/graph-api/reference/insights/
- https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/

### 5.3 Polling cadence
- Insights are **not real-time** — reach/views settle over ~24–48 h. Poll new posts hourly for the first 48 h, then daily for ~28 days, then weekly. Account-level follower counts: daily is plenty.
- Respect **BUC (Business Use Case) rate limits** — track the `X-Business-Use-Case-Usage` / `X-App-Usage` response headers and back off when nearing 100%.

---

## 6. Gotchas / failure modes (read before building the publish worker)

1. **The public-URL requirement is the #1 gotcha for IG.** Instagram never accepts a binary upload for feed/reels — it **fetches** `image_url`/`video_url` from your server. The URL must be publicly reachable (no auth, no signed-cookie), correct `Content-Type`, and stay alive until publish completes. Architecture: upload user media to **S3/CloudFront (or a signed but public-readable URL)** and hand Meta that URL. FB Pages *can* take a real upload, but mirroring the "stage to public URL" pattern keeps both paths uniform.
2. **Reel processing is async** — you MUST poll `status_code` until `FINISHED` before `media_publish`, or you get `ERROR`/"media not ready". Containers **expire in 24 h**.
3. **App Review + Business Verification is the real project risk**, not the code. Without Advanced Access nothing works for real customers. Screencasts must show each permission in use. Start review early.
4. **Rate limits are per-account and per-app.** IG: 100 posts/24h/account (carousels = 1). Plus app-level BUC limits. Build a queue with per-account throttling and read the usage headers.
5. **Business vs Creator matters:** publishing historically required **Business** IG accounts (Creator unsupported on some paths); comment/insight coverage also differs. Detect account type at connect time and warn Creator users. Personal accounts can't use the API at all.
6. **Metric deprecation churn:** `impressions` (IG + FB) → `views`; `page_fans` → followers. Don't hardcode `impressions`/`page_impressions` — they now error. Target `views`/`reach`/`total_interactions` and read follower counts as node fields.
7. **Token expiry UX:** FB Page tokens are effectively permanent but the **60-day user token** and **60-day IG long-lived token** are what break autoposting. Run the `debug_token` health cron and surface "reconnect in N days."
8. **Two IG products = two code paths** (`graph.instagram.com` vs `graph.facebook.com`, different scope names). Abstract the host + scope names behind a per-account "connection type" so the publish/insights layer is uniform.
9. **FB link previews aren't customizable** via API since 2018 — you can't override OG image/title on link posts; rely on the destination page's OG tags.
10. **Version pinning:** never call un-versioned endpoints. Track Meta's ~quarterly version releases and 2-year deprecation window; schedule a periodic bump.

---

## Key source URLs
- IG Platform overview: https://developers.facebook.com/docs/instagram-platform/overview/
- IG content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing/
- IG media_publish ref: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish/
- IG publishing limit: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
- IG insights: https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/
- Permissions reference: https://developers.facebook.com/docs/permissions/
- App Review (IG): https://developers.facebook.com/docs/instagram-platform/app-review/
- Facebook Login for Business: https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
- Long-lived tokens: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
- Token expiration/extension: https://developers.facebook.com/docs/facebook-login/access-tokens/expiration-and-extension/
- Pages posts API: https://developers.facebook.com/docs/pages-api/posts
- Video API: https://developers.facebook.com/docs/video-api/
- Page insights: https://developers.facebook.com/docs/graph-api/reference/insights/
- Page Insights deprecations (Aug 2025): https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/
