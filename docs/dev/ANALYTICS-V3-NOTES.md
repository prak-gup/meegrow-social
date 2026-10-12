# Analytics v3 — Revision 2 implementation

Implemented 12 October 2026. The owner’s dashboard brief supersedes conflicting instructions in the earlier design review. Changes are uncommitted; nothing was pushed or published.

## What was built

- A compact title/client header, visible period/platform/account/source controls, platform colour dots, a muted capture timestamp, and the retained “Preview — numbers not yet validated” badge.
- Five KPI cards: engagement rate, reach, views, followers, and published posts. Cards show relative prior-period delta pills and gradient sparklines. Followers also show the observed net change. Definitions and coverage are available through one info tooltip per card.
- Up to four deterministic, server-generated insight cards. An empty insight list renders no row.
- A wide platform-coloured publication-week area chart with Views, Reach, Likes, Comments, Saves, and Engagement rate chips, friendly dates, light horizontal gridlines, exact hover values, a period total and delta, and a screen-reader data table. Segments are straight; missing metric buckets remain null gaps.
- Six visible supporting cards: platform reach split with post counts/rates, format rate bars, weekday/hour heatmap with a sequential teal ramp and qualified slot chips, follower captures per account, stacked publication-week posting bars, and snapshot-qualified engagement by post age. Cards have icon/text empty states.
- Top posts and platform tables retain their content, top-post sorting, pagination and CSV export. Post titles have no history link or expansion. Definitions sit in column headers rather than every cell. Rows show thumbnails, single-line titles, accounts, friendly dates and Imported markers. Rate bases are in tooltips.
- One collapsed calculation footer contains formulas, coverage/exclusions, comparison limitations, snapshot rules, and the native metric table. The raw table is visible when that footer opens.
- Shared platform chart colours are defined once: Instagram pink, Facebook blue, YouTube red, Google Business teal, Bluesky sky blue and WordPress slate. Cards use existing surface/type/status tokens, 12px corners and a very soft shadow. Desktop uses five KPI columns and two supporting-card columns; narrower screens wrap KPIs and use one supporting-card column on phones. Tables retain their internal overflow containers. Layout skeletons cover KPI, primary trend, supporting cards and table rows.

## Core computations and contract compatibility

All new report arithmetic lives in core. `analytics-insights.ts` is pure; no AI generation, network calls or storage writes are involved. Existing fields remain, with additive optional fields in the GET `/v1/analytics/report` schema:

- `insights`, `formatWinner`, `bestSlots`, `platformShares`, `followerTrend`, and `weeklySeries`.
- `bestTimes.cells[].postsCounted`, `followerSeries[].change`, and per-platform publication-bucket engagement rates.

`weeklySeries` always uses viewer-zone Monday weeks, even when the existing `overTime` uses days for a short period. Weekly follower sparklines sum each selected, mapped account’s latest actual capture in that week only when every such account has a capture. Missing weeks/accounts remain null. Account follower change compares the latest in-period capture with its prior-period capture; no prior capture means no change.

Bluesky now maps `likeCount`, `replyCount`, `repostCount`, and `bookmarkCount` to likes/comments/shares/saves, and `followers` to the account count. Unsupported concepts remain null. Raw native values remain available.

## Insight and display sample rules

1. Format comparisons require at least **five rate-counted posts in each group**, matching non-mixed bases and identical engagement components, and unequal rates. The highest eligible winner gets the Best marker. The legacy `formats[].best` flag is not used as authority.
2. Time slots require **three measured posts**, not merely three published posts. Slots sort by average, then weekday/hour. The top three qualified slots become chips. A time insight appears only when scored by engagements, rather than fallback views.
3. Top-post engagement share requires **five published posts**, an engagement-ranked best post and a positive reported engagement total. The share is of reported engagement, not an estimate of unreported counts.
4. Platform reach findings require **two platforms with reported reach**, positive total reach and **five published posts on the leading platform**. Unreported platform reach stays null; it never becomes a zero share.
5. Reach-change findings require a positive prior value, a current value, and a finite nonzero relative change. Missing/zero baselines never produce infinity.
6. Findings appear in stable format → time → post → platform → delta order, capped at four. Ineligible findings are absent. These are descriptive observations, not significance tests or causal recommendations.
7. Engagement-by-age uses the existing snapshot qualification: three captures, first within 24h, latest at least 48h old, positive latest engagement. The display retains the stricter existing rule of one selected account and ten contributors per age, and requires at least two qualified points to render a curve. Otherwise it shows an insufficient-data state.

Unit tests cover threshold boundaries, absent values, mixed/incompatible comparisons, equal rates, stable ordering/capping, missing follower weeks, publication-week totals, account net changes, Bluesky native mappings and legacy optional-field parsing. Server-rendered markup tests cover the visible cards, null/zero distinctions, finite deltas, friendly dates, tooltip placement, removal of expansion, CSV/pagination controls and empty states.

## Gates exactly as observed

All commands were run from the repository root. No integration test command, direct Vitest invocation, database/Redis connection, environment-file read, dependency installation, commit or push was performed.

| Gate                                          | Observed result                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec prettier --write` on changed files | Passed. Changed source/tests/docs formatted.                                                                         |
| `pnpm format:check`                           | Passed: “All matched files use Prettier code style!”                                                                 |
| `bash scripts/guardrails.sh`                  | Passed: “✅ guardrails passed”.                                                                                      |
| `pnpm lint`                                   | Passed, exit 0; no lint diagnostics.                                                                                 |
| `pnpm build`                                  | Passed: **7 successful tasks / 7 total**, including TypeScript and Vite production output.                           |
| `pnpm test`                                   | Passed: **89 files, 2,576 tests**. Final observed run duration **20.20s**. No `listen EPERM` exceptions were needed. |
| `git diff --check`                            | Passed; no whitespace diagnostics.                                                                                   |

The initial build exposed two chart typing errors (dynamic row indexing and a too-narrow Recharts formatter signature); these were corrected. The initial test run had three failures from changed report-field expectations and a zero-post platform empty-state defect; these were corrected. Subsequent full test runs passed.

Build output included sandbox Turbo-cache IO warnings (“Operation not permitted”) and Vite’s warning about a minified chunk larger than 500 kB. These were warnings, not gate failures. The test runner emitted the existing Vite CJS Node API deprecation warning.

## What remains unverified

No browser was opened. The evidence does **not** establish visual quality or absence of overflow at 1512 / 1024 / 390px, actual chart geometry/hover rendering, touch usability of the hourly heatmap, keyboard interaction behaviour in a browser, or screen-reader announcements. Responsive classes, accessible labels/data alternatives and server-rendered markup were checked; they are not substitutes for those real journeys.

No database, Redis or live platform was contacted. The evidence does **not** validate production metric accuracy, imported media classification, real account coverage, provider data freshness, transport-backed filtering, or live CSV downloads. The preview badge remains visible. Prior comparisons are publication-cohort comparisons of latest counts, and followers compare captures; neither establishes period-attributed audience growth. API additions compile and parse in unit fixtures, but were not exercised through a live authenticated report request.
