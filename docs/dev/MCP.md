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

26 tools. **Read** changes nothing. **Write** changes data in the workspace. **Publish** can put content on a
real social account.

| Tool                      | What it does                                                                                          | Effect  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| `get_workspace`           | The workspace this key belongs to: id, name, slug                                                     | Read    |
| `list_workspaces`         | The same workspace as a one-item list; a key never sees another                                       | Read    |
| `list_connections`        | Connected social accounts with `health` and `expiresInDays`                                           | Read    |
| `get_connection`          | One connected account by id, same fields                                                              | Read    |
| `connection_health`       | Status, reason and recommended action per account (or for one), from stored state only                | Read    |
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

Notes that are easy to get wrong:

- `create_post` and `add_to_queue` take `variants` (one entry per account, each with its own
  optional caption, media and options) and group-level `media`. The older single-target arguments
  `connectionId` + `provider` (+ `options`), and `publishAt` on `create_post`, still work; mixing
  the two styles in one call is rejected.
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

| REST                               | MCP tool                 | Notes                                                                                 |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `POST /v1/posts/:id/retry`         | `retry_post`             | No body. `200 {"post":…}`; `404` unknown post; `409` when the post is not `failed`    |
| `POST /v1/posts/validate`          | `validate_post`          | Body of `POST /v1/posts`. Always `200 {"valid":…,"issues":[…]}`, even for a bad body  |
| `GET /v1/connections/health`       | `connection_health`      | `200 {"connections":[…]}`                                                             |
| `GET /v1/connections/:id/health`   | `connection_health` + id | `200 {"health":…}`; `404` unknown connection                                          |
| `GET /v1/queues/:id/slots?count=N` | `preview_queue_slots`    | `count` 1–50, default 5. `404` unknown queue; `400` inactive queue or bad `count`     |
| `POST /v1/posts`                   | `create_post`            | Now `404 {"error":"connection <id> not found"}` for a connection not in the workspace |

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
| Tags, reviews                                                                  | Workstreams C1 and B2 are not built; their tools are added with them                    |
