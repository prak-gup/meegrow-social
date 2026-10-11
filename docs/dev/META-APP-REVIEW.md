# Meta App Review — paste-ready resubmission pack (issue #53)

Date drafted: 2026-10-11. App "Meegrow Social", App ID `2214641422606935`, business portfolio
Meegrowlabs.com (`785314568581019`), verified as Meegrow.com Private Limited on 2025-12-18. App
mode: Development. Graph version pinned in code: `v21.0`.

Everything in `[SQUARE BRACKETS]` is a fact only Prakhar has. Fill those in before submitting.

**Decide one thing first:** whether `business_management` is in this submission (§3). Everything
marked **(BM)** below applies only if it is.

## Facts needed before you start

| Placeholder                 | What it is                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `[REVIEWER_EMAIL]`          | An operator login on `social.meegrowlabs.com` created only for Meta's reviewer                       |
| `[REVIEWER_PASSWORD]`       | Its password. Goes in Meta's form only, never in this repo                                           |
| `[REVIEW_WORKSPACE]`        | The client workspace that login opens — a demo client, no real client's name                         |
| `[TEST_PAGE_NAME]`          | The Facebook Page you record with, already connected in `[REVIEW_WORKSPACE]`                         |
| `[TEST_IG_HANDLE]`          | The Instagram Business account linked to that Page                                                   |
| `[TEST_BUSINESS_NAME]`      | **(BM)** The Meta Business portfolio that owns `[TEST_PAGE_NAME]`                                    |
| `[OLD_POST_CAPTION]`        | First words of an already-published post on each account that has insight numbers                    |
| `[PRIVACY_URL]`             | Privacy policy URL in App settings → Basic (the Google pack used `https://meegrowlabs.com/privacy/`) |
| `[TERMS_URL]`               | Terms of service URL in App settings → Basic                                                         |
| `[DATA_DELETION_URL]`       | Data deletion instructions URL (or callback) in App settings → Basic                                 |
| `[SUPPORT_EMAIL]`           | Contact address the reviewer can write to                                                            |
| `[FB_SCREENCAST]`           | The recorded file for the Facebook Page flow (§6)                                                    |
| `[IG_SCREENCAST]`           | The recorded file for the Instagram flow (§6)                                                        |
| `[SUBMISSION_DATE]`         | Logged on issue #53 when you press submit                                                            |
| `[BM_NARROW_ROUTE_OUTCOME]` | Result of the `debug_token` granular-scopes change: proven / not proven (§3)                         |

---

## 1. Why the last submission failed, and what is different this time

Requests dated 2026-07-29, result 2026-08-11. All seven permissions were rejected for the same
reason: **"Screencast Not Aligned with Use Case Details"**, Developer Policy 1.6. Meta's words:

> We have determined that your apps' use case is allowed, however, the submitted screencast fails to
> demonstrate the end-to-end experience of the use case described in the submission notes

Meta asked that the new screencast include: the complete Meta login flow; a user granting the app
access to the permission; the end-to-end experience of the use case for that permission.

So the use case itself passed. What failed was the video. This time:

- The recording starts **logged out of Facebook** and shows every Meta screen through to the grant.
- Each permission has a named shot where the data it unlocks is visibly on screen (§6), and the
  per-permission text (§4) describes that same shot — nothing the video does not show.
