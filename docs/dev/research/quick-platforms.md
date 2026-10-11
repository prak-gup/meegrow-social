# Bluesky, Telegram, Discord, Slack — research and bring-up

Four platforms that need **no third-party approval**: nobody reviews an app, there is no OAuth
client of ours, and each account or channel brings its own credential. Bluesky is a social
network (posts on a profile). Telegram, Discord and Slack are **broadcast only**: one post goes
into one channel. Nothing is read from any of them — no inbox, no messages, no members.

**Status: built from public documentation only. No request has ever been made to any of these
services by this code or its author.** Every fixture in the tests is constructed from the
documentation cited here and says so. The integration tests (`*.integration.test.ts`) were
written without a database and have never been executed; CI is their first run.

Each claim below is marked **[doc]** (stated in the cited documentation, read on 2026-10-11) or
**[assumed]** (inferred, commonly reported, or a choice of ours) — every **[assumed]** item is on
the bring-up checklist of its platform.

## 0. What the four share

### Switches

Each provider registers only behind its own exact opt-in, default off
(`packages/core/src/providers/registry.ts`). Nothing else is needed: no client id, no secret.

| Variable           | Value  | Registers  |
| ------------------ | ------ | ---------- |
| `BLUESKY_ENABLED`  | `true` | `bluesky`  |
| `TELEGRAM_ENABLED` | `true` | `telegram` |
| `DISCORD_ENABLED`  | `true` | `discord`  |
| `SLACK_ENABLED`    | `true` | `slack`    |

Any other value (`1`, `TRUE`, `yes`) leaves the provider out. They are read by the API **and the
worker** (the worker publishes), so both need the variable. Neither `compose.prod.yml` nor any
`.env*` file was edited by this work.

### How they connect — "pasted credential"

A fourth connect shape next to OAuth, two-step OAuth and WordPress's site-address flow. The
provider declares `connectInput: 'credentials'` and implements `connectWithCredentials(fields)`;
the dashboard shows a form (`ConnectCredentialDialog`, driven by a per-provider guide in
`apps/web/src/lib/credentialConnect.ts`) and makes **one** request:

`POST /v1/connections/:provider/credentials` `{ "fields": { … } }` → `201 { connectionId,
displayName, reconnected }`

Core (`services/credential-connect.ts`) verifies the credential against the platform, then stores
it. No flow row, no redirect, no callback, no popup.

- **Who may call it:** the same as every other connect route — a session cookie or an API key of
  the workspace; a cookie-authenticated call from another origin is refused (the existing CSRF
  check). The codebase has no per-role gate on connect routes today, so none was added here.
- **Dashboard only in this pass.** The public invite-link path has no form for a credential:
  `POST /v1/connections/:provider/invite` answers 400 for these providers and the "Invite client"
  button is not shown for them.
- **Attempt limit.** Each call makes our server present a token to someone else's API, so it is
  counted like a password guess (`beginAuthAttempt`, new scope `connect`): 10 per 15 minutes per
  workspace + platform, 30 per 15 minutes per client address, counted before the platform is
  asked. A refusal by the platform counts; input rejected before any request
  (`CredentialFormatError`) and a platform that could not be reached do not; a success clears the
  workspace's count. Over the limit: `429` with `Retry-After`, and the platform is not contacted.
- **Reconnect replaces in place.** A second connect to the same account (same provider and
  external id in the workspace) puts the new credential on the existing connection and clears its
  needs-reconnect flag, so its scheduled posts and history stay attached.
