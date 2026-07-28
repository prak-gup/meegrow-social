# Google stack: YouTube, Search Console, Google Business Profile

Date: 2026-07-28
Status: design approved in conversation; implementation not started.

## Priority (set by Prakhar, 2026-07-28)

YouTube, Google Search Console, and Google Business Profile are the top three. GA4 and Google Ads
are deferred — they ride the same port once it exists, so deferring them costs nothing.

## Decisions taken

| Decision              | Choice                                                 | Why                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity model        | **Per-client consent**, like Meta today                | Matches the connect-invite flow already shipped; clean offboarding. Cost: OAuth app stays External and must be verified per sensitive scope.                                                 |
| Read-only Google data | **Windsor.ai as the data plane**                       | GA4 (7 properties), Search Console (7 sites) and GBP (1 location) are already connected and already paid for. Building native clients buys no differentiation and costs months of approvals. |
| Publishing            | **Own providers only**                                 | Publishing through Windsor would put a second path outside the queue, DLQ, webhooks and token-health — the split-brain the guardrails exist to prevent.                                      |
| GBP posting interim   | **No interim.** Wait for the own provider              | Windsor's `create_local_post` would work in days but becomes permanent.                                                                                                                      |
| Storage for insights  | **Proxy live + short-TTL cache**, no timeseries tables | Windsor is already the warehouse. A second copy means owning restatement handling (GA4 and Ads both restate for days).                                                                       |
| First target          | **One pilot client end-to-end**                        | Breadth later.                                                                                                                                                                               |

Pilot client: **Value Plus** — the only client with both a Search Console property
(`valueplusretail.com`) and a GBP location (`locations/13790234960711841165`) already live in Windsor.
Its YouTube channel is unconfirmed (see Open questions).

## The finding that reorders the work

Every video uploaded via `videos.insert` from an unaudited API project created after 28 July 2020 is
**restricted to private viewing mode**. The "Meegrow Social" GCP project post-dates that. So YouTube
publishing is not degraded before the YouTube compliance audit — it is unusable: the upload succeeds,
the video is locked private, and the only way to publish it is manually through the YouTube web UI.

That audit (`support.google.com/youtube/contact/yt_api_form`) is a **separate process** from Google
OAuth verification, with its own form and its own clock. Consequence: the highest-priority platform
has the longest lead time, and the lowest-priority one (Search Console) needs no approval at all.

| Platform       | Approvals needed                                                                 | Ships  |
| -------------- | -------------------------------------------------------------------------------- | ------ |
| Search Console | none — Windsor already connected                                                 | first  |
| GBP            | GBP Basic API Access + OAuth verification (`business.manage`)                    | second |
| YouTube        | OAuth verification (`youtube.upload`, `youtube.readonly`) **+ compliance audit** | last   |

The audits gate _launch_, not _development_. Both submissions expect a working app to demo, so the
code must exist first either way.

## Architecture: two ports, not one

`SocialProvider` requires `post()`, `postAnalytics()` and `finalizeAccount()`. A Search Console
property can implement none of them. Forcing read-only sources into that interface yields providers
whose `post()` throws, which breaks the composer, the queue, the invite links and the overview
rollup.

**Port 1 — `SocialProvider` (existing).** YouTube (`youtube`) and GBP (`gmb`) are publishers and
already sit in the `providerIdentifier` enum. Issues #25 and #21.

**Port 2 — `InsightsSource` (new),** in `packages/core/src/insights/`:

```ts
export interface InsightsSource {
  readonly identifier: InsightsSourceIdentifier; // 'search-console' | 'gbp-insights' | 'ga4' | 'google-ads'
  readonly displayName: string;
  listAccounts(): Promise<InsightsAccount[]>;
  fetch(params: {
    accountId: string;
    from: Date;
    to: Date;
    metrics?: string[];
  }): Promise<InsightsRow[]>;
}
```

`InsightsRow = { date, dimensions: Record<string,string>, metrics: Record<string,number> }` — flexible
key-value for the same reason `MetricPoint` is: platforms rename metrics, so nothing canonical gets
hardcoded.

Read-only by construction — no `post()`, so it can never be mistaken for a publishing path. Registry
mirrors `providers/registry.ts` (explicit, no auto-discovery).

**One `WindsorSource` class parameterised by connector, registered per source** — not one class per
platform. Adding GA4, Google Ads, or Meta ad spend later is a registration line.

## The real first task: #44

`PostDetails` is `{ caption, media }`. There is nowhere to express:

