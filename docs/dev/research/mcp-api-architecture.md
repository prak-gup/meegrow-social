# MCP + REST Architecture Research Brief — meegrow-social

> Greenfield, agency-grade, multi-tenant social-media publishing platform.
> **Primary interfaces:** (1) REST API, (2) hosted **remote MCP server** — both authenticated by per-workspace API keys.
> Consumers: Claude Code, Cowork, Codex, antidote bot. Web dashboard is secondary.
> **Constraint:** light-ops — **Postgres + Redis only** (no Temporal, no Kafka/ES), TypeScript.
>
> This is a decision brief feeding an AX-PRD. Concrete recommendations with reasoning; no implementation code beyond tiny signatures.

---

## TL;DR recommendations

| Decision | Choice | Why |
|---|---|---|
| Monorepo | **pnpm workspaces + Turborepo** | Shared types across `core/api/mcp/worker/web`; one build graph |
| Packages | `core` (services) · `api` (REST) · `mcp` (MCP server) · `worker` (BullMQ) · `web` (dashboard) | Thin adapters over one capability layer |
| REST framework | **Fastify** (+ TypeBox or Zod-schema) | Boring, fast, schema-first, easy for agents to extend one route at a time |
| MCP transport | **Streamable HTTP** (`@modelcontextprotocol/sdk`), stateless mode | Spec-current (2025-11-25); load-balanceable; deprecates HTTP+SSE |
| MCP + REST auth | **Per-workspace API key in `Authorization: Bearer sk_...` header** | Spec-permitted for programmatic/internal servers; agents can't do OAuth dances |
| ORM | **Drizzle** | Types flow from schema (no codegen drift), tiny bundle, SQL-control for RLS |
| DB | **Postgres**, `workspace_id` on every row + optional RLS via `SET LOCAL` | Simple, auditable tenancy |
| Jobs | **BullMQ** repeatable + delayed jobs on Redis | Scheduled publish, analytics polling, token refresh — no Temporal needed |
| Webhooks | Signed (HMAC symmetric) + exponential-backoff retries + DLQ (Svix pattern; self-host or use Svix) | Reliable outbound events to agencies |

---

## 1. Hosted / remote MCP servers (2025–2026 state)

### Streamable HTTP is the transport
The MCP spec defines exactly two standard transports: **stdio** and **Streamable HTTP**. Streamable HTTP **replaces** the old HTTP+SSE transport (from protocol `2024-11-05`); current spec version is **`2025-11-25`**. ([spec/transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports))

