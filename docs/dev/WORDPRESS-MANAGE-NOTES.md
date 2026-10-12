# WordPress management — implementation notes

2026-10-12. Step 1 and Step 1b were already merged. This run implements Step 2.
Step 3 is deferred, including SEO research §12, SEO reads/writes and the Royal MCP specification.
Changes remain uncommitted. No WordPress site, database or Redis was contacted. No browser was opened.

## Step 1 and Step 1b — existing functionality retained

The existing REST/XML-RPC inventory importer and `/blog` / `/blog/:postId` views remain the basis
of management. Inventory keeps HTML, site status, names, source, dates and truncation facts in the
existing options JSON. This run adds optional numeric category/tag/featured attachment IDs to those
observations, so remote edits can address existing site objects without creating terms or uploads.
Older observations lack those optional IDs; use **Refresh from site** before editing their terms.

The existing import ceiling remains 500 articles per run, with capped reporting, 25-item pages,
one-second page pacing and resumable numeric cursors. Inventory bounds, deduplication, imported
source, removal checks and thumbnail storage remain intact. The existing Content and Composer
lifecycle routes are not repurposed for remote writes. HTML previews remain escaped text.

## Step 2 — edit and trash on site

- Added optional provider methods `readPublishedPost`, `updatePublishedPost`,
  `deletePublishedPost`. WordPress implements single-article observations and verified updates on
  both existing credential transports. All outbound traffic uses the existing guarded clients;
  thumbnails use `copyWordPressThumbnail`, which uses safeFetch and bounded guarded redirects.
- REST updates use `POST /wp/v2/posts/{id}`. Trash uses `DELETE /wp/v2/posts/{id}?force=false`,
  followed by an independent authenticated GET that must return the same ID and `status=trash`.
  No force-delete path exists. A site with trash disabled must refuse the REST operation.
- XML-RPC updates use `wp.editPost`, followed by independent `wp.getPost`. **Deliberate safety
  deviation:** trash uses `wp.editPost` with `post_status=trash`, followed by `wp.getPost` that must
  confirm the same ID and trash status. It does **not** call the requested `wp.deletePost`: that
  method delegates to `wp_delete_post`, which can permanently delete when `EMPTY_TRASH_DAYS=0`.
  XML-RPC does not expose this setting reliably. A status transition avoids that irreversible
  fallback. Real-site restore behavior and cleanup metadata for this status transition are unverified.
- Core owns `refreshRemotePost`, `updateRemotePost`, `trashRemotePost`. Every database operation
  is inside `withWorkspace`; post rows are locked during the operation, so this app's edits and
  importer updates serialize. Providers without the required methods are refused. Unsent drafts,
  schedules, publishing/failed/cancelled rows, missing platform IDs and removed articles are refused.
  Disconnected or reconnect-required sites are refused before any outbound operation.
- The caller supplies the ISO `expectedModifiedAt` last observed. Core compares it with the stored
  observation, and the adapter independently reads the site before writing and compares the live
  GMT modification time. A changed site returns a clear “changed on the site — refresh” conflict;
  REST returns 409 and MCP returns `invalid_state`. Missing legacy observations require refresh.
- Editable fields: title, body, excerpt, slug, draft/publish/pending/private status, categories,
  tags and featured image. Categories/tags are arrays of existing numeric site term IDs. Featured
  image is an existing site attachment ID; 0 removes it. Empty term arrays remove assignments.
  Omitted fields stay omitted, including a site's existing future/scheduled status. No new term
  creation or media upload is added by remote editing.
- App-authored Markdown uses the existing `articleMarkdownToHtml` converter. Observed HTML is
  edited as HTML in a clearly labelled plain textarea, and is passed as HTML without Markdown
  conversion or a new sanitizer. WordPress's own role-dependent HTML filtering still applies.
  HTML is never injected into the dashboard. Refresh converts the stored observation of an older
  app-published row into site HTML; future edits then follow the HTML path.
- The 100,000-character stored-body cap remains. Core and adapter both refuse body edits when
  the stored/live observation is truncated. The UI disables that textarea and explains the loss
  risk. Other fields remain editable. The provider never treats a truncated read-back as a
  successfully verified full-body write.
