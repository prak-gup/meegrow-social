# Meta App Review — paste-ready resubmission pack (issue #53)

Date drafted: 2026-10-11; code walkthrough updated: 2026-10-12. App "Meegrow Social", App ID `2214641422606935`, business portfolio
Meegrowlabs.com (`785314568581019`), verified as Meegrow.com Private Limited on 2025-12-18. App
mode recorded in the earlier pack: Development (current dashboard state unverified). Graph version pinned in code: `v21.0`.

Remaining `[SQUARE BRACKETS]` are unknowns to fill before submitting. Credentials belong only in Meta’s form, never in this repo. The screen labels below were checked against the current web code; deployment state and live data were not checked.

**Recommended submission: eight permissions, including `business_management` (§3).** A real client’s business-owned Page could not connect without it on 2026-10-11. Keep the BM text and shots unless the narrower route is independently proven before recording.

## Facts needed before you start

| Fact                                   | Value / action before submitting                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Reviewer email                         | `[REVIEWER_EMAIL]` — create a new app login as a **member**, never owner/admin                                               |
| Reviewer password                      | `[REVIEWER_PASSWORD]` — generated once, then changed privately; goes in Meta’s form only                                     |
| Review workspace                       | **Meegrow Review** — dedicated demo workspace recommended below; provisioning and test-account connections remain unverified |
| Test Facebook Page                     | **Meegrow Labs - Zero to AI Hero**                                                                                           |
| Test Instagram                         | **@meegrowlabs** — linked Business account status must be checked before recording                                           |
| Test Business portfolio                | `[TEST_BUSINESS_NAME]` — the portfolio owning the test Page; unknown                                                         |
| Earlier posts with real insight values | `[OLD_FB_POST_CAPTION]` and `[OLD_IG_POST_CAPTION]` — choose separately after checking values                                |
| Privacy                                | https://meegrowlabs.com/privacy                                                                                              |
| Terms                                  | https://meegrowlabs.com/terms                                                                                                |
| Data deletion                          | https://meegrowlabs.com/data-deletion                                                                                        |
| Support address                        | `[SUPPORT_EMAIL]` — unknown                                                                                                  |
| Screencasts                            | `[FB_SCREENCAST]`, `[IG_SCREENCAST]`                                                                                         |
| Submission date                        | `[SUBMISSION_DATE]` — log on issue #53 when submitted                                                                        |
| Narrower BM route outcome              | `[BM_NARROW_ROUTE_OUTCOME]` — unknown / not proven here                                                                      |

Use **Meegrow Review**, rather than the operational **Meegrow** workspace, so the recording and
reviewer see only demo content. This workspace has not been provisioned by this code change. After
deployment, an existing owner uses **Clients → Add client** to create it, then its row’s actions
menu → **Add a person to this client**. Enter a fresh reviewer email and choose **Member**. Save the
temporary password privately when it is shown once; sign in with it and use the account menu’s
**Change password** before submitting the final credential. The people panel also lists access and
lets the owner **Remove** a non-owner, with **Remove person** confirmation and session revocation.
A member can publish and connect accounts but cannot create clients, manage people, or manage API
keys. No migration is required. There is no forced first-login password change or expiry for the
temporary password; changing it before sharing the final reviewer credential is an operator step.
Connect the named test accounts to the demo workspace and verify only its membership appears in
**Clients**, the client switcher and Analytics, including a direct `scope=all` request.

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

| Check                         | Expected                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| App icon                      | Uploaded (done). Confirm it is the one shown in the consent dialog                                    |
| Privacy policy URL            | `https://meegrowlabs.com/privacy` — opens without login, mentions Facebook/Instagram data             |
| Terms of service URL          | `https://meegrowlabs.com/terms` — opens without login                                                 |
| Data deletion                 | `https://meegrowlabs.com/data-deletion` — opens without login and says how a client gets data removed |
| App domains                   | `meegrowlabs.com` / `social.meegrowlabs.com`                                                          |
| Valid OAuth redirect URI      | `https://social.meegrowlabs.com/connect/callback` (the value in `docs/dev/DEPLOY.md`)                 |
| Login for Business config     | "Meegrow Social — Pages + Insta", ID `1379559764274124`, user access token                            |
| Permissions in that config    | Eight, including `business_management`; change only after proving the narrower route                  |
| Each permission's call status | Shows a recent successful call (see below)                                                            |

