# Google approvals — paste-ready submissions (issue #1)

Date drafted: 2026-07-28. Three independent clocks; **submission 1 gates 2 and 3.**

Everything in `[SQUARE BRACKETS]` is a fact only Prakhar has. Fill those in before submitting.

## Facts needed before you start

| Placeholder            | Where to find it                                                          |
| ---------------------- | ------------------------------------------------------------------------- |
| `[LEGAL_NAME]`         | Exact registered entity name (must match business registration documents) |
| `[LEGAL_ADDRESS]`      | Registered address — street, city, state, postal code, country            |
| `[GCP_PROJECT_NUMBER]` | Cloud Console → project "Meegrow Social" → Dashboard → Project info card  |
| `[GCP_PROJECT_ID]`     | Same card                                                                 |
| `[GCP_OWNER_ACCOUNT]`  | The Google account that is **Owner or Editor** on that project            |
| `[GBP_LOCATION]`       | The verified GBP you'll cite — must be active 60+ days                    |
| `[GBP_OWNER_ACCOUNT]`  | The Google account that is **OWNER** (not manager) of that GBP            |
| `[ORG_SIZE]`           | Employee count / org type                                                 |

---

## 1. Search Console domain verification → OAuth brand verification

Not a form — a prerequisite chain. **Do this first.** Google will not accept a data-access (scope)
verification request until branding is published, and branding cannot be published until the
authorized domain is proven in Search Console.

1. Sign in to `search.google.com/search-console` **as `[GCP_OWNER_ACCOUNT]`**. Using any other
   account is the single most common way this fails — and it fails silently, weeks later.
2. Add a **Domain** property for `meegrowlabs.com` (not a URL-prefix property). Add the TXT record
   it gives you at your DNS host. Verify.
3. Cloud Console → APIs & Services → OAuth consent screen (Branding):
   - App name: `Meegrow Social`
   - User support email: `[GCP_OWNER_ACCOUNT]`
   - App home page: `https://meegrowlabs.com/social/`
   - Privacy policy: `https://meegrowlabs.com/privacy/`
   - Authorized domain: `meegrowlabs.com`
   - Publishing status: **In production** (External)
4. Submit for brand verification. Once branding shows verified, request data-access verification for
   the scopes in §4.

---

## 2. YouTube API Services — Audit and Quota Extension Form

`support.google.com/youtube/contact/yt_api_form`

**Pick the compliance-audit reason, not the quota-extension reason.** The default allocation (100
`videos.insert`/day) is ample for us. What we actually need is the audit that lifts the restriction
locking every API-uploaded video to private. Asking for quota we don't need invites questions we
don't need to answer.

| Field                    | Answer                                   |
| ------------------------ | ---------------------------------------- |
| Applying as              | Organization                             |
| Full legal name          | `[YOUR_FULL_LEGAL_NAME]`                 |
| Organization legal name  | `[LEGAL_NAME]`                           |
| Primary website          | `https://meegrowlabs.com`                |
| Legal address            | `[LEGAL_ADDRESS]`, India                 |
| Category                 | **Marketing and Advertising Technology** |
| Organization size / type | `[ORG_SIZE]`                             |
| Sell ads on YouTube?     | No                                       |
| Google representative?   | No (unless you have one)                 |

### Use-case description (minimum 100 characters — this is the field that gets you approved)

> Meegrow Social is the internal social-media publishing and reporting platform of `[LEGAL_NAME]`, a
> marketing agency based in India. It is invite-only software with no public sign-up; its users are
> our own operators and the clients whose accounts we manage under contract.
>
> We use the YouTube Data API for exactly one write operation: uploading a video to a client's own
> channel on a schedule our operator sets, after that client has explicitly granted our application
> access to their channel through the standard Google OAuth consent screen. We use
> `youtube.readonly` and `yt-analytics.readonly` to read back the resulting video's public
> statistics and the channel's own analytics, which we present to that same client in their
> dashboard as a performance report on the content we published for them.
>
> We do not aggregate data across channels, do not expose one client's data to another (tenant
> isolation is enforced in the database with PostgreSQL row-level security), do not sell or share
> YouTube data with third parties, and do not sell advertising on or within YouTube content.
>
> We are applying for the compliance audit in order to lift the private-viewing restriction on
> videos uploaded via `videos.insert`. We are not requesting quota above the default allocation —
> our expected volume is well under 100 uploads per day.
>
> Data handling: we store YouTube API data only for the client who authorized it, refresh or delete
> stored data within 30 calendar days per Developer Policies III.E.4, and re-verify authorization on
> the same 30-day cycle. Revoking our access in a client's Google account removes our ability to
> read or publish immediately.

**Before you submit this, read §5** — the last paragraph is a commitment our code does not yet keep.

