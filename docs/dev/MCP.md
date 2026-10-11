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
`{"error":"unauthenticated"}` before MCP is reached. Only `POST` is served: the optional `GET /mcp`
stream some clients probe for returns `404`, which the official SDK client logs and carries on from.

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
| `invalid_state`   | The post is past the point where it can be edited, scheduled or cancelled     | 409             |
| `invalid_request` | Arguments fail the contract or the platform's own rules; or an inactive queue | 400             |
| `internal_error`  | Anything else, with the underlying message                                    | 500             |

Arguments that fail the tool's input schema (a malformed id, an unknown status) are rejected by the
MCP SDK before the handler runs. That is also `isError: true`, but the text is the SDK's plain
message (`MCP error -32602: Input validation error: …`), not the JSON shape above.

A row that belongs to another workspace is reported as `not_found`, exactly like a row that does
not exist.

## 4. Tools

22 tools. **Read** changes nothing. **Write** changes data in the workspace. **Publish** can put content on a
real social account.

| Tool                      | What it does                                                                                          | Effect  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| `get_workspace`           | The workspace this key belongs to: id, name, slug                                                     | Read    |
| `list_workspaces`         | The same workspace as a one-item list; a key never sees another                                       | Read    |
| `list_connections`        | Connected social accounts with `health` and `expiresInDays`                                           | Read    |
| `get_connection`          | One connected account by id, same fields                                                              | Read    |
| `list_posts`              | Posts, filtered by status / provider / connectionId / from / to, with limit + offset                  | Read    |
| `get_post`                | One per-platform post: status, schedule, `releaseUrl` or `error`                                      | Read    |
| `get_post_group`          | Everything one `create_post` call made, with shared caption and media                                 | Read    |
| `calendar`                | One month of posts bucketed by day in a given timezone                                                | Read    |
| `create_post`             | Create a post for one or more accounts; draft by default, or scheduled / now / queue                  | Publish |
| `update_post`             | Edit caption / media / options / `publishAt` of a draft or scheduled post                             | Publish |
| `schedule_post`           | Schedule a draft, or move a scheduled post to a new time                                              | Publish |
| `unschedule_post`         | Return a scheduled post to draft and stop its pending publish                                         | Write   |
| `cancel_post`             | Cancel a draft or scheduled post for good (irreversible; record kept)                                 | Write   |
| `delete_post`             | Cancels the post, exactly like `cancel_post`. No hard delete; removes nothing from the social network | Write   |
| `duplicate_post`          | Copy one post into a new draft on the same account                                                    | Write   |
| `list_queues`             | Publishing queues with their weekly slots                                                             | Read    |
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
- `create_post` does not check that a `connectionId` exists in the workspace. A post created
  against an unknown id is accepted and fails when it tries to publish. Take ids from
  `list_connections`.
- `list_media` exists only over MCP. REST has no `GET /v1/media`; that is a REST gap, not an MCP one.
- `get_post` and `list_posts` do not return a post's media; `get_post_group` returns the group's.

## 5. REST modules with no MCP tool

| REST                                                                           | Why not                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `/v1/api-keys` (create, list, revoke)                                          | Deliberate — key management stays a human action                      |
| `/v1/auth/*` (login, logout, me, session workspace, rotate, password)          | Human sessions; an API key has no user                                |
| `GET /v1/overview`, `POST /v1/workspaces`                                      | Session-only: they span every workspace a user belongs to             |
| Connecting accounts: `auth-url`, `invite`, `/v1/invite/*`, `finish`, providers | OAuth needs a human in a browser                                      |
| `DELETE /v1/connections/:id`                                                   | Not in the D1 tool list                                               |
| `POST /v1/media` (multipart upload)                                            | Binary upload does not fit a tool call; use `register_media_from_url` |
| `POST /v1/media/:id/validate`                                                  | Not in the D1 tool list                                               |
| Queue management: create, get, update, delete                                  | Not in the D1 tool list (`list_queues` and `add_to_queue` exist)      |
| `/v1/logs`, `/v1/logs/aggregate`                                               | Not in the D1 tool list                                               |
| Tags, reviews                                                                  | Workstreams C1 and B2 are not built; their tools are added with them  |