Meta's submission guide says to "Make at least 1 successful API call using each permission for which
you are requesting advanced access." Running the full flow in §6 once as a rehearsal, a day or two
before recording, covers every permission and also produces the post that will have insights.

**Accounts and data**

- A Facebook account that has a role on the app (the app is in Development mode) and manages
  `Meegrow Labs - Zero to AI Hero`. Not a personal account you mind showing on video.
- `@meegrowlabs` is a Business account linked to `Meegrow Labs - Zero to AI Hero`.
- **(BM)** `Meegrow Labs - Zero to AI Hero` is owned by `[TEST_BUSINESS_NAME]`, so the "Choose the Businesses"
  step appears and is doing real work.
- One published post on the Page and one on Instagram, each at least a day or two old
  (`[OLD_FB_POST_CAPTION]` / `[OLD_IG_POST_CAPTION]`), made through Meegrow Social. A post published during the recording will
  not have insights yet.
- An image ready to upload for the new post (JPEG; Instagram has no text-only posts).
- `[REVIEWER_EMAIL]` exists, opens `Meegrow Review` only, and that workspace already has
  `Meegrow Labs - Zero to AI Hero` and `@meegrowlabs` connected.

**Analytics must show real numbers — check before recording**

Open Analytics in `Meegrow Review`, select the **Facebook Page** platform chip, and look at the
`[OLD_FB_POST_CAPTION]` row under **Top posts**. Use **Period** to include its publish date, the **Facebook Page** platform chip, **Account** to select the test Page, and **Source → All sources** (or **Published here** if showing only this app’s posts).

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
- The operator view carries a badge, "Preview — numbers not yet validated". It will be on camera. The current `Analytics.tsx` renders it unconditionally; no build flag removes it. Leave it visible and explain it in §5. Do not crop it out.
- Repeat for Instagram: the six media metrics (`views`, `reach`, `total_interactions`, `likes`,
  `comments`, `saved`) are also marked "confirm at live bring-up" in `instagram.ts`.

**Known risks before recording**

- **Facebook insights remain unconfirmed with real data:** `post_media_view`,
  `post_total_media_view_unique`, `post_reactions_like_total`. The operator reported that a Facebook
  post published on 11 Oct still showed dashes for views and reach on 12 Oct. A dash is missing
  data, not proof of zero or just collection delay. In the Page’s Analytics view select the correct
  account and period, inspect **Top posts**, **Platform breakdown**, and **How these numbers are calculated → Platform metrics, as collected**. Check the data timestamp/status and compare the same post in Meta Business Suite.
  During an authorized live rehearsal, check each named metric’s Graph response independently
  (`facebook.ts:POST_METRICS` / `postAnalytics`); distinguish an unsupported metric from empty data,
  permissions failure, a wrong post id or missing collection. Record no tokens. If values remain
  absent, fix the metric mapping/collection or choose a genuinely measured earlier post; postpone
  the insight shot instead of showing dashes as proof. Do not invent replacement metric names or
  mark Preview validated. No live checks were performed for this update.
- **Instagram container readiness:** the bug is being fixed separately. The current provider only
  polls readiness in its video path; image/carousel publishing must be checked after that separate
  fix. Rehearse image creation through **Published** and the live permalink before recording; the
  success panel alone does not establish publication. This task does not fix that provider bug.

**Screen hygiene**

- Facebook, Instagram and the browser set to **English**.
- Use a clean browser profile: no bookmarks bar, no other tabs, no extensions with badges.
- Hide: other clients' names (the client switcher and the Clients screen — record with a login that
  sees only `Meegrow Review`), the API keys screen, access tokens, email inboxes, notification
  pop-ups, 2FA codes.
- The Facebook password field is masked, but do not paste it from a visible password manager.

---

## 3. Per-permission map

The Login for Business configuration is shared, so the Facebook and Instagram invite links show the
**same** Meta dialog. Shot numbers refer to §6 (F = Facebook recording, I = Instagram recording).

