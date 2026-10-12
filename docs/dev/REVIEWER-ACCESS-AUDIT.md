# Reviewer login and workspace scoping audit

2026-10-12. Source inspection only: no database, Redis, seed execution, production access or Meta
calls. Starting behavior and changes in this branch are distinguished below.

## Could a second, single-workspace user be created before this change?

Yes, through `apps/api/src/seed.ts:main`: a fresh email creates a user with `hashPassword`, then an
**owner** membership in the named workspace. Re-running for an existing email resets its password
and adds a membership if absent; it does not remove old memberships. It cannot guarantee that an
existing identity sees only one client.

There was no people-creation UI, API route or MCP tool. `services/users.ts` supplied identity views,
login and password change. `server.ts` exposed `POST /v1/workspaces` (workspace plus caller-owner
membership), not user creation. `mcp/index.ts` registers connection, post, media, queue, analytics
and workspace tools; `mcp/workspaces.ts` only exposes the authenticated workspace. Public
connection invites in `services/invites.ts` connect social accounts; they do **not** create app users.

`docs/dev/BUILD-SPEC-V2.md` records the reversal to client logins (lines 46–57) and future roles
matrix (lines 591–592). The schema already supports users, memberships with roles and sessions
(`packages/db/src/schema.ts`), but role enforcement was incomplete.

## Route-by-route scoping at the start

Paths below are in `apps/api/src/server.ts`; service references are under `packages/core/src/services`.

| Surface / routes                                                                     | Scope and evidence                                                                                                                                                                                                                                                                              | Starting gap / change                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login, `/v1/auth/me`, logout, rotation, password change                              | `users.ts:buildUserView` joins memberships by userId; `sessions.ts:authenticateSession` checks active membership on each request. Password change uses authenticated user/session                                                                                                               | No public signup or global membership view                                                                                                                                  |
| Workspace switching `/v1/auth/session/workspace`                                     | `sessions.ts:switchActiveWorkspace` requires both user and target membership                                                                                                                                                                                                                    | Already refuses foreign workspace with 403; session UPDATE now also includes userId                                                                                         |
| Overview `/v1/overview`, Clients, client switcher                                    | `overview.ts:overviewForUser` selects only user memberships, then reads each with `withWorkspace`; API-key automation query explicitly filters workspaceId. `pages/Clients.tsx` uses this overview. `components/ClientSwitcher.tsx` and `lib/sidebar.ts:joinClients` use `/auth/me` memberships | No foreign client names selected. Add-client controls were shown to everyone                                                                                                |
| Workspace creation `POST /v1/workspaces`                                             | `overview.ts:createClientWorkspace` creates workspace and caller-owner membership                                                                                                                                                                                                               | **Any session could become an owner.** Now core requires an existing owner membership                                                                                       |
| Connections list/health/individual health/delete/import/followers                    | Authenticated workspaceId; `connections.ts`, `post-import.ts`, `analytics.ts` use `withWorkspace`. Followers first checks a scoped connection list                                                                                                                                              | Isolation depends on deployed non-superuser application role and RLS; mutations were not role-gated                                                                         |
| Connect auth-url/start/credential/password/site-check paths                          | Authenticated workspace, never caller-selected workspace                                                                                                                                                                                                                                        | Viewer mutations and GET auth-url initiation are now refused                                                                                                                |
| OAuth finish `/v1/connections/finish`                                                | `connections.ts:finishConnect` checks flow.workspaceId before using tokens/accounts                                                                                                                                                                                                             | Foreign flow formerly generic 500; now typed access denial → 403                                                                                                            |
| Connection invite create/list/delete                                                 | `server.ts:inviteWorkspace` allows active workspace or explicit target after `isWorkspaceMember`; API keys cannot reach another workspace. `invites.ts` explicitly filters non-RLS tables by workspaceId                                                                                        | Members may connect/invite for their own client. Viewer access to invite tokens is now refused                                                                              |
| Public invite lookup/start/flow/finish, `/connect/callback`, `/connect/done`         | Intentional capability access: live opaque invite token, signed OAuth state and browser proof cookie, expiry/use/revocation and offered-account checks in `invites.ts`, `connections.ts`, `crypto.ts`                                                                                           | A holder of a live link can see its intended client name and connect an account. No enumerable workspace list. Membership does not grant foreign browser proofs             |
| Posts create/validate/list/calendar/get/update/delete/retry; bulk/individual metrics | Only authenticated workspaceId; `posts.ts`, `validate-post.ts`, `analytics.ts` use `withWorkspace`. Foreign connection/media/queue references are resolved in that tenant                                                                                                                       | Validation and bulk metrics can return 200 with invalid/missing entries; no foreign data                                                                                    |
| Post groups list/get/duplicate                                                       | `posts.ts`, same tenant boundary                                                                                                                                                                                                                                                                | Foreign group not found                                                                                                                                                     |
| Remote post refresh/update/trash                                                     | Authenticated `AuthContext`; `remote-posts.ts` checks local post under `withWorkspace` before provider operation                                                                                                                                                                                | Foreign post not found without provider contact                                                                                                                             |
| Analytics status/report                                                              | Default active workspace. `scope=all` requires a session; `analytics-report.ts:getAnalyticsReportForUser` selects only user memberships                                                                                                                                                         | All clients means all memberships, never all database workspaces                                                                                                            |
| Media upload/register/get/validate                                                   | `media.ts`, authenticated workspace with `withWorkspace`                                                                                                                                                                                                                                        | Foreign id not found. Published media URLs (`/media/` or storage URLs) are intentionally public for platforms to retrieve; a known asset URL is not protected by membership |
| Queues create/list/get/slots/update/delete                                           | `queues.ts`, authenticated workspace with `withWorkspace`                                                                                                                                                                                                                                       | Foreign queue not found                                                                                                                                                     |
| Logs query/aggregate                                                                 | `logs.ts`, authenticated workspace with `withWorkspace`; no all-client endpoint                                                                                                                                                                                                                 | Request logs contain route/status/timing, not bodies or returned credentials                                                                                                |
| API keys create/list/delete                                                          | `auth.ts` explicit workspace predicates (table is non-RLS)                                                                                                                                                                                                                                      | **Every member and even an API key could manage keys.** Now `manageWorkspaceApiKeys` requires owner/admin session authority in core for all three operations                |
| MCP `/mcp`                                                                           | Tools bound to `ctx.workspaceId`; arguments cannot choose another workspace. `mcp/workspaces.ts` lists one workspace; analytics uses bound workspace                                                                                                                                            | No user/key/workspace-create tool. Viewer sessions now refused at transport                                                                                                 |