- YouTube: `title` (mandatory), `description`, `privacyStatus`, `categoryId`, `tags`
- GBP: `topicType` (STANDARD / EVENT / OFFER / ALERT), CTA `actionType` + `url`, event dates

Issue #44 owns this field but is currently scoped as Meta reels with "Shape TBD". **It must be
designed against YouTube and GBP as well**, or both providers block again the moment they start. It
touches `contracts/posts.ts` and `core/services/posts.ts`, which STATE.md says to serialize.

#44 is therefore task 1, ahead of all three platforms.

## Data model

One new table. `insights_links`:

| column                | notes                                                       |
| --------------------- | ----------------------------------------------------------- |
| `workspace_id`        | FK, RLS predicate                                           |
| `source`              | `'search-console' \| 'gbp-insights' \| …`                   |
| `external_account_id` | Windsor account id, e.g. `https://www.valueplusretail.com/` |
| `display_name`        | for the UI                                                  |
| `linked_at`           |                                                             |

FORCE row-level security, like every other client-data table.

**The isolation risk, stated plainly.** The Windsor API key is platform-level (`WINDSOR_API_KEY` in
env), not per-workspace. That key can read all seven GA4 properties and all seven Search Console
sites. Unlike an OAuth connection — where the token itself is the tenant boundary — here the _only_
thing preventing workspace A from reading workspace B's client is this mapping table. Therefore:

- `fetch()` takes `external_account_id` from the linked row, **never** from request input.
- An integration test in the style of `rls.integration.test.ts` must prove a cross-workspace read
  fails. This is a merge blocker, not a nice-to-have.

## Surface

- `GET  /v1/insights/sources` — what can be linked
- `POST /v1/insights/links` — map a Windsor account to the active workspace
- `GET  /v1/insights/:source?from=&to=&metrics=` — the data, with an `asOf` timestamp
- MCP tool `insights_query` mirroring it (#15)

Both adapters call core. No logic in `apps/`.

## Errors and testing

- Windsor unreachable or rate-limited → the transient/auth split the analytics sweeper already uses.
- Unlinked workspace → 404.
- Cache returned with `asOf`; never silently stale.
- `FakeInsightsSource` mirrors `FakeProvider` so CI runs with no Windsor key.
- YouTube and GBP providers built against recorded fixtures, like the Meta providers.

## Sequencing

**Human, today — three independent clocks:**

1. Verify `meegrowlabs.com` in Search Console as a domain property (DNS TXT), signed in as an account
   that is Owner or Editor on the "Meegrow Social" GCP project. Then publish consent-screen branding
   (homepage `/social/`, privacy `/privacy/`) and request brand verification. **Data-access (scope)
   verification cannot be requested until branding is published** — this gates both YouTube and GBP.
2. Submit the YouTube compliance audit — `support.google.com/youtube/contact/yt_api_form`.
3. Submit GBP Basic API Access — `support.google.com/business/contact/api_default`. Needs a GBP
   verified and active 60+ days plus a website; quota is 0 QPM until granted. Send from an email that
   is an owner/manager on that GBP.

**Code, in order:**

1. **#44** — per-platform post options, designed for reels _and_ YouTube _and_ GBP.
2. **New issue** — `InsightsSource` port + `WindsorSource` + `insights_links` + RLS test, with
   Search Console as the first registered source. No approvals needed; proves the port end-to-end on
   real Value Plus data.
3. **#21** — GBP localPosts publishing. Its performance-metrics half moves to `gbp-insights`, so the
   issue narrows to publishing.
4. **#25** — YouTube provider. Build and test against a Meegrow-owned channel; videos land private
   until the audit clears, which is fine for validating the pipeline and produces the screencast both
   submissions need.
5. On approval: flip flags. No code change.

**Issue housekeeping:** #1 loses its Google Ads and GA4 threads but **keeps** Search Console domain
verification, which remains a hard prerequisite for OAuth even though no GSC API client is being
built.

## Out of scope

No timeseries tables. No charts (#28 owns those). No Windsor write actions. No native GA4 / Google
Ads / Search Console clients. No Google Ads developer token or MCC application.

## Open questions

1. Does the Value Plus pilot have a YouTube channel? If not, pick a different pilot for #25 or use a
   Meegrow-owned channel.
2. Windsor's refresh cadence and per-connector pricing — decides whether the dashboard calls it live
   or needs the nightly cache. Unverified.
3. Whether Windsor's YouTube connector can upload. Assumed read-only; it does not change the plan,
   since publishing stays on the own provider regardless.