| Permission                     | What our code does with it                                                                                                                                                         | Where the reviewer sees it                                                                                | Shot    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| `pages_show_list`              | `GET me/accounts?fields=id,name,access_token` with the user token, during connect only                                                                                             | `/i/finish/:flowId` — "Confirm the account to connect", the Page's name with a Connect button             | F5      |
| `pages_read_engagement`        | `GET /{page-id}?fields=followers_count` with the Page token; also a dependency of the publish and insights calls                                                                   | Analytics → Followers KPI and Follower growth card for the selected Page                                  | F11     |
| `pages_manage_posts`           | `POST /{page-id}/feed` (text, multi-photo), `POST /{page-id}/photos` (one photo), `POST /{page-id}/videos` (video)                                                                 | Create post side panel → Now → Publish now → confirmation; then the post live on the Facebook Page        | F7–F9   |
| `read_insights`                | `GET /{post-id}/insights?metric=<name>`, one call per metric, five names (§2)                                                                                                      | Analytics → Top posts and Platform breakdown, metric columns for the Facebook post                        | F10     |
| `instagram_basic`              | `instagram_business_account{id,username}` on `me/accounts`; `GET /{ig-user-id}?fields=followers_count`; `GET /{ig-media-id}?fields=permalink`                                      | `/i/finish/:flowId` shows `@handle`; Content card’s actions → "View on Instagram"; followers in Analytics | I5, I9  |
| `instagram_content_publish`    | `POST /{ig-user-id}/media` (container), `GET /{container-id}?fields=status_code,status` (video only), `POST /{ig-user-id}/media_publish`                                           | Create post side panel → Now → Publish now → confirmation; then the post live on the Instagram profile    | I7–I9   |
| `instagram_manage_insights`    | `GET /{ig-media-id}/insights?metric=<name>`, one call per metric: `views`, `reach`, `total_interactions`, `likes`, `comments`, `saved`                                             | Analytics → Top posts and Platform breakdown, metric columns for the Instagram post                       | I10     |
| `business_management` **(BM)** | **No Graph call of its own.** With it granted, `me/accounts` returns Pages owned through a Business portfolio; without it that list came back empty for such a client (2026-10-11) | Meta's "Choose the Businesses" step, then the portfolio-owned Page appearing at `/i/finish/:flowId`       | F3b, F5 |

### The `business_management` decision

Recommend submitting **eight**, keeping the BM permission, justification and F3b/F5 shots. The
2026-10-11 client report is direct evidence of a connection failure for a business-owned Page
without it. There is no dedicated Business Manager API call in our provider code: the permission
supports discovery through `me/accounts` for that ownership arrangement. Do not describe business
asset management that the product does not perform.

`[BM_NARROW_ROUTE_OUTCOME]` remains unknown. If a narrower `debug_token` granular-scopes route is
later proven against the same business-owned Page without BM, remove BM from the Login
configuration, repeat the entire connection successfully, and then submit seven and omit the BM
text and shots. Until that proof exists, do not assume the other seven are enough for every client.

The earlier permissions-reference reading described BM allowed usage as "Manage business assets
such as an ad account" and "Claim ad accounts". Our discovery use may receive scrutiny; this is a
risk inferred from that reading, not an observed rejection. Re-check allowed usage in the request
form before pasting. The consent and recording must match the final submitted permission set.
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
> `GET /{page-id}?fields=followers_count`, once a day, and plot it in the "Follower growth"
> card on our Analytics screen; the latest count also appears in the Followers KPI band. The agency operator and the client use that chart to see whether
> the Page's audience is growing while we publish for it. We read only the Page the client
> connected. We do not read followers' names, profiles or any other person's data. The permission
> is also required by the Page publishing and insights calls described under `pages_manage_posts`
> and `read_insights`.

### `pages_manage_posts`

> Our operator opens the Create post side panel for a client: they pick the client's connected
> Facebook Page under "Post to", type a caption, optionally add photos or one video, choose **Now** under "When to post", click "Publish now", then confirm the "Publish now?" dialog, or choose **Schedule** and a date/time. We then create that post on the client's Page with
> `POST /{page-id}/feed` (text or several photos), `POST /{page-id}/photos` (one photo) or
> `POST /{page-id}/videos` (video). The published post appears in our Content screen with a link
> that opens it on Facebook. Publishing to the client's Page on their behalf is the core service
> the client has asked our agency for; without this permission the operator would have to log in to
> each client's Facebook account by hand.

### `read_insights`

