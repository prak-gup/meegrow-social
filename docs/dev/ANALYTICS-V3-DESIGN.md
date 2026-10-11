# Analytics v3 — design proposal

Status: proposal only · 12 October 2026 · no product code changes

## Direction

An agency operator should leave this page knowing **what changed, what worked, and what to try next**. Make the findings the first read, numbers the second, and evidence available immediately below. Calm comes from fewer competing plots, consistent alignment, and space around meaningful comparisons; not from decorative gradients or larger cards everywhere.

Recommend an **answer-led overview**: findings → KPI band → one performance trend → compact diagnostic grid → existing tables. A chart-led reskin would preserve the repetition; separate platform dashboard pages would fragment comparison. Keep one page with platform chips and adapt its vocabulary to the selected platform.

### Evidence and boundaries

- Studied `.design-ref/zernio-analytics.png` and `ours-current.png`. Zernio's useful qualities are clear number alignment, readable tables, and compact format/heatmap cards. Do not copy its many repeated plots, smooth curves, or multi-scale engagement chart.
- Our screenshot has four large breakdown charts before the engagement trend, repeated formula/coverage paragraphs, a six-part KPI strip, and a full raw-metrics table. The strongest information is buried. Its table structure and thumbnails already work.
- Read `Analytics.tsx`, all four `components/analytics/*` files, `lib/analyticsReport.ts`, shared `Chart`, `Heatmap`, the contract, report builder, and metric mappings. No repository `AGENTS.md` or `ARCHITECTURE.md` was found. The current report and the v2 update in `ANALYTICS-UI-BRIEF.md` supersede that brief's older endpoint/layout constraints.
- Report arithmetic belongs in core. Web shapes, formats, filters, and sorts; it must not become a second analytics engine.
- `overTime` describes **posts grouped by publication date, using their latest totals**. It is not activity gained each day. This is the decisive design constraint: use publish-cohort bars and a persistent short subtitle, rather than a smooth daily-growth line.
- No new dependency, migration, collection job, AI text, or provider API call is needed for the recommended first release. Existing report/status reads remain the data path.

### Competitor capability reference

The supplied `zernio-docs-index.txt` describes dashboard totals/comparisons, daily aggregates, historical best-time slots, accumulation, cadence correlation, and daily follower snapshots. Its best-time slots are UTC; ours use the viewer's `report.timezone`.

It also describes YouTube channel insights, per-video daily views/watch time/subscriber changes, signed-in audience demographics, and video retention. These are distinct datasets, often delayed or suppressed. Our report does **not** expose daily YouTube activity, demographics, or retention. Google Business location performance/search keywords and Meta account insights are similarly distinct from our post report. Use the local index as inspiration, not evidence that our product has these capabilities; no external documentation was fetched or live provider behavior verified.

## Composition and visual system

```text
Analytics                                      [Client] [Last 30 days]
[All platforms] [Instagram] [Facebook] [YouTube]  [Account] [Source]
Data as of …  [Coverage / connection issue if applicable]

What changed             What worked             Try next
[plain finding]          [plain finding]          [plain finding]
------------------------------------------------------------------
Views       Reach        Engagement rate         Followers     Posts
value Δ     value Δ      value Δ / basis         value Δ       value Δ
spark       spark        spark                   spark         spark
------------------------------------------------------------------
Performance by publish week                        [Views v] [i]
Latest totals for posts published each week
|                  single-metric cohort bars                       |
------------------------------------------------------------------
Platform contribution     Format performance      Publishing times
direct-label bars         three compact rows      7 × 24 heatmap
------------------------------------------------------------------
Follower growth           Engagement lifespan     Posting cadence
account selector/line     observed age points     discrete rate bands
------------------------------------------------------------------
Platform breakdown — existing columns and order
Top performing posts — existing sorting, thumbnails, CSV, pagination
[How these numbers are calculated ▾]
```

The insight row is an unboxed editorial strip with subtle vertical separators, not three more elevated cards. The KPI band shares one frame. The primary chart gets the most space; the diagnostic cards are smaller. Left-align titles and findings; right-align table numbers.

### Tokens

Use `apps/web/tailwind.config.js` and `index.css`; preserve the existing Inter/Cereal/system stack and `.tnum` tabular figures.

