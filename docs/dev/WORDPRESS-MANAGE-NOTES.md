# WordPress management — implementation notes

2026-10-12. **This run implements Step 1 only. Steps 2 and 3 are not built.**
Changes are uncommitted. No WordPress site, database or Redis was contacted. No browser was opened.

## Step 1 — see articles

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
routes, MCP write tools, or article edit/detail panel. Optimistic concurrency, write read-back,
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

## Gates

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