> For each post we published to a client's Page, we call `GET /{post-id}/insights` to read that
> post's performance — views, unique viewers, like reactions, clicks and video views — and show the
> numbers in the "Top posts" table on our Analytics screen, next to the post's
> caption and a link to it on Facebook. The client and the operator use this table as the
> performance report for the content we published for them. The single-client scope shows that client’s data. All clients scope is limited to the signed-in user’s memberships; a one-client reviewer sees only their demo client. We do not sell these insights or expose another client’s data to a non-member.

### `instagram_basic`

> When a client signs in with Facebook from our Instagram invite link, we read the Instagram
> Business account linked to the Page they selected — its id and username — and show it as
> "@username" on our "Confirm the account to connect" screen so they can confirm it is the right
> account. After they connect it, we read that account's `followers_count` for the "Follower growth" chart in Analytics, and the `permalink` of each post we published so that the "View on Instagram" action in our Content screen opens the real post. We read only the account the client
> connected.

### `instagram_content_publish`

> Our operator creates an Instagram post for a client in the Create post side panel: they select the
> client's connected Instagram account, write the caption, attach an image, a video or up to ten items for a carousel, and choose **Now** under "When to post", then **Publish now** and confirm **Publish now?**, or choose **Schedule** and a date/time. We create a media container
> with `POST /{ig-user-id}/media`, wait for it to finish processing if it is a video, and publish it
> with `POST /{ig-user-id}/media_publish`. The post then appears on the client's Instagram profile
> and in our Content screen. This is the service the client engaged us for: posting to their
> Instagram account on a schedule they have agreed, without sharing their password with us.

### `instagram_manage_insights`

> For each Instagram post we published for a client, we call `GET /{ig-media-id}/insights` to read
> views, reach, total interactions, likes, comments and saves, and show those numbers in the "Top posts" table on our Analytics screen, filtered to Instagram. The columns show the latest reported counts; the metric chips above change the trend chart, and Platform breakdown shows totals. There is no per-row expansion. The client sees how the posts we made for
> them performed; the operator uses the same table to decide what to publish next. We read insights
> only for media we published on the account the client connected.