- After writing, an independent read-back verifies every requested field, including term IDs and
  attachment ID. A mismatch is an error and carries the observed article internally; core stores
  those observed values before returning the error. A failed read-back does not claim success and
  tells callers the change may have been applied and to refresh before retrying. No automatic
  write retry or background publish job is created by these operations.
- Verified reads update the existing row's caption, options and permalink. Its imported/app source
  and published lifecycle remain unchanged. Confirmed trash sets `platformRemovedAt`; the stored
  copy remains accessible. A changed featured attachment is copied through the existing guarded
  storage helper into a scoped media row; unavailable/refused images clear the stale thumbnail
  rather than showing the old attachment as current. No remote CDN image URL is returned as the
  stored thumbnail. Storage copy failures do not hide the article.
- Each attempted remote update/trash that reaches the provider gets an event-log record with
  authenticated user ID or API key ID, local post ID, changed field names and confirmed/unconfirmed
  result. Field values, bodies and credentials are excluded. Unconfirmed events commit even when
  the service then throws. Validation/capability failures before an outbound attempt do not add an
  event. REST error text from WordPress also redacts the stored password and Basic authorization.
- Blog detail now contains the editor, Save on site, Refresh from site and Move to trash on site.
  Refresh explicitly discards unsaved edits. Save sends only changed fields and the version seen.
  Trash opens a confirmation dialog stating that the article goes to WordPress trash and can be
  restored there. The final request requires `confirm: true` in contracts and core; no bulk endpoint
  exists. Editing is disabled until a version is available and after removal. Pending editor
  responses cannot update the parent after navigating away/unmounting.

## API and MCP

Thin REST adapters, authenticated using the existing API/session context:

| Route                               | Request                                 |
| ----------------------------------- | --------------------------------------- |
| `POST /v1/posts/:id/remote/refresh` | `{}`                                    |
| `POST /v1/posts/:id/remote/update`  | `{ expectedModifiedAt, fields }`        |
| `POST /v1/posts/:id/remote/trash`   | `{ expectedModifiedAt, confirm: true }` |

All successful REST responses are `{ post: PostView }`. Missing scoped rows return 404; invalid
inputs/capability failures 400; lifecycle/site-version conflicts 409; site credential failures 401;
transient site failures 503. Site failure does not mean the caller's application session expired.
MCP adds `refresh_remote_post`, `update_remote_post`, `trash_remote_post` with the same inputs plus
`postId`, returning PostView. Tools carry open-world write annotations; update/trash are destructive.
Trash's description requires explicit human confirmation. No tool accepts a workspace or credentials.
See `docs/dev/MCP.md`. Existing `update_post`, cancellation, retry and publish guards remain intact.

## Storage and migration

**No migration, no SQL to execute, no new table or dependency.** New term/media IDs are optional
properties of existing `posts.options.remote` JSON. Existing rows parse without them.
The imported-row constraint remains unchanged:

```sql
CHECK (posts.source <> 'imported' OR posts.status = 'published')
```

A site draft/private/pending article still has our published/observed lifecycle; its site state is
separate. Imported articles cannot be scheduled, retried or published through Composer. Copies that
carry remote HTML are still refused by the provider's Markdown publish guard.

## Tests and gate results

Documentation-built fixtures cover both transports' single reads, updates, requested field mapping,
HTML preservation, Markdown conversion, conflict refusal before mutations, independent read-back,
mismatches, failed read-back, bounded/truncated bodies, trash confirmation and invalid IDs. Existing
inventory tests continue to cover list/paging/presence on both transports. In-memory scoped service
tests cover app/imported rows, missing scoped posts, unsupported providers, unavailable observations,
truncated bodies, mismatches, unconfirmed attempts, actor/field audit and confirmed removal. REST
and MCP delegation tests prove context/input forwarding and confirmation/conflict mapping. Web
library and static-render tests cover minimal patches, IDs, truncation, removed-state controls,
HTML labels and escaping. These tests use no database, Redis or real site.

Dependencies were already installed; `pnpm install --frozen-lockfile` was not needed. Changed files
were formatted with `pnpm exec prettier --write`. Final gate results below were observed after the
last implementation/test change. The notes were then updated and formatted; formatting and
whitespace checks were repeated after that documentation-only update.