- **Failures:** `400` input or a stated refusal, `422` the platform rejected the credential (not
  `401` — this app's session is fine), `503` the platform could not be reached. Anything
  unexpected is answered with a fixed sentence, never the error's own text.

### Where the secret travels and rests

1. Typed into the dialog. It lives in that component's state until the request is made and is
   dropped with the dialog. It is never put in the URL, the page's status message, or storage.
   Secret fields are masked and never pre-filled on reconnect.
2. Sent once, in the body of an authenticated POST to this app over its own HTTPS. The body is
   not logged: Fastify's logger is off and the request log records route pattern and status only.
3. Presented to the platform to verify it, through `safeFetch`.
4. Stored as one JSON blob in `connections.access_token`, encrypted with the existing token
   encryption (`encryptToken`) — the WordPress precedent. `refresh_token` is null, `expires_at` is
   null, `token_model` is `one-time`. **No migration:** the existing columns fit.
5. Decrypted in the worker at publish time and presented to the platform again.

It is never returned by any API (the connect answer and `GET /v1/connections` carry only the
safe identifiers below), never written to a log, and never part of an error message: everything
a platform or the transport says passes through `redact()` before it becomes an error, and no
error is ever built from a URL. Tests assert this per provider, including platforms that echo
the credential back and transports that quote the request.

| Platform | Secret (encrypted)                    | Shown: `displayName` · `externalId`               |
| -------- | ------------------------------------- | ------------------------------------------------- |
| Bluesky  | app password (+ DID, handle, PDS)     | `@handle` · the DID                               |
| Telegram | bot token (+ chat id, username)       | channel title · numeric chat id                   |
| Discord  | webhook token (+ webhook/guild/channel ids) | webhook name · webhook id                    |
| Slack    | webhook URL's secret (+ T… and B… ids) | the label the operator typed · `T…/B…`           |

### Outbound requests

Everything goes through `safeFetch` (`packages/core/src/net/safe-fetch.ts`): https only, port
443, no credentials in the URL, public addresses only, resolved once and pinned, bounded in time
and bytes. Redirects are never followed on a request that carries a credential.

- **Fixed hosts** are additionally held to an allowlist (`fixedHostFetch`): `api.telegram.org`;
  `discord.com` / `discordapp.com`; `hooks.slack.com`; and for Bluesky `plc.directory` and
  `public.api.bsky.app`. A request to any other host is refused before it is made.
- **User-influenced hosts** get the full guard and nothing less: a Bluesky handle's own domain,
  a `did:web` domain, the PDS named by a DID document, and — for every platform — the stored
  media URL this app downloads before uploading.

### Text

Captions are plain text. Each platform reads some plain text as markup, so each gets a
conversion, and each counts length differently. Both live in
`packages/contracts/src/platform-text.ts`, used by the provider (what is sent and enforced) and
the Composer (what is counted and shown), so the two cannot disagree.

### Duplicate safety

None of the four offers an idempotency key on the call that posts (Bluesky's `createRecord`
accepts a caller-chosen record key, which could serve as one — not used here, see §1.9). So all
four apply the WordPress rule: **a failure after the posting request was written to the socket is
final**, not retried — `ProviderBadRequestError` "…did not answer in time. The post may or may not
have been published — check the channel before retrying, so it is not posted twice." A failure
before the request left, and a failure of a read or an upload, stays transient and is retried.

### Rate limits and the retry hint

A 429 becomes `ProviderRateLimitError` (transient) carrying the platform's own wait in its
message. The publish queue retries on its fixed schedule — the 2nd and 3rd attempts about 2 and 4
minutes after the one before (`services/publish-queue.ts`) — which is longer than any wait these
platforms document for normal use. **The hint is recorded, not used to schedule:** a wait longer
than ~6 minutes in total would exhaust the three attempts and fail the post. Honouring it exactly
needs a delay passed to the job runner, which the provider contract has no field for.

---

## 1. Bluesky (AT Protocol)

Sources:

- Lexicons (the schemas): <https://github.com/bluesky-social/atproto/tree/main/lexicons> —
  `app/bsky/feed/post.json`, `app/bsky/embed/images.json`, `app/bsky/richtext/facet.json`,
  `app/bsky/feed/defs.json`, `app/bsky/actor/defs.json`, `app/bsky/feed/getAuthorFeed.json`,
  `com/atproto/server/createSession.json`, `com/atproto/repo/createRecord.json`,
  `com/atproto/repo/uploadBlob.json`
- Guides (source of docs.bsky.app): <https://github.com/bluesky-social/bsky-docs/tree/main/docs> —
  `advanced-guides/posts.md`, `advanced-guides/post-richtext.md`, `advanced-guides/rate-limits.md`,
  `advanced-guides/resolving-identities.md`, `advanced-guides/entryway.md`,
  `advanced-guides/api-directory.mdx`, `get-started.mdx`
- Specs: <https://atproto.com/specs/handle>, <https://atproto.com/specs/did>,
  <https://atproto.com/specs/xrpc>

### 1.1 Credential: an app password

- **[doc]** Login is `com.atproto.server.createSession` with `identifier` + `password`, returning
  `accessJwt`, `refreshJwt`, `handle`, `did` (and `active` / `status`). (lexicon; XRPC spec)
- **[doc]** App passwords are created and revoked separately from the main password, log in the
  same way, and "grant slightly restricted permissions". They "usually have the form
  `xxxx-xxxx-xxxx-xxxx`, and clients can check against this format to prevent accidental logins
  with primary passwords". (XRPC spec, "App Passwords")
- **Decision:** a value that is not of that form is refused **before anything is contacted**
  (dialog and server). A main password is therefore never sent anywhere by this app.
- **[doc]** `createSession` errors include `AccountTakedown` and `AuthFactorTokenRequired`
  (lexicon). The second means the main password was used on an account with email sign-in codes;
  it is answered with words about making an app password.
- **[assumed]** Where a person makes one: Bluesky → Settings → Privacy and security → App
  passwords (`https://bsky.app/settings/app-passwords`), and that the creation screen offers an
  "allow access to direct messages" option which is not needed.

### 1.2 Token lifetimes, and what is stored

- **[doc]** "The validity lifetime for [access] tokens is short. Every couple minutes, a new
  access JWT can be requested by hitting `com.atproto.server.refreshSession`, using the refresh
  JWT." (XRPC spec.) The get-started guide: the access token "expires after a few minutes".
- **[assumed]** Exact lifetimes (commonly about 2 hours access, about 90 days refresh on Bluesky's
  own PDS) and that a refresh token is single-use and rotated on every refresh. Neither figure is
  relied on: the access token's own `exp` claim decides how long a session is reused.
- **Decision: store the app password (encrypted), not the refresh token.** A rotating single-use
  refresh token has to be written back after every use. `post()` cannot do that — the publish
  service owns the connection row and the provider contract returns only a post result — and the
  token sweeper works on a 7-day horizon, not a 2-hour one. One lost response, or two workers
  refreshing at once, would strand the connection until a human reconnected it. The app password
  is the credential the platform designed for this: stable, revocable on its own, limited in
  scope. Sessions made from it are kept **in memory only** (per worker process, until one minute
  before the access token expires) and are never written anywhere; the refresh token in the
  login response is dropped.
- **[doc]** `createSession` is limited to 30 per 5 minutes and 300 per day per account
  (rate-limits guide). The in-memory session cache keeps one login per account per token
  lifetime per process; analytics use no login at all (§1.8).
- Cost of this choice, stated plainly: a database **and** encryption-key compromise yields app
  passwords, which stay valid until revoked in Bluesky. A refresh token would have been equally
  usable for its (assumed ~90-day) life.

### 1.3 Finding the account's server (PDS)

- **[doc]** The default "bsky.social" is an _entryway_; an account actually lives on a PDS such as
  `morel.us-east.host.bsky.network`, or on someone else's server entirely. "The user's PDS is the
  hostname listed in the DID doc." (entryway guide)
- **[doc]** Handle → DID has two methods and "services should fully support both": a DNS TXT
  record `_atproto.<handle>` with value `did=<did>` (preferred; several different DIDs → fail),
  and `GET https://<handle>/.well-known/atproto-did` returning the DID as plain text. (handle spec)
- **[doc]** "Handles must be bi-directionally linked to a DID: the DID document must claim the
  handle." (handle spec.) `did:plc` documents come from the PLC directory; `did:web` from the
  domain's `/.well-known/did.json`, hostname-level only, no port. (DID spec)
- **[doc]** The PDS is the `service` entry whose `id` ends `#atproto_pds` with type
  `AtprotoPersonalDataServer`; "the first matching entry should be used"; `serviceEndpoint` holds
  scheme and host only — no userinfo, no path. (DID spec)
- **Implemented:** handle (or DID, or a pasted `bsky.app/profile/…` link) → DNS TXT, then the
  well-known file → DID document → the document must list `at://<handle>` → PDS origin, with a
  malformed first PDS entry refused rather than skipped. The password is then sent to that PDS
  and nowhere else, and the session's DID must equal the resolved DID.
- **SSRF:** the well-known request, a `did:web` document and every PDS call go to hosts a person
  influenced, through the full guard. Tests drive the real `safeFetch` with a fake resolver: a PDS
  resolving to `10.0.0.5`, or named as `169.254.169.254` / `localhost` / `*.internal` / port 8443,
  never gets a socket.
- **[assumed]** `https://plc.directory/<did>` as the PLC lookup URL (the DID spec names the
  directory; the URL form is the conventional one). That the well-known file is served without a
  redirect (redirects are not followed there).
- **Limitation:** the PDS is recorded at connect time. An account that migrates to another PDS
  must be reconnected.

### 1.4 Posting

- **[doc]** `com.atproto.repo.createRecord` with `repo` (the DID), `collection`
  `app.bsky.feed.post`, `record` `{ $type, text, createdAt }`; answers `{ uri, cid }` where `uri`
  is `at://<did>/app.bsky.feed.post/<rkey>`. `createdAt` with a trailing `Z` is preferred.
- **[doc]** `text`: `maxGraphemes` 300 **and** `maxLength` 3000 (bytes). (post lexicon)
- **Implemented:** both limits. Graphemes are counted with `Intl.Segmenter` (extended grapheme
  clusters) — no new dependency; a family emoji is one, a Devanagari syllable with its vowel sign
  is one. The byte limit is what 121 four-person family emoji reach long before 300 graphemes.
- **[assumed]** That `Intl.Segmenter` (ICU in Node 22) and Bluesky's own counter agree on every
  cluster. They implement the same Unicode rule but may be on different Unicode versions; a
  disagreement of a character or two near the limit is possible for conjunct-heavy scripts. The
  server's own refusal is surfaced verbatim if it happens.
- **[assumed]** The public post URL `https://bsky.app/profile/<handle>/post/<rkey>` (and that a
  DID works in place of the handle).

### 1.5 Facets — links, tags, mentions

- **[doc]** The API links nothing by itself: a link, mention or tag exists only as a facet
  `{ index: { byteStart, byteEnd }, features: [...] }`, "counting bytes of the UTF-8 encoded
  text", start inclusive, end exclusive. Features: `#link { uri }`, `#mention { did }`,
  `#tag { tag }` (without the `#`, at most 64 graphemes). (facet lexicon; posts guide)
- **[doc]** A handle that does not resolve is skipped and "will be rendered as text". (posts guide)
- **Implemented:** every `http(s)://` address, every `#tag` (any script; a bare number is not a
  tag), and every `@handle` that resolves, each with byte offsets. Tests slice the UTF-8 bytes
  back out for Hindi + emoji + several addresses, and reproduce the offsets of the guide's own
  worked example (mention 23–35, link 74–108).
- **Choices:** only addresses with an explicit scheme are linked (a bare `example.com` is left as
  text); an address ends at the first non-ASCII character, so a Devanagari danda after a link is
  not swallowed into it; mentions are resolved through `com.atproto.identity.resolveHandle` on
  the public AppView, at most 10 per post.
- **Not done:** link preview cards (`app.bsky.embed.external` needs a fetched title, description
  and thumbnail blob) — links are clickable but show no card.

### 1.6 Images; video

- **[doc]** `app.bsky.embed.images`: at most 4; each needs `image` (a blob) and `alt`; blob
  `maxSize` 2,000,000 bytes, accept `image/*`; `aspectRatio` optional and best left out when
  unknown. Blobs are uploaded first with `com.atproto.repo.uploadBlob` (raw bytes, their own
  `Content-Type`) and are "deleted if not referenced within a time window (eg, minutes)".
- **Conflict in the documentation:** the posts guide says in one place "limited to 1,000,000
  bytes" and in another 2,000,000; the lexicon says 2,000,000 ("formerly limited to 1 MB"). The
  lexicon is what a PDS validates against, so 2,000,000 is used. On the checklist.
- **Implemented:** up to 4 images, each downloaded from our storage (SSRF-guarded, capped at
  2,000,000 bytes) and uploaded as a blob before the record is created — so a failed upload
  leaves nothing posted. JPEG, PNG, WebP, GIF. No transcoding or resizing (AX-PRD: validate and
  reject): an image over 2 MB is refused, at validation when its size is known and at publish
  otherwise.
- **Alt text is sent empty.** This app's media has no alt-text field. An accessibility gap.
- **Video: out of scope.** It is not a blob-and-embed: `app.bsky.embed.video` goes through a
  separate upload service with service-auth tokens and an asynchronous processing job. A video is
  refused at validation with "attach images only".

### 1.7 Errors

| Bluesky                                                                         | Becomes                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 401 / 403; `ExpiredToken`, `InvalidToken`, `AuthenticationRequired`, `AccountTakedown`, `AccountDeactivated` | auth → needs reconnect (after one fresh login was tried) |
| `AuthFactorTokenRequired`                                                       | auth, with "that was the main password"                        |
| 429                                                                             | rate limited (transient), wait from `Retry-After` / `ratelimit-reset` |
| 5xx                                                                             | transient                                                      |
| other 4xx                                                                       | bad request, "Bluesky says: … [ErrorName]"                     |

- **[doc]** XRPC errors are JSON `{ error, message }`; rate-limit headers follow the IETF
  `ratelimit-*` draft and a crossed limit is a 429. (XRPC spec; rate-limits guide)
- **[assumed]** The names `ExpiredToken`, `InvalidToken`, `AuthenticationRequired`,
  `AccountDeactivated` (used by the reference PDS; only `AccountTakedown` and
  `AuthFactorTokenRequired` are in the `createSession` lexicon). Unknown names fall through to the
  status code, so a wrong guess degrades to "bad request", not to a silent success.
- **[doc]** Write limits: 5,000 points per hour and 35,000 per day per account, 3 per create —
  far above anything this app does.

### 1.8 Analytics

- **[doc]** `public.api.bsky.app` is the public, cached AppView: its endpoints "do not require
  authentication". `app.bsky.feed.getPosts` returns `postView` with `likeCount`, `repostCount`,
  `replyCount`, `quoteCount`, `bookmarkCount`; `profileViewDetailed` has `followersCount`,
  `followsCount`, `postsCount`. (api-directory guide; feed and actor lexicons)
- **Implemented, with no credentials:** a revoked app password never stops a published post's
  numbers, and no login is spent reading them.
  - `postAnalytics` → `likeCount`, `repostCount`, `replyCount`, `quoteCount`, `bookmarkCount`,
    stored under exactly those names (invariant 7), only those Bluesky actually sent.
  - `accountAnalytics` → `followers` (this app's one cross-platform account metric, which the
    follower trend reads — every provider uses it), plus `followsCount` and `postsCount` verbatim.
- **For whoever owns the metric-concept mapping** (`packages/core/src/services/metric-concepts.ts`,
  which landed on `main` while this was being built and was **not edited** here): Bluesky has no
  entry yet, so its numbers show only as raw metrics and its follower trend is not read. The
  entries it needs:
  - `POST_SOURCES.bluesky`: `likes: ['likeCount']`, `comments: ['replyCount']`,
    `shares: ['repostCount']`, `saves: ['bookmarkCount']`. `quoteCount` (a quote post — a share
    with commentary) is best left unmapped: a concept takes the first name a post reports, not a
    sum, so listing it under `shares` would never be read, and adding it would need a rule.
  - `FOLLOWER_SOURCES.bluesky`: `['followers']`.
  - No `views`, `reach`, `clicks` or `follows`: there is **no** impression, reach or view count
    for a Bluesky post anywhere in the public API, so an engagement _rate_ cannot be computed.
  - `followsCount` and `postsCount` are account-level and feed no concept.
- **[assumed]** That `bookmarkCount` is populated on the unauthenticated view (it is in the
  lexicon, and is simply omitted from the stored metrics when absent).

### 1.9 Out of scope, and what it would take

- **Importing past posts** (`listPublishedPosts` via `app.bsky.feed.getAuthorFeed`, which is
  public and paginated): not implemented. Implementing it also queues an automatic backfill at
  every connect and copies thumbnails through the import path, neither of which could be tried
  here; it deserves its own change.
- **Idempotent create:** `createRecord` accepts a caller-chosen `rkey`. A record key derived from
  this app's post id would make a retry after a timeout safe (the second create would conflict
  instead of duplicating). The provider is not given the post id today; passing it would lift the
  "may have been posted" rule for Bluesky.