- The notes (§5) give the reviewer a working login and the same click path the video follows.
- The invite flow now finishes on our own page (`/i/finish/:flowId`, #93), so the Page list that
  `pages_show_list` returns is on camera inside our product.

---

## 2. Pre-flight checklist

Do all of this before pressing record. A gap here is a re-record.

**App dashboard** (`developers.facebook.com/apps/2214641422606935`)

| Check                         | Expected                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| App icon                      | Uploaded (done). Confirm it is the one shown in the consent dialog                    |
| Privacy policy URL            | `[PRIVACY_URL]` — opens without login, mentions Facebook/Instagram data               |
| Terms of service URL          | `[TERMS_URL]` — opens without login                                                   |
| Data deletion                 | `[DATA_DELETION_URL]` — opens without login and says how a client gets data removed   |
| App domains                   | `meegrowlabs.com` / `social.meegrowlabs.com`                                          |
| Valid OAuth redirect URI      | `https://social.meegrowlabs.com/connect/callback` (the value in `docs/dev/DEPLOY.md`) |
| Login for Business config     | "Meegrow Social — Pages + Insta", ID `1379559764274124`, user access token            |
| Permissions in that config    | Exactly the set you are submitting — seven, or eight with `business_management`       |
| Each permission's call status | Shows a recent successful call (see below)                                            |

Meta's submission guide says to "Make at least 1 successful API call using each permission for which
you are requesting advanced access." Running the full flow in §6 once as a rehearsal, a day or two
before recording, covers every permission and also produces the post that will have insights.

**Accounts and data**

- A Facebook account that has a role on the app (the app is in Development mode) and manages
  `[TEST_PAGE_NAME]`. Not a personal account you mind showing on video.
- `[TEST_IG_HANDLE]` is a Business account linked to `[TEST_PAGE_NAME]`.
- **(BM)** `[TEST_PAGE_NAME]` is owned by `[TEST_BUSINESS_NAME]`, so the "Choose the Businesses"
  step appears and is doing real work.
- One published post on the Page and one on Instagram, each at least a day or two old
  (`[OLD_POST_CAPTION]`), made through Meegrow Social. A post published during the recording will
  not have insights yet.
- An image ready to upload for the new post (JPEG; Instagram has no text-only posts).
- `[REVIEWER_EMAIL]` exists, opens `[REVIEW_WORKSPACE]` only, and that workspace already has
  `[TEST_PAGE_NAME]` and `[TEST_IG_HANDLE]` connected.

**Analytics must show real numbers — check before recording**

Open Analytics in `[REVIEW_WORKSPACE]`, filter Platform to Facebook, and look at the
`[OLD_POST_CAPTION]` row under "Posts published in this period".

- We request five Facebook post metrics: `post_media_view`, `post_total_media_view_unique`,
  `post_reactions_like_total`, `post_clicks`, `post_video_views`. Only the last two have ever been
  seen returning data (2026-07-16). The first three are documented by Meta but unconfirmed.
- If the row shows no Facebook numbers at all, **do not record for `read_insights`** — an empty
  table is the same rejection again. Find out which names return data first (`facebook.ts`
  `POST_METRICS`; `docs/dev/research/meta.md` §5.2.1).
- If only clicks show, use a post that has actually been clicked. A photo post will never have
  `post_video_views`.
- Compare the numbers on screen with the same post in Meta Business Suite. They should agree or be
  explainably close.
- The operator view carries a badge, "Preview — numbers not yet validated". It will be on camera. It
  is removed by the `VITE_ANALYTICS_UI=true` build flag. Only flip it if the comparison above holds;
  otherwise leave it and say so in the notes (§5 has a line for it). Do not crop it out.
- Repeat for Instagram: the six media metrics (`views`, `reach`, `total_interactions`, `likes`,
  `comments`, `saved`) are also marked "confirm at live bring-up" in `instagram.ts`.

**Screen hygiene**

- Facebook, Instagram and the browser set to **English**.
- Use a clean browser profile: no bookmarks bar, no other tabs, no extensions with badges.
- Hide: other clients' names (the client switcher and the Clients screen — record with a login that
  sees only `[REVIEW_WORKSPACE]`), the API keys screen, access tokens, email inboxes, notification
  pop-ups, 2FA codes.
- The Facebook password field is masked, but do not paste it from a visible password manager.

---

## 3. Per-permission map

The Login for Business configuration is shared, so the Facebook and Instagram invite links show the
**same** Meta dialog. Shot numbers refer to §6 (F = Facebook recording, I = Instagram recording).