| Command                      | Observed result                                         |
| ---------------------------- | ------------------------------------------------------- |
| `pnpm format:check`          | Exit 0; all matched files use Prettier code style       |
| `bash scripts/guardrails.sh` | Exit 0; “✅ guardrails passed”                          |
| `pnpm lint`                  | Exit 0; no ESLint errors or warnings                    |
| `pnpm build`                 | Exit 0; 7 successful tasks / 7 total; 1 cached; 7.199 s |
| `pnpm test`                  | Exit 0; 97 files passed / 2,691 tests passed; 23.21 s   |
| `git diff --check`           | Exit 0; no whitespace errors                            |

Intermediate gates caught an incorrectly sorted expected MCP tool list and a test expecting a
Promise rejection from a synchronously parsed invalid confirmation. The tool inventory expectation
was sorted correctly; the service exports now consistently return Promises. An initial formatting
command included two nonexistent `.tsx` patterns for `.ts` library files; the real files were
formatted and the command corrected. The latest intermediate test run passed 97 files / 2,686 tests;
subsequent field/read-back tests and safety refinements are covered by the final gate results above.

The final build emitted five Turbo `WARNING IO error: Operation not permitted (os error 1)`
messages and Vite's warning about chunks larger than 500 kB. The test runner emitted Vite's CJS
Node API deprecation warning. No tests failed, and no `listen EPERM 127.0.0.1` exception was needed.

## What the evidence does not establish

- No WordPress site was contacted. Actual hosting/CDN behavior, role permissions, custom filters,
  raw-vs-rendered text, status transitions, taxonomy replacement, attachment removal, HTML filtering,
  XML-RPC trash restoration and REST trash refusal on disabled-trash installs are unverified.
- No browser was opened. Authenticated Blog → detail → refresh → edit → save → confirm trash,
  focus handling and responsive behavior have not been exercised interactively. Static rendering
  verifies escaping, labels and disabled controls, not user interaction or effects.
- No database or Redis was contacted; integration tests were not run. In-memory transaction tests
  prove service branching and workspace-helper use, not real RLS, locks, persistence or worker behavior.
- WordPress supplies no atomic conditional-write primitive on these transports. The comparison is
  a preflight optimistic check, not a compare-and-swap. An external site edit between preflight and
  write, or two edits within WordPress's modification-time precision, can escape detection. Our row
  lock serializes this application's operations only. A site-side conditional-write plugin would
  be needed for an atomic guarantee. Meta-only edits may not update WordPress modification time.
- Remote writes and local persistence cannot be one atomic transaction. A site may accept a write
  before its read-back, storage copy, database update or event-log commit fails. Errors do not claim
  confirmation; operators must refresh/check WordPress. Pending requests continue on the server
  after navigation; the UI ignores responses from unmounted editors.
- Remote reads hold a scoped row lock/transaction across bounded site requests and thumbnail copy.
  This serializes local writers but may delay imports; transaction duration, large-site latency and
  storage-object cleanup after transaction failures have not been benchmarked.
- Read-back is strict: legitimate WordPress/plugin normalization of title, excerpt, slug or HTML
  can return a mismatch even though the site accepted some change. Observed mismatches are stored
  and errors identify the field; they never invite an automatic retry.
- Existing pagination is not a site snapshot. Capped imports remain explicitly partial; older
  observations lack numeric IDs until a new observation. Stored featured image copying is bounded
  and best effort. No new image upload or term-name editor was built.
- Step 3 is not built: no SEO read/write or plugin detection; research §12 and a detailed Royal MCP
  transport specification remain outstanding. No SEO success is implied by Step 2.
- No `.env` file was read; no dependency, commit, push or client-system mutation was performed.
  Neither `pnpm test:integration` nor a direct vitest invocation was used.

## Document reading and editing — 2026-10-12

This pass replaces the HTML textarea as the default article experience. Blog detail opens as a
70ch document with title, featured image, status chip, author, dates, categories, tags and live
article link. Shared document typography renders headings, paragraphs, lists, quotes, links,
images, tables and code. WordPress Content cards/table previews use the same renderer in compact
mode. The existing Composer Article mode and its Markdown contract are unchanged.