| Role                    | Existing token / rule                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page and card           | `canvas` (#fff); `surface-soft` (#f7f7f7) for inset controls; `surface-strong` (#f2f2f2) for loading/empty regions                                                                  |
| Main and secondary text | `ink` (#222), `body-ink` (#3f3f3f), `muted` (#6a6a6a); no `muted-soft` for essential small text                                                                                     |
| Frames                  | `hairline` (#ddd); chart guides `hairline-soft` (#ebebeb); no card shadows                                                                                                          |
| Accent                  | Existing `rausch` (#de0d44), limited to existing Create post action and tiny selected-state accents if needed; no pink card washes or full pink plots                               |
| State                   | `status-ok`, `status-warn`, `status-bad`; always pair with sign, text, or icon                                                                                                      |
| Radius                  | Cards and KPI frame `rounded-md` (8px); controls `rounded-sm` (6px); bars/cells `rounded-xs` (4px); chips `rounded-full`                                                            |
| Spacing                 | Desktop page padding 24px, mobile 16px; section gap 24px, grid gap 16px; card padding 16px; internal gaps 8/12px                                                                    |
| Type                    | Page `text-title` 20px; card title `text-base` 14px semibold; body `text-sm` 13px; axes/metadata `text-caption` 12px; hero numbers `text-3xl` 24px semibold, mobile `text-2xl` 20px |

Propose semantic analytics color variables, consumed locally through CSS variables, rather than changing brand marks or global chart tokens. Small categorical palette: Facebook blue `#0072B2`, Instagram purple `#6F4C9B`, YouTube vermilion `#B74720`, Google Business teal `#007F73`, Bluesky slate `#526B83`; unknown providers use `ink` with a distinct marker. These deliberately distinguish two blue-branded networks and avoid pink as a category. Labels remain `ink`; do not use these hues as small text. Direct names plus markers/dashes ensure color is never the sole identifier. Verify graphical contrast against the actual surface during implementation, including focus outlines.

Heatmap uses one teal ramp: `#E5F2EF`, `#B8DDD4`, `#72B7A5`, `#348975`, `#006650`. Missing cells use `surface-strong` with a dash/pattern; observed zero is the lightest teal and reads “0” in its details. Rank marks use `ink` on the first three shades and white on the last two. A low→high key names the scored metric.

The app is explicitly **light-only** (`color-scheme: light`, no dark theme tokens in the inspected configuration). Do not add dark mode in this task. Keep surfaces, labels, tooltips, and chart colors variable-based; a future dark theme must supply a tested ramp/palette, not invert these hex values or reuse translucent fills blindly.

### Chart grammar and accessibility

- One metric and one visible unit per primary chart. No dual axes, independent hidden scales, or metric rainbow.
- Cohort bars start at zero; rounded tops, 24–40px maximum width, direct totals where space permits. At long ranges suppress crowded bar labels, retaining exact values on focus/tap.
- Actual snapshot lines use 2px strokes, observed dots, and `connectNulls=false`; expand to a calendar-day axis so absent days produce gaps. Never smooth, interpolate, synthesize daily increments, or forward-fill.
- Sparklines use observed dots/straight segments; soft area fills at at most 8% only for contiguous follower captures, never cohort totals or across gaps. A single observation is a dot, not a line.
- At most three faint horizontal guides, no vertical grid, compact axes, visible units. Direct end labels or adjacent labeled rows replace legends; avoid clipped end labels.
- Every plot keeps a text/data-table alternative. Tooltip triggers work on hover, keyboard focus, and tap; Escape dismisses. Use existing primitives or a small accessible disclosure/popover with existing dependencies, not native `title` alone.
- Heatmap uses roving keyboard focus and a selected-cell detail line with day/hour, exact mean, and sample size; its full data table is available in the disclosure. Mobile touch targets and filter controls are at least 44px; desktop controls can retain the compact 32px scale with generous hit areas.
- Respect reduced motion; no animated counting or chart-drawing sequence. Loading uses the existing skeleton primitive without required motion.

## Section specifications

All field paths below start at `AnalyticsReportView` unless explicitly stated. Template examples use placeholders, not purported client numbers.

### 1. Context and filters

**Question:** Which client, platforms, accounts, sources, and dates am I reviewing?

**Fields:** `accounts.{id,workspaceId,workspaceName,provider,displayName,selected,needsReconnect}`, `period.{priorStart,start,end}`, `timezone`, `summary.lastCapturedAt`; existing status endpoint `lastCapturedAt`, `nextDueAt`, `cadence`, and connection import state.

```text
Analytics                    [Client v] [Last 30 days v]
[All] [Instagram] [YouTube]   [Account v] [Source v]
Data as of …                 [2 accounts need attention]
```

**Interaction:** Chips are single-select plus All; match the existing single `provider` query (no multi-select contract change). Providers come from accounts, including those with no period posts. Preserve URL filters, range choices/custom dates, scope role rules, invalid-filter correction, and account reset when changing provider. Account names include platform/client where ambiguous. Keep the preview/Beta badge until the existing validation sign-off. Click freshness for cadence/next refresh; warnings expose the affected accounts and existing operator-only reconnect link. Importing and undated-post counts become compact status badges with details, not repeated prose.

**Empty:** No accounts → existing connect-account empty state with role-aware action. No period posts → “No posts in this period” and widen-period action; retain followers if captured. Failed report → existing retry state. Status failure → “Refresh status unavailable”; do not imply freshness.

### 2. Findings: what changed / what worked / try next

**Question:** What deserves attention before I inspect charts?

**Fields:** proposed optional `insights[]` (typed facts below), computed in core from `summary`, full current posts, `formats`, `bestTimes.cells`, `mapping`, and `accounts`. Render fixed human-written templates, at most four findings, never AI output.

```text
What changed            What worked              Try next
{Metric} up {Δ}%        {Format} led on {basis}   Test {day}, {hour}
[View trend]            [View formats]           [View time slots]
```

**Deterministic eligibility rules (versioned in core):**

1. **Change:** largest absolute eligible delta among views, reach, likes, comments, shares, saves, clicks, follows; ties use contract concept order. Template “{Metric} up/down {absDelta}% vs prior period.” Require current and prior >0, at least five measured posts per period, and the same contributing account set in both periods. Exclude GBP and mixed lifetime/window totals. Use core `deltaPct`; suppress rounded-to-zero changes. This is largest relative change, not a causal claim or “growth this week.”
2. **Format:** “{Format} had the highest engagement rate ({rate}%, by {basis}).” Require at least two eligible formats with five counted posts each, one selected account, same non-mixed basis and identical reported engagement-component set across compared posts, and a unique winner. Do not blindly trust `formats.best`: it currently only needs two rates. Link to formats; phrase next action as “Test another {format} post,” not a guaranteed result.
3. **Time:** “{day} {hour} led on average {engagements/views} per post. Test this slot.” Require one selected account, ten measured posts overall, at least two slots with three **measured** posts each, positive unique winning mean, and identical engagement-component sets when scoring engagements. Re-rank eligible cells, rather than picking `bestTimes.top[0]`. Core has access to the scored posts: current cell `posts` includes unmeasured posts and is not sufficient evidence. Show the winner's measured n; no scheduling mutation from this link.
4. **Standout:** “One post had {ratio}× its account's median {engagements/views}.” Compute a leave-one-out median for each account, among current posts of the same format and reported component set; views fallback only if that account reports no engagements. Require ≥5 other measured posts, median >0, ratio ≥2 (or ≤0.5 for an underperformer), and age ≥48h for every comparison post. Pick the highest overperformer first, else lowest underperformer; ties use publish time descending then post id. “Review this post” opens its table row. This controls some mix differences, not age or exposure fully; put that limitation in the finding details.

**Interaction:** Each finding has one evidence link and an info trigger revealing source metric, basis, sample sizes, rule, and cohort semantics. No cross-account “best” recommendations in All clients. All findings referencing totals are labeled as cohort comparisons in their details. Formula/basis stays available beside rate-based findings.

**Empty:** Hide each unsupported finding; reflow one/two/three findings naturally. Hide the entire strip if none qualify, without filler or speculative advice. Templates must handle ties, nulls, zero baselines, and incomplete data. Findings use full core data, never the capped `topPosts` list.

### 3. Hero KPI band

**Question:** How did this set of published posts and connected accounts compare with the preceding period?

**Fields:** `summary.totals[concept].{value,prior,deltaPct}`, `summary.{posts,engagementRate,engagementRatePrior,engagementRateDeltaPct,followers}`, `overTime.{key,posts,totals,engagementRate}`, `followerSeries.{connectionId,points}`, `mapping`, proposed coverage metadata.

```text
Views                 Reach             Engagement rate / mixed basis
{value} {signed Δ}%   {value} {Δ}%      {rate}% {Δ}% [i]
mini cohort bars      mini bars         observed cohort rate dots
Followers {value} {Δ / change}          Posts {value} {Δ}%
observed sparkline                       mini cohort bars
```

**Layout/interaction:** Five cells by default: Views, Reach, Engagement rate, Followers, Posts. Unsupported concepts across all selected platforms are omitted from the hero; supported-but-missing values are “—”. Retain all concepts in the table/disclosure. KPI click selects that metric in the trend, except Followers scrolls to its snapshot card. Count deltas are neutral signed text with arrows, not indiscriminate green success. Rate delta remains **relative %**, not percentage points, and the tooltip names that distinction. Mixed rate keeps a visible “Mixed basis” badge; partial counts keep “n/N posts” or “n/N accounts” metadata. Formula tooltip: Σ reported engagement components ÷ Σ valid post denominators ×100; reach >0 first, views >0 fallback, excluding missing halves.

Count/rate mini-series come from `overTime` and are explicitly cohort sparklines, not daily gains. Follower sparkline shows one account by default; for multi-account scope, show an aggregate only on days with captures for every currently counted account, leaving other days null. No partial-sum aggregate that creates fake growth when an account appears. “Best post” leaves the numeric band and survives as the standout finding/table evidence or a compact thumbnail link in the Top posts header using `summary.bestPost`.

**Empty:** Missing value/delta → “—” with accessible reason. Prior zero → no percentage growth, exact prior/current on tap. One bucket → bar/dot; no available series → omit sparkline, preserve value. GBP-only substitutes Clicks for Reach and omits rate/followers; Bluesky-only uses Engagements, Likes, Replies, Followers, Posts (engagement comparison addition below), with no fabricated rate.

### 4. Primary performance chart

**Question:** Which publication cohorts produced stronger results?

**Fields:** `bucket`, `timezone`, `overTime.{key,start,posts,totals,engagementRate,byPlatform}`, `summary.totals`, `mapping`; no new timeline endpoint.

```text
Performance by publish week                       [Views v] [i]
Latest totals for posts published each week
|        ▂      ▆      █      ▅      ▃                         |
| week   …      …      …      …      …                         |
```

**Interaction:** Default Views when supported, otherwise Likes, otherwise Posts. Metric menu offers supported concepts, Posts, and rate when calculable; hero selection synchronizes URL `metric`. Single total series by default; optional “Split by platform” stacked bars for additive counts only, with direct labels/tooltips and a compact named key if stacks cannot be labeled. Rate is a separate single-scale dot plot, not stacked. Tooltip gives bucket dates, latest total, posts, measured-post coverage, unit and basis. Daily buckets for ≤14 days, Monday weeks otherwise; no prior-period series because the contract supplies only prior summary values. GBP in scope changes subtitle to “Latest reported metrics for posts published each week” and adds “Includes 30-day GBP counts”; prohibit cross-window platform contribution percentages.

**Empty:** No supported values → “No {metric} reported”; offer Posts. Missing buckets remain gaps; Posts can show an actual zero publication count. If the series is all measured zeros, show the baseline with “0”, never an insufficient-data message.

### 5. Platform contribution

**Question:** Where did the selected metric come from?

**Fields:** `byPlatform.{provider,posts,totals,engagementRate}`, `mapping`, coverage addition; selected primary concept (Posts fallback).

```text
Platform contribution [Views v]
Instagram   ███████████  {value}  {share}%
Facebook    ███          {value}  {share}%
```

**Interaction:** Compact horizontal ranked bars, platform names and exact totals adjacent. Choose one additive metric; click a platform applies its chip filter. Percentage = provider total / sum of known comparable totals, calculated in core; tooltip names this as share of **reported** totals, not audience share. Null platforms stay listed as “—”; partial coverage is a badge. With mixed GBP windows, switch this card to Posts and disallow mixed-window metric shares. Never use a pie chart or deduplicate reach across posts/platforms.

**Empty:** One platform → single labeled row, no redundant legend. No counts → “No {metric} reported” and Posts choice; no posts → empty status.

### 6. Format performance

**Question:** Which content format merits another experiment?

**Fields:** `formats.{format,posts,engagementRate,vsAveragePct,best}`, `summary.engagementRate`; insight eligibility/evidence for a qualified highlight.

```text
Format performance                 [Engagement rate i]
Video    {n} posts     ███████      {rate}% / views
Image    {n} posts     ███          {rate}% / reach
Text     {n} posts     —
```

**Interaction:** Three tight rows with existing format icons, aligned bars, values and counted samples. Basis always visible. A single account with comparable, sufficiently sampled formats may get a small “Highest” outline label; no full green/pink background. In mixed basis/component scope, render values grouped by basis without competitive highlighting or common comparison bars; prompt account selection in the info popover. `vsAveragePct` is available on hover only when the comparison is eligible. Do not call the first media item's type a carousel/Shorts classification: current formats are only video/image/text.

**Empty:** Format with posts but no rate → “—”; no rates → retain post-count rows and “No comparable rates.” Bluesky/GBP can show the existing format post counts; no rate from likes alone or clicks/views.

### 7. Publishing times

**Question:** Which observed slots are worth testing again?

**Fields:** `bestTimes.{by,postsCounted,cells,top}`, `timezone`, proposed per-cell `postsMeasured`, qualified time insight.

```text
Publishing times                     {timezone} [i]
Mon  ░░▒░░▓░░░░░░░░░░░░░░░░░░  Low → High
…    24 hourly cells per weekday
Selected: {day hour} · {mean} avg · {n} measured posts
```

**Interaction:** Seven rows × 24 true hourly slots; never merge neighboring hours without core rebucketing. Rank only slots passing insight sample rules; all observed slots remain inspectable. All-platform mode shows the grid as descriptive observations without “best” badges; an account selector reveals eligible comparisons. Tooltip distinguishes measured posts from all posts in the slot. No “optimal time” claim. Mobile uses a locally scrollable minimum-width 640px grid with fixed day labels, plus readable best-slot/evidence list; do not squeeze 168 tap targets into 358px.

**Empty:** No scored slots → “No timing data yet.” Sparse slots remain visible with sample details, but no recommendation; unknown cells differ from measured zero cells.

### 8. Follower growth / audience size

**Question:** Is the captured audience count growing, and which account is contributing?

**Fields:** `summary.followers.{value,change,deltaPct,accounts,accountsCounted}`, `followerSeries.{connectionId,points.{day,value}}`, `accounts`.

```text
Follower growth                    [Account v]
{latest count}   {reported change vs prior}
| observed dots / straight segments, gaps for missing days |
```

**Interaction:** Default first selected account with captures; selector names account/platform/client. Account latest count derives from its last point; do not show global prior-period change beside an individual account. Aggregate summary change stays in the hero. Expandable adjacent account list shows all latest counts, including missing “—”. Use a clearly labeled fitted linear y-axis with exact ticks, no log scale or unmarked truncated bars. YouTube label is Subscribers; multi-platform aggregate is Followers & subscribers. No audience demographic card: size history is what the current data supports.

**Empty:** No account captures → “No follower snapshots in this period.” Platform with no follower mapping (GBP) → omit card rather than imply collection is pending. One capture → dot and exact date, no growth claim.

### 9. Engagement lifespan

**Question:** By which measured ages had engagement arrived?

**Fields:** `accumulation.{points.{untilHours,pct,posts},postsConsidered,postsUsed,rules,halfByHours,eightyByHours}`.

```text
Engagement lifespan                        [i]
{80% threshold age, if observed}
|  •      •       •       •       •        |
| 6h     12h     24h      2d      7d        |
```

**Interaction:** Plot all age entries, preserving nulls; observed dots with optional straight segments, no smooth area curve. Display “80% of latest engagement by {age}” only when `eightyByHours` exists. This means the first sampled threshold, not exact crossing time, final lifetime total, or content decay. Tooltip gives contributing n at that age and last-snapshot-at-or-before-age rule. Qualification and newest-200-candidate limit live in the disclosure; do not generalize to every post.

**Empty:** “Not enough early snapshots” with `postsUsed / rules.minPosts`; one short detail action. Inapplicable platforms can omit the card; missing threshold shows “—”, not a made-up age. It is the fifth diagnostic card, not a demographic substitute.

### 10. Posting cadence

**Question:** Which observed publishing frequencies had stronger rates?

**Fields:** `frequency.{fullWeeks,platforms.{provider,bands.{min,max,weeks,posts,engagementRate},best}}`.

```text
Posting cadence                           [Platform v] [i]
1–2 / week    • {rate}%    {weeks} weeks
3–5 / week    • {rate}%    {weeks} weeks
```

**Interaction:** Discrete horizontal dot rows rather than a continuous line between categorical bands. Platform selector; show sampled weeks next to each rate. Highlight only with two rated bands each containing ≥2 full weeks; no “optimal cadence” or causal recommendation. Current frequency payload lacks basis/components, so keep this descriptive and withhold cross-band winner highlighting until additive comparison metadata verifies a common basis/component set. Do not invent rate-based results for Bluesky/GBP.

**Empty:** Fewer than two full weeks → “Needs two full weeks.” One band → show one row, “One cadence observed”; no empty 224px plot. On mobile this becomes a collapsed “Posting cadence” card, expanded on demand.

### 11. Platform and top-posts tables

**Question:** Can I verify the aggregate and inspect the actual posts?

**Fields:** Existing `byPlatform`, `topPosts`, `accounts`, `mapping`, `postsOmitted`, `summary.bestPost`; per-post expanded detail keeps its existing metrics/history endpoint reads.

```text
Platform breakdown
Platform | Posts | supported concept columns… | Rate / basis
Top performing posts                         [Export CSV]
▸ thumbnail / caption / account / date | metrics… | rate / basis
Showing {n} of {available}                    [Show more]
```

**Interaction:** Preserve all current content, metric columns, null semantics, account/source/date labels, safe external links, expanded rows, CSV, and 10-row initial/25-row increment pagination. Top posts stays engagements-desc by default, existing sort toggles, stable tie ordering, and nulls last in both directions. Platform table currently has **no interactive sorting** and retains core's posts-desc/provider order; do not introduce a new default under “restyle.” Thin dividers, subtle surface-soft header, tabular numbers; keep basis labels visible. Remove repeated explanatory footers, transferring their full meaning to column info and the disclosure. Omitted-post count stays visible beside pagination/export, which covers only returned rows.

**Empty:** Existing period-empty table states. A missing supported metric is “—”; unavailable columns are still excluded as today, with the excluded list in the disclosure. Never replace these tables with mobile cards; horizontal scrolling stays inside each table, sticky post/platform column where practical.

### 12. How these numbers are calculated

**Question:** What do these numbers mean, and what was unavailable?

**Fields:** `mapping`, `rawMetrics`, all coverage/basis/rules fields above, `summary.undatedPosts`, `postsOmitted`, `period`, `timezone`, freshness/status data.

```text
[How these numbers are calculated ▾]
  Period / publication cohorts / capture times
  Formula / basis / coverage / missing values
  Platform mappings and all native metrics, including unmapped
  Time-slot, cadence and snapshot qualification rules
```

**Interaction:** One closed-by-default disclosure after tables; anchors from all info controls open the relevant part. Preserve raw metric rows and mapping table rather than deleting them. Warn here that summing native averages/rates is not meaningful. Include repeated reach across posts, imported history limits, first-media format classification, timezone/week boundaries, and GBP's trailing window. Data freshness is the newest capture, not proof that every account is equally current. Never hide live reconnect/import/partial-data badges behind this disclosure.

**Empty:** Disclosure remains useful with no metric captures: show available mappings and explain missing data; omit empty native rows, not definitions.

## Platform treatment

| Platform                | Show when available                                                                               | Boundary                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instagram               | Views, reach, likes, comments, saves, followers                                                   | Current provider does not request shares; no invented shares/impressions/follows                                                                                                                          |
| Facebook                | Views, reach, likes, clicks, followers                                                            | `post_video_views` remains native-only; do not add it to views or invent comments/shares/saves                                                                                                            |
| YouTube                 | Views, likes, comments, shares, subscribers gained per post; Subscribers from account `followers` | Prefer `viewCount/likeCount/commentCount` over lagging Analytics names as current mapping does; no reach/saves; per-post gains are not channel net growth                                                 |
| Google Business (`gmb`) | Post views and CTA clicks; format/post counts                                                     | `LOCAL_POST_VIEWS_SEARCH` / `LOCAL_POST_ACTIONS_CALL_TO_ACTION` are trailing 30-day counts. Keep a visible “30-day GBP counts” marker even when selected date range differs. No followers/engagement rate |
| Bluesky                 | Likes, Replies, Reposts, Bookmarks, Engagements, Followers                                        | Add read-time mappings below; no reach/views so no engagement rate. `quoteCount` remains accessible native-only                                                                                           |

YouTube watch minutes (`estimatedMinutesWatched`) already exist in native post metrics and can be surfaced under an optional compact “Watch time” value in a YouTube-only diagnostic header via an additive core fact, if it has measured posts. Do not sum `averageViewDuration` or `averageViewPercentage`; preserve them in per-post details. Keep channel daily metrics, daily video views, retention, demographics, Shorts segmentation, GBP location metrics, and demographic collection out of v3. They require separate data contracts/collection semantics, not another frontend chart.

## Small additive core / contract changes

1. **Bluesky mappings only:** in `metric-concepts.ts`, likes=`likeCount`, comments=`replyCount`, shares=`repostCount`, saves=`bookmarkCount`; account followers=`followers`. Provider already emits these native names when available. No stored-row rewrite or schema migration; missing bookmarks remain null.
2. **Optional `insights[]`:** typed discriminated facts (`change`, `format`, `time`, `standout`), with concept, provider/account scope, evidence ids/format/slot, current/baseline/ratio or delta, basis/components, sample counts and rule version as appropriate. No prose in the contract. Compute from full filtered current/prior inputs before top-post cap; older reports simply hide the strip. Rule thresholds are product guardrails, not statistical confidence claims.
3. **Optional coverage:** current/prior per-concept measured post counts and contributing account ids/counts; current per-platform/per-bucket concept counts. Core calculates these from non-null concepts, exposing scope equality for change eligibility and partial-count badges. Include prior rate basis/components/counts if a future rate comparison finding is enabled; v3 does not need it.
4. **Optional `bestTimes.cells[].postsMeasured`:** number actually entering that cell's mean, distinct from existing `posts`. Insight rules additionally examine exact component sets internally. Old payloads retain the descriptive grid and suppress qualified rankings.
5. **Optional compared engagements:** `{value,prior,deltaPct}` beside existing summary rate statistics, plus cohort engagement totals for the Bluesky hero mini-bars. Sum reported components in core; disclose components. No engagement rate without a valid denominator.
6. **Optional contribution facts:** shares of known, semantically comparable totals per provider/concept; omitted for mixed GBP windows. This avoids frontend arithmetic and makes partial-total labeling explicit.
7. **Optional frequency evidence:** per-band basis/components and counted-post coverage, sufficient to gate descriptive highlighting. Without it, the cadence card still ships unhighlighted.
8. **Optional YouTube watch-time fact:** sum latest per-post `estimatedMinutesWatched`, measured-post count and capture scope. Display minutes/hours, never a sum of duration averages. Defer if it would expand the first release; native values remain available today.

All new schema fields are optional; no new query filter, endpoint, dependency, database column, or Redis use. Existing totals, ranking, tables and prior comparisons remain intact. Missing metadata suppresses a claim, never substitutes inferred coverage. New collection/capability work is explicitly outside this proposal.

## Remove or consolidate

| Current element                                           | Change and reason                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Posts per platform + posts over time pair                 | Fold into contribution/trend metric choices; publication volume should not occupy the largest first plots |
| Likes/concept per-platform + over-time pair               | Same shared charts; four repetitive plots become two focused questions                                    |
| Multi-metric engagement chart and nine toggles            | Replace with one unit at a time; remove hidden percentage scale and competing axes                        |
| Best post inside hero band                                | Move evidence link to findings/table header; give numeric cells equal alignment                           |
| Formula, rate coverage and mixed-basis paragraphs         | Formula/details on accessible info triggers; retain compact visible basis/coverage badges                 |
| Repeated chart subtitles/footnotes and mapping paragraphs | One necessary cohort subtitle, short unit labels, shared disclosure; preserve the underlying meaning      |
| Large full-width format card and colored “best” wash      | Compact diagnostic rows with qualified highlight; sparse text-only posts cannot win a loud banner         |
| Continuous frequency line                                 | Discrete observed bands; line suggests an interpolated relationship the data does not establish           |
| Raw metrics table in default reading flow                 | Move intact into the disclosure; valuable audit evidence should remain discoverable                       |
| Verbose sync cadence and import/undated explanations      | Short freshness/status badges with details; retain warnings that materially affect interpretation         |

## Responsive and state behavior

| Viewport | Layout                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1512px   | Existing 176px sidebar; ~1288px content after 24px side padding. Findings 3–4 columns; five-cell hero (minimum 152px); full-width 280px primary plot; diagnostic grid 3 columns × 2 rows, cards ~408px wide and 240–280px tall. Tables full width                                                                                                                                                 |
| 1024px   | Respect current app shell; about 800px content with expanded sidebar. Findings 2 columns; KPI grid 3 then 2 cells; primary plot 240px; diagnostics 2 columns × 3 rows. Filters wrap by groups, never truncate account names silently                                                                                                                                                              |
| 390px    | App shell's mobile navigation, 16px page padding gives 358px. Context/range wrap; chips scroll inside their row; Account/Source behind a visible “Filters” disclosure with active-count badge. Findings stack without a carousel; KPI grid 2 columns with final cell full width; primary plot 200px; diagnostic cards one column. Heatmap/table overflow locally; body never scrolls horizontally |

DOM order always matches reading order. Supported diagnostic cards reflow when inapplicable cards are omitted; insufficient-but-applicable cards keep a compact empty state, not giant dashed rectangles. Skeletons match the reserved hero/primary/grid/table sizes and show no fake numbers. Filter reload preserves geometry, but marks the old content “Updating” and disables stale evidence links until the new filter result arrives; on failure show retry rather than relabel old numbers as the new scope. Screen-reader status announces loading and the returned scope/post count. Reconnect, import, partial coverage, truncated results, and preview state remain observable without opening help.

## Ordered implementation plan

1. Add Bluesky read mappings and unit fixtures for every concept/null case. Keep all native rows untouched and prove quote counts do not double-count shares.
2. Add optional coverage, measured-slot counts and deterministic insight facts in pure core report helpers. Test ties, exact thresholds, unequal account scope, different component sets/bases, GBP windows, null/zero, and >1000-post caps using plain rows. Add compared engagements/contribution facts as needed; defer watch-time/frequency evidence if scope grows.
3. Add a small frontend presentation layer for fact templates, applicable KPI selection and compact metadata. Preserve URL filter semantics; verify old payload fallback and hidden unsupported findings with existing unit-test patterns.
4. Recompose header, chips, findings and KPI band. Add accessible info/disclosure behavior and matched skeletons using existing primitives; preserve role-specific affordances and preview state.
5. Replace duplicated plots with the single cohort trend and contribution bars. Make shared chart changes additive or analytics-local; verify other pages using Chart do not change unintentionally. Keep null gaps and actual zeros distinct.
6. Recompose format, hourly heatmap, follower snapshots, lifespan and cadence into the compact grid. Add calendar-day gaps and focus/tap evidence; do not derive provider daily activity from cumulative counters.
7. Lightly restyle the existing tables and move raw metrics/mappings into the shared calculation disclosure. Check sort order/null-last, expansion, pagination, export scope, safe links and cap warning remain identical.
8. Run target-file Prettier checks, then applicable repo lint/type/build/unit checks using repository scripts (`pnpm test` only after confirming unit configuration remains service-free; never direct Vitest or integration tests). Do not read env files, start infra, connect to databases/Redis, or fetch live report endpoints in this workspace.
9. Verify the real `/analytics` React journey with intercepted fixture responses and browser screenshots at 1512/1024/390: platform/account/range/URL filters, keyboard/touch, disclosures, sorting/CSV, null/zero, sparse history, mixed bases, GBP, YouTube, Bluesky, import/reconnect, old payloads, capped posts, loading/error. Intercept **all** API reads, including auth/status/connections/expanded posts; do not start a backend. Keep reference images untracked.
10. Record what fixture/UI checks prove and what remains unverified: live provider accuracy, full collection coverage, scope authorization, and native-platform reconciliation. This proposal does not remove the existing preview badge or establish production validation. Implementation, publishing, and pushing require their separately authorized task.
