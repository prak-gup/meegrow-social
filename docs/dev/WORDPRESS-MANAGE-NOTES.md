# WordPress management — implementation notes

2026-10-12. **Step 1 was already merged; this run adds Step 1b only. Steps 2 and 3 are not built.**
Changes are uncommitted. No WordPress site, database or Redis was contacted. No browser was opened.

## Step 1b — dedicated Blog page (this run)

- Added `/blog` and `/blog/:postId` under the existing authenticated layout. The Blog sidebar
  entry uses the existing Phosphor Article icon and appears when a client is active. Content stays
  the cross-platform overview; its existing WordPress metadata component now links app-published
  and imported article cards/table entries to their Blog detail as well as the site permalink.
- The dense table shows full title, separate site status, site, author, categories, tags,
  publication/modification dates, source and a safe external article link. Site status is Published,
  Draft on site, Pending, Scheduled, Private or Removed, independently of our lifecycle status.
  Removal takes precedence. Unsent Composer drafts/schedules stay in Content.
- Uses existing scoped `GET /v1/posts?provider=wordpress&status=published&limit=50&offset=…` and
  `GET /v1/connections`. Reads stored pages serially to the end before filtering/sorting, so a title
  or category on later pages is searchable. Deduplicates repeated IDs if offsets shift. A failed
  page shows a retryable error rather than silently presenting a partial inventory. Navigation or
  a client switch discards old results and stops requesting further pages. No outbound site call
  is added. The existing `withWorkspace` core read service continues to own scoping.
- Title search ignores case and surrounding whitespace. Site-status/category filters combine
  with a site selector when multiple sites are connected. Publication/modification date and title
  sorts work in both directions, with sortable table headers and a sort selector. Missing dates
  sort last; ID breaks ties. Show more reveals 50 additional matching rows at a time.
- Empty states distinguish no connected WordPress site (Connections link), import in progress
  and no stored articles. Shows existing import messages, including the 500-article cap and failed
  or paused runs. Refresh re-reads stored import results; it does not request a live site scan.
- Detail reads `GET /v1/posts/:postId` and shows all stored article settings, stored featured image,
  source, removal state, body preview and the truncation warning. Older app-published articles have
  no site-owned metadata in Step 1: these show the original publishing settings, known term names
  or explicitly labelled term IDs, and `—` for unknown authors/dates. The UI explains this; it does
  not invent a site publication date from our dispatch time or claim those settings are current.
- Chose the permitted **escaped source with a simple formatted text preview** option. HTML is
  never inserted with `innerHTML` or `dangerouslySetInnerHTML`. `articlePreviewText` extracts text,
  paragraph breaks and list markers, removes non-visible blocks, then decodes a small entity set.
  Both the result and original source are React text children. This helper is expressly **not an
  HTML sanitizer** and must never be used as one. Malformed tags or encoded payloads remain text.
  App-authored Markdown is displayed as escaped source/text; it is not reclassified as imported
  HTML. Site styles, links and embedded media are omitted; the live-site link provides that view.
- Reuses the app's layout, typography, controls and table frame. Controls wrap, table overflow is
  contained horizontally, long detail content wraps, and the detail columns stack below `xl`.
  Title links provide keyboard navigation alongside clickable rows. Switching client from an
  article detail returns to `/blog`, not an ID owned by the previous client. The layout remounts
  scoped pages using the active workspace key. These are implementation facts, not browser proof
  at 1512 / 1024 / 390 px.
- Added 24 Blog library/preview tests, 3 rendered Content-link tests and 1 sidebar switching test.
  Fixtures parse through the real `postView` contract, which caught an initial incorrect assumption
  that `externalPostId` is exposed on that view. Tests cover statuses, missing dates, original
  app settings, combined filters, both sorts, later-page reads, deduplication, excluded-row offsets,
  read failures, stale client results, large bodies and malicious/malformed HTML. Server-rendered
  markup proves escaping and internal/external link destinations; it does not exercise effects or
  browser interaction. No provider/service change or integration test was necessary for this UI step.