### `business_management` — recommended for this eight-permission submission

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
> This is a **member** account limited to the dedicated demo client **Meegrow Review**. It can
> publish and connect accounts; it cannot add clients, manage people or manage API keys.
>
> **Reproduce the Facebook Page flow**
>
> 1. In the left menu open **Connections**. Scroll to **Add an account**. On the **Facebook Page**
>    platform card, click **Invite client**, then **Copy link** in the **Invite link — Facebook Page**
>    dialog. The link is `https://social.meegrowlabs.com/i/<token>`. **Connect** instead starts the
>    same Facebook consent in a popup for an account you can authorize yourself. Outstanding links
>    appear under **Invite links that still work**, where they can be copied or cancelled.
> 2. Open the link in a new tab in the same browser. The page reads **Connect your Facebook Page**,
>    names the requesting workspace, explains access in bullets, and has **Continue with Facebook**.
>    Click it.
> 3. Sign in to Facebook. Choose the Page(s), the Business portfolio owning the Page and the linked
>    Instagram account(s), then review access and complete consent. A returning-user flow observed
>    on 2026-10-11 used **Edit settings**, **Next**, **Save**, then **Got it**. First-time order and
>    labels remain unverified. Instagram selection appears because the two providers share one
>    Facebook Login for Business configuration.
> 4. You return to `/i/finish/<flowId>`. With one account, the heading is **Confirm the account to
>    connect**; with several it is **Choose the account to connect**. The subtitle says nothing is
>    connected yet. Click **Connect** beside the intended Page (`pages_show_list`,
>    `business_management`). Wait for **Connected**, naming the account and workspace.
> 5. Back in the first tab, click **Refresh** on Connections. Find the Page in the connected-account
>    table. Desktop columns include **Status**, **Token expiry**, and **Connected**. **Never expires**
>    appears only if expiry is absent. **Disconnect** is in that account’s actions menu.
> 6. Click the sidebar’s **Create post**. A side panel opens. If a WordPress account is connected,
>    the **Post / Article** switch is visible; select **Post** (otherwise only post mode appears).
>    Under **Post to**, the account picker is grouped by platform: select the Page under **Facebook Page**.
>    Write the caption, optionally add a photo under **Media**, then under **When to post** choose
>    **Now** from **Draft / Now / Schedule / Queue**. Click **Publish now**, check the Page named in
>    **Publish now?**, and click **Publish now** again (`pages_manage_posts`). For multiple selected
>    accounts the button includes “to N accounts”; select only the intended Page for this test.
> 7. Read the success panel’s **Status:** line; an accepted request is not proof of a live post.
>    Click **View content**. Content is a card grid (select **Grid** if needed), with status chips
>    and **Source → All sources**. Find the caption and **Published** chip. Open the card’s actions
>    menu → **View on Facebook Page**, and check the live Page post.
> 8. Open **Analytics**, use the **Facebook Page** platform chip and **Account** filter for the Page,
>    and set **Period** to include an earlier measured post. The top KPI band contains
>    **Engagement rate**, **Reach**, **Views**, **Followers**, **Posts published**, and prior-period
>    deltas. Below it are an insights row, a trend chart with **Views / Reach / Likes / Comments /
>    Saves / Engagement rate** chips, and a card grid. **Follower growth** shows this Page’s
>    follower captures and net change (`pages_read_engagement`); use **Follower account** if there
>    is more than one selected account. Scroll to **Top posts** for latest per-post counts and
>    **Platform breakdown** for totals (`read_insights`). The earlier post beginning
>    `[OLD_FB_POST_CAPTION]` on **Meegrow Labs - Zero to AI Hero** must have verified numeric
>    values before submission. Missing counts appear as dashes, not zero. There is no row expansion.
>
> **Reproduce the Instagram flow**
>
> 1. Connections → **Add an account** → Instagram → **Invite client** → **Copy link**. Open the
>    link in the same browser. The heading is **Connect your Instagram**; click **Continue with
>    Facebook** and complete consent, selecting the Page and its linked Instagram Business account.
> 2. At `/i/finish/<flowId>`, confirm or choose the listed Instagram account **@meegrowlabs**
>    (`instagram_basic`). Click **Connect** and wait for **Connected**. Return to Connections and
>    click **Refresh** to see its connected-account row.
> 3. **Create post** → **Post** if the switch is present → **Post to** → Instagram group → select
>    the account. Write a caption and add an image under **Media** (Instagram has no text-only
>    posts). **When to post → Now** → **Publish now** → **Publish now?** → **Publish now**
>    (`instagram_content_publish`). Read the success panel’s **Status:** line.
> 4. **View content** → the post’s **Published** card → actions menu → **View on Instagram**. Check
>    the live post and caption on the Instagram profile.
> 5. Analytics → **Instagram** platform chip → **Account** → **@meegrowlabs** → **Period** including
>    the earlier post. Scroll to **Top posts**: the `[OLD_IG_POST_CAPTION]` row should have verified
>    numbers for the reported views, reach, likes, comments and saves (`instagram_manage_insights`).
>    **Platform breakdown** shows totals. The KPI band and metric chips above offer the same
>    summary and trend controls as Facebook; rows do not expand.
>
> **Notes.** An invite link lasts up to 14 days, until cancelled or until it successfully connects
> an account; an abandoned consent or account pick can be retried. Create a new link after a
> successful connection if repeating the flow. A finish page works only in the browser where that
> invite flow started. If Facebook offers “Continue as …?”, choose **Edit settings** to review the
> account list again. To remove access in our product use the account’s **Disconnect** menu item in
> Connections. Analytics currently displays **Preview — numbers not yet validated** unconditionally;
> the Facebook metric names are still being checked against real data and Meta Business Suite.
> Questions: `[SUPPORT_EMAIL]`.

Before pasting: fill both earlier-post captions only after numeric values have been checked. Keep
the Preview note while the badge exists. If the narrower BM route is proven and the submission is
changed to seven, remove the Business selection and BM references and re-record the matching flow.
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