| Permission                     | What our code does with it                                                                                                                                                         | Where the reviewer sees it                                                                           | Shot    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| `pages_show_list`              | `GET me/accounts?fields=id,name,access_token` with the user token, during connect only                                                                                             | `/i/finish/:flowId` — "Confirm the account to connect", the Page's name with a Connect button        | F5      |
| `pages_read_engagement`        | `GET /{page-id}?fields=followers_count` with the Page token; also a dependency of the publish and insights calls                                                                   | Analytics → "Followers over time", Facebook line                                                     | F11     |
| `pages_manage_posts`           | `POST /{page-id}/feed` (text, multi-photo), `POST /{page-id}/photos` (one photo), `POST /{page-id}/videos` (video)                                                                 | Composer → Publish now; then the post live on the Facebook Page                                      | F7–F9   |
| `read_insights`                | `GET /{post-id}/insights?metric=<name>`, one call per metric, five names (§2)                                                                                                      | Analytics → "Posts published in this period", metric columns for the Facebook post                   | F10     |
| `instagram_basic`              | `instagram_business_account{id,username}` on `me/accounts`; `GET /{ig-user-id}?fields=followers_count`; `GET /{ig-media-id}?fields=permalink`                                      | `/i/finish/:flowId` shows `@handle`; Content → "View post on Instagram" link; followers in Analytics | I5, I9  |
| `instagram_content_publish`    | `POST /{ig-user-id}/media` (container), `GET /{container-id}?fields=status_code,status` (video only), `POST /{ig-user-id}/media_publish`                                           | Composer → Publish now; then the post live on the Instagram profile                                  | I7–I9   |
| `instagram_manage_insights`    | `GET /{ig-media-id}/insights?metric=<name>`, one call per metric: `views`, `reach`, `total_interactions`, `likes`, `comments`, `saved`                                             | Analytics → "Posts published in this period", metric columns for the Instagram post                  | I10     |
| `business_management` **(BM)** | **No Graph call of its own.** With it granted, `me/accounts` returns Pages owned through a Business portfolio; without it that list came back empty for such a client (2026-10-11) | Meta's "Choose the Businesses" step, then the portfolio-owned Page appearing at `/i/finish/:flowId`  | F3b, F5 |

### The `business_management` decision

- **If `[BM_NARROW_ROUTE_OUTCOME]` = proven** (the `debug_token` granular-scopes route returns the
  portfolio-owned Page without the permission): remove `business_management` from the Login
  configuration, re-run the connect once to confirm the Page is still offered, submit **seven**, and
  skip everything marked (BM). This is the better outcome.
- **If not proven by the time you record:** submit **eight**, record with a portfolio-owned Page,
  and use the (BM) text and shots.

Why dropping it is better: Meta's permissions reference describes the allowed usage of
`business_management` as "Manage business assets such as an ad account" and "Claim ad accounts". We
do neither; we need it only as a side effect on `me/accounts`. A reviewer could reasonably say our
use does not match. That is a reading of the reference, not an observed rejection.

Do not record until this is decided: the consent screens differ between the two outcomes, and the
video must show exactly the permissions submitted — no more, no fewer.

---

## 4. "How the app uses this permission" — paste-ready, one per permission

Meta's guide: "Each permission and feature must have its own description." "Do not copy and paste."
Each answer below names one user action and one screen, and matches a shot in §6. If you change a
shot, change its text.

### `pages_show_list`

> Meegrow Social is an invite-only publishing and reporting tool that our agency runs for its
> clients. A client opens the invite link we send them, signs in with Facebook, and chooses which
> Pages to share. We then call `GET /me/accounts` once to read the id and name of the Pages that
> person selected, and show them on our "Confirm the account to connect" screen so the client can
> press Connect next to the Page they mean. We do not store the list; only the Page they pick is
> saved. Without this permission we could not show the client their own Pages and they would have
> no way to tell us which Page to connect.

### `pages_read_engagement`