**Migration:** none; no SQL or schema change. **API/MCP:** no new query parameter, route or tool.
`docs/dev/MCP.md` is unchanged. No dependency was added. No credentials are requested, logged or
returned by the new UI. Existing imported-source publish/edit/cancel/retry guards and safeFetch
transports remain in place. The existing stored-body cap is unchanged at 100,000 characters; the
detail warns when truncated and has no body-write path.

This run stops at the tested Step 1b boundary under the request's room-limit fallback. Step 2
remote update/trash, concurrency, read-back, field event logs, API/MCP write tools and confirmation
dialog remain unbuilt. Step 3 SEO reads/writes, research §12 and Royal MCP transport specification
remain unbuilt. Nothing here implies those steps are supported.

## Step 1b gates (this run)

Dependencies were already installed; `pnpm install --frozen-lockfile` was not needed. Changed files
were formatted using `pnpm exec prettier --write`. The following gates ran from the repository
root after the final code/test changes:

| Command                      | Observed result                                       |
| ---------------------------- | ----------------------------------------------------- |
| `pnpm format:check`          | Exit 0; “All matched files use Prettier code style!”  |
| `bash scripts/guardrails.sh` | Exit 0; “✅ guardrails passed”                        |
| `pnpm lint`                  | Exit 0; no ESLint errors or warnings                  |
| `pnpm build`                 | Exit 0; 7 successful tasks, 7 total; 6 cached; 5.37 s |
| `pnpm test`                  | Exit 0; 91 files passed; 2,590 tests passed; 19.35 s  |
| `git diff --check`           | Exit 0; no whitespace errors                          |

The final build emitted one `WARNING IO error: Operation not permitted (os error 1)` from Turbo
and Vite's warning about chunks larger than 500 kB. The test runner emitted Vite's CJS Node API
deprecation warning. There were no `listen EPERM 127.0.0.1` test failures and no exception to the
passing test gate was needed. Intermediate checks caught a missing JSX brace, a fixture relying
on the unexposed `externalPostId`, and an overbroad assertion matching attribute-like text in an
escaped source block; these were corrected. Link tests now use StaticRouter for server rendering
instead of MemoryRouter, eliminating its server-side layout-effect warning. Notes were then updated
with these observations and formatted; the repository formatting check was repeated afterwards.

### Step 1b evidence limits

- No browser was opened. Responsive behavior at 1512 / 1024 / 390 px, focus/navigation, client
  switching, import progress, Show more and the authenticated Content → Blog detail user journey
  have not been exercised in a browser. Static markup tests cover escaping and link destinations.
- No database or Redis was contacted, and no integration tests were run. Actual scoped API reads,
  RLS and worker behavior were not re-proven live. Existing core reads and their guards are reused.
- No WordPress network calls were made. The table is a view of stored observations, not a live
  site inventory. Existing import caps/pacing/truncation apply. Refresh only re-reads our API.
- Older app-published articles lack site-owned metadata; original settings and Markdown body are
  shown with an explanation. Original category IDs are labelled as IDs. Site edits to these rows
  are not made current by this UI change, and missing dates/author are not fabricated.
- Offset reads do not establish a snapshot while imports change records. Deduplication handles
  repeats; concurrent inserts can still shift pages. Reload revisits the inventory. The UI reads
  the entire stored WordPress inventory (bodies included) for global filtering/sorting; latency and
  memory use on very large stored inventories have not been benchmarked. Show more bounds rendered
  rows, not the amount fetched. Provider import runs retain their existing 500-article cap.
- Remote editing/trash and SEO have no implementation or test evidence in this run. Steps 2 and 3
  remain required work, including the research §12 and plugin-key transport specification.
- No migration, dependencies, commits, pushes or client-system mutations were performed. No `.env`
  file was opened. `pnpm test:integration` and direct vitest invocation were never used.

## Step 1 — see articles (already merged)

- `WordPressProvider` now implements `listPublishedPosts` and `publishedPostPresence` on both
  existing transports. Registration makes the existing connection/worker import pipeline pick up
  WordPress automatically, including existing connections that have no import state yet.