- Threads, replies, quote posts, link cards, video, languages (`langs`), self-labels, alt text.
- OAuth for atproto exists and would replace the app password; it needs a hosted client-metadata
  document and DPoP, and is a larger build than this pass.

### 1.10 Live bring-up checklist — Bluesky

1. Set `BLUESKY_ENABLED=true` for API and worker; restart; `GET /v1/providers` lists `bluesky`.
2. Create an app password on a **test account** (not a client's). Confirm the Settings path and
   the `xxxx-xxxx-xxxx-xxxx` shape; if Bluesky issues another shape, the format check is wrong.
3. Connect with the `name.bsky.social` handle. Then connect an account with a **custom-domain
   handle** (DNS TXT path) and, if one is available, an account on a **non-Bluesky PDS**.
4. Try the account's main password: it must be refused in the dialog without a request.
5. Post plain text; open the returned link (confirms the URL format).
6. Post Hindi + emoji + two links + a hashtag + an `@handle`: every link, tag and mention must be
   clickable **and land on the right text** (a facet off by a byte shows as a link covering the
   wrong characters).
7. Post exactly 300 graphemes of a conjunct-heavy script (e.g. Hindi with many `क्ष`/`त्र`) and a
   301st: confirm our count and Bluesky's agree.
8. Post 1 and 4 images; post a 1.5 MB image (settles the 1 MB vs 2 MB conflict).
9. Delete the app password in Bluesky, wait for the cached session to lapse (or restart the
   worker), publish: the post must fail with a reconnect message and the connection must read
   "Needs reconnect". Reconnect with a new app password: same connection row.
10. After an hour, check Analytics shows `likeCount` etc. for the post and a follower count.
11. Read the worker and API logs for the app password and for `Bearer`: neither may appear.

---

## 2. Telegram (Bot API)

Sources: <https://core.telegram.org/bots/api> (the reference; sections "Making requests",
"Formatting options", "Sending files", `getMe`, `getChat`, `getChatMember`, `sendMessage`,
`sendPhoto`, `sendVideo`, `sendMediaGroup`, `ResponseParameters`),
<https://core.telegram.org/bots/faq> (limits).

