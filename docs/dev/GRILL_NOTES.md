# GRILL_NOTES — meegrow-social

Product: Meegrow-owned social media management platform, bottom-up build, Zernio as design reference.
Replaces: paid Zernio account + self-hosted Postiz (postiz.meegrowlabs.com — being handed to Priyanshi as keep-alive during the build).

## Standing context (from screenshots + memory, 2026-07-06)
- 27 Zernio screenshots reviewed: Connections (profiles + token health), Posts (grid/list/calendar + queues + CSV import), Inbox (Messages/Comments/Reviews/Campaigns[Broadcasts/Sequences/Comment-to-DM]/Workflows/Contacts), Ads (Campaigns/Audiences/Lead Forms, boost post), Numbers (WhatsApp), API Keys (per-key scope+perms), Users (roles+access), Webhooks, Logs (filterable API/event logs), Analytics (posting + inbox), Settings (profile/notifications/Slack/AI providers/billing).
- Prakhar's REAL usage of Zernio: per-client API keys (Antidote, Ecolive, GLs, Mlearn, Empower&Shine) called by the antidote bot; Connections; Queues; E&S Instagram inbox has real DM/comment volume. Ads/Numbers/Workflows/Broadcasts unused.
- Platform developer-app assets already owned (the true moat): Meta app 2214641422606935 (IG+FB publish working), Google Cloud project "Meegrow Social" (GBP publish working; YouTube creds exist; OAuth production verification in progress), LinkedIn app (Community Management API / Microsoft vetting pending), X API keys.
- Thesis agreed: hard part = platform approvals (owned), not code. Focused publishing-core v1 is buildable; full parity is a product company.

## Round 1 decisions (2026-07-06)
1. **v1 scope = Publishing core + API.** Connections+OAuth w/ token health, profiles/workspaces (per-client), posts + queues + calendar, per-client API keys, webhooks, logs, basic post analytics. Inbox is v2; Ads/Numbers/Workflows later/maybe never.
2. **Audience = agency tool with multi-tenant DNA.** Workspaces + roles + client logins from day one; NO self-serve signup/billing in v1. SaaS door stays open.
3. **Platforms v1 = Meta (IG+FB) + Google Business, AND LinkedIn + X + YouTube.** Caveat accepted: LinkedIn vetting + Google YouTube verification are external blockers — build the providers, ship them behind flags; launch doesn't gate on them. Provider layer designed so adding a platform is cheap.
4. **Build strategy = greenfield, Postiz as reference.** Own codebase/UX/data model; read Postiz provider code for scopes/endpoints/quirks (knowledge, not code — also avoids AGPL entanglement).

## Round 2 decisions (2026-07-06)
5. **Design principles = fix all four pains**: (a) real client tenancy (workspaces, per-workspace API keys, client logins); (b) light ops — Postgres + Redis ONLY, no Temporal/ES; (c) API + webhooks + logs as first-class product surface (Zernio's Logs/API Keys screens are the bar); (d) UX polish on composer/queues/calendar/token-health at Zernio level.
6. **MCP is a first-class interface** (Prakhar addition): hosted MCP server exposing the same capabilities as the API, authenticated by per-client API keys, so Claude Code / Cowork / Codex / other agents connect directly. API and MCP share one capability layer.
7. **API contract = clean new API + small adapter in antidote.** No Zernio-shape compatibility debt.
8. **Media v1 = images + video/reels.** S3-backed media library; upload + validation/transcode-check, no editing. AI generation stays in antidote — platform accepts media, doesn't create it.
9. **Analytics v1 = collect-everything from day 0, simple UI.** Scheduled workers persist per-post metrics + follower counts into Postgres (history compounds, can't backfill). UI: per-post stats + follower trend. Rich dashboards later.

## Round 3 decisions (2026-07-06)
10. **Human auth = email+password + Google SSO, invite-only.** Owner invites users into workspaces; no public signup.
11. **Scheduling = queues + direct schedule + calendar.** Per-profile queues with timezone-aware weekly slots; add-to-queue fills next slot; exact-datetime scheduling; grid/list/calendar views; states draft/scheduled/published/failed/cancelled; retry on failure. (Client-approval flow deliberately deferred — revisit v1.1; antidote already has its own approval loop.)
12. **Hosting = new dedicated EC2 + docker compose at social.meegrowlabs.com.** App + worker + Postgres + Redis; Caddy auto-HTTPS; S3 (+CloudFront if needed) for media. ~$15–30/mo.
13. **Cutover criterion = 2-week parallel run, all 5 client workspaces,** antidote publishing via new API/MCP alongside Zernio with zero missed/failed posts → cancel Zernio, decommission Postiz.

## Roadmap additions (user-raised)
14. **Blotato-style "winning posts" template engine — sequenced AFTER platform v1** (user: "first we create this and then pick that up"). Scope when picked up: library of proven post formats/hooks (viral templates), AI remix into client voice, repurposing chains (long-form → platform-native posts). Architectural implication for v1: posts/media APIs must be clean enough that a Templates/Studio module (or antidote) can compose drafts programmatically — which the API-first design already guarantees. Include a Blotato teardown in Phase 2 RESEARCH.md.

## Open threads / to grill later
- Name + domain: recommend keeping "Meegrow Social" brand (Google project + meegrowlabs.com/social/ page already exist) → app at social.meegrowlabs.com. OAuth redirect URIs must be added per provider for the new domain.
- Hosting: recommend single EC2 + docker compose (Postgres + Redis + app + worker) + Caddy — no Temporal/Elasticsearch (explicit anti-goal from Postiz pain).
- Team build model: Prakhar + Claude agents (HITL/AFK per e2e-dev); Priyanshi runs Postiz keep-alive + QA milestones.
- What happens to prak-gup/meegrow-social-postiz handoff issues once this ships: issues #2/#3 (approvals) still matter — they unblock THIS product's LinkedIn/YouTube providers. Reframe later.
