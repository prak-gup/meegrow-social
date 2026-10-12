# MCP reference

meegrow-social exposes its modules to agents over the Model Context Protocol. One API key is bound
to one workspace; every tool reads and writes that workspace only, and no tool accepts a workspace
id. The tools call the same `core` services as the REST API (`apps/api/src/mcp/`, one file per noun).

## 1. Get an API key

A key is created by a human over REST. There is no MCP tool for it, on purpose: an agent that could
mint keys could outlive the key you gave it.

```bash
curl -s -X POST https://<host>/v1/api-keys \
  -H "Authorization: Bearer <an existing key of the same workspace>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent"}'
# -> {"id":"…","name":"my-agent","prefix":"sk_live_abc123…","secret":"sk_live_…"}
```

- `POST /v1/api-keys` accepts either an existing key of that workspace or a logged-in dashboard
  session cookie; with a session, the key is created for the session's active workspace.
- `secret` is shown once and is not stored. A lost key is revoked (`DELETE /v1/api-keys/:id`) and
  reissued. `GET /v1/api-keys` lists the keys of the workspace.
- The dashboard has no API-keys screen yet, so the first key of a workspace is made with the
  session cookie of a logged-in user.

## 2. Endpoint

|           |                                                                                           |
| --------- | ----------------------------------------------------------------------------------------- |
| URL       | `POST https://<host>/mcp` (production host: `social.meegrowlabs.com`; local dev: `:8990`) |
| Auth      | `Authorization: Bearer sk_live_…` — the same header and key as REST                       |
| Transport | Streamable HTTP, stateless: no session id, no `initialize` needed before a call           |
| Headers   | `Content-Type: application/json` and `Accept: application/json, text/event-stream`        |
| Response  | `200` with a one-message SSE body: `event: message` then `data: <JSON-RPC response>`      |

A request without both media types in `Accept` gets `406`. A missing or revoked key gets `401`
`{"error":"unauthenticated"}` before MCP is reached. Only `POST` is served. `GET /mcp` (the optional
server-to-client stream some clients probe for) and `DELETE /mcp` (session teardown) return `405`
with `Allow: POST`, which is what the MCP spec asks of a server that offers neither; the official
SDK client treats it as "not offered" and carries on. Auth is checked first for every method, so a
`GET /mcp` without a valid key is `401`, not `405`.

### Add it to Claude Code

```bash
claude mcp add --transport http meegrow-social https://<host>/mcp \
  --header "Authorization: Bearer sk_live_…"
```

### Raw JSON-RPC

```bash
curl -s -X POST https://<host>/mcp \
  -H "Authorization: Bearer sk_live_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Calling a tool is the same request with
`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_posts","arguments":{"status":"scheduled"}}}`.

## 3. Results and errors

A successful call returns one `text` content item holding JSON — the value the `core` service
returned (dates as ISO 8601 strings).

A failed call returns `isError: true`, never a JSON-RPC error, with
`{"error":"<code>","message":"…"}`:

| `error`           | Meaning                                                                       | REST equivalent |
| ----------------- | ----------------------------------------------------------------------------- | --------------- |
| `not_found`       | No such post, group, media, connection or queue in this workspace             | 404             |
| `invalid_state`   | The post is not in a status that allows the edit, schedule, cancel or retry   | 409             |
| `invalid_request` | Arguments fail the contract or the platform's own rules; or an inactive queue | 400             |
| `internal_error`  | Anything else, with the underlying message                                    | 500             |

Arguments that fail the tool's input schema (a malformed id, an unknown status) are rejected by the
MCP SDK before the handler runs. That is also `isError: true`, but the text is the SDK's plain
message (`MCP error -32602: Input validation error: …`), not the JSON shape above.

A row that belongs to another workspace is reported as `not_found`, exactly like a row that does
not exist. That includes a `connectionId` passed to `create_post` or `add_to_queue`: a connection of
another workspace gets the same `connection <id> not found` as an id that exists nowhere.

`validate_post` is the exception to "a problem is an error": an invalid post is its answer, so it
returns a normal result with `valid: false` and the problems listed in `issues`.

## 4. Tools

27 tools. **Read** changes nothing. **Write** changes data in the workspace. **Publish** can put content on a
real social account.