### 2.1 Credential: a bot token

- **[doc]** "Each bot is given a unique authentication token when it is created", like
  `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`; requests go to
  `https://api.telegram.org/bot<token>/METHOD_NAME`. Bots are made with @BotFather.
- **The token is in every request URL.** So: (a) its shape (`digits:` then 20–128 of
  `A-Za-z0-9_-`) is checked before it is ever placed in a path — nothing with `/`, `?`, `#`, `%`
  or whitespace gets that far; (b) no error or log is ever built from a URL — failures are worded
  from Telegram's `description`, redacted; `safeFetch`'s own errors name only the host; (c) the
  host is allowlisted. Tests feed every failure mode a response that echoes the full URL and
  assert that neither the token nor `/bot<digits>` appears in any message.
- **[assumed]** The exact length range of the secret half of a token.

### 2.2 Connect verification

- **[doc]** `getMe` returns the bot's `User` (`id`, `is_bot`, `username`). `getChat` takes a
  `chat_id` that is a numeric id or `@channelusername` and returns `id`, `type`
  (`private` / `group` / `supergroup` / `channel`), `title`, `username`. `getChatMember` returns
  the member's `status` (`creator`, `administrator`, `member`, `restricted`, `left`, `kicked`);
  an administrator of a channel has `can_post_messages`.