---

## 3. Google Business Profile — Application for Basic API Access

`support.google.com/business/contact/api_default` → dropdown → **"Application for Basic API Access"**

**Submit while signed in as `[GBP_OWNER_ACCOUNT]`.** Applications sent from a manager-level account
are bounced. Quota stays at 0 QPM until this is granted — a 429 on the API means "not approved yet",
not "slow down".

| Field          | Answer                                       |
| -------------- | -------------------------------------------- |
| Project number | `[GCP_PROJECT_NUMBER]`                       |
| Project ID     | `[GCP_PROJECT_ID]`                           |
| Business name  | `[LEGAL_NAME]`                               |
| Business GBP   | `[GBP_LOCATION]` (verified, active 60+ days) |
| Website        | `https://meegrowlabs.com`                    |

### Use case

> `[LEGAL_NAME]` is a marketing agency in India. We manage Google Business Profiles for our own
> clients, who grant us owner or manager access to their profiles as part of a service contract, and
> for our own business location `[GBP_LOCATION]`.
>
> We are building an internal publishing tool, Meegrow Social (https://social.meegrowlabs.com),
> which lets our operators schedule and publish Business Profile posts and read performance data for
> the profiles we manage, instead of logging into each profile by hand. It is invite-only, with no
> public sign-up, and each client's data is isolated at the database level.
>
> Endpoints we need:
>
> - `mybusinessaccountmanagement.googleapis.com/v1` — list the accounts we manage
> - `mybusinessbusinessinformation.googleapis.com/v1` — list locations and read business information
> - `mybusiness.googleapis.com/v4/accounts/*/locations/*/localPosts` — create and manage local posts
> - `businessprofileperformance.googleapis.com/v1` — read impressions, direction requests and calls
>   for the profiles we manage
>
> Every profile we access is one where the profile owner has granted us access. We do not access
> profiles we do not manage.

You'll get a confirmation email with a case number — that's how you know it's queued. Reported
turnaround ranges from about a week to six.

---

## 4. OAuth data-access verification — scope justifications

Submit after brand verification shows as published (§1). One justification per scope; Google rejects
requests where a narrower scope would do, so each of these names why the narrower option fails.

| Scope                            | Justification                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.../auth/youtube.upload`        | Publishing a client's video to their own channel on a schedule. This is the only scope that permits `videos.insert`; no read-only scope can publish.                                 |
| `.../auth/youtube.readonly`      | Listing the client's channel at connect time so the operator can pick which channel to link, and reading back the uploaded video's status and public statistics for their report.    |
| `.../auth/yt-analytics.readonly` | Channel-level analytics (views, watch time) shown to the channel's own owner in their dashboard. `youtube.readonly` does not expose analytics.                                       |
| `.../auth/business.manage`       | Creating Business Profile posts and reading performance metrics for profiles the client has granted us access to. Business Profile exposes no narrower read-only or post-only scope. |

### Demo video shot list

Requirements are strict and specific; a video that misses one gets the whole submission bounced.

1. Start on `https://social.meegrowlabs.com` showing the app name and branding **exactly as
   submitted**.
2. Click Connect for the platform. Record the **full Google OAuth consent screen**, unclipped, with
   the language toggle set to **English**, showing **precisely the scopes listed above** — no more.
3. Grant consent and land back in the app.
4. Then demonstrate **each scope doing its job**: compose and publish a post to the connected
   account; open the analytics view showing the numbers read back. A scope shown on the consent
   screen but never exercised on camera is a rejection reason.
5. Show where the client can revoke access.

Upload unlisted to YouTube and paste the link into the verification request.

---

## 5. What our code must change before §2 is truthful

The YouTube use-case description above commits to Developer Policies III.E.4. **We do not currently
comply**, and this is not a paperwork detail — it is what a compliance audit inspects.

- **`metrics` rows are stored indefinitely.** For YouTube-sourced rows, Authorized Data must be
  deleted or refreshed within **30 calendar days**. Our analytics sweeper (#9) refreshes on its own
  cadence, but nothing guarantees the 30-day ceiling or deletes rows that fall out of it.
- **Authorization must be re-verified every 30 days** for data we keep. The token-health sweeper
  (#12) gets us close, but it is not wired to metric retention.
- Publicly available statistics may be kept up to 36 months only under specific approved use-case
  categories. Assume 30 days unless we're granted otherwise.

Concretely, before submitting §2 we should either implement a 30-day retention/refresh sweep for
YouTube-sourced metrics, or narrow the description to say we do not store YouTube analytics at all
and read them live. **The second option is cheaper, is consistent with the proxy-not-store decision
already taken for the Google read plane, and is the one I'd recommend.**

This deserves its own issue before #25 ships.
