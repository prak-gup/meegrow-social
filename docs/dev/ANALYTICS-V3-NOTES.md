# Analytics v3 implementation notes

Implemented against `ANALYTICS-V3-DESIGN.md`, the final agreed design dated 12 October 2026.

## Built

- Factual KPI band: supported Views, Post reach, descriptive engagement rate and Followers; YouTube uses Subscribers/Post engagement rate, and GBP uses Views/CTA clicks. Unsupported KPIs disappear, missing values remain `—`, observed zero remains zero, rate basis/counts and small samples stay visible. Follower absolute change is labelled “vs prior capture”.
- Client/period controls precede account-derived single-select platform chips in DOM order; retained URL filters/custom periods/client scope, collapsible account/source filters with active counts and a visible scope summary. Capture status, reconnect/import/undated/partial-rate/GBP/preview warnings remain visible. Retained results have their previous scope labelled and are inert while updating.
- One zero-based blue bar chart of latest counts grouped by publication day/week. Partial buckets are labelled. Missing bucket totals have explicit dash labels; a visible data disclosure gives dates, publication counts and reported totals. No daily-gain claim, rate timeline, platform-contribution plot, stacked mode or dual axes.
- Top posts before platform breakdown. Sorting/null-last behaviour, initial ten rows, +25 Show more, Show fewer, safe external links, thumbnails/account/date/source, post-native metrics/history and returned-row CSV export remain available. Capped-result warnings explain that summary/chart totals include omitted posts while sorting/export do not. Identity columns scroll locally/stick where practical; the selected chart concept is first among post metric columns.
- Collapsed Explore patterns: neutral format rows; one-account follower chart with null calendar gaps, straight segments and observed dots; desktop roving day/hour grid with exact selected-day data and mobile day/hour rows; discrete provider cadence rows; isolated engagement-age points only with one account and at least ten contributors per age. No best/rank/optimal/crossing badges or recommendation claims.
- Calculation definitions and raw prior comparisons live in one main disclosure. “Platform metrics, as collected” remains a separate collapsed table inside it, with all native names/mappings intact. Definition controls work by focus/hover/tap with Escape dismissal, and exact chart data is available visibly.
- Removed unused legacy stacked/multi-series/follower-row builders and the frontend heat-level computation. Formatting, selection and table sorting remain in web; new analytics computation stays in core.

## Optional report additions

All additions flow through the existing report builder/GET report response and are optional in the shared contract; no API route, storage, collection, dependency or infrastructure change:

| Field                          | Core owner                   | Meaning                                                                                                            |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `overTime[].window`            | `publicationWindow`          | Selected publication-window intersection and partial-bucket flag.                                                  |
| `followerSeries[].dailyPoints` | `followerCalendar`           | Calendar-day series in the viewer timezone, with null gaps and observed zeros preserved, including DST.            |
| `bestTimes.cells[].level`      | `publicationIntensity`       | Descriptive ramp index; missing is null, zero is observed, never a rank.                                           |
| `accumulation.displayPoints`   | `engagementAgeDisplayPoints` | One selected account and at least ten non-null contributors at each plotted age; no winner or lifetime prediction. |

Each new pure core function has unit tests. Old payloads still parse: missing bucket metadata is marked “Not supplied”, missing daily follower facts use exact capture tables without reconstructing a calendar in web, missing intensity uses a neutral observed surface, and missing age eligibility suppresses the plot.

## Design decisions and deviations

The task summary requested sparklines, an insights row, a default compact card grid and Bluesky mappings. The final design explicitly removes sparklines/default diagnostic grids, permits no findings strip when comparison evidence is missing, and defers Bluesky mappings. The conflicting requirements were surfaced; implementation follows the instruction to implement the final design exactly. **No Bluesky mapping was added:** native metrics remain in the calculation table; mapped Bluesky engagement/follower heroes stay absent. No median engine or comparison findings were invented from capped posts.

Small optional presentation facts were added to core to satisfy the requested separation of computation and rendering. These do not supply deferred age-matched change/format/slot/cadence recommendation evidence. Existing `best`, `top`, and crossing fields remain backward compatible but are ignored as recommendation authority.