- **Implemented:** `getMe` (is it a bot?) → `getChat` (does the chat exist, is it a channel or a
  group?) → `getChatMember` for the bot itself. A channel needs `creator`, or `administrator`
  with `can_post_messages: true`; a group needs membership that may write. **Nothing is sent to
  the chat** to verify.
- The channel is given as `@username`, a `t.me/username` link, or a numeric id (private channels
  have no username; their id starts `-100`). An invite link (`t.me/+…`) is refused with words.
- **[assumed]** That a bot can call `getChat` / `getChatMember` on a channel it administers by
  `@username` before it has ever posted there. If Telegram answers "chat not found" for a bot
  that _is_ an admin, the first connect must use the numeric id.

### 2.3 Posting

- **[doc]** `sendMessage` `text`: "1-4096 characters after entities parsing". Captions of
  `sendPhoto` / `sendVideo`: "0-1024 characters after entities parsing". `sendMediaGroup`: "must
  include 2-10 items"; returns an array of the sent messages.
- **[doc]** Media can be passed as "an HTTP URL for the file to be sent. Telegram will download
  and send the file. 5 MB max size for photos and 20 MB max for other types of content."
- **Implemented:** no media → `sendMessage`; one → `sendPhoto` or `sendVideo`; 2–10 →
  `sendMediaGroup` with the caption on the first item. Media is passed **by URL**: Telegram
  fetches our public storage URL itself, so no file bytes pass through this app and the limits
  are 5 MB (photo) and 20 MB (video). The photo limit is in the media validation table; the
  video limit is not (that table cannot express "size only"), so an oversized video is refused
  by Telegram at publish with its own words.
- **Limits enforced before sending:** 4096 without media, 1024 beside media, 10 items.
- **[assumed]** That "characters" means UTF-16 code units. This is the largest of the candidate
  measures, so the check can be too strict by an emoji, never too lenient.
- **[assumed]** Message links: `https://t.me/<username>/<message_id>` for a public chat;
  `https://t.me/c/<id without -100>/<message_id>` for a private channel or supergroup (opens only
  for its members); none for a basic group, which is reported as a notice on the event log.
- **Rate:** "avoid sending more than one message per second" in one chat; "not more than 20
  messages per minute" in a group (FAQ). The provider runs one job at a time.

### 2.4 Text: `parse_mode: "HTML"`

- **[doc]** In HTML style "all `<`, `>` and `&` symbols that are not a part of a tag or an HTML
  entity must be replaced with the corresponding HTML entities". MarkdownV2 instead requires
  escaping eighteen characters "in all other places" with different rules inside code and links.
- **Decision: HTML mode, with exactly those three characters escaped.** It is the mode whose
  escaping rule is three characters with no exceptions, so nothing a person types — `*`, `_`,
  `` ` ``, `[x](y)`, a literal `<b>` — can turn into formatting. Addresses, @usernames and
  #hashtags are linked by Telegram itself.
- Sending no `parse_mode` at all would also give plain text. HTML was chosen so the behaviour is
  pinned by a documented rule rather than by the absence of a parameter, and so an explicit link
  can be added later without changing mode.

### 2.5 Errors

- **[doc]** Every answer is JSON with `ok`; a failure has `description` and `error_code` ("its
  contents are subject to change"), and may have `parameters.retry_after`.

| Telegram                                                        | Becomes                                  |
| --------------------------------------------------------------- | ---------------------------------------- |
| 401; 404 (what a malformed token path gets)                     | auth → needs reconnect                   |
| 403 (bot kicked, blocked, not a member)                         | auth → needs reconnect                   |
| 400 at publish: "chat not found", "not enough rights", "need administrator rights", "group chat was upgraded" | auth → needs reconnect |
| 429                                                             | rate limited (transient), `retry_after`  |
| 5xx                                                             | transient                                |
| other 400                                                       | bad request, "Telegram says: …"          |

- **[assumed]** The 400 description strings (matched case-insensitively as substrings). They are
  not a documented vocabulary; a string that changes degrades to "bad request" — the post still
  fails with Telegram's words, but the connection is not flagged.
- **[assumed]** That a token of the wrong shape or an unknown one is answered 404 as well as 401.
- At **connect** time a 400/403 on `getChat` or `getChatMember` is worded as "the bot has not been
  added to the channel" — the token had just worked for `getMe`.

### 2.6 Analytics: none

- **[doc]** The Bot API has no method returning views, reactions counts or forwards for a
  channel post made by a bot (the method list has none; channel statistics belong to the separate
  client API). `postAnalytics` and `accountAnalytics` return nothing. Nothing is invented.

### 2.7 Out of scope

Reading anything (updates, webhooks, comments); formatting; inline buttons; polls; silent or
protected messages; topics in forum supergroups (`message_thread_id`); uploading bytes (larger
files: 10 MB photo, 50 MB other); editing or deleting a sent message; member counts.

### 2.8 Live bring-up checklist — Telegram

1. Set `TELEGRAM_ENABLED=true` for API and worker; restart.
2. Make a test bot with @BotFather; make a **test channel**; add the bot as an administrator
   with "Post messages".
3. Connect by `@username`. Confirm the bot posted nothing during connect.
4. Remove "Post messages" from the bot and connect again: must be refused with the instruction to
   switch it on. Remove the bot: must be refused as "not added".
5. Connect a **private** channel by its numeric id (`-100…`).
6. Post text containing `<b>x</b> & *y* _z_ [a](b) https://example.com #tag @username`: it must
   arrive exactly as typed, with only the address, tag and username linked.
