# Analytics UI brief — issue #28

**Date:** 2026-10-10 · **For:** Anshul · **Owner / sign-off:** Prakhar · **Status:** brief, no code
**Verified against:** `main@cb16944`. Every path and type below was read at the cited line; if a line
has moved, trust the file, not this page.
**Reads with:** `BUILD-SPEC-V2.md` §8 F3 (lines 533–537), invariant 7 (lines 102–103), the client-role
decision (lines 46–61) · `DESIGN-airbnb.md` (tokens) · issue #28 (acceptance criteria).

> **Update 2026-10-11 (analytics v2) — the page and its data path were rebuilt; §2–§5 and §8 below
> describe the screen before it.** What holds now:
>
> - **One read.** The screen is drawn from `GET /v1/analytics/report` (core
>   `services/analytics-report.ts`, MCP `analytics_report`): totals against the prior period,
>   per-platform and by-publish-date breakdowns, best times, followers, formats, top posts, posting
>   frequency and an accumulation curve. The arithmetic left the web app; `lib/analyticsReport.ts`
>   only shapes and labels.
> - **Invariant 7 still holds, and "never hardcode a metric name" now has one stated exception.**
>   Storage keeps platform-native names. `core/services/metric-concepts.ts` is the single read-time
>   mapping from display concepts (views, reach, likes, comments, shares, saves, clicks, follows)
>   to native names, tested platform × concept. A concept a platform lacks is `null` → "—". Every
>   native name, mapped or not, is listed in the page's "Platform metrics, as collected" section
>   and in each post's expanded row.
> - **Engagement rate** = (likes + comments + shares + saves) ÷ reach, ÷ views for a post without
>   reach; a ratio of sums over the posts that have both halves. The screen states the formula,
>   what each rate was divided by, and warns when one number mixes the two.
> - **Time.** "Over time" is by publish week (day for ≤ 14 days) in the viewer's timezone, summing
>   current all-time totals, and says so. Only "Engagement accumulation" uses snapshot history,
>   and only for posts with enough of it.
> - **§7 (validation against the platforms) is still open** and the preview badge still stands.
>
> **Update 2026-10-11 (UI pass 2) — where this brief is now out of date.** The page was reworked
> and two of §9's questions were answered with small API additions, so read the following over the
> matching parts below:
>
> - **§9 Q1, bulk metrics — answered.** `POST /v1/posts/metrics/latest` (`{ postIds }`, up to 200)
>   returns the newest value per metric name per post, names verbatim. The page loads its numbers
>   with it — one request per 200 posts — so the chunks-of-10 loading and the **300-post cap in §3
>   are gone**. The per-post `GET /v1/posts/:id/metrics` is now read only for an expanded row's
>   history. The honesty rules are unchanged: a failed read marks its posts and withholds the
>   comparison; a post list cut short at the paging limit says so and compares nothing.
> - **§9 Q2, last / next sync — answered.** `GET /v1/analytics/status` returns the workspace's
>   newest `capturedAt`, its last sweep, when the next poll falls due (by the sweep's own rules) and
>   the cadence as data. The sync line in §3 is built from it; no cadence text is hardcoded.
> - **§3 layout.** The stat tiles are one bordered strip (followers, posts published, then every
>   metric the period's posts report, then the best post by the chosen metric). The metric picker
>   moved from the chart to the filter row and is kept in the URL (`?metric=`). Post views carry
>   `media`, so the table and the best post show thumbnails.
>
> Everything else — invariant 7, the `—`-never-`0` rule, the preview badge, the undated-posts note,
> §6 and the §7 validation checklist — stands as written.

---

## 1. Goal, non-goals, where it lives

**Goal.** One screen, `/analytics`, where an operator (and later a client) sees how a workspace's
published posts and connected accounts are performing, built entirely from the read endpoints that
already exist. It must render whatever metric names the API returns and must never hardcode a list
of them — platforms rename metrics (`impressions` → `views`, `page_fans` → `followers_count`) and
the whole analytics layer is built so a rename is not a code change (invariant 7, spec lines
102–103; `packages/contracts/src/analytics.ts:6-9`).

**Non-goals.**

- No new backend. No new endpoints, no changes to `packages/core`, `apps/api`, `packages/contracts`
  or `packages/db`. Gaps go in §9 as questions for Prakhar.
- No new UI framework, chart library or primitive of your own. Tailwind 3 + Radix + cva stay
  (owner decision 2026-10-10). Charts and tables come from the shared primitives in §4.
- No cross-workspace rollup. That is the Overview page (`GET /v1/overview`,
  `apps/api/src/server.ts:281-284`). Analytics is one workspace at a time.
- No export, no scheduled reports, no "rich dashboards" (PRD F5.3 says post-v1).

**Where it lives.**

- Route: `/analytics`, registered inside the `<Protected />` group in `apps/web/src/App.tsx:30-38`,
  next to `/content` and `/connections`. The page renders inside `<Outlet />` in
  `apps/web/src/components/AppLayout.tsx:117-122`, which is keyed on `me.activeWorkspaceId`, so a
  client-switch remounts and refetches your page for free — do not add your own workspace watcher.
- Nav entry: "Analytics" with the `ChartLineUp` icon already exported from
  `apps/web/src/lib/icons.ts`. The nav is the `TABS` array at `AppLayout.tsx:9-14` today; the
  left-sidebar layout is being built in parallel and will own that array — add your entry wherever
  the nav list lives at the time you merge.
- **Visibility (changed 2026-10-11, owner decision).** The route is always registered and the
  "Analytics" nav entry is now shown to everyone, unconditionally, after Content. The numbers have
  still **not** been validated against the platforms' native insights (§7), so the page keeps a
  neutral `Badge` reading "Preview — numbers not yet validated" ("Beta" for a client role).
  `VITE_ANALYTICS_UI` no longer hides anything: it is a build-time record of the §7 sign-off, and
  its only read is in `apps/web/src/pages/Analytics.tsx` — set it to `'true'` once the checklist is
  signed off and the badge goes away. Production does not set it, so `main` deploys with Analytics
  visible and labelled preview. (Originally the same flag also gated the nav entry.)
- **Posts without a publish time.** Legacy "publish now" posts have no stored `publishAt` and are
  not being backfilled, so the date-bounded list never returns them and they appear in no period.
  When a period comes back empty the page reads the published list once more without `from`/`to`
  and, if such posts exist, says "N published posts have no recorded publish time and cannot be
  placed in a period" instead of suggesting a longer range. Their metrics are not shown anywhere on
  this page.

---

## 2. The data you already have

All routes sit behind the session-or-API-key `preHandler` at `apps/api/src/server.ts:201-225`.
The dashboard calls them through the typed client in `apps/web/src/lib/api.ts` only
(`request<T>()` at lines 34–61; the `api` object at 63–140). **Two methods are missing from `api.ts`
and are yours to add** (web-only, in scope): `postMetrics(id)` and `connectionFollowers(id)`.

| Call                                                                        | Route (file:line)                                                                        | Response type (file:line)                                                                                                   | Notes                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/connections`                                                       | `server.ts:429-431`                                                                      | `{ connections: ConnectionView[] }` — `packages/contracts/src/connections.ts:4-16`                                          | Drives the connection/profile filter. `provider`, `displayName`, `health`, `needsReconnect` are what you render. **`lastAnalyticsAt` is not in the view** (it exists on the table, `packages/db/src/schema.ts:140`, but is not exposed) — see §9 Q2.                                  |
| `GET /v1/posts?status=published&provider&connectionId&from&to&limit&offset` | `server.ts:471-475`; query schema `packages/contracts/src/posts.ts:226-235`              | `{ posts: PostView[] }` — `posts.ts:190-206`                                                                                | `from`/`to` filter on `publishAt` (`packages/core/src/services/posts.ts:256-257`). `limit` max 100, default 50 — page with `offset` until a page comes back short. Ordered `publishAt asc` (`services/posts.ts:260-264`). Use `status=published`; only published posts have metrics.  |
| `GET /v1/posts/:id/metrics`                                                 | `server.ts:486-490` → `getPostMetrics` `packages/core/src/services/analytics.ts:239-255` | `postMetricsView` `{ latest: Record<string, number>; series: MetricPoint[] }` — `packages/contracts/src/analytics.ts:20-24` | `latest` = newest value per metric name (a cumulative snapshot as of the last sweep, not a per-window number). `series` is the full append-only history, **oldest first**. 404 when the post id is unknown. One call per post — there is no bulk endpoint (§9 Q1).                    |
| `GET /v1/connections/:id/followers`                                         | `server.ts:440-446` → `getConnectionFollowers` `analytics.ts:258-276`                    | `followerSeriesView` `{ followers: MetricPoint[] }` — `analytics.ts:27-30`                                                  | **Newest first** (opposite of the post series — reverse before charting). Only rows whose metric is literally `followers` and `postId` is null (`analytics.ts:266-272`). 404 when the connection is not in this workspace. Empty array for a provider with no follower concept (GBP). |

`MetricPoint` (`contracts/src/analytics.ts:11-17`) is `{ metric: string; value: number; capturedAt: Date }`.
Over the wire `capturedAt` is an ISO string; the contract uses `z.coerce.date()`, but `api.ts`
does not run the Zod parsers, so **parse it yourself** (`new Date(p.capturedAt)`) before any date
math, as `Overview.tsx` and `Posts.tsx` do for `publishAt`.

**Where the numbers come from (so you can explain a gap).** The worker ticks hourly
(`apps/worker/src/analytics.ts:24`). A post is polled hourly for its first 48 h, then daily
(`analytics.ts:28`, `postIsDue` at 38–48); an account's followers daily (`accountIsDue`, 51–54).
Rows are appended, never updated (`appendMetrics`, 176–194); `capturedAt` is the provider's
timestamp when it gives one, else the sweep time (line 191). Storage is the key-value `metrics`
table, `packages/db/src/schema.ts:262-271`, RLS-forced like every tenant table (302–313).

**Metric names you will actually see today** (Meta only; GBP/LinkedIn/YouTube providers do not
exist yet, spec line 21):

| Provider  | Per-post names (requested one at a time; missing ones are simply absent)                                                                                                                                                                                                                                                                                | Account names                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| facebook  | `post_media_view`, `post_total_media_view_unique`, `post_reactions_like_total`, `post_clicks`, `post_video_views` — `POST_METRICS` in `packages/core/src/providers/meta/facebook.ts`. The first three are from Meta's documentation and unconfirmed against live traffic (#54, `docs/dev/research/meta.md` §5.2.1); any Meta rejects are simply absent. | `followers` — `facebook.ts:173`                                         |
| instagram | `views`, `reach`, `total_interactions`, `likes`, `comments`, `saved` — `instagram.ts:43-50`                                                                                                                                                                                                                                                             | `followers` — `instagram.ts:207`                                        |
| gmb       | Planned: `LOCAL_POST_VIEWS_SEARCH`, `LOCAL_POST_ACTIONS_CALL_TO_ACTION` (spec lines 251–253)                                                                                                                                                                                                                                                            | Planned: `BUSINESS_IMPRESSIONS_*` etc.; **no followers** (spec 261–262) |

Treat this table as "examples of what the union might contain", never as a list to code against.

**What is missing** (questions, not designs — §9): a bulk per-workspace metrics read; `lastAnalyticsAt`
on the views; a read path for account-level metrics other than `followers`; an MCP analytics tool
(`apps/api/src/mcp.ts` registers five tools at lines 21, 62, 71, 88, 126 — none for metrics; D1 adds
`post_metrics`/`connection_followers`, spec line 409 — not needed for this page).

---

## 3. Layout

Modelled on Zernio's "Posting analytics" screen, in the work-tool direction agreed 2026-10-10:
left sidebar nav (owned by the layout PR), full-width content, denser tables and cards, existing
colour tokens only (`apps/web/tailwind.config.js`, `apps/web/src/index.css:12-42`). Top to bottom:

1. **`PageHeader`** — title "Analytics", one-line subtitle naming the active workspace.
2. **Filter row** (one line, `Select` primitives, `apps/web/src/components/ui/Select.tsx:5-19`):
   - Platform: "All platforms" + one option per distinct `provider` in `GET /v1/connections`.
     Derive it from the data; do not enumerate `providerIdentifier`.
   - Connection / profile: "All" + each `ConnectionView.displayName`, narrowed by the platform pick.
   - Date range: **7 / 30 / 90 days**, default 30, ending now. Window = `[now − N days, now]`;
     prior window = the N days before that.
   - Filters live in the URL query (`?platform=&connection=&days=`) so a view can be linked and so
     the client-switch remount restores cleanly.
3. **Sync line**, muted, under the filters: "Data as of {max `capturedAt` across everything loaded}
   · posts refresh hourly for 48 h then daily · followers daily". The cadence text is static (from
   the code cited in §2) because the API does not expose last/next sync (§9 Q2). If nothing is loaded,
   say "No data collected yet".
4. **Stat tiles** (`StatTile`, one row, wrap on narrow widths). One tile per metric name in the
   **union of names across the loaded data for the current filter**, plus `followers` first when any
   selected connection has a follower series. Each tile: humanised label (replace `_` with a space,
   capitalise the first letter — a cosmetic transform, never a rename map), the value, and the change
   vs prior period as a signed percentage with `status-ok` / `status-bad` text and a muted `—` when
   there is no prior value. Definitions:
   - `followers`: newest point inside the window vs the newest point at or before the window start,
     summed across the selected connections. No point before the window start → delta `—`.
   - Any per-post metric: sum of `latest[name]` over posts whose `publishAt` is inside the window,
     vs the same sum over posts published in the prior window. State this on hover ("Posts published
     in the period, all-time totals") — `latest` is cumulative, so a 29-day-old post counts its
     lifetime views. This is how Zernio presents it too; it is an honest number as long as it is
     labelled.
   - A tile is only shown if at least one selected connection's platform produced that name. If the
     filter is "All platforms" and GBP (no followers) is one of them, the followers tile still shows,
     computed over the connections that have the series.
5. **Paired charts** (`Chart` primitive, two cards side by side, stacked below ~900 px):
   - **Per platform** (left): for the metric chosen in a small `Select` above the chart (options = the
     same union), a bar per platform (or per connection when a platform is selected) showing the
     window total. A platform that lacks the metric gets no bar and a `—` in the legend row.
   - **Over time** (right): followers per selected connection, one line per connection, x = date over
     the window. Reverse the series (it arrives newest-first) and bucket by day. When the chosen
     connection has no follower series (GBP), the card renders the `EmptyState` text "No follower
     metric for {platform}" — not a flat zero line.
6. **Per-post table** (`Table` primitive). Rows = published posts in the window matching the filters,
   newest first. Columns: Published (local date/time), Platform (icon from `icons.ts`), Profile
   (`displayName`), Post (caption truncated to ~80 chars, links to `releaseUrl` when present), then
   **one column per metric name in the union for the rows shown**, in alphabetical order. Cell
   value = `latest[name]`, formatted with `toLocaleString()`; **`—` when the post has no such
   metric**. Click a row to expand it: a compact sparkline per metric from `series` (oldest first) and
   the raw point count ("14 captures, last {capturedAt}"). Page size 50 to match the API default;
   "Load more" appends the next `offset`.

Loading the table needs one `/metrics` call per post. Fire them with `Promise.all` in chunks of 10,
render rows as they resolve, and cap the window at 300 posts with a visible "Showing the first 300"
note (§9 Q1 asks for a bulk read; until then this is the ceiling).

**Table layout rules**: dense (`py-2`), `hairline` row separators, numeric columns right-aligned,
no zebra striping (DESIGN-airbnb has none), sticky header on scroll.

---

## 4. Shared primitives (hard dependency)

Use only these, from `apps/web/src/components/ui/`: `Table`, `StatTile`, `Chart`, `EmptyState`,
`ErrorState`, `PageHeader`, plus the existing `Card` (`Card.tsx:4-25`), `Badge` (`Badge.tsx:7-21`),
`Select` (`Select.tsx:5-19`) and `Button` (`Button.tsx:8-27`).

The first six **do not exist on `main@cb16944`** — `apps/web/src/components/ui/` holds only Badge,
Button, Card, Input, Label, Modal, Select, Textarea. They are being added in a parallel primitives
PR, which also owns the chart-library choice (`apps/web/package.json` has no chart dependency today
— **do not add one**). Sequence:

- If that PR is merged: build on `main`.
- If it is open but unmerged: branch from it, and say so in your PR body.
- If it has not been opened when you start: stop and ask Prakhar (§9 Q4). Do **not** write
  page-local `<table>`/`<svg>` markup as a stopgap — page-local chart or table markup is explicitly
  disallowed and will be rejected in review.

Everything else about the page (hooks, helpers, filter state, formatting) lives under
`apps/web/src/pages/Analytics.tsx` and `apps/web/src/lib/analytics.ts` (pure helpers: window math,
metric-name union, deltas, series bucketing — unit-tested with Vitest, which the root
`vitest.config.ts` already runs).

---

## 5. States

| State              | Trigger                                                                                               | Render                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading            | First fetch of connections + posts; per-row metrics still resolving                                   | Skeleton tiles and a skeleton table (same geometry as the loaded view — no layout jump). Rows fill in as their `/metrics` call returns; unresolved cells show a muted dash placeholder, not `0`.                                  |
| Empty: no accounts | `GET /v1/connections` returns `[]`                                                                    | `EmptyState`: "Connect an account to start collecting analytics." Operators get a `Button` to `/connections`; clients (§6) get the text only.                                                                                     |
| Empty: no data yet | Connections exist, but no published posts in the window and no follower points                        | `EmptyState`: "Nothing collected yet. Metrics appear within an hour of the first published post." Tiles and charts hidden, filters stay usable (a wider range may have data).                                                     |
| Partial            | Some selected platforms lack a metric, or a connection has no follower series (GBP)                   | Normal view; `—` in every cell/tile/legend slot that has no value. Never substitute `0`, never drop the column. This is the invariant-7 case and must be visibly correct.                                                         |
| Error              | Any call throws `ApiError` (`api.ts:23-30`)                                                           | `ErrorState` in place of the section that failed (tiles, charts or table), with the message and a "Retry" `Button`. A single failed row `/metrics` call marks that row's cells `—` with a tooltip, and does not fail the table.   |
| Stale sync         | Any selected connection has `needsReconnect` / `health === 'needs_reconnect'` (`connections.ts:9,13`) | Warning `Badge` beside the sync line: "{displayName} needs reconnecting — its metrics stopped on {last capturedAt}". The sweeper skips such connections (`analytics.ts:121,151`), so this is the only reason data silently stops. |
| Unauthenticated    | 401                                                                                                   | Already handled by `<Protected />` (`App.tsx:13-18`); nothing to do.                                                                                                                                                              |

---

## 6. What a `client` user sees

Decision (spec lines 46–61): clients log in, scoped to exactly one workspace, with read access to
calendar, published content and analytics, and never connections, API keys, logs or other
workspaces. That role is **decided but not in the code yet** — `memberships.role` is
`owner | admin | member | viewer` (`packages/db/src/schema.ts:85`) and #20 (roles matrix) is open.

For this page:

- Read the role from the session: `me.user.memberships.find(m => m.workspaceId === me.activeWorkspaceId)?.role`
  (`packages/contracts/src/auth.ts:14-20,31-35`, loaded by `useAuth()` in `apps/web/src/lib/auth.tsx`).
  Put the test in one helper, `isClientRole(role)`, returning true for `'client'` (and `'viewer'`
  until #20 lands — §9 Q5), so the string lives in one place.
- Client view = the same page with operator affordances removed: no link or button to
  `/connections`, no connection ids or external ids anywhere (show `displayName` only), no
  "Preview" badge copy that mentions validation internals (say "Beta" instead). The filter row,
  tiles, charts and table are identical. The page has no mutations, so "read-only" needs no extra
  guarding.
- Workspace scope is not your problem to enforce: a client's session has one membership, the
  switcher lists memberships only (`ClientSwitcher.tsx:20-27`), and every read is RLS-scoped in the
  database (`schema.ts:295-313`). Say plainly in your PR that the UI gating is cosmetic until #20
  enforces the role at the API, because today a `viewer` who calls `/v1/connections` directly still
  gets an answer.

---

## 7. Numbers-validation checklist (gate for removing the route gate)

The page is not "done" when it renders; it is done when its numbers match the platform. Before PR 4
removes the gate, record the following in `docs/dev/ANALYTICS-VALIDATION.md` (new file, yours) and
Prakhar signs off by approving PR 4.

1. **Accounts:** at least two real connected accounts, on at least two platforms where possible
   (today that means one Facebook Page and one Instagram account from the live clients).
2. **Windows:** for each account, the 7-day and 30-day views.
3. **Per metric:** for every tile and every table column shown, the value in our UI next to the
   value in the platform's native insights (Meta Business Suite / Instagram Insights) for the same
   post or account and the same window. Only compare posts older than 48 h — Meta's numbers settle
   over 24–48 h (`docs/dev/research/meta.md:183`) and our hourly snapshots lag the sweep.
4. **Record for each comparison:** date and time of the check; the window as we computed it
   (start/end in UTC); the timezone the native tool reports in (Meta uses the Page's timezone; we
   store `capturedAt` in UTC and render in the browser's local zone — note any day-boundary drift);
   the `capturedAt` of the point we displayed.
5. **Known discrepancies, listed, not hidden:**
   - #54: Facebook now requests `post_media_view` / `post_total_media_view_unique` /
     `post_reactions_like_total` in place of the rejected `post_impressions_unique`. These names
     come from Meta's documentation and were not verified live; a Facebook post with no such
     columns after a sweep means Meta rejected them (`docs/dev/research/meta.md` §5.2.1).
   - `latest` is cumulative as of the last sweep; the native UI may show a later number if the sweep
     is behind. A gap that closes on the next hourly tick is fine; one that persists is a bug.
   - Followers are a daily snapshot; an intraday change in the native UI is not a discrepancy.
6. **Tolerance:** anything beyond the above must be explained or fixed before sign-off. "Close
   enough" is not a category.
7. **Partial case:** confirm on at least one platform/metric pair that lacks data that the UI shows
   `—` and not `0` (today: FB rows under the IG-only `saved` column, or vice versa).

---

## 8. Definition of done and PR slicing

**Done means:** `/analytics` renders all six §5 states correctly for a real workspace; every tile,
column and chart series is derived from returned metric names (grep your PR for any literal metric
name other than `followers` — there should be none outside tests); the §7 file exists with Prakhar's
sign-off; the gate is removed; the five repo gates are green on every PR (`pnpm format:check`,
`bash scripts/guardrails.sh`, `pnpm lint`, `pnpm build`, `pnpm test`). Each PR body lists what was
**not** verified. Green `main` auto-deploys, so every PR must be a whole working change on its own.

| PR  | Scope                                                                                                                                                                                | Depends on                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1   | `api.ts` methods; `lib/analytics.ts` helpers + unit tests; route + gate + nav entry (flag-hidden); `PageHeader`, filter row, sync line, stat tiles; loading/empty/error/stale states | primitives PR (`StatTile`, `EmptyState`, `ErrorState`, `PageHeader`) |
| 2   | Paired charts (per platform, over time) with the partial/empty handling                                                                                                              | PR 1, `Chart`                                                        |
| 3   | Per-post table, row expansion with sparklines, chunked loading, load-more, 300-post cap                                                                                              | PR 1, `Table`                                                        |
| 4   | Client view (`isClientRole`, stripped affordances); `ANALYTICS-VALIDATION.md` filled in; nav entry un-gated                                                                          | PR 1–3, §7 signed off                                                |

Keep each PR under ~400 lines of diff; if PR 1 grows past that, split the route+gate from the tiles.

---

## 9. Open questions for Prakhar (unknowns, not guesses)

1. **Bulk metrics read.** The table needs one `GET /v1/posts/:id/metrics` per row. For a 90-day
   window on an active client that is 100+ calls per page load. Is a `GET /v1/metrics?from&to`
   (or `latest` embedded in `PostView`) worth adding before PR 3, or is the 300-post cap acceptable
   for v1?
2. **Last / next sync.** `connections.last_analytics_at` and `posts.last_analytics_at` exist
   (`schema.ts:140,214`) but neither view exposes them. The brief falls back to "data as of max
   `capturedAt`". Should `ConnectionView`/`PostView` gain `lastAnalyticsAt` so the line can be exact?
3. **Account metrics other than followers.** `getConnectionFollowers` filters `metric = 'followers'`
   (`analytics.ts:268`). When GBP ships, its `BUSINESS_IMPRESSIONS_*` account rows will be written
   but unreadable through any endpoint. Not needed for Meta validation; needed before GBP validation.
4. **Primitives PR.** Not open on `prak-gup/meegrow-social` as of 2026-10-10 (open PRs: #74, #72,
   #71, #60). Who owns it, when does it land, and which chart library does it pick? Anshul blocks on
   it from PR 1.
5. **Role string.** Will the client role be literally `'client'` in `memberships.role`, and should
   `viewer` be treated as a client until #20 ships?
6. **Flag mechanism.** `VITE_ANALYTICS_UI` as a build-time env var is the proposal (first flag in the
   web app). Acceptable, or do you want a runtime toggle?
7. **Prior-period semantics.** Per-post tiles use "posts published in the window, lifetime totals".
   Confirm that is the number you want to compare against Zernio, or specify otherwise.
8. **#54 timing.** Fix the rejected FB metric before validation (so FB rows gain reach/impressions)
   or validate with it recorded as a known gap?
9. **Issue #28 says "light + dark".** The token layer is deliberately light-only
   (`apps/web/src/index.css:7-8`). Drop the dark acceptance criterion?