- REST reads `/wp/v2/posts` with `context=edit`, all five requested statuses, `_embed`, and
  pagination from `X-WP-TotalPages`. Missing embeddings are followed up through the authenticated
  REST root for terms, author and featured attachment. REST inventory responses are bounded at
  8 MiB; other REST responses retain their existing 2 MiB limit.
- XML-RPC reads `wp.getPosts` with `number` and `offset`, all five statuses, descending by date;
  a full page requests the next offset, a short page ends the list. Terms and featured attachment
  come from the returned article. Author names use `wp.getUser`, cached per page. If that optional
  profile read is unavailable (an Editor can lack permissions to read another user's profile),
  the article remains visible and its author is an empty string, not an invented name.
- Normalised articles preserve HTML body, title, excerpt, slug, site status, permalink, GMT
  publication/modification dates, category/tag names, author name when available, and featured
  image URL for copying. Titles use the existing `options.title`; full site facts are retained in
  `options.remote`, including the full headline. The display uses that full headline.
- WordPress opts into whole-history imports: old articles, old drafts and future site schedules
  survive the social import date window. Each run stops at 500 articles and reports the cap;
  pages contain at most 25 articles with the existing one-second page delay. Periodic imports scan
  the inventory again rather than limiting old articles' edits to the last month. A paused run
  retains its numeric page/offset in the existing import-state JSON. Social expiring cursors remain
  unchanged. Recently published articles retain the existing settling delay to avoid importing
  an article in the gap before our publishing worker records its remote id.
- Imports match platform ids/permalinks, preserve `source = imported`, refresh imported body and
  options on later reads, and do not duplicate app-published articles. Confirmed absence/trash
  marks removal; auth, permissions, malformed answers and transport failures mean `unknown`.
  Whole-blog removal checks include old articles; capped or resumed reads do not mark removals.
- WordPress featured-image copying uses `safeFetch`, with a 15-second timeout, a 5 MiB limit and
  independently guarded redirect hops. Images are copied into our storage using the existing media
  rows. A refused/missing/oversized image does not hide its article. Existing imported images are
  not recopied on every sync; replacing a featured image on an already-imported article has not
  gained a thumbnail refresh path in this step.
- Content cards/table and Calendar use the article title and show Published, Draft on site,
  Pending on site, Scheduled on site, or Private. Removed-on-platform takes precedence. Content
  and the roomy Calendar entry show category/tag names; the compact calendar cell shows the site
  status alongside its title. Content has a direct safe article link; Calendar's existing action
  menu provides the article link. Existing platform badges and WordPress/account filters are reused.
  Import UI describes the whole-blog scan and does not promise WordPress analytics.

## Storage and migration

**No migration, no new table, no SQL.** The existing `posts_imported_is_published` check remains:

```sql
CHECK (posts.source <> 'imported' OR posts.status = 'published')
```

An imported site draft is represented by `posts.status = published`, `posts.source = imported`,
`options.remote.status = draft`. Here our lifecycle status means imported/observed, not publicly
published on the site. Site status is displayed separately. Future site articles retain `future`
in remote metadata; the existing publishing-options status remains `draft` since our composer does
not offer site scheduling. Publication date is nullable in remote metadata for undated REST drafts;
Calendar uses modification time for such drafts, without inventing a site publication date.

The existing API lifecycle status filter still filters our row status. Thus site drafts are under
our Published/imported inventory, distinguished by their site chips; a separate site-status filter
has not been added.

Bodies are stored as HTML in `caption`, limited to 100,000 characters. `options.remote.bodyFormat`
is `html`; `bodyTruncated` records truncation and the web displays an explanation. Imported HTML
cannot be published through `WordPressProvider.assertPublishable`, including copies carrying these
options; its Duplicate action is hidden. Existing imported-source scheduler/update/cancel/retry
safety guards remain. There is no remote body editing path yet, so truncated HTML cannot be written
back. Step 2 must enforce that restriction in its independent core update service as well.

## Step 2 — not built

No `updatePublishedPost` / `deletePublishedPost`, `updateRemotePost` / `trashRemotePost`, REST write
routes, MCP write tools, or article editing panel. Step 1b adds a read-only detail page. Optimistic concurrency, write read-back,
actor/field event logs, site trash confirmation and edit-field validation remain outstanding.
Nothing in this run writes to a WordPress site or moves an article to its trash.

## Step 3 — not built

No SEO reading/writing, no read-back verification of SEO values, and no Royal MCP transport.
The requested research §12 (plugin REST keys, writability, XML-RPC limitations and Royal MCP
connection design) also remains outstanding. Existing research §11.8–11.9 is unchanged.

## REST and MCP

No routes or tools were added or renamed. Existing post/calendar/group read responses now retain
optional WordPress `options.remote` metadata through contracts parsing. Existing import endpoints,
MCP read tools and worker entry points continue to call core. `docs/dev/MCP.md` is unchanged because
`update_remote_post` and `trash_remote_post` are not implemented.

## Safety and tests

Both providers' existing clients use `safeFetch` for every site API request; credentials stay inside
those clients and the existing encrypted-token path. Featured-image downloads also use `safeFetch`.
No credential is returned in normalised article metadata. Imports use the existing `withWorkspace`
transactions, unique platform-id matching and source/status guards. HTML is displayed as text/title
metadata rather than injected into the page. Only confirmed not-found/trash can mark removal.

New documentation-built fixtures cover REST and XML-RPC lists/paging, metadata, all statuses,
missing embeddings, presence/trash/not-found/unknown, undated drafts, HTML truncation and rejection
of Markdown-path republishing. Service unit tests cover whole-history bounds, idempotent metadata
patching, 500-article caps, pacing, settling and numeric cursor resumption, plus guarded thumbnail
copying/refusal. Web library tests cover titles/status chips in Content/Calendar, imported edit
restrictions and WordPress/account query filters. Update/trash/conflict/SEO fixtures are not written
because their steps are not built. No integration tests were run.

## Previous Step 1 gates (historical; not this run)

Dependencies were already installed; `pnpm install --frozen-lockfile` was not needed.
Changed files were formatted with `pnpm exec prettier --write`.
Final code gates, run from the repository root after the last implementation change:

| Command                      | Observed result                                           |
| ---------------------------- | --------------------------------------------------------- |
| `pnpm format:check`          | Exit 0; “All matched files use Prettier code style!”      |
| `bash scripts/guardrails.sh` | Exit 0; “✅ guardrails passed”                            |
| `pnpm lint`                  | Exit 0; ESLint emitted no errors or warnings              |
| `pnpm build`                 | Exit 0; 7 successful tasks, 7 total; 1 cached; 6.901 s    |
| `pnpm test`                  | Exit 0; 89 test files passed; 2,562 tests passed; 21.34 s |
| `git diff --check`           | Exit 0; no whitespace errors                              |

The build emitted five `WARNING IO error: Operation not permitted (os error 1)` messages from Turbo,
plus Vite's warning about chunks larger than 500 kB. All seven builds succeeded. The test runner
emitted Vite's CJS Node API deprecation warning. No tests failed, and no `listen EPERM 127.0.0.1`
exception was needed. Earlier checks caught a wrong UI helper import, a test using the wrong helper
name, and a settling-guard regression; those were corrected before the final gates above.
The notes file was subsequently formatted and included in a fresh repository formatting check.

## What the evidence does not establish

- No real-site test: hosting/CDN response headers, XML-RPC filter behavior, role permissions,
  plugin/security restrictions, real attachment/profile shapes and timezone quirks remain unverified.
- No database/Redis test: actual import inserts, RLS isolation and worker scheduling were not exercised
  against those systems. Existing code paths and unit tests supply evidence, not live DB proof.
- No browser: responsive rendering, keyboard interaction, live Content/Calendar filters/links and
  the full connect → worker import → Content/Calendar journey were not exercised visually.
- Pagination is not a site snapshot: concurrent site edits during page/offset reads may move items;
  a later complete sync revisits the inventory. Sites with more than 500 articles remain explicitly
  partial. Responses larger than the bounded API budget fail instead of being silently accepted.
- SEO, remote editing, trashing, conflicts and write verification have no implementation evidence.