| #   | What must be visible                                                                                                                                                                                                                                            | Caption to overlay                                                                                                   | Proves                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| F1  | `social.meegrowlabs.com/login`, **Sign in to Meegrow Social**, Email / Password / **Sign in**; Connections → **Add an account** → Facebook Page → **Invite client** → **Copy link**                                                                             | The reviewer signs in with a member login confined to the demo client, then creates a client connection link.        | App login without Meta                  |
| F2  | New tab `/i/<token>`: **Connect your Facebook Page**, requesting workspace and access bullets, **Continue with Facebook**. Click it                                                                                                                             | The client opens the invite and starts Facebook Login.                                                               | Start of Meta login                     |
| F3  | Facebook login from logged-out, then observed returning-user **Choose the Pages…**: tick **Meegrow Labs - Zero to AI Hero**, **Next**. First-time sequence must be verified                                                                                     | The client logs in and chooses the Page to share.                                                                    | Meta login; `pages_show_list`           |
| F3b | Recommended BM flow: **Choose the Businesses…** → `[TEST_BUSINESS_NAME]` → **Next**; verify the actual sequence before recording                                                                                                                                | business_management: the client selects the portfolio owning the Page.                                               | `business_management`                   |
| F3c | **Choose the Instagram accounts…** → **@meegrowlabs** → **Next**, as observed for returning consent                                                                                                                                                             | The shared configuration also serves Instagram.                                                                      | —                                       |
| F4  | **Review Meegrow Social’s access request**: every permission line readable; **Save** → **Got it**, for the observed returning-user sequence                                                                                                                     | The client grants pages_show_list, pages_read_engagement, pages_manage_posts, read_insights and business_management. | Grant of requested Facebook permissions |
| F5  | `/i/finish/<flowId>`: **Confirm the account to connect** (one) or **Choose the account to connect** (several), Page name, **Connect** → **Connected** naming account/workspace                                                                                  | pages_show_list: choose the returned Page. business_management enables discovery for the business-owned Page.        | `pages_show_list`; BM                   |
| F6  | First tab: Connections → **Refresh**. Page in connected-account table; **Status**, **Token expiry** (actual value), **Connected**; account actions menu → **Disconnect** visible                                                                                | The Page is connected to the demo workspace; Disconnect removes the app connection.                                  | End of connect                          |
| F7  | Sidebar **Create post** → side panel; **Post** if Post / Article switch is visible; **Post to** grouped **Facebook Page** picker → Page; caption/date; **Media** → photo; **When to post → Now** → **Publish now**                                              | pages_manage_posts: compose for the client’s Page and choose Now.                                                    | `pages_manage_posts`                    |
| F8  | **Publish now?** lists the Page; **Publish now** to confirm; success panel’s **Status:** line, **View content / View calendar / Create another / Done**                                                                                                         | Publishing a single photo uses POST /{page-id}/photos. Verify the returned status and live post.                     | `pages_manage_posts`                    |
| F9  | **View content** → Content **Grid**, **All sources**, matching caption and **Published** chip; card actions → **View on Facebook Page** → live post with matching caption/date on the test Page                                                                 | The post is live on the client’s Facebook Page.                                                                      | `pages_manage_posts`                    |
| F10 | Analytics → **Facebook Page** chip, Page **Account**, appropriate **Period**; KPI band with deltas, insights row, metric-chip trend chart; scroll to **Top posts** → `[OLD_FB_POST_CAPTION]` with verified numbers; **Platform breakdown** totals. No expansion | read_insights: latest reported per-post values from /{post-id}/insights, plus platform totals.                       | `read_insights`                         |
| F11 | Same filtered Analytics screen: **Followers** KPI value; **Follower growth** card with Page subtitle and net change; **Follower account** when present; hover chart point to read capture/value                                                                 | pages_read_engagement: Page followers from /{page-id}?fields=followers_count.                                        | `pages_read_engagement`                 |

Match the caption in F8 to the post type you actually publish: `/feed` for text, `/photos` for one
photo, `/videos` for a video.

### Instagram recording