> After a client has connected their Facebook Page, we read that Page's own metadata with
> `GET /{page-id}?fields=followers_count`, once a day, and plot it in the "Followers over time"
> chart on our Analytics screen. The agency operator and the client use that chart to see whether
> the Page's audience is growing while we publish for it. We read only the Page the client
> connected. We do not read followers' names, profiles or any other person's data. The permission
> is also required by the Page publishing and insights calls described under `pages_manage_posts`
> and `read_insights`.

### `pages_manage_posts`

> Our operator writes a post for a client in the Composer screen: they pick the client's connected
> Facebook Page under "Post to", type a caption, optionally add photos or one video, and choose
> "Publish now" or a scheduled time. We then create that post on the client's Page with
> `POST /{page-id}/feed` (text or several photos), `POST /{page-id}/photos` (one photo) or
> `POST /{page-id}/videos` (video). The published post appears in our Content screen with a link
> that opens it on Facebook. Publishing to the client's Page on their behalf is the core service
> the client has asked our agency for; without this permission the operator would have to log in to
> each client's Facebook account by hand.

### `read_insights`

> For each post we published to a client's Page, we call `GET /{post-id}/insights` to read that
> post's performance — views, unique viewers, like reactions, clicks and video views — and show the
> numbers in the "Posts published in this period" table on our Analytics screen, next to the post's
> caption and a link to it on Facebook. The client and the operator use this table as the
> performance report for the content we published for them. Insights are shown only inside that
> client's own workspace; we do not combine them across clients, sell them or share them with
> anyone else.

### `instagram_basic`

> When a client signs in with Facebook from our Instagram invite link, we read the Instagram
> Business account linked to the Page they selected — its id and username — and show it as
> "@username" on our "Confirm the account to connect" screen so they can confirm it is the right
> account. After they connect it, we read that account's `followers_count` for the "Followers over
> time" chart in Analytics, and the `permalink` of each post we published so that the "View post on
> Instagram" link in our Content screen opens the real post. We read only the account the client
> connected.

### `instagram_content_publish`

> Our operator creates an Instagram post for a client in the Composer screen: they select the
> client's connected Instagram account, write the caption, attach an image, a video or up to ten
> items for a carousel, and choose "Publish now" or a scheduled time. We create a media container
> with `POST /{ig-user-id}/media`, wait for it to finish processing if it is a video, and publish it
> with `POST /{ig-user-id}/media_publish`. The post then appears on the client's Instagram profile
> and in our Content screen. This is the service the client engaged us for: posting to their
> Instagram account on a schedule they have agreed, without sharing their password with us.

### `instagram_manage_insights`

> For each Instagram post we published for a client, we call `GET /{ig-media-id}/insights` to read
> views, reach, total interactions, likes, comments and saves, and show those numbers in the "Posts
> published in this period" table on our Analytics screen, filtered to Instagram. Clicking a row
> shows how each number changed since the post went out. The client sees how the posts we made for
> them performed; the operator uses the same table to decide what to publish next. We read insights
> only for media we published on the account the client connected.

### `business_management` — conditional (BM): include only if it is in the submission

> Many of our clients hold their Facebook Page inside a Meta Business portfolio rather than on a
> personal profile. For those clients, `GET /me/accounts` returned an empty list after they signed
> in, so our "Confirm the account to connect" screen had nothing to offer and they could not
> connect. With `business_management` granted, the Facebook dialog adds a "Choose the Businesses"
> step, the client selects their portfolio, and the Page it owns is returned and shown on our
> screen. That is the only thing we use this permission for. We make no Business Manager API calls:
> we do not read, create or change business assets, ad accounts, people or settings.

---

## 5. Reviewer instructions — paste into the submission notes

Meta's guide: "Your app must be publicly available or you must provide instructions on how to access
it", and "Do not include your _personal_ Meta Technologies app account's credentials." The login
below is for our own product, not a Meta account.