| Tool                      | What it does                                                                                          | Effect  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| `get_workspace`           | The workspace this key belongs to: id, name, slug                                                     | Read    |
| `list_workspaces`         | The same workspace as a one-item list; a key never sees another                                       | Read    |
| `list_connections`        | Connected social accounts with `health` and `expiresInDays`                                           | Read    |
| `get_connection`          | One connected account by id, same fields                                                              | Read    |
| `connection_health`       | Status, reason and recommended action per account (or for one), from stored state only                | Read    |
| `import_past_posts`       | Queue an import of the posts an account already has on the platform (30/90/180/365 days); reads only  | Write   |
| `list_posts`              | Posts, filtered by status / provider / connectionId / from / to, with limit + offset                  | Read    |
| `get_post`                | One per-platform post: status, schedule, `releaseUrl` or `error`                                      | Read    |
| `get_post_group`          | Everything one `create_post` call made, with shared caption and media                                 | Read    |
| `calendar`                | One month of posts bucketed by day in a given timezone                                                | Read    |
| `create_post`             | Create a post for one or more accounts; draft by default, or scheduled / now / queue                  | Publish |
| `validate_post`           | Dry-run `create_post`: same arguments, creates nothing, returns `{ valid, issues }`                   | Read    |
| `update_post`             | Edit caption / media / options / `publishAt` of a draft or scheduled post                             | Publish |
| `schedule_post`           | Schedule a draft, or move a scheduled post to a new time                                              | Publish |
| `unschedule_post`         | Return a scheduled post to draft and stop its pending publish                                         | Write   |
| `cancel_post`             | Cancel a draft or scheduled post for good (irreversible; record kept)                                 | Write   |
| `delete_post`             | Cancels the post, exactly like `cancel_post`. No hard delete; removes nothing from the social network | Write   |
| `duplicate_post`          | Copy one post into a new draft on the same account                                                    | Write   |
| `retry_post`              | Queue a `failed` post to publish again now; any other status is `invalid_state`                       | Publish |
| `list_queues`             | Publishing queues with their weekly slots                                                             | Read    |
| `preview_queue_slots`     | The next N slots a queue would assign (default 5, max 50), without taking any                         | Read    |
| `add_to_queue`            | Create a post in the next free slot of a queue                                                        | Publish |
| `register_media_from_url` | Register an image or video already hosted at a public URL                                             | Write   |
| `list_media`              | Media records of the workspace, newest first, with limit + offset                                     | Read    |
| `get_media`               | One media record: kind, URL, size, probed dimensions / duration / codec                               | Read    |
| `post_metrics`            | Collected metrics of one post: latest value per metric and the full series                            | Read    |
| `connection_followers`    | Follower-count history of one connected account, newest first                                         | Read    |
| `analytics_report`        | A period's performance against the one before: totals, engagement rate, breakdowns, top posts         | Read    |

Notes that are easy to get wrong:

- `create_post` and `add_to_queue` take `variants` (one entry per account, each with its own
  optional caption, media and options) and group-level `media`. The older single-target arguments
  `connectionId` + `provider` (+ `options`), and `publishAt` on `create_post`, still work; mixing
  the two styles in one call is rejected.
- A **WordPress** connection (`provider: "wordpress"`, present only when the server runs with
  `WORDPRESS_ENABLED=true`) takes a blog article through the same tools. There is no separate
  article tool:
  - `options` is required: `{"kind":"wordpress","title":"…"}`, plus optional `excerpt`, `slug`
    (lowercase letters, digits, hyphens), `categories` and `tags` (each a list of WordPress term
    ids or names), and `status`.
  - `caption` is the article **body, in Markdown** — headings, paragraphs, lists, quotes, fenced
    code, bold, italic, links and `![alt](https://…)` images. It is converted to HTML on the
    server. Raw HTML is **not** passed through: it is escaped and appears as the text you typed.
  - The body may be up to 100000 characters, but only when it is the **variant's own** `caption`.
    The shared top-level `caption` stays at 5000, so an article longer than that needs `variants`
    (the single-target shorthand has nowhere to put a variant caption).
  - At most one image in `media`: it is uploaded to the site's media library and set as the
    featured image. A video is rejected.
  - `schedule` works as for every platform: this server sends the article at that time.
    `options.status` is the state it is created in **on WordPress** at that moment — `publish`
    (the default), or `draft` / `pending` / `private`, which hand it to the site's own editors and
    make nothing public. A post created as `draft` on WordPress still reads `published` here
    (it was sent); its link is then not a public URL.
  - A category name that does not exist on the site fails the post; a tag name that does not
    exist is created.
  - Connecting a site is a human action in the dashboard (the site owner approves on their own
    WordPress). No tool starts it. `post_metrics` and `connection_followers` return nothing for
    WordPress: WordPress core has no analytics API.
  - Once published, an article cannot be edited or deleted from here (`update_post` and
    `cancel_post` only act before publishing, as for every platform).