| #   | What must be visible                                                                                                                                                                                                                                     | Caption to overlay                                                                          | Proves                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| I1  | App **Sign in**; Connections → **Add an account** → Instagram → **Invite client** → **Copy link**                                                                                                                                                        | The reviewer creates an Instagram connection invite for the demo client.                    | App login without Meta       |
| I2  | `/i/<token>`: **Connect your Instagram**, requesting workspace and access bullets, **Continue with Facebook**                                                                                                                                            | Instagram Business accounts connect through Facebook Login.                                 | Start of Meta login          |
| I3  | Facebook login from logged-out; Page **Meegrow Labs - Zero to AI Hero**, Business `[TEST_BUSINESS_NAME]`, Instagram **@meegrowlabs** selections; verify exact first-time screens                                                                         | The client selects the Page, owning portfolio and linked Instagram account.                 | Meta login; BM when selected |
| I4  | Access request: every Instagram permission line readable; observed returning consent **Save** → **Got it**                                                                                                                                               | The client grants instagram_basic, instagram_content_publish and instagram_manage_insights. | Grant                        |
| I5  | `/i/finish/<flowId>`: **Confirm the account to connect** / **Choose the account to connect**, **@meegrowlabs**, **Connect** → **Connected**                                                                                                              | instagram_basic: the linked Instagram account’s username is shown before connection.        | `instagram_basic`            |
| I6  | Connections → **Refresh**; Instagram in connected-account table with **Status**, **Token expiry** and **Connected** columns                                                                                                                              | The Instagram account is connected to the demo client.                                      | End of connect               |
| I7  | **Create post** side panel → **Post** if switch visible → **Post to** Instagram group → account; caption/date, image under **Media**; **When to post → Now** → **Publish now**                                                                           | instagram_content_publish: compose the image post for the connected account.                | `instagram_content_publish`  |
| I8  | **Publish now?** names Instagram account; confirm **Publish now**; success panel **Status:** and **View content**. Verify after separate readiness fix                                                                                                   | Publish uses /{ig-user-id}/media then /media_publish.                                       | `instagram_content_publish`  |
| I9  | Content **Grid**, **All sources**, matching **Published** card; actions → **View on Instagram** → live post/profile with matching caption                                                                                                                | The live-post link uses the permalink read with instagram_basic.                            | Publish; `instagram_basic`   |
| I10 | Analytics → **Instagram** chip, account and period; KPI band/deltas, insights row, metric-chip trend chart; **Top posts** → `[OLD_IG_POST_CAPTION]` with verified reported views/reach/likes/comments/saves; **Platform breakdown** totals. No expansion | instagram_manage_insights: per-media insight values in Top posts and platform totals.       | `instagram_manage_insights`  |

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

1. Comment on issue #53 with `[SUBMISSION_DATE]`, which permissions were submitted (eight recommended)
   and the `[BM_NARROW_ROUTE_OUTCOME]` (unknown unless actually tested).
2. **Check the Tech Provider / access verification panel.** On 2026-07-16 nothing in the dashboard
   offered a way to start it; the panel only said it is "only required for Tech Providers". The
   hypothesis is that it activates once Advanced Access has been requested. Look again right after
   submitting and again when the result arrives, and record on #53 what you see **either way**. If it
   has not activated after an approval, Meta support is the next step. The "Become a Tech Provider"
   doc that search finds is WhatsApp-only — wrong door.
3. Do not change the Login configuration, the redirect URI, the reviewer login or the connected test
   accounts while the review is open. Keep `Meegrow Review` working: a reviewer who cannot log
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
  `debug_token` route and resubmit without it. Re-prove discovery against the affected ownership arrangement; do not assume dropping BM preserves every client’s connection flow.
- Approved permissions stay approved; resubmit only the rejected ones, each with its own text.
  (Unverified: we have not been through a partial approval on this app.)

---

## 8. Open questions and unverified claims

Sources recorded in the earlier pack as read on 2026-10-11; preserved here without making any new Meta calls. Dashboard state and the guidance itself were not re-verified in this update:

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
  "will test your app using our own test accounts" but app-mode requirements remain unverified here.
  Check the dashboard's submission checklist; if it is silent, the pre-connected `Meegrow Labs - Zero to AI Hero`
  in `Meegrow Review` still lets a reviewer see publishing and Analytics.
- Whether the form accepts one screencast per permission or one for the whole submission. §6 covers
  both.
- That the values in App settings → Basic (`https://meegrowlabs.com/privacy`, `https://meegrowlabs.com/terms`, `https://meegrowlabs.com/data-deletion`,
  app domains, redirect URI) are what §2 expects. Not inspected for this document.
- How long after publishing our Analytics screen first shows insights for a post. "A day or two" in
  §2 is a safe margin, not a measured figure.
- That the Instagram media metrics all return data; `instagram.ts` still marks them "confirm at live
  bring-up".
- Whether Tech Provider access verification applies to this app at all (§7.2).
- Review turnaround. The only data point is our own: 2026-07-29 to 2026-08-11.