7. Post one photo, one video, and an album of three; post 1024 and 1025 characters with a photo.
8. Open the returned link for the public channel and for the private one (as a member).
9. Post a text of emoji near 4096 to see which unit Telegram counts.
10. Revoke the token in BotFather (`/revoke`), publish: must fail and flag "Needs reconnect".
    Separately, kick the bot from the channel and publish: same.
11. Read the logs for the token and for `/bot`: neither may appear.

---

## 3. Discord (incoming webhook)

Sources (the repository behind discord.com/developers/docs):
<https://github.com/discord/discord-api-docs/blob/main/developers/resources/webhook.mdx>,
`…/resources/message.mdx` (allowed mentions, embed limits), `…/reference.mdx` (uploading files),
`…/topics/rate-limits.mdx`, `…/topics/opcodes-and-status-codes.mdx`.

### 3.1 Credential: the webhook URL

- **[doc]** An Incoming webhook (type 1) "can post messages to channels with a generated token".
  "Get Webhook with Token" — `GET /webhooks/{id}/{token}` — "does not require authentication and
  returns no user in the webhook object". The object has `id`, `type`, `name`, `channel_id`,
  `guild_id`.
- **The URL is the credential**: id + token, nothing else. It is treated exactly like a password.
- **Validation is strict and on the raw text**: one anchored pattern — `https://`, host exactly
  `discord.com` or `discordapp.com`, `/api/` (optionally `/v<n>/`), `webhooks/`, a 17–20 digit id,
  a token of `A-Za-z0-9_-`, optional trailing slash, **nothing else** — and the host as a URL
  parser reads it must agree. No port, userinfo, query, fragment, percent-encoding, backslash,
  other subdomain, or `/slack` / `/github` suffix. The request URL is then **rebuilt** from the id
  and token on `discord.com`; the typed text is never used. Tests cover 46 hostile inputs
  (look-alike hosts, `discord.com@evil`, `discord.com\@evil`, `https:discord.com`, homoglyphs,
  encoded slashes and dots, IP literals, header injection).
- **Verify:** one `GET`; the id must match and the type must be 1. A Channel Follower or
  Application webhook is refused with words. Nothing is posted.
- **[assumed]** That `discordapp.com` still serves webhooks (the request is sent to `discord.com`
  either way). The id and token length ranges.

### 3.2 Posting

- **[doc]** `POST /webhooks/{id}/{token}`; `wait=true` "waits for server confirmation of message
  send before response, and returns the created message body" (default false, where "a message
  that is not saved does not return an error"). `content`: "up to 2000 characters". At least one
  of `content`, `embeds`, `components`, `file`, `poll`.
- **[doc]** Files: `multipart/form-data` with `payload_json` and `files[n]` parts, each with a
  `Content-Disposition` carrying `filename`; `attachments` lists them by index. "The default
  limit is 20 MiB" per file.
- **Implemented:** always `?wait=true` (so the message id is known and an unsaved message is an
  error). Text only → JSON. With media → each file is downloaded from our storage (SSRF-guarded,
  capped at 20 MiB) and uploaded as `files[n]`; up to 10 files. JPEG/PNG/GIF/WebP and
  MP4/MOV/WebM.
- **Our own ceiling, not Discord's:** 50 MB across one post's files, because every file is held
  in memory to build the upload. Stated as ours in the error.
- **[assumed]** 10 attachments per message (Discord's client limit; the webhook reference does
  not state a count). The message link `https://discord.com/channels/<guild>/<channel>/<message>`.
  That "2000 characters" is counted in a unit no larger than UTF-16 code units (ours is the
  strictest candidate).
- A forum or media channel needs a thread (**[doc]**, error 220001): not supported; the error
  says to use a webhook of a text or announcement channel.

### 3.3 Mentions and Markdown

- **[doc]** "In interactions and webhooks, only user mentions are parsed" by default; the
  `allowed_mentions` object controls who is notified, and the docs advise "using
  `allowed_mentions` to prevent unexpected mentions" for user-generated content.
- **Implemented:** `allowed_mentions: { "parse": [] }` on **every** message — no `@everyone`,
  `@here`, role or user is ever notified, whatever the text says. A test asserts it on every
  payload shape.
- Discord renders `content` as Markdown and has no plain-text switch, so the caption is escaped
  (`discordContent`): a backslash before `\ * _ ~ \` | < [`, and before `#`, `>`, `-` where they
  start a line. Escaping `<` also defuses `<@id>`, `<@&id>`, `<#id>`, `<:emoji:id>`, `<t:…>`.
  Addresses are left untouched so they still link. The 2000 limit is applied to the **escaped**
  text, and the Composer counts the same string.
- **[assumed]** The escape set and that a backslash defuses each of those characters in a webhook
  message. Discord's Markdown is documented in its help centre, not its API reference.