> **What Meegrow Social is.** An invite-only publishing and reporting tool run by a marketing
> agency, Meegrow.com Private Limited, for its own clients. There is no public sign-up. An agency
> operator creates a workspace for a client and sends that client an invite link. The client opens
> the link, signs in with Facebook and grants access to their own Page or Instagram account. The
> operator then composes and publishes posts for that client and both see the results in an
> Analytics screen. Each client's data is isolated in our database with PostgreSQL row-level
> security.
>
> **How to get in.** Go to https://social.meegrowlabs.com/login and sign in with:
>
> - Email: `[REVIEWER_EMAIL]`
> - Password: `[REVIEWER_PASSWORD]`
>
> This is an operator account limited to one demo client workspace, `[REVIEW_WORKSPACE]`.
>
> **Reproduce the Facebook Page flow**
>
> 1. In the left menu open **Connections**. Under "Add an account", on the Facebook Page card, click
>    **Invite client**, then **Copy link**. The link looks like
>    `https://social.meegrowlabs.com/i/<token>`. (Clicking **Connect** instead runs the same Facebook
>    login in a pop-up.)
> 2. Open the link in a new tab. The page reads "Connect your Facebook Page". Click **Continue with
>    Facebook**.
> 3. Sign in to Facebook. Choose the Page(s) to share, [choose the Business that owns the Page,]
>    choose the Instagram account(s), review the access request and click **Save**, then **Got it**.
>    The dialog asks about Instagram accounts as well because our Facebook and Instagram connections
>    share one Facebook Login for Business configuration.
> 4. You return to our page "Confirm the account to connect", which lists the Pages you selected
>    (`pages_show_list`[, `business_management`]). Click **Connect**. The page reads "Connected".
> 5. Back in the first tab, click **Refresh** on Connections. The Page is listed under "Connected
>    accounts".
> 6. Click **Create post** (or open **Composer**). Under "Post to" select the Page, type a caption,
>    optionally add a photo, choose **Publish now** and confirm (`pages_manage_posts`).
> 7. Open **Content**. The post is listed as published; the link icon on its row opens it on
>    Facebook.
> 8. Open **Analytics** and set Platform to Facebook. "Followers over time" shows the Page's
>    follower count (`pages_read_engagement`). "Posts published in this period" shows insight numbers
>    per post (`read_insights`). Insights take time to arrive, so a post you published a minute ago
>    will be empty; the row beginning "`[OLD_POST_CAPTION]`" on the already-connected Page
>    `[TEST_PAGE_NAME]` shows them.
>
> **Reproduce the Instagram flow**
>
> 1. Connections → Instagram card → **Invite client** → **Copy link**, open it, **Continue with
>    Facebook**, and go through the same Facebook screens, ticking the Page and the Instagram
>    Business account linked to it.
> 2. Our page lists the Instagram account as "@username" (`instagram_basic`). Click **Connect**.
> 3. Composer → select the Instagram account, add a caption and an image (Instagram has no text-only
>    posts), **Publish now** (`instagram_content_publish`).
> 4. Content → the link icon on the post opens it on Instagram.
> 5. Analytics → Platform: Instagram. The posts table shows views, reach, likes, comments and saves
>    (`instagram_manage_insights`); the row beginning "`[OLD_POST_CAPTION]`" on `[TEST_IG_HANDLE]`
>    already has numbers.
>
> **Notes.** An invite link works once; make a new one from Connections if you need to repeat a
> step. If Facebook shows "Continue as …?", choose **Edit settings** to see the Page list again. To
> remove access, click **Disconnect** on the account's card in Connections. [The Analytics screen
> carries a "Preview" badge because we are still cross-checking some Facebook metric names against
> Meta Business Suite; the numbers shown are the values the Graph API returned.] Questions:
> `[SUPPORT_EMAIL]`.

Before pasting: delete the square-bracketed (BM) fragments in steps 3 and 4 if you submit seven, and
delete the "Preview" sentence if the badge is gone.

---

## 6. Screencast shot list