No all-workspace data listing exposed to a one-workspace session was found in these sources. The
privilege gaps still made such an account unsuitable before these changes. Live RLS/callback
security and every route have not been exercised in this sandbox.

## Implementation and setup

- **No migration or new dependency.** `contracts/src/people.ts`, core `people.ts` / `access.ts` use
  existing users/memberships/sessions.
- Owner-only **Clients → row actions → Add a person to this client** creates a new identity and
  exactly one admin/member/viewer membership. Owner cannot be assigned. Existing emails are
  refused without changing their password or memberships. Emails and login lookup are normalized.
- Crypto-generated temporary password returned once with `Cache-Control: no-store`; only Argon2id
  hash is persisted. Credentials are not logged or placed in localStorage. Issuance counts
  successful and duplicate attempts using the existing store: 10 per owner and 30 per IP per
  15 minutes. Shared-store deployment behavior is unchanged.
- Owner-only list/remove requires actor AND target membership. Removal refuses self/owners,
  deletes only that client membership and revokes all user sessions in one transaction. Other
  memberships, if any, remain. No owner-transfer flow.
- API-key management requires owner/admin session authority. API keys still authenticate normal
  tenant operations, but cannot mint replacements. This deliberately tightens the old API.
- Reviewer should be **member** in a dedicated **Meegrow Review** client. An existing owner creates
  it, connects test accounts, adds a fresh reviewer email, saves the temporary password privately,
  then changes it using the existing account-menu **Change password** before sharing final review
  credentials. No user or workspace has been created in any database by this task. Password change
  is recommended, not forced; no expiry marker exists for temporary passwords.
- Members can publish/connect/invite in their own client but cannot create clients or manage
  people/keys. Admins can manage keys but cannot create clients or manage people. Viewers cannot
  mutate tenant content, start OAuth, read invite tokens or use MCP; own password changes and
  membership-checked switching remain available. UI hides Add client/API keys according to
  authority; core/API refusal applies to handcrafted requests too.

## Proof and remaining uncertainty

Unit tests use DB doubles and Fastify injection without databases or Redis. They cover authority
predicates, hashing, one-membership writes, throttling, rollback, removal-session writes, HTTP
refusals, tenant-scope delegation and viewer transport refusal. Authored
`apps/api/src/reviewer-access.integration.test.ts` covers real lifecycle, membership visibility,
aggregates and foreign resource ids with existing helpers, but was **not run**. Existing key and
workspace-creation integration expectations were updated, also unrun.

Live RLS, concurrent provisioning/removal, production roles, browser journey, actual account
provisioning, social connections/publishing, provider metrics and Meta acceptance remain
unverified. The review pack retains credentials, earlier-post, Business portfolio, support and
recording placeholders instead of inventing them.