Key properties for a hosted multi-tenant server:
- **Single MCP endpoint** (e.g. `https://api.meegrow.social/mcp`) serving **both POST and GET**.
- **POST** carries each JSON-RPC message; client sends `Accept: application/json, text/event-stream`. Server responds with either one JSON object (`application/json`) **or** an SSE stream (`text/event-stream`) when it needs to stream progress/notifications.
- **GET** optionally opens an SSE stream for server→client messages.
- **Stateless-capable**: because any request can be handled independently, you can run **multiple MCP instances behind a standard load balancer** — critical for a hosted product. ([fka.dev](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/), [thenewstack](https://thenewstack.io/how-mcp-uses-streamable-http-for-real-time-ai-tool-interaction/))
- **Sessions** (optional): server may return an `MCP-Session-Id` header on the `InitializeResult`; clients then echo it on every request. For a REST-parity tool server, prefer **stateless** (`sessionIdGenerator: undefined`) — no server-side session store, cleaner horizontal scaling.
- **Security requirements (from spec):** MUST validate `Origin` header (DNS-rebinding defense → 403 on invalid); SHOULD bind localhost-only when local; SHOULD authenticate all connections. Client must also send `MCP-Protocol-Version: 2025-11-25` on subsequent requests.

### Auth: OAuth 2.1 spec vs the pragmatic API-key pattern
The **MCP Authorization spec** (Nov 2025) says remote servers **intended for public/broad use** MUST implement **OAuth 2.1 with PKCE (S256)**, expose **OAuth 2.0 Protected Resource Metadata (RFC 9728)**, and require `Authorization: Bearer <token>` on every request. ([spec/authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization), [Descope](https://www.descope.com/blog/post/mcp-auth-spec), [Stack Overflow blog](https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/))

**However** — the same guidance repeatedly notes that for **internal team tools, agency-driven, and programmatic servers, a static Bearer token / API key in the `Authorization` header is acceptable and often preferable.** ([mcpplaygroundonline](https://mcpplaygroundonline.com/blog/mcp-server-oauth-authentication-guide), [Toolradar](https://toolradar.com/blog/mcp-authentication))

**Recommendation for meegrow-social:** Since consumers are our own agents (Claude Code / Cowork / Codex / antidote) not arbitrary end-users, ship **per-workspace API keys as Bearer tokens** (`Authorization: Bearer sk_live_...`). This is:
- The **same credential** the REST API uses → one auth path.
- Trivial for headless agents (no interactive OAuth redirect flow).
- Spec-compliant as long as we still validate `Origin`, use TLS, and 401 on bad keys.

Keep an **OAuth 2.1 path as a later option** (`.well-known/oauth-protected-resource`) if we ever open the MCP server to third-party end-user clients that expect the discovery dance.

### TypeScript SDK server pattern (Streamable HTTP)
Use `@modelcontextprotocol/sdk`. Modern helper packages: `@modelcontextprotocol/node` (Node Streamable HTTP transport) and `@modelcontextprotocol/express` (`createMcpExpressApp()` adds Host-header validation by default). Runnable examples live in the SDK repo under `src/examples/server`. ([typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk), [Koyeb tutorial](https://www.koyeb.com/tutorials/deploy-remote-mcp-servers-to-koyeb-using-streamable-http-transport))

Tiny illustrative shape (stateless):
```ts
const server = new McpServer({ name: "meegrow-social", version: "1.0.0" });
server.registerTool("schedule_post",
  { inputSchema: SchedulePostInput, outputSchema: PostResult },  // Zod
  async (args, extra) => coreSchedulePost({ workspaceId: extra.auth.workspaceId, ...args }));

// per-request: read Bearer, resolve workspace, then hand off
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);
await transport.handleRequest(req, res, req.body);
```
Auth is enforced in Express/Fastify middleware **before** `handleRequest`; the resolved `workspaceId` is threaded into the tool handler (via a per-request server instance or an async-local-storage context).

---

## 2. Sharing ONE capability layer between REST and MCP

### The "split-brain" problem
The dominant industry failure mode: your HTTP API serves humans/scripts, the MCP server serves agents, **but both call the same logic** — so teams end up maintaining two copies. Add a param to REST → must update the MCP wrapper; rename an endpoint → two changes. This does not scale. ([Stainless](https://www.stainless.com/blog/from-api-to-mcp-a-practical-guide-for-developers/), [dev.to/schrepa](https://dev.to/schrepa/serving-mcp-and-rest-from-the-same-typescript-process-1n41))

### The fix: a shared `core` service layer, two thin adapters
- **`packages/core`** owns all business logic as framework-agnostic **use-cases/services**: `schedulePost()`, `pollAnalytics()`, `listAccounts()`, `refreshToken()`. Each takes a typed input + a `WorkspaceContext` and returns a typed result. **No HTTP, no MCP, no framework imports here.**
- **Zod schemas are defined once** in `core` (or a `contracts` package) and imported by *both* adapters. REST validates request bodies with them; MCP uses the same objects as `inputSchema`/`outputSchema`. Shared schemas = shared validation = **no drift**. ([Medium/jageenshukla](https://medium.com/@jageenshukla/building-a-typescript-mcp-server-a-guide-for-integrating-existing-services-5bde3fc13b23))
- **`packages/api`** (Fastify): each route is a ~5-line adapter — parse+auth → call `core` use-case → serialize.
- **`packages/mcp`**: each tool is a ~5-line adapter — `registerTool(name, {schema}, handler)` where the handler calls the *same* `core` use-case.
- **Rule (borrowed from MCP middleware guidance):** adapters MUST be thin — **no business logic in the adapter**, ever. That is the single discipline that prevents drift. ([WorkOS MCP vs REST](https://workos.com/blog/mcp-vs-rest))

Result: adding a capability = add one `core` service + one Zod schema + register in two 5-line adapters. An AFK agent can do this mechanically.

> Note: MCP tools are **not** 1:1 with REST endpoints. REST is resource/CRUD-shaped; MCP tools should be **task-shaped** ("schedule_post", "get_post_performance") for good agent ergonomics. Both still delegate to `core`. ([Scalekit](https://www.scalekit.com/blog/map-api-into-mcp-tool-definitions))

---

## 3. Recommended stack (light-ops, TypeScript)

### Framework comparison
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **(a) Fastify + BullMQ + Drizzle + Postgres** | ~30–35k req/s, schema-first validation (TypeBox/Zod), minimal magic, thin routes are easy for agents to add/read, small surface | You assemble structure yourself (DI, module layout) | **RECOMMENDED** |
| **(b) NestJS** | DI + modules + enterprise conventions, great for 10+ devs / many bounded contexts; can run on Fastify adapter | Decorator/DI indirection adds cognitive load; heavier for a small team; more "framework to learn" for AFK agents | Overkill now |
| **(c) Next.js full-stack (API routes + React)** | One repo, one deploy, dashboard co-located | API routes ~5k req/s (React runtime overhead); route handlers are an awkward home for a **primary** programmatic API + long-running jobs; MCP/worker don't belong in Next | Use Next **only** for the secondary dashboard |

Sources: [Encore NestJS vs Fastify vs Hono](https://encore.dev/articles/nestjs-vs-fastify-vs-hono), [NestJS vs Next.js 2026](https://tech-insider.org/nestjs-vs-nextjs-2026/), [wfnext](https://wfnext.com/blog/expressjs-vs-fastify-vs-nestjs-2026/).

**Why Fastify over NestJS here:** our differentiator is *agent-buildability and ownability*. Fastify keeps the codebase "boring": a route is a function, a service is a function, types are explicit. NestJS's DI/decorator layer is worth it at 10+ engineers across bounded contexts — not for an agency team leaning on AFK agents where **less framework magic = fewer ways for an agent to go wrong.** (If we later outgrow it, NestJS-on-Fastify is a contained migration.)

**ORM: Drizzle over Prisma.** Drizzle's types flow directly from the TS schema with **no codegen step** (Prisma drifts if you forget `prisma generate`), ~7.4kb, SQL-level control (useful for RLS `SET LOCAL` and tenant filters), 3–5x faster cold starts. Prisma's edge is migration DX; acceptable trade. ([Bytebase](https://www.bytebase.com/blog/drizzle-vs-prisma/), [Encore](https://encore.dev/articles/drizzle-vs-prisma))

### Monorepo layout
```
meegrow-social/            (pnpm workspace + turborepo)
  packages/
    core/     # use-cases/services + Zod contracts + provider interfaces (NO framework)
    db/       # Drizzle schema + migrations + tenant-scoped client
    api/      # Fastify REST — thin route adapters
    mcp/      # Streamable HTTP MCP server — thin tool adapters
    worker/   # BullMQ workers + repeatable job registration
    web/      # Next.js dashboard (secondary)
```
Turborepo caches builds/tests across the graph; shared types cross package boundaries with zero duplication. ([Turborepo monorepo guidance](https://encore.dev/articles/nestjs-vs-fastify)) Deploy `api`, `mcp`, `worker` as separate processes (single-instance concerns like the antidote bot's Telegram-polling rule don't apply — these are stateless HTTP + a queue consumer).

---

## 4. Scheduled jobs on Redis (BullMQ)

BullMQ (Redis-backed) covers all three cadence needs with no Temporal. From BullMQ 2.0+, no separate `QueueScheduler` is needed. ([BullMQ repeatable](https://docs.bullmq.io/guide/jobs/repeatable), [dev.to background jobs 2026](https://dev.to/young_gao/background-job-processing-in-nodejs-bullmq-queues-and-worker-patterns-31d4))

- **(a) Publish a post at a scheduled time** → **delayed job**: enqueue with `{ delay: scheduledAt - now }` (or compute at enqueue). On fire, worker calls `core.publishPost()`. Store the `jobId` on the DB row so a reschedule/cancel removes/replaces the delayed job.
- **(b) Poll analytics on a cadence** → **repeatable job**: cron or fixed-interval (`{ repeat: { pattern: "*/30 * * * *" } }` or `{ every: ms }`), one per workspace/account, fanning out fetch jobs.
- **(c) Refresh OAuth tokens before expiry** → **delayed job scheduled at `expiresAt - safetyMargin`** (e.g. −10 min), OR a repeatable sweep that refreshes any token expiring within the next window. Delayed-per-token is more precise; a sweeper is simpler and self-healing. Recommend the **sweeper** (repeatable every ~5 min → refresh tokens expiring within 15 min) for robustness against missed jobs.

### Reliability patterns
- **Retries + backoff:** `{ attempts: 5, backoff: { type: "exponential", delay: 1000 } }`. BullMQ's exponential formula is `2^(attempts-1) * delay`, with optional **jitter** (0–1 multiplier) to avoid thundering herds. ([BullMQ retrying](https://docs.bullmq.io/guide/retrying-failing-jobs), [oneuptime backoff](https://oneuptime.com/blog/post/2026-01-21-bullmq-retry-exponential-backoff/view))
- **Idempotency:** "no difference to final state whether a job completes first try or after retries." Use a **durable idempotency key** recorded *atomically with the side effect* — e.g. before calling a platform publish API, check/insert `(workspace_id, post_id, platform)` into a `publish_attempts` unique-constraint table; if the row exists as "published", short-circuit. Use platform post IDs to dedupe. ([BullMQ delivery guarantees](https://github.com/taskforcesh/bullmq/discussions/2223))
- **Dead-letter queue:** BullMQ has **no built-in DLQ**, but the pattern is standard — on `failed` after final attempt, move the job's data to a `*-dlq` queue for inspection/manual replay. Watch it. ([oneuptime DLQ](https://oneuptime.com/blog/post/2026-01-21-bullmq-dead-letter-queue/view))
- **Transactional outbox** (optional, later): if a webhook/event MUST fire exactly when DB data commits, write the event to an `outbox` table in the same transaction, and a poller enqueues it. Keeps "publish event ⇔ data committed" atomic. ([digitalapplied 2026 reference](https://www.digitalapplied.com/blog/background-job-queue-patterns-2026-engineering-reference))

---

## 5. Multi-tenant data model basics

- **`workspace_id` on every tenant-owned row.** Index it; it's the first predicate on virtually every query. Compound indexes lead with `workspace_id`.
- **Tenant context threading:** every `core` use-case receives a `WorkspaceContext { workspaceId, scopes }` resolved from the API key — never trust a `workspace_id` in the request body.
- **Optional defense-in-depth: Postgres Row-Level Security.** Enable RLS on tenant tables; policy filters `workspace_id = current_setting('app.workspace_id')::uuid`. Set it per transaction with **`SET LOCAL app.workspace_id = ...`** so pooled connections never leak tenant context across requests. ([PG RLS docs](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [Nile multi-tenant RLS](https://www.thenile.dev/blog/multi-tenant-rls), [AWS RLS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)) Start with **app-layer scoping in Drizzle** (a tenant-bound client that injects `where workspace_id = ?`); add RLS as a belt-and-suspenders layer before GA.
- **Per-workspace API keys table:** `api_keys(id, workspace_id, key_hash, key_prefix, scopes[], name, last_used_at, revoked_at, expires_at, created_at)`.

---

## 6. API-key auth + webhooks

### Issuing & hashing keys
- **Format:** prefixed opaque string, e.g. `sk_live_<random>` / `sk_test_<random>` (Stripe-style). The prefix communicates environment and lets you scan-detect leaked keys. Store a short **`key_prefix`** (first ~8 chars) in plaintext for UI display ("sk_live_ab…") and fast lookup narrowing.
- **Hashing:** the **raw key is shown once** at creation; store only a hash. **SHA-256** is fine for high-entropy random keys (they're not low-entropy passwords, so bcrypt's slow-hash benefit is marginal and costs latency on every request); bcrypt/argon2 is defensible if you want uniformity. On each request: hash the presented key → look up by hash → verify not revoked/expired → load `workspace_id` + `scopes`. ([dev.to two key types](https://dev.to/hamurda/why-my-multi-tenant-chatbot-needed-two-types-of-api-keys-4248), [makerkit Supabase keys](https://makerkit.dev/blog/tutorials/supabase-api-key-management))
- **Scopes:** e.g. `posts:write`, `posts:read`, `analytics:read`, `accounts:manage`. Enforce in the auth middleware and re-check in `core` use-cases. MCP tools declare their required scope so an under-scoped agent key can't schedule publishes.
- Update `last_used_at` asynchronously (don't block the request); support instant revocation.

### Outbound webhooks (agencies subscribe to events: post_published, publish_failed, analytics_ready)
Follow the **Svix pattern** (self-host the OSS core, or use Svix directly — Postgres/Redis backed, fits our ops): ([Svix](https://www.svix.com/), [svix-webhooks GH](https://github.com/svix/svix-webhooks))
- **Async, never synchronous** from the request path — enqueue delivery on BullMQ so a slow/down subscriber never blocks the API. ([Svix sending](https://www.svix.com/resources/webhook-best-practices/sending/))
- **Signed payloads:** HMAC signature over `id.timestamp.body` with a per-endpoint secret (symmetric is the Svix default — faster/simpler than asymmetric). Send `webhook-id`, `webhook-timestamp`, `webhook-signature` headers so receivers verify authenticity and reject replays. ([Svix signatures])
- **Retries with exponential backoff + jitter:** Svix's schedule is immediate, 5s, 5m, 30m, 2h, 5h, 10h, 10h. Jitter avoids retry thundering-herd. ([Svix retries](https://www.svix.com/resources/webhook-best-practices/retries/))
- **Idempotency for receivers:** deliver a stable `webhook-id` and document that handlers must dedupe on it.
- **DLQ / manual replay** for endpoints that exhaust retries, plus a dashboard to inspect/redeliver.

---

## 7. AX (agent-experience) considerations

The whole point: this codebase must be **safely extendable by Claude Code AFK agents**. Design for the tight **write → typecheck → test → fix** loop that agents excel at *when the scaffolding exists*. ([agentexperience.ax](https://agentexperience.ax/all/), [AddyOsmani AI workflow](https://addyosmani.com/blog/ai-coding-workflow/), [Loop Engineering](https://explainx.ai/blog/loop-engineering-coding-agents-claude-code-guide-2026))

Concrete design rules:
1. **Strict types end-to-end.** `strict: true`, no `any`. Drizzle (schema→types) + Zod contracts mean a wrong shape fails at compile time — the fastest feedback an agent gets. Types are the guardrail that lets an agent refactor confidently.
2. **One capability = one predictable diff.** Because logic lives in `core` + adapters are thin (§2), "add a feature" is a mechanical, template-shaped change across known files. Document the recipe in `CLAUDE.md` / a `docs/dev/adding-a-capability.md` playbook.
3. **A `provider` interface for platforms.** Define `SocialProvider { publish(), getAnalytics(), refreshToken() }`; each platform (X, LinkedIn, Instagram, …) implements it. Agents add a new platform by implementing one interface + registering it — no changes to `core` orchestration. This is the single most leveraged AX decision for a social platform.
4. **Tests as the feedback gate.** Fast unit tests on `core` use-cases (pure functions, easy to test), contract tests asserting REST and MCP expose the same schemas, and a provider test-double. Agents "get the most out of coding when tests exist." A pre-merge `turbo test typecheck lint` gate is the loop's verification step.
5. **Machine-readable surfaces.** Generate OpenAPI from Fastify schemas and expose MCP tool schemas — agents (and the MCP self-description) read these to self-correct. Keep them auto-derived from the shared Zod contracts so they can't drift.
6. **Boring beats clever.** Prefer explicit functions over DI magic, obvious file layout, and a single documented way to do each thing — every reduction in "framework surprise" is a reduction in agent error rate.

---

## Open questions for the AX-PRD
- Do any MCP consumers need **stateful sessions / streaming progress** (long publishes)? If yes, keep the stateful `MCP-Session-Id` path available; default stateless.
- Self-host Svix vs. depend on Svix SaaS — ops vs. speed trade for webhooks.
- Whether to enforce Postgres RLS from day 1 or ship app-layer tenant scoping first, RLS before GA.
- Do we ever expose the MCP server to **third-party end-user** clients (→ then implement full OAuth 2.1 + RFC 9728 discovery), or stay agent/agency-only (→ API-key Bearer is enough)?