Two recordings, one per platform, each continuous. Attach `[FB_SCREENCAST]` to the four Facebook
permissions (and `business_management`), `[IG_SCREENCAST]` to the three Instagram ones. If the form
takes only one file, record Facebook then Instagram back to back in one take; the second login will
then show "Continue as …?" — choose **Edit settings** so the pickers appear again.

**Before each take:** log out of Facebook and of Meegrow Social. To get the first-time consent
screens rather than "Continue as …? You've previously linked Meegrow Social…", remove Meegrow Social
from the test account's Business integrations first. The first-time sequence has not been observed
by us; the sequence below from "Choose the Pages" onward is what a returning user saw on 2026-10-11
after choosing Edit settings.

### Facebook Page recording

| #   | What must be visible                                                                                                                                         | Caption to overlay                                                                              | Proves                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| F1  | `social.meegrowlabs.com/login`, "Sign in to Meegrow Social"; sign in; Connections → Facebook Page card → Invite client → Copy link                           | "Agency operator creates an invite link for a client. The app is invite-only."                  | App login without Meta (Meta asks for it) |
| F2  | New tab, the `/i/<token>` page: "Connect your Facebook Page", the three bullet points, **Continue with Facebook**. Click it                                  | "The client opens the invite link and starts Facebook Login."                                   | Start of Meta login                       |
| F3  | Facebook's login form, logged out. Type email and password, log in. Then "Choose the Pages you want Meegrow Social to access": tick `[TEST_PAGE_NAME]`, Next | "Complete Facebook login from logged-out. The client chooses which Pages to share."             | Meta login; `pages_show_list`             |
| F3b | **(BM)** "Choose the Businesses…": tick `[TEST_BUSINESS_NAME]`, Next                                                                                         | "business_management: the client selects the Business portfolio that owns the Page."            | `business_management`                     |
| F3c | "Choose the Instagram accounts…": tick `[TEST_IG_HANDLE]`, Next                                                                                              | "Same dialog serves our Instagram connection."                                                  | —                                         |
| F4  | "Review Meegrow Social's access request" — scroll slowly so **every** permission line is readable. Click **Save**. "…has been connected…" → **Got it**       | "The client grants: pages_show_list, pages_read_engagement, pages_manage_posts, read_insights…" | The grant, all Facebook permissions       |
| F5  | Our page `/i/finish/…`: "Confirm the account to connect", `[TEST_PAGE_NAME]` with a Connect button. Pause two seconds. Click **Connect** → "Connected"       | "pages_show_list: the Page the client selected, read from /me/accounts."                        | `pages_show_list` (and BM)                |
| F6  | First tab: Connections → Refresh. `[TEST_PAGE_NAME]` under "Connected accounts", "Token never expires", the Disconnect button                                | "The Page is now connected to this client's workspace. Disconnect removes it."                  | End of connect                            |
| F7  | Composer: select `[TEST_PAGE_NAME]` under "Post to", type a caption with today's date in it, add a photo, choose **Publish now**                             | "pages_manage_posts: the operator writes a post for the client's Page."                         | `pages_manage_posts`                      |
| F8  | The "Publish now?" confirmation naming the Page; confirm; the success card with its Status line                                                              | "Published to the Page through POST /{page-id}/photos."                                         | `pages_manage_posts`                      |
| F9  | Content: the post marked published; click its link; **the post live on facebook.com** on `[TEST_PAGE_NAME]` with the same caption and date                   | "The post is live on the client's Facebook Page."                                               | `pages_manage_posts`                      |
| F10 | Analytics, Platform = Facebook. "Posts published in this period": the `[OLD_POST_CAPTION]` row with **numbers** in the metric columns. Expand the row        | "read_insights: per-post insights from /{post-id}/insights. Shown for an earlier post."         | `read_insights`                           |
| F11 | Same screen, "Followers over time" with the Facebook line; hover a point to show the value                                                                   | "pages_read_engagement: Page follower count from /{page-id}?fields=followers_count."            | `pages_read_engagement`                   |