`sanitiseArticle` uses parse5's HTML5 parser and emits a strict tag/attribute allowlist. Scripts,
styles, SVG/MathML, forms and objects are dropped; embeds become neutral labelled cards. Event
attributes, site classes/inline styles and unsafe URLs never enter the rendered document. Only
absolute HTTP(S) image/link URLs are accepted (including no data URLs). Links open with
`target="_blank" rel="noopener noreferrer"`; images are lazy loaded, constrained and omit the
referrer. Gutenberg comments are hidden in the document, and shortcodes/unsupported Gutenberg
blocks are labelled placeholders. Original source remains escaped and read-only under an advanced
control. No original protected HTML is injected into the editor DOM.

**Edit** mounts a lazy TipTap editor. Its labelled, keyboard reachable controls include paragraph /
H2 / H3 / H4, bold, italic, underline, strike, add/edit/remove link, both list types, quote, inline
code/code block, rule, image URL, basic table insertion/row/column addition/table deletion and
undo/redo. StarterKit supplies Markdown typing shortcuts. The toolbar has its own horizontal
scroll container and 44px controls. No reusable WordPress media picker was found; images use a URL
field. Actual 390px rendering, focus movement and typing have not been verified in a browser.

### Round-trip rules

- Pure `analyseEditability(html)` classifies safe content, content with protected blocks, or
  source-only content. Unknown markup, shortcodes, Gutenberg galleries/embeds/columns/buttons/
  custom HTML, meaningful attributes/classes/styles, relative URLs and iframes are protected.
  Unknown Gutenberg attributes also protect their containing block. Malformed/unbalanced block
  structures, parser-repaired overlapping regions, bodies over 100,000 characters and more than
  400 regions use the source-only path. A source-only article never mounts the rich editor.
- Each locked atomic editor node stores its original HTML, including surrounding Gutenberg
  comments. The original-region registry is authoritative at serialization. Missing, reordered
  or modified regions block saving and instruct the operator to undo. Protected HTML is copied
  byte-for-byte. Empty editable regions allow text to be added around runs of locked blocks.
- The editor's initial parsed JSON is its comparison baseline. Unedited regions always serialize
  to their original bytes, even if TipTap would normalize the HTML. Merely opening the editor
  therefore does not create a body change; the existing minimal-patch function omits it entirely.
  Returning a region to its baseline also restores its original HTML. Text-only changes preserve
  original markup, whitespace and entity spellings when source text maps exactly to editor text;
  structural/formatting changes serialize only the changed editable region.
- **Deliberate Classic fallback:** unchanged Gutenberg regions retain their original comments;
  edited simple regions use Classic HTML without their Gutenberg comments. This avoids emitting
  block metadata that might disagree with edited markup. Before a rich body save the UI says,
  “Saved content will open in WordPress as a Classic block”, and explains that unchanged blocks
  retain comments while edited regions use Classic HTML. Mixed articles retain their locked and
  untouched Gutenberg blocks alongside edited Classic regions. Full Gutenberg regeneration is
  not implemented or claimed.
- Advanced source is read-only by default, then explicitly enabled with **Edit HTML source
  (advanced)**. That mode warns that block preservation is not guaranteed. It is intentionally
  an expert escape hatch rather than a rich-editor preservation guarantee.
- Save first displays **What will change**: changed field names, body yes/no, and protected-block
  count (or the source-mode limitation). Confirmation submits the exact reviewed patch. No-change
  confirmation makes no update request. Site-version checks and independent read-back remain in
  the existing service. Nothing in this pass makes a remote request while reading locally stored
  content in tests.
- Truncated stored bodies remain disabled in both editing modes and are always removed from the
  outgoing patch. Other metadata can still be edited. Refresh resets edits and editor state.
- Composer reuse would require a separate Markdown input/output adapter, document-to-Markdown
  serialization and contract compatibility tests, plus a configuration without remote-region
  locks. That is deliberately deferred; changing new-article storage to HTML is not part of this
  pass.

### Dependencies and measured bundle effect

Added to `@meegrow-social/web` using registry `latest`: `@tiptap/react`, `@tiptap/starter-kit`,
`@tiptap/extension-link`, `@tiptap/extension-image`, `@tiptap/extension-underline`,
`@tiptap/extension-table`, `@tiptap/extension-placeholder`, all resolved to **3.31.4**.
Also added **parse5 8.0.1** for browser-independent sanitization/source locations and
**happy-dom 21.0.1** as a dev dependency for offline editor-state tests. Package manifest and
lockfile changes remain uncommitted, as explicitly requested by the hard rule.