### 3.4 Errors

| Discord                                               | Becomes                                           |
| ----------------------------------------------------- | ------------------------------------------------- |
| 404 (10015 Unknown Webhook), 401 (50027 Invalid Webhook Token), 403 | auth → needs reconnect              |
| 429                                                   | rate limited (transient), `retry_after` / `Retry-After` |
| 413 or 40005                                          | bad request about file size                       |
| 400 with 220001                                       | bad request: forum channel                        |
| other 4xx                                             | bad request, "Discord says: … [code]"             |
| 5xx                                                   | transient                                         |

- **[doc]** Error codes 10015, 50027, 40005, 50035, 220001; the 429 body `{ message,
  retry_after, global }` and the `X-RateLimit-*` / `Retry-After` headers. "Your application
  should rely on the `Retry-After` header or `retry_after` field."
- `X-RateLimit-Remaining` on a success is not acted on: one post is one request.

### 3.5 Analytics: none

A webhook cannot read a message back, so there are no reactions or replies to count, and Discord
has no view counts. Both analytics methods return nothing.

### 3.6 Out of scope

A bot or OAuth app; embeds (the brief asked for them to be researched: an embed would give a
titled card, at the cost of a second set of limits and escaping rules — not needed to post a
caption); threads and forum posts; overriding the webhook's name or avatar; editing or deleting
the message; components and polls; alt text for attachments.

### 3.7 Live bring-up checklist — Discord

1. Set `DISCORD_ENABLED=true` for API and worker; restart.
2. In a **test server**, create a webhook on a text channel; copy its URL; connect. Confirm
   nothing was posted and the webhook's name is what the connection shows.
3. Paste the `discordapp.com` spelling of the same URL: must connect.
4. Post `@everyone @here **bold** _it_ ~~no~~ ||sp|| # h1 <@yourUserId> [x](https://example.com)
   https://example.com/a_b`: it must arrive as that literal text, **nobody pinged**, only the
   bare address linked. Any character that still renders as formatting is a gap in the escape set.
5. Post 2000 characters of plain text, then 1001 asterisks (2002 once escaped): the second must
   be refused before sending.
6. Post 1 image, 1 video, 10 images. Open the returned message link.
7. Create a webhook on a **forum** channel and post: must fail with the forum message.
8. Delete the webhook in Discord and publish: must fail and flag "Needs reconnect".
9. Read the logs for the webhook token and for `/api/webhooks/`: neither may appear.

---

## 4. Slack (incoming webhook)

Sources: <https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks>,
<https://docs.slack.dev/messaging/formatting-message-text>,
<https://docs.slack.dev/apis/web-api/rate-limits>,
<https://docs.slack.dev/reference/block-kit/blocks/section-block>,
<https://docs.slack.dev/reference/block-kit/blocks/image-block>,
<https://docs.slack.dev/reference/block-kit/blocks>.

### 4.1 Credential: the incoming-webhook URL

- **[doc]** A webhook URL looks like
  `https://hooks.slack.com/services/T…/B…/…`, is "specific to
  a single user and a single channel", and "contains a secret… Slack actively searches out and
  revokes leaked secrets."
- **[doc]** "You cannot override the default channel, username, or icon" from a webhook.
- **Validation:** one anchored pattern on the raw text — exactly that host, the `/services/`
  path, a `T…` workspace id, a `B…` webhook id, an alphanumeric secret; no trailing slash, query
  or fragment. Workflow triggers (`/triggers/…`, `/workflows/…`) and every other Slack host are
  refused. The request URL is rebuilt from the three parts. A stored blob is re-validated the
  same way before use.
- **Slack never tells a webhook its channel's name**, so the dialog asks for a label
  ("Channel name") — a label for this dashboard only, shown as the connection's name.
- **[assumed]** The length ranges of the three path parts.

### 4.2 Connect verification — an empty payload

- There is no way to look a webhook up: it accepts POSTs only.
- **[doc]** Errors include: `no_text` "the text attribute was missing from the payload";
  `invalid_payload`; `no_service` "the incoming webhook is either disabled, removed, or invalid";
  `no_active_hooks`; `invalid_token`; `no_service_id`; `no_team`; `channel_is_archived`;
  `action_prohibited`; `posting_to_general_channel_denied` — with "more relevant HTTP status
  codes (like 400, 403 and 404)".
- **Implemented:** connecting POSTs an **empty** JSON object. A live webhook is expected to
  refuse it for having no text — posting nothing — which is taken as proof of life; a removed one
  to answer `no_service` / a 404.
- **[assumed] — the most important unverified item for Slack:** that an empty payload is answered
  `no_text` (HTTP 400) by a live webhook **and posts nothing**, and that a dead webhook answers
  with one of the "gone" words or 403/404. This is read off the documented error list, not
  observed. If a live webhook answered an empty payload with 200, nothing visible could have been
  posted (there is no text to show) and the connect still succeeds; if a dead webhook answered a
  plain 400, a dead webhook would be connected and the first publish would then flag it.

### 4.3 Posting

- **[doc]** `POST` JSON with `text` and optionally `blocks`. A section block's text is 1–3000
  characters. An image block takes `image_url` — "the URL for a publicly hosted image", up to
  3000 characters — and a required `alt_text`. Up to 50 blocks per message.
- **[doc]** The answer is "a plain text `ok`". The message's `ts` "is not returned when sending a
  request to an incoming webhook".
- **Implemented:** one `section` block with the caption as `mrkdwn`, then one `image` block per
  image by its public URL, with `text` as the notification fallback. Limits: 3000 characters **as
  sent**, 10 images, **no video and no other file** — an incoming webhook cannot upload; a video
  is refused at validation with words.