Match the caption in F8 to the post type you actually publish: `/feed` for text, `/photos` for one
photo, `/videos` for a video.

### Instagram recording

| #   | What must be visible                                                                                                                                         | Caption to overlay                                                                           | Proves                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------- |
| I1  | Log in to Meegrow Social; Connections → Instagram card → Invite client → Copy link                                                                           | "Agency operator creates an Instagram invite link for a client."                             | App login without Meta      |
| I2  | The `/i/<token>` page: "Connect your Instagram", **Continue with Facebook**. Click it                                                                        | "Instagram Business accounts connect through Facebook Login."                                | Start of Meta login         |
| I3  | Facebook login from logged-out; "Choose the Pages…" tick `[TEST_PAGE_NAME]`; **(BM)** "Choose the Businesses…"; "Choose the Instagram accounts…" tick handle | "The client chooses the Page and the Instagram Business account linked to it."               | Meta login                  |
| I4  | "Review Meegrow Social's access request" — scroll so every Instagram permission line is readable. **Save** → **Got it**                                      | "The client grants: instagram_basic, instagram_content_publish, instagram_manage_insights…"  | The grant                   |
| I5  | `/i/finish/…`: "Confirm the account to connect" listing `@[TEST_IG_HANDLE]`. Pause. **Connect** → "Connected"                                                | "instagram_basic: the Instagram account's username, read from the linked Page."              | `instagram_basic`           |
| I6  | Connections → Refresh; the Instagram account under "Connected accounts"                                                                                      | "The Instagram account is connected to this client's workspace."                             | End of connect              |
| I7  | Composer: select the Instagram account, caption with today's date, add an image, **Publish now**                                                             | "instagram_content_publish: the operator creates a post for the client's Instagram account." | `instagram_content_publish` |
| I8  | "Publish now?" confirmation; confirm; success card                                                                                                           | "Published through /{ig-user-id}/media then /media_publish."                                 | `instagram_content_publish` |
| I9  | Content: the post marked published; click its link; **the post live on instagram.com** on the profile                                                        | "Live on Instagram. The link uses the permalink read with instagram_basic."                  | Publish; `instagram_basic`  |
| I10 | Analytics, Platform = Instagram. The `[OLD_POST_CAPTION]` row with numbers for views, reach, likes, comments, saves. Expand the row                          | "instagram_manage_insights: per-post insights from /{ig-media-id}/insights."                 | `instagram_manage_insights` |

### Recording practicalities

From Meta's screen-recording guide (quoted; link in §8):

- "Capture the entire login flow, from _logged-out_ to _logged-in_." "Before you start a recording,
  log out of any test accounts you are using."
- "Capture the complete authorization flow."
- "Use English as the app UI language."
- "Record in high-resolution, ideally 1080 or better." "Decrease your monitor's resolution to a
  width of 1440 or less when you record."
- "When possible, use your mouse to interact with your app instead of your keyboard." "Increase your
  mouse's cursor size so it's easier for us to see."
- "Omit audio; our reviewers will not listen to it."
- "We recommend that you use annotations for all of the permissions and features that you are
  requesting."
- "Record only what we need to see."
- If users can log into the app without a Meta Login product, capture that flow too — that is why
  F1 and I1 show our own sign-in.

Our own recommendations (not Meta rules):

- No cuts between F2 and F6 (I2 and I6). A cut inside the login or consent is the easiest way to
  repeat the last rejection. Trimming dead time elsewhere is fine.
- Put the permission name in the caption, in the exact spelling of the dashboard, at the moment the
  data is on screen. Keep each caption up for at least three seconds.
- Meta's guide gives no length. Aim for roughly four to six minutes per recording: long enough to
  read every screen, short enough to watch once.
- Record the browser window only, at 100% zoom. Zoom in afterwards on the metric numbers in F10/I10
  and on the permission list in F4/I4 if they are small.
- Watch the result once against §3 with the table open: every permission must have a moment where
  its caption and its data are on screen together.

---

## 7. After submitting