The follower chart uses a zero-based axis rather than cropping it; this is an allowed safer axis treatment and needs no inferred bound. Exact daily values remain available. Missing main-chart buckets are named with a dash beneath the plot and in its table, rather than inserting fabricated zero bars. No browser-based fixture journey was performed because the task prohibits opening a browser.

## Verification observed

Commands were run from the repository root. Existing dependencies were already installed and resolved; `pnpm install --frozen-lockfile` was not needed. No new dependency was added.

| Gate                                          | Observed result                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec prettier --write` on changed files | Exit 0.                                                                                                                                                                                                            |
| `pnpm format:check`                           | Exit 0; “All matched files use Prettier code style!”                                                                                                                                                               |
| `bash scripts/guardrails.sh`                  | Exit 0; “✅ guardrails passed”.                                                                                                                                                                                    |
| `pnpm lint`                                   | Exit 0; no lint diagnostics.                                                                                                                                                                                       |
| `pnpm build`                                  | Exit 0; “7 successful, 7 total”. Vite warns that some chunks exceed 500 kB. Turbo also printed “IO error: Operation not permitted (os error 1)” cache warnings on uncached builds; package builds still succeeded. |
| `pnpm test`                                   | Final run: exit 0; 88 test files passed, 2,542 tests passed. No `listen EPERM` failures occurred in this environment.                                                                                              |
| `git diff --check`                            | Exit 0.                                                                                                                                                                                                            |

Earlier unit runs exposed and then corrected three fixture issues: an old exact slot-object assertion omitted the additive `level: null`; a new rendering test expected `0%` while the existing formatter returns `0.00%`; removal of obsolete chart-helper imports also removed the `bucketLabel` import still used by a retained formatting test. No non-environment failure remains in the final run.

The Node-only rendering fixtures establish missing/zero output, YouTube/GBP/Bluesky vocabulary and supported concepts, mixed/partial rate labels, suppressed unqualified winners, follower-only captures/gaps, old optional payload compatibility, capped returned-row export wording, first-ten pagination and sortable headings. Existing URL/sorting/CSV/core tests also pass. Static code implements touch-sized controls, local table overflow, responsive chart heights and KPI wrapping; these are not browser usability proof.

Calculated sRGB contrast pairs: white on `#277461` 5.59:1; white on `#006650` 6.96:1; ink `#222` on the first three heatmap shades 13.85/10.86/6.84:1; `#6a6a6a` outlines on white 5.41:1; main `#0072B2` on white 5.19:1. Heatmap focus outlines are offset onto the surrounding surface. These are calculations, not rendered accessibility certification.

## Commit block

Staging and committing were attempted, but Git cannot create the worktree lock:

```text
fatal: Unable to create '/Users/prakhar/Desktop/Meegrow/meegrow-social/.git/worktrees/analytics-v3/index.lock': Operation not permitted
```

The Git metadata lives outside the sandbox's writable roots, and approval escalation is unavailable. Changes therefore remain uncommitted. Intended sensible commits, each with the required blank line and trailer:

```text
feat(analytics): expose optional publication and sample display facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

feat(web): implement the agreed analytics v3 evidence-first layout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

docs(analytics): record implementation and verification limits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

`.design-ref/` was inspected locally and never staged or committed. No push was attempted.

## Not verified

No browser was opened. The real React route, fixture-intercepted auth/status/connections/history requests, keyboard/touch/focus/Escape behaviour, visual layout at 1512/1024/390/320 px, 200% zoom, body scroll width, rendered contrast, screen readers and colour-blind simulations remain unverified. Server-rendered component fixtures are narrower evidence than an interactive route test.

No database, Redis, backend or live provider was connected. No `.env` file was read, direct Vitest invocation or integration-test command run, migration/collection change made, or client system mutated. Provider accuracy, collection completeness, permission enforcement and production freshness remain unverified. The preview behaviour is preserved; independent production validation is still required. Git commit creation is also unverified/blocked as described above.