- **Bluesky, Telegram, Discord and Slack** connections (`provider: "bluesky"` / `"telegram"` /
  `"discord"` / `"slack"`, each present only when the server runs with its own switch —
  `BLUESKY_ENABLED`, `TELEGRAM_ENABLED`, `DISCORD_ENABLED`, `SLACK_ENABLED` `=true`) post through
  the same tools. No tool was added for them:
  - They take **no `options`**; passing any is rejected. `caption` is plain text and is sent as
    plain text: Markdown, HTML and mention syntax in it are escaped, not rendered, and nobody is
    pinged (Discord's `@everyone`, Slack's `<!channel>`). The one exception is Slack, which still
    shows `*bold*` / `_italic_` if typed — it has no way to switch that off.
  - Each has its own length limit, measured its own way. Run `validate_post` first; it answers
    per account in the platform's words:
    - `bluesky` — 300 characters counted as a reader sees them (an emoji is one), and 3000 bytes.
      Links, `#tags` and resolvable `@handle.example` mentions are made clickable. Up to 4
      images of 2 MB each; **no video**.
    - `telegram` — 4096 characters, or 1024 when there is media. Up to 10 photos and videos
      (5 MB per photo, 20 MB per video).
    - `discord` — 2000 characters **after escaping** (each `*`, `_`, `~`, `` ` ``, `|`, `<`, `[`
      and `\` costs one more). Up to 10 images or videos of 20 MB each.
    - `slack` — 3000 characters after escaping (`&`, `<`, `>` and each link cost a few more).
      Images only, shown from their public URL; **no video**.
  - A published `slack` post has **no `releaseUrl`** — an incoming webhook reports no link — and
    a `telegram` post into a basic group has none either. `get_post` then returns
    `releaseUrl: null` on a post whose `status` is `published`; that is success, not a failure.
  - `post_metrics` and `connection_followers` return data for `bluesky` only (public counts under
    Bluesky's own names: `likeCount`, `repostCount`, `replyCount`, `quoteCount`, `bookmarkCount`;
    account `followers`, `followsCount`, `postsCount`). The other three have no numbers to give.
  - A post that fails with "may or may not have been published — check … before retrying" was
    sent and never answered. **Do not `retry_post` it blindly**: look at the channel or profile
    first, or it may go out twice.
  - Connecting one is a human action in the dashboard (pasting an app password, a bot token or a
    webhook address). No tool starts it and no tool accepts a credential. `import_past_posts`
    is not available for these four.
- `analytics_report` is the dashboard's Analytics screen as data (`GET /v1/analytics/report`), for
  the key's workspace. Give `days` (default 30, ending now) or `from` + `to`; optional `provider`,
  `connectionId`, `source` (`app` / `imported`), `timezone` (IANA, default `UTC` — weeks, days and
  posting hours are cut in it) and `topPosts` (how many to return, default 20, at most 100). How to
  read it:
  - Numbers are **concepts** (`views`, `reach`, `likes`, `comments`, `shares`, `saves`, `clicks`,
    `follows`), not platform metric names. `mapping` says which native name(s) feed each concept
    on each platform; an empty list means the platform has no equivalent and its value is `null`.
    `null` is "not reported", never zero. `rawMetrics` lists every native metric of the period's
    posts untouched, including the ones that feed no concept. `post_metrics` still returns one
    post's native names and history.
  - **Engagement rate** = (likes + comments + shares + saves) ÷ reach × 100, divided by views for
    a post without reach, summed over the posts that have both halves (`postsCounted` of `posts`).
    `basis` is `reach`, `views` or `mixed`; `mixed` means the two denominators were combined, and
    the number is not comparable with a pure-reach rate. `components` lists what was actually in
    the numerator — Facebook reports only likes today, Instagram no shares.
  - Totals and `overTime` are the **all-time counts of the posts published in the period**, grouped
    by publish date. They are not growth measured on those dates. `deltaPct` compares with the
    posts published in the period before and is `null` when that period has nothing to compare.
  - `accumulation` is built from stored snapshots and only from posts that have enough of them
    (`rules`); `points` is empty when fewer than `rules.minPosts` qualify. Imported posts never do.
- `create_post` with `schedule` `{"type":"now"}` or `{"type":"at",…}`, `add_to_queue`,
  `schedule_post`, and `update_post` with a `publishAt` all end in a real publish. Nothing here can
  recall a post once it is published.
- Pass `idempotencyKey` on `create_post`, `add_to_queue` and `duplicate_post` whenever a call may
  be retried. A repeated key returns the posts of the first call and writes nothing.
- `cancel_post` is terminal: a cancelled post cannot be edited or rescheduled. Use
  `unschedule_post` to pause a post and keep it editable.
- `create_post` and `add_to_queue` reject a `connectionId` the workspace does not have, at create
  time, with `not_found` — for every variant, and the whole call fails if any one is wrong. Take
  ids from `list_connections`. They do not check that `provider` matches the connection's own
  provider; a mismatch is accepted and fails at publish.
- `retry_post` publishes for real, immediately, through the same job queue as a first attempt — or
  at the post's `publishAt` when that is still in the future (a post that could not be queued for
  tomorrow is queued for tomorrow, not sent today). Only
  a `failed` post can be retried, so a post that is `published` is never sent twice, and each
  account of a multi-account post is retried on its own. One case it cannot see: a post the
  platform accepted but that was recorded as `failed` anyway. If the `error` leaves that open, look
  at the account before retrying. A post whose job ran out of attempts, could not be queued, or
  was found stranded by the worker's sweep is marked `failed` with the reason in `error`, and can
  be retried with this tool.
- `validate_post` checks, without writing anything: the contract; each platform's own rules; that
  every connection is in the workspace; that a queue schedule names an existing, active queue; and
  that each media ref resolves and fits the platform's media spec. The last two are stricter than
  `create_post`, which accepts such a post and lets it fail at publish. It does **not** contact the
  platform: a revoked token, a rate limit, a platform-side content rejection or an unreachable
  media URL are not caught, so `valid: true` is not a promise that the post publishes. Issue codes:
  `invalid_request`, `not_publishable`, `connection_not_found`, `queue_not_found`,
  `queue_inactive`, `media_not_found`, `media_rejected`.
- `connection_health` reads stored state only (`source: "stored"`): token expiry, the
  needs-reconnect flag, the last analytics sweep and the newest failed post of the account. It does
  **not** call the platform, so a token revoked on the platform's side reads `healthy` until a
  publish or a token refresh fails. `status` is `healthy`, `expiring`, `expired` or
  `needs_reconnect`; `expired` is the one value `list_connections` does not have (its `health`
  reports an expired token as `expiring`). `lastFailedPost` is informational and never changes
  `status`.
- `preview_queue_slots` runs the same slot picker as `add_to_queue`: `slots[0]` is the time the
  next `add_to_queue` gets. It reserves nothing, so a concurrent `add_to_queue` can take a slot
  first, and all targets of one `add_to_queue` call share one slot. It returns fewer than `count`
  when the queue has no more free slots in the next 90 days.
- `list_media` exists only over MCP. REST has no `GET /v1/media`; that is a REST gap, not an MCP one.
- Every post a tool returns (`get_post`, `list_posts`, `calendar`, `get_post_group`, and the posts
  returned by the create / update / retry / duplicate tools) carries `media`: its own media in
  carousel order, each `{ id, kind, url, thumbnailUrl }`. `url` is the public URL the platform is
  given, or `null` when the ref has none and no stored media matches its id. `thumbnailUrl` is set
  only for a video with a cover (`options.coverUrl` of a `meta` post); no thumbnail is generated.
  `get_post_group` still returns the group's shared media as refs (`{ mediaId, kind, url? }`).

## 5. REST routes for the same features

Each of these calls the same `core` function as the tool beside it.

| REST                               | MCP tool                 | Notes                                                                                   |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `POST /v1/posts/:id/retry`         | `retry_post`             | No body. `200 {"post":…}`; `404` unknown post; `409` when the post is not `failed`      |
| `POST /v1/posts/validate`          | `validate_post`          | Body of `POST /v1/posts`. Always `200 {"valid":…,"issues":[…]}`, even for a bad body    |
| `GET /v1/connections/health`       | `connection_health`      | `200 {"connections":[…]}`                                                               |
| `GET /v1/connections/:id/health`   | `connection_health` + id | `200 {"health":…}`; `404` unknown connection                                            |
| `POST /v1/connections/:id/import`  | `import_past_posts`      | Body `{"windowDays":90}`. `202 {"import":…}`; `404` unknown; `400` unsupported platform |
| `GET /v1/queues/:id/slots?count=N` | `preview_queue_slots`    | `count` 1–50, default 5. `404` unknown queue; `400` inactive queue or bad `count`       |
| `POST /v1/posts`                   | `create_post`            | Now `404 {"error":"connection <id> not found"}` for a connection not in the workspace   |

## 6. REST modules with no MCP tool

| REST                                                                           | Why not                                                                                 |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `/v1/api-keys` (create, list, revoke)                                          | Deliberate — key management stays a human action                                        |
| `/v1/auth/*` (login, logout, me, session workspace, rotate, password)          | Human sessions; an API key has no user                                                  |
| `GET /v1/overview`, `POST /v1/workspaces`                                      | Session-only: they span every workspace a user belongs to                               |
| Connecting accounts: `auth-url`, `invite`, `/v1/invite/*`, `finish`, providers | OAuth needs a human in a browser                                                        |
| `DELETE /v1/connections/:id`                                                   | Not in the D1 tool list                                                                 |
| `POST /v1/media` (multipart upload)                                            | Binary upload does not fit a tool call; use `register_media_from_url`                   |
| `POST /v1/media/:id/validate`                                                  | Not in the D1 tool list                                                                 |
| Queue management: create, get, update, delete                                  | Not in the D1 tool list (`list_queues`, `preview_queue_slots` and `add_to_queue` exist) |
| `/v1/logs`, `/v1/logs/aggregate`                                               | Not in the D1 tool list                                                                 |
| `GET /v1/post-groups` (list), `POST /v1/post-groups/:id/duplicate`             | Dashboard reads added with the UI pass; `list_posts` / `duplicate_post` cover the tools |
| `POST /v1/posts/metrics/latest`, `GET /v1/analytics/status`                    | Dashboard reads added with the UI pass; `post_metrics` covers one post                  |
| `GET /v1/analytics/report?scope=all`                                           | Spans every workspace of a signed-in user; a key has one workspace (`analytics_report`) |
| Tags, reviews                                                                  | Workstreams C1 and B2 are not built; their tools are added with them                    |

## Remote WordPress article management

These tools manage one existing article, including imported articles; they do not use scheduler
lifecycle edits. Both REST and MCP call the same workspace-scoped core services.

- `refresh_remote_post { postId }`: observe the current site copy, store its HTML and
  `options.remote.modifiedAt`. Discards the prior stored observation. REST:
  `POST /v1/posts/:id/remote/refresh` with `{}`.
- `update_remote_post { postId, expectedModifiedAt, fields }`: optional fields `title`, `body`,
  `excerpt`, `slug`, `status` (`draft|publish|pending|private`), `categories`, `tags`,
  `featuredImage`. Terms are arrays of existing numeric site IDs; featured image is an existing
  attachment ID (0 removes). Omitted fields remain unchanged; empty term arrays remove assignments.
  REST: `POST /v1/posts/:id/remote/update`, same input without `postId`.
- `trash_remote_post { postId, expectedModifiedAt, confirm: true }`: call only after an explicit
  human confirmation to move this article to WordPress trash, where it can be restored. REST:
  `POST /v1/posts/:id/remote/trash`, same input without `postId`. Never bulk or permanent delete.

All return the updated stored `PostView` (REST wraps it as `{ post }`). Refresh first when no
modification date has been stored, or when a conflict asks for refresh. Imported HTML is submitted
as HTML; it is never converted through Markdown. A truncated stored body cannot be edited, but
other fields can. Independent read-back must match requested fields; failures say the write is
unconfirmed or not stored and must not be blindly retried. Failed or mismatched writes are audited;
a mismatch stores the observed site values. Tool annotations identify these as open-world writes.

Overview remains session-only and is not exposed as an MCP tool. `GET /v1/overview` accepts
`timezone` (the viewer's IANA zone, default UTC), matching Analytics' Monday week boundary.
`weekTotals.publishedThisWeek` and each client's `publishedThisWeek` count distinct post groups
with a visible, non-removed published child whose `publishAt` is between Monday 00:00 and now,
inclusive. Genuine imports published this week count; import/creation time does not.
Production-hidden test providers follow `SHOW_FAKE_PROVIDERS` as elsewhere.

The additive `upcomingGroups` field contains up to 12 groups ordered by earliest future scheduled
publish time: `groupId`, `workspaceId`, `workspaceName`, `caption` (article title for WordPress),
`publishAt`, `laterCount` (children scheduled after that earliest time), and `accounts`
(`connectionId`, `provider`, `name`). The web Overview renders account badges with name tooltips
and `+N later`. Legacy `upcoming` remains available with its original per-platform shape and limit.