A Vite build of the original HEAD web source in an ignored, local scratch directory, using the
same installed dependencies, measured the baseline. Final root build output:

| Asset                | Original HEAD                | Final                        | Effect                                                                                |
| -------------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| Main JS              | 1,115.50 kB / 321.28 kB gzip | 1,279.69 kB / 368.98 kB gzip | +164.19 kB / +47.70 kB gzip, including the shared HTML parser and reading/analysis UI |
| RichArticleEditor JS | absent                       | 463.97 kB / 146.64 kB gzip   | Separate lazy chunk; mounted/requested on Edit, not during default reading            |
| CSS                  | 41.76 kB / 8.71 kB gzip      | 44.34 kB / 9.06 kB gzip      | +2.58 kB / +0.35 kB gzip for document/editor styling                                  |

The editor implementation is excluded from the initial JS chunk; the always-available reading
renderer/analysis does increase that chunk. Vite's existing larger-than-500-kB warning remains.
These are emitted asset sizes, not a browser loading/performance measurement.

### Observed gates and evidence limits

The final implementation gates below ran from the repository root. `pnpm install` succeeded;
registry access was not blocked. Initially the inherited node_modules store location disagreed
with the sandbox store location; reinstalling resolved that before product dependencies were
added. Husky's prepare command reported that it could not lock the parent repository's git config
(`Operation not permitted`), then completed with exit 0. pnpm also warned about the ignored
`msgpackr-extract@3.0.4` build script. The generated installation cache was moved under ignored
node_modules so it is excluded from source formatting and the working diff. An intermediate
format check had inspected that generated cache and failed; the final source check below passed.

| Command                                       | Observed final result                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                | Exit 0; lockfile up to date; 981ms; prepare/ignored-script warnings above                                       |
| `pnpm exec prettier --write` on changed files | Exit 0; changed TS/TSX/JSON/CSS and these notes formatted; lockfile is excluded by the existing Prettier ignore |
| `pnpm format:check`                           | Exit 0; “All matched files use Prettier code style!”                                                            |
| `bash scripts/guardrails.sh`                  | Exit 0; “✅ guardrails passed”                                                                                  |
| `pnpm lint`                                   | Exit 0; no ESLint errors or warnings                                                                            |
| `pnpm build`                                  | Exit 0; 7 successful / 7 total; 0 cached; 6.995s; Vite built in 3.22s                                           |
| `pnpm test`                                   | Exit 0; 102 files / 2,786 tests passed; 24.55s; no EPERM exception needed                                       |
| `git diff --check`                            | Exit 0; no whitespace errors                                                                                    |

Build emitted five Turbo `WARNING IO error: Operation not permitted (os error 1)` warnings and the
Vite chunk-size warning. Tests emitted Vite's CJS Node API deprecation warning. Synthetic fixtures
cover classic HTML, Gutenberg paragraphs/headings/lists/images/quotes, gallery, embed, columns,
buttons, shortcode, custom HTML, tables, Hindi/emoji and entities. Tests exercise strict sanitizing,
block/shortcode handling, loss analysis, actual TipTap parse/editor-state normalization, unchanged
minimal patches, protected-byte preservation, text edits and refusal of removed/changed locks.
Existing preview tests were updated to require sanitization rather than omission of every image.

**What remains unverified:** no browser was opened, and no authenticated Blog/Content interaction,
390px layout, keyboard focus/toolbar scrolling, real paste behavior or live save was exercised.
Happy-dom verifies offline editor state, not browser behavior. No WordPress site, database or Redis
was contacted. Integration tests and direct vitest invocations were not run; no `.env` file was
read; no git commit or push was performed. WordPress/plugin filtering, real Gutenberg/Classic
interpretation, custom theme behavior, remote image availability and site-side byte preservation
remain unverified. The local serializer preserves protected bytes; a site's own normalization can
still produce the existing verified-read-back mismatch. The prior concurrency/remote-write limits
in these notes still apply. Documentation-only formatting/whitespace checks were repeated after
this appendix; implementation build/test results above precede that documentation-only change.
