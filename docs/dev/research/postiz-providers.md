# Postiz Provider Knowledge — Primary-Source Extraction

Source: running `postiz` container, `/app/libraries/nestjs-libraries/src/integrations/`.
Extracted for the greenfield **meegrow-social** platform. Facts (scopes, endpoint URLs,
method names, request shapes) only — no code copied. All scope strings and URLs below are
quoted verbatim from the actual `*.provider.ts` files.

---

## 1. The Provider Contract (most valuable artifact)

File: `social/social.integrations.interface.ts`. Every provider `implements SocialProvider`,
which is the intersection of two interfaces plus a metadata block. This is the shape our own
`SocialProvider` interface should mirror.

### `IAuthenticator` — OAuth lifecycle
- `authenticate({ code, codeVerifier, refresh? }, clientInformation?) → AuthTokenDetails | string`
  — exchanges the OAuth callback code for tokens. `codeVerifier` doubles as the PKCE verifier
  **or** (for OAuth 1.0a like X) a packed `oauth_token:oauth_token_secret`.
- `generateAuthUrl(clientInformation?) → { url, codeVerifier, state }` — builds the provider
  authorize URL; returns the verifier + state to persist in session for CSRF/PKCE.
- `refreshToken(refreshToken) → AuthTokenDetails` — refresh flow (stubbed to empty for
  providers whose tokens don't refresh, e.g. base Instagram/Facebook page tokens).
- `reConnect?(id, requiredId, accessToken)` — re-link an existing account.
- `analytics?(id, accessToken, date) → AnalyticsData[]` — account-level insights.
- `postAnalytics?(integrationId, accessToken, postId, fromDate) → AnalyticsData[]` — per-post insights.
- Optional profile mgmt: `changeNickname?`, `changeProfilePicture?`, `missing?`.

### `ISocialMediaIntegration` — publishing
- `post(id, accessToken, postDetails: PostDetails[], integration) → PostResponse[]`
  — the core publish call. `postDetails` is an **array** (thread/multi-part native support).
- `comment?(id, postId, lastCommentId, accessToken, postDetails, integration) → PostResponse[]`
  — first comment / reply chain.

### Shared types (copy these conceptually)
```
AuthTokenDetails = { id, name, accessToken, refreshToken?, expiresIn?, username,
                     picture?, error?, additionalSettings?[] }
GenerateAuthUrlResponse = { url, codeVerifier, state }
PostDetails<T> = { id, message, settings: T, media?: MediaContent[], poll?: PollDetails }
MediaContent = { type: 'image'|'video', path, alt?, thumbnail?, thumbnailTimestamp? }
PollDetails  = { options: string[], duration: number(hours) }
PostResponse = { id(db), postId(platform), releaseURL, status }
AnalyticsData = { label, data: {total,date}[], percentageChange }
ClientInformation = { client_id, client_secret, instanceUrl }  // for BYO-app / self-host providers
```

### `SocialProvider` metadata fields (drive UI + engine behaviour)
- `identifier` (string key, e.g. `'instagram'`), `name`, `toolTip`.
- `scopes: string[]` — the OAuth scope array (see per-provider tables).
- `isBetweenSteps: boolean` — **key concept**: `true` means OAuth is a two-step flow —
  after the redirect the user must still pick a Page / Organization / Channel before the
  integration is finalized (Facebook, Instagram-business, LinkedIn-Page, YouTube, GMB).
  `false` = one-shot connect (LinkedIn personal, X, Threads, TikTok, IG-standalone).
- `editor: 'none'|'normal'|'markdown'|'html'` — content editor type.
- `maxLength: (additionalSettings?) => number` — per-platform char limit.
- `oneTimeToken?` — token cannot be reused/refreshed (LinkedIn).
- `refreshWait?`, `refreshCron?` — refresh scheduling hints (see §4).
- `convertToJPEG?`, `stripLinks?`, `isWeb3?`, `isChromeExtension?`, `extensionCookies?`.
- `customFields?()` — provider-supplied config fields (client_id/secret for BYO-app).
- `externalUrl?`, `mention?`, `mentionFormat?`, `fetchPageInformation?`, `dto` (validation schema).

---

## 2. Abstract Base Class — `social.abstract.ts` (`SocialAbstract`)

Worth copying conceptually. Every provider `extends SocialAbstract`.

- `abstract identifier`; `maxConcurrentJob = 1` (per-provider concurrency ceiling, overridden:
  IG=400, IG-standalone=200, FB=100, TikTok=300, LinkedIn=2, Threads=2, X=1).
- `fetch(url, options, identifier, totalRetries, ignoreConcurrency)` — a resilient wrapper over
  native `fetch`. Returns on 200/201. On **429 / 500 / "rate_limit_exceeded" / "Rate limit"**
  it sleeps 5s and retries (max 3). On **401** (or `handleErrors` → `refresh-token`) throws
  `RefreshToken`; otherwise throws `BadBody`.
- `handleErrors(body, status)` — overridable hook returning
  `{ type: 'refresh-token'|'bad-body'|'retry', value }`. Each provider parses its own error
  bodies here (e.g. Facebook maps "Error validating access token" → refresh-token).
- `checkScopes(required, got)` — validates granted scopes ⊇ required; splits on `,` or ` `;
  throws `NotEnoughScopes` otherwise.
- `runInConcurrent(func, ignoreConcurrency?)` — wraps a call, converting thrown errors into
  typed `RefreshToken`/`BadBody`.
- `mention()` — default `{ none: true }`.

**Error classes tie into Temporal:** `RefreshToken` and `BadBody` extend
`@temporalio/activity` `ApplicationFailure` (type `'refresh_token'` / `'bad_body'`,
non-retryable). So a provider throwing `RefreshToken` deterministically drives the workflow's
refresh branch rather than a blind retry. Our engine should adopt the same typed-failure pattern.

---

## 3. Per-Provider Facts

### Instagram (Facebook Business) — `instagram.provider.ts`
- identifier `instagram`; `isBetweenSteps=true`; maxLength 2200; maxConcurrentJob 400.
- **scopes**: `instagram_basic`, `pages_show_list`, `pages_read_engagement`,
  `business_management`, `instagram_content_publish`, `instagram_manage_comments`,
  `instagram_manage_insights`.
- Auth via Facebook: `https://www.facebook.com/v20.0/dialog/oauth`; token exchange at
  `https://graph.facebook.com/v20.0/oauth/access_token`; scopes verified at `/me/permissions`.
- Page/IG-account discovery: `/me/accounts?fields=...,instagram_business_account` and
  `/me/businesses` → owned_pages/client_pages (this is the "between steps" account picker).
- **Publish** (2-step container): `POST graph.facebook.com/v20.0/{ig-id}/media` (create
  container; carousel = children + `is_carousel_item`; poll `?fields=status_code`) then
  `POST /{ig-id}/media_publish?creation_id=...`; permalink from `/{mediaId}?fields=permalink`.
- **Comment**: `POST /{postId}/comments?message=...`.
- **Analytics**: `/{id}/insights?metric=follower_count,reach&period=day` and
  `metric_type=total_value&metric=likes,views,comments,shares,saves,replies` (v21.0);
  post insights `/{postId}/insights?metric=views,reach,saved,likes,comments,shares`.
- Music search: `/v20.0/music/search`.

### Instagram (Standalone) — `instagram.standalone.provider.ts`
- identifier `instagram-standalone`; `isBetweenSteps=false`; `refreshCron=true`; maxLength 2200.
- **scopes**: `instagram_business_basic`, `instagram_business_content_publish`,
  `instagram_business_manage_comments`, `instagram_business_manage_insights`.
- Auth via Instagram directly: `https://www.instagram.com/oauth/authorize?enable_fb_login=0`;
  short-token at `https://api.instagram.com/oauth/access_token`, upgraded to long-lived at
  `https://graph.instagram.com/access_token`; profile `graph.instagram.com/v21.0/me`.
- **Refresh**: `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`.
- Reuses `instagramProvider.handleErrors`. Media/publish flow mirrors the FB-business one but
  against `graph.instagram.com`.

### Facebook Page — `facebook.provider.ts`
- identifier `facebook`; `isBetweenSteps=true`; maxLength 63206; maxConcurrentJob 100.
- **scopes**: `pages_show_list`, `business_management`, `pages_manage_posts`,
  `pages_manage_engagement`, `pages_read_engagement`, `read_insights`.
- Auth `https://www.facebook.com/v20.0/dialog/oauth`; token `/oauth/access_token`;
  page picker via `/me/accounts` (+ `/me/businesses` owned/client pages) — returns per-page
  `access_token` (page tokens).
- **Publish** by content type: text → `POST /{pageId}/feed`; photo → `/{pageId}/photos`;
  reel/video → `/{pageId}/videos`; **stories** → `/{pageId}/video_stories` (start/finish upload
  phases) or `/{pageId}/photo_stories`. releaseURLs: `/reel/{id}`, `/stories/{id}`.
- **Comment**: `POST /{replyToId}/comments`.
- **Analytics**: page `/{id}/insights?metric=page_impressions_unique,page_posts_impressions_unique,page_post_engagements,page_daily_follows,page_video_views`;
  post `/{postId}/insights?metric=post_impressions_unique,post_reactions_by_type_total,post_clicks,post_clicks_by_type`.

### LinkedIn (personal) — `linkedin.provider.ts`
- identifier `linkedin`; `isBetweenSteps=false`; `oneTimeToken=true`; `refreshWait=true`; maxLength 3000; maxConcurrentJob 2.
- **scopes**: `openid`, `profile`, `w_member_social`, `r_basicprofile`,
  `rw_organization_admin`, `w_organization_social`, `r_organization_social`.
- Auth `https://www.linkedin.com/oauth/v2/authorization?response_type=code&...&prompt=none`;
  token `https://www.linkedin.com/oauth/v2/accessToken`; profile `/v2/userinfo` + `/v2/me`.
- **Publish**: `POST https://api.linkedin.com/rest/posts` (versioned REST API, `LinkedIn-Version`
  header). **Media**: register/upload via `/rest/images` or
  `/rest/videos?action=initializeUpload` → chunk upload → `/rest/videos?action=finalizeUpload`.
- **Analytics/engagement**: `/v2/socialActions/{urn}`. Org lookup `/v2/organizations?q=vanityName`.

### LinkedIn Page — `linkedin.page.provider.ts` (extends LinkedinProvider)
- identifier `linkedin-page`; `isBetweenSteps=true`; same scopes as personal.
- Auth same authorization/token endpoints (redirect `/linkedin-page`). Admin org discovery:
  `/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR` (the between-steps org picker);
  org detail `/v2/organizations/{id}`.
- **Publish**: `POST /rest/posts` as `author = urn:li:organization:{id}`.
- **Analytics**: `/v2/organizationPageStatistics`, `/v2/organizationalEntityFollowerStatistics`,
  `/v2/organizationalEntityShareStatistics`, plus `/v2/socialActions/{urn}` for post engagement.

### X (Twitter) — `x.provider.ts`
- identifier `x`; `isBetweenSteps=false`; `scopes = []` (**OAuth 1.0a, not OAuth2 scopes**);
  maxLength 200 (4000 if `isTwitterPremium`); maxConcurrentJob 1 (300 posts/3h limit);
  `stripLinks` gated by env `STRIP_LINKS_FROM_X_POSTS`.
- Uses `twitter-api-v2`. `generateAuthUrl` → `generateAuthLink` yielding `oauth_token` +
  `oauth_token_secret`; `codeVerifier` stores `oauth_token:oauth_token_secret`, `state=oauth_token`.
- Requests signed HMAC-SHA1 with `X_API_KEY`/`X_API_SECRET` (consumer key/secret) env vars.
- **Publish**: `POST https://api.x.com/2/tweets` (thread = chained `reply.in_reply_to_tweet_id`);
  releaseURL `https://twitter.com/{username}/status/{id}`. Media uploaded via v1.1 media endpoint
  (twitter-api-v2 `uploadMedia`), images pre-processed with `sharp`.

### YouTube — `youtube.provider.ts`
- identifier `youtube`; `isBetweenSteps=true`; maxLength 5000. Uses `google-auth-library`
  `OAuth2Client` + `googleapis` (`google.youtube`, `google.oauth2`, `youtubeAnalytics`).
- **scopes** (full Google URLs): `.../auth/userinfo.profile`, `.../userinfo.email`,
  `.../youtube`, `.../youtube.force-ssl`, `.../youtube.readonly`, `.../youtube.upload`,
  `.../youtubepartner`, `.../yt-analytics.readonly`.
- Auth via `client.generateAuthUrl(...)` (Google consent, `access_type=offline`); redirect
  `/integrations/social/youtube`.
- **Publish**: `youtube.videos.insert` (resumable upload of the video file) via the SDK;
  releaseURL `https://www.youtube.com/watch?v={id}`.
- **Analytics**: `youtubeAnalytics` SDK client.

### Google My Business (google-business) — `gmb.provider.ts`
- identifier `gmb`; name "Google My Business"; `isBetweenSteps=true`; maxLength 1500. Uses
  `OAuth2Client` (redirectUri `/integrations/social/gmb`).
- **scopes**: `.../auth/userinfo.profile`, `.../userinfo.email`, `.../auth/business.manage`.
- Account/location discovery: `https://mybusinessaccountmanagement.googleapis.com/v1/accounts`
  → `https://mybusinessbusinessinformation.googleapis.com/v1/{account}/locations` (location picker).
- **Media**: `POST .../mybusinessbusinessinformation/v1/{location}/media`.
- **Publish**: `POST https://mybusiness.googleapis.com/v4/{id}/localPosts`;
  releaseURL `https://business.google.com/locations/{locationId}`.
- **Analytics**: `https://businessprofileperformance.googleapis.com/v1/{location}:fetchMultiDailyMetricsTimeSeries`
  with `dailyMetrics=WEBSITE_CLICKS,CALL_CLICKS,BUSINESS_DIRECTION_REQUESTS,BUSINESS_IMPRESSIONS_DESKTOP_MAPS,BUSINESS_IMPRESSIONS_MOBILE_MAPS`.

### Threads — `threads.provider.ts`
- identifier `threads`; `isBetweenSteps=false`; `refreshCron=true`; maxLength 500; maxConcurrentJob 2.
- **scopes**: `threads_basic`, `threads_content_publish`, `threads_manage_replies`,
  `threads_manage_insights` (`threads_profile_discovery` commented out).
- Auth `https://www.threads.net/oauth/authorize`; token `https://graph.threads.net/oauth/access_token`
  then long-lived `/access_token`; **refresh**
  `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token`.
- Profile `graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url`.
- **Publish** (2-step container): `POST /v1.0/{userId}/threads` (poll `?fields=status,error_message`)
  then `POST /v1.0/{userId}/threads_publish?creation_id=...`; permalink `/{threadId}?fields=id,permalink`.
- **Analytics**: `/v1.0/{id}/threads_insights?metric=views,likes,replies,reposts,quotes`;
  post `/{postId}/insights?metric=views,likes,replies,reposts,quotes`.

### TikTok — `tiktok.provider.ts`
- identifier `tiktok`; `isBetweenSteps=false`; maxLength 2000; maxConcurrentJob 300.
- **scopes**: `video.list`, `user.info.basic`, `video.publish`, `video.upload`,
  `user.info.profile`, `user.info.stats`.
- Auth `https://www.tiktok.com/v2/auth/authorize/`; token
  `https://open.tiktokapis.com/v2/oauth/token/`; profile
  `/v2/user/info/?fields=open_id,avatar_url,display_name,union_id,username`.
- **Publish**: query `POST /v2/post/publish/creator_info/query/` (privacy/limit options) →
  init `POST /v2/post/publish/{video|content}/init/` → poll `/v2/post/publish/status/fetch/`;
  releaseURL `https://www.tiktok.com/@{id}/video/{id}`.
- **Analytics**: `/v2/user/info/?fields=follower_count,following_count,likes_count,video_count`;
  posts `/v2/video/list/` + `/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count`.

---

## 4. Per-Provider Compact Table

| platform | scopes | auth URL base | redirect path | publish endpoint | media flow | analytics endpoint |
|---|---|---|---|---|---|---|
| instagram | instagram_basic, pages_show_list, pages_read_engagement, business_management, instagram_content_publish, instagram_manage_comments, instagram_manage_insights | facebook.com/v20.0/dialog/oauth | /integrations/social/instagram | graph.facebook.com/v20.0/{ig}/media → /media_publish | 2-step container (create→publish), carousel children | /{id}/insights (v21) follower_count,reach + total_value likes,views,comments,shares,saves,replies |
| instagram-standalone | instagram_business_basic, instagram_business_content_publish, instagram_business_manage_comments, instagram_business_manage_insights | instagram.com/oauth/authorize | /integrations/social/instagram-standalone | graph.instagram.com {user}/media → media_publish | 2-step container | graph.instagram.com insights (refreshCron token) |
| facebook | pages_show_list, business_management, pages_manage_posts, pages_manage_engagement, pages_read_engagement, read_insights | facebook.com/v20.0/dialog/oauth | /integrations/social/facebook | graph.facebook.com/v20.0/{page}/feed \| /photos \| /videos \| /video_stories \| /photo_stories | direct upload per type; stories = start/finish phases | /{page}/insights page_* ; /{post}/insights post_* |
| linkedin | openid, profile, w_member_social, r_basicprofile, rw_organization_admin, w_organization_social, r_organization_social | linkedin.com/oauth/v2/authorization | /integrations/social/linkedin | api.linkedin.com/rest/posts | /rest/images \| /rest/videos initializeUpload→finalizeUpload | /v2/socialActions/{urn} |
| linkedin-page | (same as linkedin) | linkedin.com/oauth/v2/authorization (prompt=none) | /integrations/social/linkedin-page | api.linkedin.com/rest/posts (author=org urn) | same as linkedin | /v2/organizationPageStatistics, organizationalEntityFollower/ShareStatistics |
| x | [] (OAuth 1.0a, HMAC-SHA1) | twitter-api-v2 generateAuthLink | /integrations/social/x | api.x.com/2/tweets | v1.1 media upload (uploadMedia); sharp preprocess | (via twitter-api-v2; account/tweet metrics) |
| youtube | userinfo.profile, userinfo.email, youtube, youtube.force-ssl, youtube.readonly, youtube.upload, youtubepartner, yt-analytics.readonly | Google OAuth2 (client.generateAuthUrl) | /integrations/social/youtube | youtube.videos.insert (SDK, resumable) | resumable video upload via googleapis | youtubeAnalytics SDK |
| gmb (google-business) | userinfo.profile, userinfo.email, business.manage | Google OAuth2 (client.generateAuthUrl) | /integrations/social/gmb | mybusiness.googleapis.com/v4/{id}/localPosts | mybusinessbusinessinformation/v1/{loc}/media | businessprofileperformance/v1/{loc}:fetchMultiDailyMetricsTimeSeries |
| threads | threads_basic, threads_content_publish, threads_manage_replies, threads_manage_insights | threads.net/oauth/authorize | /integrations/social/threads | graph.threads.net/v1.0/{user}/threads → /threads_publish | 2-step container (create→publish) | /v1.0/{id}/threads_insights views,likes,replies,reposts,quotes |
| tiktok | video.list, user.info.basic, video.publish, video.upload, user.info.profile, user.info.stats | tiktok.com/v2/auth/authorize/ | /integrations/social/tiktok | open.tiktokapis.com/v2/post/publish/{video\|content}/init/ | creator_info query → init → status/fetch poll | /v2/video/query like_count,comment_count,share_count,view_count |

Notes: redirect path pattern is uniform — `${FRONTEND_URL}/integrations/social/<identifier>`.
Local dev wraps it in `https://redirectmeto.com/...` for providers that reject localhost
(Instagram-standalone, Threads, TikTok).

---

## 5. Architecture — Registration, Tokens, Scheduling

### Provider registration (`integration.manager.ts`)
- A hand-maintained array `socialIntegrationList: Array<SocialAbstract & SocialProvider>` of
  `new XProvider()` instances (no decorator auto-discovery — explicit list).
- `IntegrationManager` (NestJS `@Injectable`) resolves by string:
  `getSocialIntegration(identifier) → SocialProvider`. `getAllIntegrations()` projects
  UI-facing metadata (name, identifier, toolTip, editor, isExternal, isWeb3, customFields).
- Tool/plug/rules metadata is attached via `reflect-metadata` decorators (`custom:tool`,
  `custom:plug`, `custom:rules:description`) and read through `Reflect.getMetadata`.
  → **Adopt:** a registry keyed by `identifier` + a resolver is enough; we don't need decorators
  unless we want the AI-tool / plug extensibility layer.

### Token storage & refresh
- Tokens persisted via `IntegrationService.createOrUpdateIntegration(... accessToken,
  refreshToken, expiresIn ...)` into the Prisma `Integration` table (fields: `token`,
  `internalId`, `providerIdentifier`, `organizationId`, `refreshNeeded`, etc.).
- `RefreshIntegrationService.refresh(integration)` looks up the provider, calls its
  `refreshToken`, and re-persists. `oneTimeToken` providers (LinkedIn) are flagged so tokens
  aren't treated as refreshable.
- `refreshCron` providers (Instagram-standalone, Threads) get a scheduled **Temporal**
  refresh workflow (`startRefreshWorkflow`, `apps/orchestrator/src/workflows/refresh.token.workflow.ts`).
- A provider throwing `RefreshToken` (from `SocialAbstract.fetch` on 401) marks
  `refreshNeeded` and notifies the user in-app.

### Scheduling / publishing engine — **Temporal, not BullMQ (in this build)**
- This Postiz build has **migrated scheduling to Temporal**. `apps/orchestrator` is a dedicated
  Temporal worker; no `bullmq`/`bull` dependency was found in package.json. (Older/OSS Postiz
  used BullMQ+Redis for the posting queue — that role is now Temporal's. Redis remains for
  cache/pub-sub, not job scheduling.)
- **Workflows** (`apps/orchestrator/src/workflows/`): versioned `post.workflow.v1.0.1…v1.0.5.ts`
  (versioning lets in-flight workflows keep their original logic during deploys), plus
  `autopost`, `streak`, `missing.post`, `refresh.token`, `digest.email`, `send.email`.
- **`postWorkflowV105` flow**: `getPost` → if scheduled, a durable `sleep()` until
  `publishDate` (Temporal timer, survives restarts) → calls activities on a **dynamic
  per-integration `taskQueue`** (`proxyTaskQueue(taskQueue)`) so each account's posts run on
  their own queue for concurrency isolation. Retry policy: `maximumAttempts: 3`,
  `initialInterval: 2m`, `startToCloseTimeout: 10m`. A `poke` **signal** lets the app interrupt
  a waiting workflow (e.g. edited/cancelled post).
- **Activities** (`apps/orchestrator/src/activities/post.activity.ts`): `postSocial` checks
  subscription, resolves `getSocialIntegration(providerIdentifier)`, maps DB posts →
  `PostDetails[]` (running `stripHtmlValidation` per `editor` type, resolving media via
  `updateMedia` with optional `convertToJPEG`), then calls `provider.post(internalId, token,
  details, integration)`. `postComment`, `refreshToken`, `refreshTokenWithCause`,
  `internalPlugs`, `globalPlugs`, `processPlug` are sibling activities. After a successful post
  it starts a `streakWorkflow`.

### Concepts worth copying into meegrow-social
1. **`SocialProvider` interface split** into auth + publish + metadata — clean seam.
2. **`isBetweenSteps`** two-phase OAuth for Page/Org/Channel selection.
3. **Typed provider errors** (`RefreshToken`/`BadBody`) that map to durable-engine retry vs
   refresh branches — decouples provider HTTP quirks from scheduling logic.
4. **Resilient `fetch` wrapper** with 429/5xx backoff + `handleErrors` per-provider hook.
5. **`post()` takes an array** of `PostDetails` → native thread/carousel support.
6. **Durable timer + per-account task queue** for scheduling (Temporal here; any durable-job
   system — Temporal, Inngest, or a DB-polled queue — can replicate the semantics).
7. **Uniform redirect convention** `${FRONTEND_URL}/integrations/social/<identifier>`.
