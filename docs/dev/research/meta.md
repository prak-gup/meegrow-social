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
  **Superseded 2026-10-11 (#54):** the name is no longer requested; see §5.2.1 for the replacement set.
- **An IG permalink is an opaque shortcode** (`/p/CxYz123/`), NOT the numeric media id that
  `media_publish` returns. `instagram.com/p/{media-id}` 404s — fetch `?fields=permalink` instead.
- **A Page with no linked IG Business account** simply omits `instagram_business_account` from the
  response (no error). Filter those out of the account picker rather than offering one that fails at
  publish. `prakgup` (110548613724876) has no linked IG account — #13 needs one for live bring-up.

### 2.5 Business-owned Pages: `me/accounts` comes back empty (live 2026-10-11) — and an UNVERIFIED fallback

**Observed live (a real client, invite link, 2026-10-11).** Login configuration with 7 permissions
(`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`,
`instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`): consent completed, the
Page was ticked, and `GET me/accounts` returned `{"data": []}`. After `business_management` was added
to the configuration, Meta's dialog gained a "Choose the Businesses" step and `me/accounts` listed the
Page. So a Page owned through a Meta Business portfolio is not listed without `business_management`.
That permission is broad and needs its own App Review justification.

**What Meta's documentation says (read 2026-10-11; nothing here was called):**

- `GET /debug_token` returns `granular_scopes` — "List of granular permissions that the user has
  granted for the app in this access token. If permission applies to all, targets will not be
  shown." — typed `shape('scope' => string, 'target_ids' => ?int[])[]`. It needs "an app access
  token or an app developer's user access token".
  https://developers.facebook.com/docs/graph-api/reference/debug_token/
- The Page node has an `access_token` field: "The Page's access token. Only returned if the User
  making the request has a role (other than Live Contributor) on the Page."
  https://developers.facebook.com/docs/graph-api/reference/page/
- The `/{user-id}/accounts` reference does not mention `business_management` or business-owned Pages
  at all; it says only that the edge returns Pages the user has a role on.
  https://developers.facebook.com/docs/graph-api/reference/user/accounts/
- The Facebook Login for Business guide does not say how an app finds which assets were granted.
  https://developers.facebook.com/docs/facebook-login/facebook-login-for-business

**What Meta does NOT document:** that reading `/{page-id}?fields=access_token` with the user token
works for a business-owned Page when `me/accounts` omits it. The two halves are documented
separately; nobody at Meta says they compose.

**Third-party reports that they do compose (not Meta, not ours):**

- A developer in Meta's community forum reports `me/accounts` empty, the Page id visible in the
  token's granular scopes in the debugger, and the Page token readable by id — with no
  `business_management` in the token. No Meta staff reply.
  https://developers.secure.facebook.com/community/threads/985555656616468
- An open-source PR describes the same fallback and reports it working live for one user, one app,
  two Pages. https://github.com/moudabdelwahab/social-center/pull/3

**What we built (`MetaClient.pagesFromGrantedScopes`):** only when `me/accounts` returns nothing,
read `granular_scopes`, take the `target_ids` of `pages_show_list` / `pages_read_engagement` /
`pages_manage_posts`, and `GET /{page-id}?fields=…` each with the user token (Instagram adds
`instagram_business_account{id,username}`). `me/accounts` stays the primary path, and the fallback
never throws, so today's behaviour cannot get worse. Fixtures are documentation-built.

**Known limits, even if it works:**

- `target_ids` is omitted when the person granted "all current and future" Pages — Meta's default
  for a new consent. The fallback then finds nothing. It can only help a person who ticked specific
  Pages (which is what the invite page now asks them to do).
- The `access_token` field needs a role on the Page. Whether access held through a business
  portfolio counts as a role for this read is exactly the thing that is unconfirmed.
- Ids are documented as integers; one past 2^53 would be corrupted by JSON parsing and is dropped.
  Page ids are well under that; Instagram ids are not, which is why IG is reached through its Page.

**The live test that settles it:** remove `business_management` from the login configuration; send
an invite to an admin of a business-owned Page; at "Continue as …?" choose "Edit settings" and tick
that one Page (not "all current and future"). If the picker lists the Page and connecting it then
publishes a post, the fallback works and `business_management` can stay out of App Review. If the
picker is empty, it does not, and `business_management` is required for business-owned Pages.

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
- **Per-post:** `GET /{post-id}/insights?metric=<one name>` — the `post_impressions*` family is gone for all API versions; the views-era set we request is in §5.2.1.
- **Page-level:** `GET /v25.0/{page-id}/insights?metric=page_impressions,page_fans,...&period=day` — again, **`page_impressions` and `page_fans` are deprecated Nov 15 2025**, replaced by **`page_media_view`** (views) and **Page followers** (`followers_count` field / `page_follows`). A larger sweep of Page Insights metrics is scheduled to drop for **all versions by June 15 2026**.
- **Current follower/like counts:** read as fields — `GET /v25.0/{page-id}?fields=followers_count,fan_count`.
- Scope: `read_insights`.
- https://developers.facebook.com/docs/graph-api/reference/insights/
- https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/

### 5.2.1 Per-post metric set (issue #54, researched 2026-10-11 — documentation only, NOT verified live)

No credentials were used for this pass: every name below comes from Meta's public reference, read
on 2026-10-11, and only the two marked "live" have ever been seen in a real response. The code asks
for one name per call and skips failures, so a name that turns out not to be served is simply absent.

| Requested name                 | What Meta documents                                                                                                                  | Status                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `post_media_view`              | "The number of times your content was played or displayed." Period `lifetime`; optional breakdowns `is_from_ads`, `is_from_followers` | Documented as current, and as the replacement for `post_impressions`. Not seen live.       |
| `post_total_media_view_unique` | "The number of total unique media viewers for FB post". Period `lifetime`                                                            | Documented as current, and as the replacement for `post_impressions_unique`. Not seen live. |
| `post_reactions_like_total`    | "Total "like" reactions of a post." Period `lifetime`                                                                                | Documented, no deprecation notice. Not seen live.                                          |
| `post_clicks`                  | Clicks anywhere on the post that do not generate a story. Period `lifetime`                                                          | Live 2026-07-16 (§2.4).                                                                    |
| `post_video_views`             | Plays of at least 3 seconds. Periods `lifetime`, `day`                                                                               | Live 2026-07-16 (§2.4).                                                                    |

What the documentation does **not** settle, so check after deploy:

- **Value shape of `post_media_view`.** The reference lists breakdowns but shows no response. We send
  no `breakdown` parameter and expect a plain number; if Meta returns an object the point is dropped
  (the column stays absent, nothing is stored wrongly).
- **Graph version.** `client.ts` pins `v21.0`. The deprecation page says the retired names are gone
  "for all API versions" and the reference marks them "Deprecated above Graph API v25", but neither
  says from which version the `*_media_view` names are served. If both come back absent on v21.0,
  the version is the first thing to suspect. (v21.0 is available until 2027-01-21 per the versions
  page, so a bump is due before then regardless — it touches publishing too and is not part of #54.)
- **Reactions.** Only "like" is requested. `post_reactions_love_total`, `_wow_`, `_haha_`, `_sorry_`,
  `_anger_` are documented the same way and cost one call each per post per sweep;
  `post_reactions_by_type_total` and `post_activity_by_action_type` return objects, which the
  key-value store cannot hold without inventing names (invariant 7). Comments and shares are not
  insights metrics at all — they are fields on the post node.

Retired, do not request (documented as returning an invalid-metric error on all versions):
`post_impressions`, `post_impressions_unique`, and their `_paid`, `_fan`, `_organic`, `_viral`,
`_nonviral` variants; also `post_activity`, `post_activity_unique`, `post_video_views_unique`.

Sources (read 2026-10-11):

- Insights reference, metric tables: https://developers.facebook.com/docs/graph-api/reference/insights/
- Deprecated Page Insights metrics and their replacements: https://developers.facebook.com/docs/platforminsights/page/deprecated-metrics
- Page Insights API updates (Aug 2025): https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/
- Graph API versions and expiry dates: https://developers.facebook.com/docs/graph-api/changelog/versions

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

## 7. Reading an account's existing posts (import past posts — researched 2026-10-11, documentation only)

**No Graph API call was made for this section.** Everything below is Meta's public developer
documentation as read on 2026-10-11 (the reference pages now render Graph API **v26.0**; `client.ts`
still pins `v21.0`). Each claim is marked **[documented]** (the page says it) or **[assumed]** (it does
not, and the code relies on it anyway). The provider fixtures built from this section are marked
documentation-built in the tests. §7.6 is the list the first live import must settle.

### 7.1 Facebook: listing a Page's posts

- **Edge: `GET /{page-id}/published_posts`**, with the stored Page token on the Page's own node —
  `me/accounts` is not involved (§2.4). **[documented]** that the edge exists, returns `PagePost`
  nodes with `paging`, and is "supported for New Page Experience".
  https://developers.facebook.com/docs/graph-api/reference/page/published_posts/
- **Why not `/feed`.** `/feed` is documented as requiring **both** `pages_read_engagement` **and**
  `pages_read_user_content`; our login configuration does not ask for the second. It also returns
  visitors' posts and unpublished posts ("Published and unpublished posts will be returned when
  querying the `/{page-id}/feed` endpoint"). **[documented]**
  https://developers.facebook.com/docs/graph-api/reference/page/feed/
- **Permission for `published_posts`.** The reference has no Requirements table; its error list says
  code 283 "requires the extended permission `pages_read_engagement` and/or `pages_read_user_content`
  and/or `pages_manage_ads` and/or `pages_manage_metadata`", and "Page Public Content Access … may be
  required" (that feature is for Pages the app user does not manage). We hold
  `pages_read_engagement`. **[assumed]** that it alone is enough for a Page the token's owner manages
  — the "and/or" wording allows it but does not promise it.
- **Fields** (documented on the feed/`PagePost` reference, same node type): `id`, `message`,
  `created_time` ("The time the post was initially published"), `permalink_url`, `full_picture` ("URL
  to a full-sized version of the Photo published in the Post or scraped from a link in the Post. If
  the photo's largest dimension exceeds 720 pixels, it is resized, with the largest dimension set to
  720"), `status_type` (`added_photos`, `added_video`, `mobile_status_update`, `shared_story`, …),
  `is_published`, `attachments` (story attachments: `media_type`, `type`, `target`, `media`, `url`,
  and a `subattachments` edge). **[documented]**
  https://developers.facebook.com/docs/graph-api/reference/story-attachment/
- **Limits.** "The API will return approximately 600 ranked, published posts per year." "You can only
  read a maximum of 100 feed posts with the `limit` field." **[documented]** Consequence: the list
  can leave a live post out, so absence from it is never proof of deletion (§7.5).
- **Paging.** Cursor paging (`paging.cursors.after`, `paging.next`) is shown in the feed sample.
  Time paging (`since` / `until`, Unix timestamps) is documented in general and its example is a feed:
  "For consistent results, specify both since and until parameters. Also, it is recommended that the
  time difference is a maximum of 6 months." Meta also says: "Don't store cursors. Cursors can quickly
  become invalid if items are added or deleted", and to stop "when the next link no longer appears" —
  a page can come back short or empty and still have a next page. **[documented]**
  https://developers.facebook.com/docs/graph-api/results/
  **[assumed]** that `published_posts` itself honours `since`/`until`: its own reference says "This
  endpoint doesn't have any parameters". The importer therefore also filters by `created_time` itself
  and stops at a page wholly older than the window, so it is correct either way; if the parameters
  are ignored the only cost is reading more pages. The 365-day window is wider than the recommended
  6 months — unverified.
- **Newest first** — **[assumed]**. "Ranked" is Meta's word. The importer does not depend on strict
  order (it filters every item), only on old posts not being served before new ones in bulk.
- **Reels.** "To get a list of Reels published to your Page, use the Page VideoReels edge."
  **[documented]** Whether a Page reel also appears in `published_posts` is not stated; this pass does
  not read `video_reels`, so Page reels may be missing from an import. Known gap.
- **Ids.** A Page post id is `{page-id}_{post-id}`. Our own publishes store what the publish call
  returned: `/feed` → that id; `/photos` → `post_id` (falling back to the photo id); `/videos` → the
  **video** id (`/videos` returns no `post_id`). So a post we published is recognised by the listed id
  **or** by `attachments.target.id` (the photo/video behind the story), **or** by the link we stored.
  **[assumed]** that `attachments{target{id}}` returns the same video id `/videos` returned.

### 7.2 Instagram: listing an account's media

- **Edge: `GET /{ig-user-id}/media`.** "Returns a maximum of 10K of the most recently created media."
  "Story IG Media not supported, use the `GET /<IG_ID>/stories` endpoint instead." "This endpoint
  supports time-based pagination. Include `since` and `until` query-string parameters with Unix
  timestamp or `strtotime` data values to define a time range." **[documented]**
  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- **Permissions:** `instagram_basic` and `pages_read_engagement` or `pages_show_list` — all held.
  "If the app user was granted a role on the Page via the Business Manager, you will also need one
  of: `ads_management`, `business_management`". **[documented]** This matters for the hospital: its
  Page is business-owned (§2.5), and `business_management` is in the login configuration only because
  of that. If it is ever removed from the configuration, this read is the first thing to re-test.
- **Token.** The reference lists a _User_ access token. We hold the Page token. **[assumed]** that
  the Page token reads this edge — the same token already publishes to and reads insights from the
  same IG user node in production, which is why it is expected to.
- **Fields** (IG Media reference): `id`, `caption`, `media_type` (`CAROUSEL_ALBUM`, `IMAGE`,
  `VIDEO`), `media_product_type` (`AD`, `FEED`, `STORY`, `REELS`), `media_url`, `thumbnail_url`
  ("Only available on `VIDEO` media"), `permalink`, `timestamp` (ISO 8601, UTC), and the `children`
  edge for albums. "The `media_url` field is omitted from responses if the media contains copyrighted
  material or has been flagged for a copyright violation. Examples of copyrighted material can
  include audio on Reels." "Some fields, such as `permalink`, cannot be used on photos within albums
  (children)." **[documented]**
  https://developers.facebook.com/docs/instagram-platform/reference/instagram-media
- **Media-URL expiry.** What Meta says: "Instagram Platform leverages Content Delivery Network (CDN)
  URLs … The CDN URL is privacy-aware and will not return the media when the content has been deleted
  or has expired." **[documented]**
  https://developers.facebook.com/docs/instagram-platform/overview/
  What it does **not** say is how long a `media_url` / `thumbnail_url` (or a Facebook `full_picture`)
  stays valid. That these are signed URLs carrying an expiry (`oe=…`) and stop working within days is
  widely observed and **[assumed]** here. **Decision: never store the platform's URL.** The importer
  fetches one still per post at import time (IG: `media_url` for an image, `thumbnail_url` for a
  video, the first child for an album; FB: `full_picture`), writes it to our own storage, and stores
  our URL. No refresh job, no broken thumbnails later; cost is one small image per imported post.
  A still that cannot be fetched leaves the post imported without a picture.
- **Ids.** The id `media_publish` returns is the media id this edge lists. **[assumed]**

### 7.3 Rate limits relevant to a backfill

- **Which limit applies.** "Pages API requests made with … system user or page access tokens are
  subject to Business Use Case Rate Limits"; Instagram Platform requests are BUC-limited too. Every
  call we make uses a Page token, so everything here is BUC. **[documented]**
  https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- **Pages:** "Calls within 24 hours = 4800 \* Number of Engaged Users" (users who engaged with the
  Page per 24 hours). **Instagram:** "Calls within 24 hours = 4800 \* Number of Impressions", counted
  per app-and-app-user pair. **[documented]** Both scale with the account's own activity, so a quiet
  account has a small allowance; the minimum is not stated for these two (Threads documents a floor
  of 10 impressions; **[assumed]** nothing about ours).
- **Headers.** `X-Business-Use-Case-Usage`: a JSON object keyed by business-object id, each an array
  of `{ type, call_count, total_cputime, total_time, estimated_time_to_regain_access }` —
  `call_count`, `total_cputime`, `total_time` are percentages ("When total_cputime reaches 100, calls
  may be throttled"); `estimated_time_to_regain_access` is "Time, in minutes, until calls will not
  longer be throttled"; `type` is e.g. `pages` or `instagram`. `X-App-Usage`: `{ call_count,
total_cputime, total_time }`, also percentages. Usage headers appear "once enough calls have been
  made to an endpoint", so their absence means "not reported", not "zero". **[documented]**
- **Error codes when throttled:** `80001` "Page calls made with a Page or System User access token",
  `80002` Instagram, `32` Page calls with a User token, `4` app, `17` user, `613` custom.
  **[documented]** Before this change `mapMetaError` did not know 80001/80002 and treated them as a
  permanent bad request — a throttled publish failed for good instead of retrying.
- **Best practice Meta states:** "When the limit has been reached, stop making API calls. Continuing
  to make calls will continue to increase your call count." **[documented]**
- **What the importer does with this:** pages of 25 with a second between them; after every page it
  reads the headers and **stops at 50%** of any figure (or whenever Meta names a regain time), pauses
  at least 30 minutes, and continues from the oldest post it read. Being throttled (80001/80002) is
  the same pause, never a failed import. 50% is our choice, not Meta's: publishing shares the
  allowance and must always find room.

### 7.4 How insights age

- Instagram media insights: "Data used to calculate metrics can be delayed up to 48 hours." "Metrics
  data is stored for up to 2 years." "Insights data is not available for any media within an
  [album]." "Story media metrics are only available for 24 hours." `impressions` is deprecated for
  media created after 2 July 2024. **[documented]**
  https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
- Consequences: an imported IG post older than two years has no insights (a 365-day import is well
  inside that); an album is polled as a whole, never per child; stories are not imported at all
  (they are not on `/media`, and their insights are gone after a day).
- Facebook post insights for old posts: no ageing rule found in the reference. **[assumed]** that
  `lifetime` metrics remain readable for a post of any age.
- **Polling cadence that follows:** a lifetime total barely moves once a post is months old, so
  `POST_POLL_TIERS` polls hourly for 48 h, daily to 30 days, weekly to 90 days, every 4 weeks after —
  and at most 25 posts per account per hourly sweep, newest first. 500 imported posts therefore take
  about 20 sweeps to get their first numbers, at ≤150 calls per account per hour, instead of
  ~3,000 calls in one.

### 7.5 A post deleted on the platform

- Reading a deleted object's node: Meta's error reference lists code 100 as "Invalid parameter" and
  does not document a specific answer for a missing object. The answer widely seen is
  `code 100, error_subcode 33`: "Unsupported get request. Object with ID '…' does not exist, cannot
  be loaded due to missing permissions, or does not support this operation." **[assumed]** — and the
  message itself says a missing _permission_ produces the same answer.
  https://developers.facebook.com/docs/graph-api/guides/error-handling/
- So a post is marked removed only when **both** hold: a complete read of a window did not list it,
  **and** its node answers 100/33 (or HTTP 404) while the account's own node still reads with the
  same token. Either signal alone is not trusted. Anything else is "unknown" and nothing is marked.
- If Meta answers a deleted post differently from 100/33, deletions are simply never detected (the
  safe failure). That is the thing to check live: delete a test post and see what its node returns.

### 7.6 What the first live import must confirm

Against the hospital's Page and Instagram account, watching `event_logs` (`kind = 'connection'`,
`status` starting `import_`) and the connection's `import` state:

1. `published_posts` answers with `pages_read_engagement` alone — not error 283 / 200.
2. `since` / `until` are honoured on `published_posts` (the run ends after the window, not after
   reading a year of posts).
3. `{ig-user-id}/media` answers with the Page token (not a "requires a user token" error), and, with
   `business_management` in the configuration, does not ask for more.
4. A post published from this app is **matched, not duplicated**: text, photo, multi-photo and above
   all **video** (the video-id-vs-story-id case) on Facebook; image and reel on Instagram. Check
   `matched` in the result and that no post appears twice in Content.
5. Thumbnails load from our own storage a week later (the platform's URLs would have expired).
6. The owner's deleted Facebook test post reads "Removed on platform" after a run — or, if it does
   not, what `GET /{post-id}?fields=id` returned for it.
7. Which usage headers actually arrive, and their values after a 90-day backfill.
8. Whether Page reels are in the list at all.
9. Re-record the fixtures in `providers/meta/published-posts.test.ts` from the real responses.

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
- Page published posts: https://developers.facebook.com/docs/graph-api/reference/page/published_posts/
- Page feed (fields, limits): https://developers.facebook.com/docs/graph-api/reference/page/feed/
- IG user media: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- IG media node: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media
- IG media insights: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
- Rate limits and usage headers: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- Paginated results: https://developers.facebook.com/docs/graph-api/results/