- **No link, no id.** A published Slack post has `releaseUrl` null and `externalPostId` null
  (`PostResult` now allows both to be absent). The event log says "An incoming webhook reports no
  link to the message", the connect dialog says so before connecting, and the Composer preview
  says so for a Slack account. The post simply has no "open" action in Content.
- **Rate:** "no more than one message per second per channel… via an incoming webhook" (**[doc]**);
  the provider runs one job at a time. A 429 carries `Retry-After` in seconds (**[doc]**).

### 4.4 Text: `mrkdwn`, escaped

- **[doc]** "`&`, `<`, `>`" must be replaced with `&amp;`, `&lt;`, `&gt;`; those strings "are used
  to trigger special parsing of the text, such as user mentions". Every mention and command is
  written with angle brackets (`<!channel>`, `<!here>`, `<@U…>`, `<#C…>`).
- **[doc]** Automatic parsing: "if this user text contained a string like `@everyone`, your app
  could unintentionally send a notification to the entire workspace"; it is disabled for a text
  object with `verbatim: true`.
- **Implemented:** the three characters are escaped (so no mention or command survives), the text
  object is sent with `verbatim: true` (so Slack guesses at nothing), and because `verbatim` also
  stops automatic linking, each address is written as an explicit `<https://…>` link.
- **Not defused, and it cannot be:** Slack has no escape for `*bold*`, `_italic_`, `~strike~` or
  `` `code` ``. A caption containing those pairs shows as formatted in Slack. Said in the dialog
  and the Composer preview. (Sending the message as top-level `text` with `mrkdwn: false` would
  disable formatting, but that field is not displayed once blocks are present, and blocks are the
  only way to show an image.)
- **[assumed]** That `&amp;` inside an explicit `<url>` is read back as `&`.

### 4.5 Errors

| Slack                                                                        | Becomes                              |
| ---------------------------------------------------------------------------- | ------------------------------------ |
| `no_service`, `no_active_hooks`, `invalid_token`, `no_service_id`, `no_team`; any other 403 / 404 / 410 | auth → needs reconnect |
| `channel_is_archived`                                                        | auth → needs reconnect (new webhook) |
| `action_prohibited`, `posting_to_general_channel_denied`                     | bad request, in words — the webhook is not broken |
| 429                                                                          | rate limited (transient), `Retry-After` |
| 5xx                                                                          | transient                            |
| other 4xx (`invalid_payload`, `no_text`, `invalid_blocks`)                   | bad request, "Slack says: …"         |
| 200 whose body is not `ok`                                                   | final: "may or may not have been published" |

Only a body that is one of Slack's lowercase words is quoted; anything else (an HTML error page)
is reported by status alone.

### 4.6 Analytics: none

No message id is returned, so there is nothing to read reactions or replies by, and a webhook
could not read them anyway. Both analytics methods return nothing.

### 4.7 What a full Slack app would add later

A Slack app of ours, installed per workspace with OAuth (bot scopes `chat:write`, plus
`files:write` and `channels:read`):

- `chat.postMessage` returns `channel` and `ts` → a **permalink** (`chat.getPermalink`), an id to
  store, and so edit, delete and threaded replies.
- **File uploads** — images that live in Slack rather than being hot-linked, and **video**
  (`files.getUploadURLExternal` + `files.completeUploadExternal`; the older `files.upload`).
- **Picking the channel** from a list (`conversations.list`) with its real name, and posting to
  several channels from one connection, instead of one pasted URL per channel.
- Reaction and reply counts (`reactions.get`, `conversations.replies`) — the only "analytics"
  Slack has.
- A proper connect check (`auth.test`) instead of the empty-payload probe.

The cost is what this pass avoided: a Slack app to register and distribute, an OAuth flow, token
storage and rotation, and (for a public listing) Slack's app review.

### 4.8 Live bring-up checklist — Slack

1. Set `SLACK_ENABLED=true` for API and worker; restart.
2. In a **test workspace**, create an app → Incoming Webhooks → add a webhook to a test channel.
3. **Before connecting, settle §4.2 by hand** with the test webhook: `POST` an empty JSON object
   and note the status and body, and look at the channel — nothing must appear. Then remove the
   webhook and repeat. If either answer differs from the assumption, fix `connectWithCredentials`
   before any client uses it.
4. Connect; confirm nothing was posted and the label is the connection's name.
5. Post `<!channel> <!here> <@yourUserId> Tom & Jerry <3 > 2 https://example.com/a?b=1&c=2`: no
   notification, the angle-bracket text shown literally, the address clickable and intact.
6. Post `*bold* _italic_ ~strike~`: expected to render formatted (the documented limitation).
7. Post text with 1 and with 3 images; post 3000 characters, and 3001 (refused before sending).
8. Try a video: refused at validation in the Composer.
9. Confirm the published post shows no link in Content and the event log carries the notice.
10. Remove the webhook and publish: must fail and flag "Needs reconnect".
11. Read the logs for the webhook secret and for `/services/`: neither may appear.

---

## 5. Not verified — the whole list in one place

- **Nothing has run against any of the four services.** Every behaviour above marked
  **[assumed]**, and the exact wording and status of every error answer.
- **The integration tests were never executed** (no database was available to the author):
  `credential-connect.integration.test.ts` and the four
  `credential-connect.<provider>.integration.test.ts` files. Unit tests ran (`pnpm test`).
- The web UI was checked against a **stub API** with a headless browser at 1512 px and 390 px —
  not against the real API, and not on a real phone. Media attachments were not exercised in
  the browser.
- Media in **local development** cannot be published to these platforms: stored media there is
  served over `http://localhost`, which the SSRF guard (and each platform) refuses. In production
  media is on public https storage.
- Worker memory with large Discord uploads (up to 50 MB held at once) was reasoned about, not
  measured.
- Grapheme counts versus Bluesky's own counter near the limit (§1.4).
- The publish queue's fixed backoff versus a long `retry_after` (§0).