1. Comment on issue #53 with `[SUBMISSION_DATE]`, which permissions were submitted (seven or eight)
   and the `[BM_NARROW_ROUTE_OUTCOME]`.
2. **Check the Tech Provider / access verification panel.** On 2026-07-16 nothing in the dashboard
   offered a way to start it; the panel only said it is "only required for Tech Providers". The
   hypothesis is that it activates once Advanced Access has been requested. Look again right after
   submitting and again when the result arrives, and record on #53 what you see **either way**. If it
   has not activated after an approval, Meta support is the next step. The "Become a Tech Provider"
   doc that search finds is WhatsApp-only — wrong door.
3. Do not change the Login configuration, the redirect URI, the reviewer login or the connected test
   accounts while the review is open. Keep `[REVIEW_WORKSPACE]` working: a reviewer who cannot log
   in is a rejection.
4. When the result arrives, log each permission's outcome on #53: approved, or rejected with Meta's
   exact reason text.

**If a permission is rejected again**

- Read the reason per permission; do not assume it is the same one. Paste it into #53 verbatim.
- "Screencast Not Aligned" again → find the shot for that permission in §6 and ask what a stranger
  would see: is the permission's data visibly on screen, and does §4's text describe that exact
  moment? Re-record that platform's video; do not resubmit the same file.
- `read_insights` or `instagram_manage_insights` rejected with empty-looking numbers → fix the
  metric set first (§2), then re-record.
- `business_management` rejected on allowed usage → that is the signal to finish the narrower
  `debug_token` route and resubmit without it. The other seven do not depend on it.
- Approved permissions stay approved; resubmit only the rejected ones, each with its own text.
  (Unverified: we have not been through a partial approval on this app.)

---

## 8. Open questions and unverified claims

Read from Meta's documentation on 2026-10-11, not observed:

- **Screen-recording requirements** quoted in §6 —
  https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings
- **Submission rules** quoted in §2, §4 and §5 (one successful API call per permission; own
  description per permission; reviewers use their own test accounts; no personal credentials) —
  https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide
- **Allowed usage of `business_management`** and of the other seven, used in §3 and to word §4 —
  https://developers.facebook.com/docs/permissions. These pages were read through an automated
  summary, so re-read the exact "Allowed usage" lines for each permission in the dashboard's request
  form before pasting §4.
- **Facebook post metric names** `post_media_view`, `post_total_media_view_unique`,
  `post_reactions_like_total` — documented, never seen returning data —
  https://developers.facebook.com/docs/graph-api/reference/insights/

Not confirmed by anyone yet:

- Whether the narrower `debug_token` granular-scopes route replaces `business_management`
  (`[BM_NARROW_ROUTE_OUTCOME]`).
- What a **first-time** user sees in the Login for Business dialog, and its exact order. Only the
  returning-user sequence was observed.
- Whether a Meta reviewer's own test account can complete Facebook Login while the app is in
  Development mode, or whether the app must be switched to Live first. Meta's guide says reviewers
  "will test your app using our own test accounts" but we have not found a statement on app mode.
  Check the dashboard's submission checklist; if it is silent, the pre-connected `[TEST_PAGE_NAME]`
  in `[REVIEW_WORKSPACE]` still lets a reviewer see publishing and Analytics.
- Whether the form accepts one screencast per permission or one for the whole submission. §6 covers
  both.
- That the values in App settings → Basic (`[PRIVACY_URL]`, `[TERMS_URL]`, `[DATA_DELETION_URL]`,
  app domains, redirect URI) are what §2 expects. Not inspected for this document.
- How long after publishing our Analytics screen first shows insights for a post. "A day or two" in
  §2 is a safe margin, not a measured figure.
- That the Instagram media metrics all return data; `instagram.ts` still marks them "confirm at live
  bring-up".
- Whether Tech Provider access verification applies to this app at all (§7.2).
- Review turnaround. The only data point is our own: 2026-07-29 to 2026-08-11.
