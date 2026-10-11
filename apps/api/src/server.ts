import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {
  calendarPostsQuery,
  changePasswordInput,
  createApiKeyInput,
  createInviteInput,
  createPostInput,
  createWorkspaceInput,
  createQueueInput,
  finishConnectInput,
  finishInviteFlowInput,
  listPostsQuery,
  loginInput,
  logsAggregateInput,
  logsQueryInput,
  providerIdentifier,
  queueSlotsQuery,
  registerMediaFromUrlInput,
  switchWorkspaceInput,
  updatePostInput,
  updateQueueInput,
  validateMediaInput,
} from '@meegrow-social/contracts';
import {
  aggregateEventLogs,
  authenticateApiKey,
  authenticateSession,
  buildUserView,
  createApiKeyForWorkspace,
  createClientWorkspace,
  CONNECT_FLOW_MAX_AGE_MS,
  createConnectInvite,
  getConnectInvite,
  calendarPosts,
  cancelPost,
  changePasswordWithLimit,
  ConnectionNotFoundError,
  createPost,
  createQueue,
  createSession,
  DEFAULT_MEDIA_DISK_DIR,
  deleteConnection,
  deleteQueue,
  finishConnect,
  finishInviteConnect,
  getConnectionHealth,
  getInviteFlow,
  getMedia,
  getPost,
  getPostGroup,
  getConnectionFollowers,
  getPostMetrics,
  getQueue,
  handleCallback,
  isWorkspaceMember,
  listApiKeys,
  listConnectionHealth,
  listConnections,
  overviewForUser,
  listPosts,
  loginWithPassword,
  previewQueueSlots,
  listConnectableProviders,
  listQueues,
  queryEventLogs,
  QueueInactiveError,
  revokeApiKey,
  QueueNotFoundError,
  recordApiRequestLog,
  registerMediaFromUrl,
  retryPost,
  revokeSession,
  rotateSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  startConnect,
  startInviteConnect,
  switchActiveWorkspace,
  updatePost,
  updateQueue,
  uploadMedia,
  validateMediaAgainstPlatform,
  validatePost,
  verifyConnectFlowProof,
  type AuthContext,
  type InviteFinishResult,
  PostStateError,
  ProviderBadRequestError,
} from '@meegrow-social/core';
import { buildMcpServer, newStatelessTransport } from './mcp/index.js';

function appUrl(): string {
  return process.env.APP_URL ?? `http://localhost:${process.env.API_PORT ?? 8990}`;
}

/** What a person reads on the callback page when no dashboard is there to take the result. */
export interface ConnectOutcome {
  /** True only when a connection row was created. Nothing else may be worded as success. */
  connected: boolean;
  title: string;
  detail: string;
}

/**
 * The truthful, human wording of a callback result. `choose_account` is NOT a success: the flow is
 * parked waiting for an account pick and no connection exists yet — reporting it as "Connected" is
 * how an invite once looked finished while connecting nothing.
 */
export function connectOutcome(payload: unknown): ConnectOutcome {
  const p = (payload ?? {}) as { status?: unknown; error?: unknown; accounts?: unknown };
  if (p.status === 'connected') {
    return {
      connected: true,
      title: 'Connected',
      detail: 'The account is connected. You can close this window.',
    };
  }
  if (p.status === 'choose_account') {
    if (Array.isArray(p.accounts) && p.accounts.length === 0) {
      return {
        connected: false,
        title: 'Nothing to connect',
        detail:
          'Access was approved, but that login did not offer any account that can be connected. ' +
          'Nothing has been connected.',
      };
    }
    return {
      connected: false,
      title: 'Not connected yet',
      detail:
        'Access was approved, but the account still has to be chosen and this window cannot do ' +
        'that. Nothing has been connected. Go back to the page you started from and connect again.',
    };
  }
  const reason =
    p.status === 'error' && typeof p.error === 'string' ? p.error : 'unexpected result';
  return {
    connected: false,
    title: 'Not connected',
    detail:
      `Connecting failed: ${reason}. Nothing has been connected. Go back to the page you started ` +
      'from and try again. If you were sent a link, open it again.',
  };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * The page the OAuth popup lands on (#45). It hands the callback result to the dashboard that
 * opened it and closes; two-phase providers carry a flowId that exists nowhere else, so dumping
 * JSON into the popup left the user stranded. With no opener (the provider redirected in the
 * top-level window) nobody receives the result, so the page itself says what happened — rendered
 * server-side from `connectOutcome`, so it is right even if the script never runs. An invited
 * client can land here (a single-step platform, or a failed exchange), so it wears the same card and
 * mark as the SPA's invite screens (pages/Invite.tsx) — keep the two in step.
 *
 * The payload is provider-derived (Page names come from Meta), so it is embedded as JSON with `<`
 * escaped — that closes the `</script>` breakout — and the visible text is HTML-escaped. The
 * message is posted to our own origin, never `*`, so nothing else can read it.
 */
export function connectPopupHtml(payload: unknown): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const origin = JSON.stringify(appUrl().replace(/\/$/, ''));
  const outcome = connectOutcome(payload);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(outcome.title)}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f7;color:#222;font:16px/1.5 "Inter Variable",Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
main{box-sizing:border-box;width:calc(100% - 32px);max-width:28rem;padding:32px;background:#fff;border:1px solid #ddd;border-radius:20px;box-shadow:rgba(0,0,0,.02) 0 0 0 1px,rgba(0,0,0,.04) 0 2px 6px 0,rgba(0,0,0,.1) 0 4px 8px 0}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:24px;font-size:19px;font-weight:700;letter-spacing:-.02em;color:#ff385c}
.logo span{color:#222}
h1{margin:0;font-size:20px;font-weight:600;line-height:1.25}
p{margin:8px 0 0;color:#6a6a6a}
</style>
</head>
<body>
<main>
<div class="logo"><svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x=".5" y=".5" width="31" height="31" rx="9" fill="#fff" stroke="#ddd"/><path d="M8 21 L14 14 L18 17 L24 9" stroke="#ff385c" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="9" r="2.6" fill="#222"/></svg>meegrow<span>·social</span></div>
<h1 id="t">${escapeHtml(outcome.title)}</h1>
<p id="m">${escapeHtml(outcome.detail)}</p>
</main>
<script>
(function () {
  var payload = ${json};
  if (window.opener) {
    window.opener.postMessage({ source: 'meegrow-social-connect', payload: payload }, ${origin});
    document.getElementById('t').textContent = 'Finishing up';
    document.getElementById('m').textContent = 'Continue in the window you started from. You can close this one.';
    window.close();
  }
})();
</script>
</body>
</html>`;
}

/**
 * Cookie carrying an invite-started flow's proof (core `signConnectFlow`). One per flow, so a
 * client working through two invite links at once does not lose the first.
 */
export function inviteFlowCookie(flowId: string): string {
  return `mg_flow_${flowId}`;
}

/**
 * Lax, not Strict: the browser must send it on the platform's top-level redirect back to
 * /connect/callback. Lax still withholds it from cross-site POSTs, which covers the finish call.
 */
function inviteFlowCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(CONNECT_FLOW_MAX_AGE_MS / 1000),
  };
}

/** The invite account-pick outcomes that are not a connection, in the `{ error }` shape. */
function inviteFlowRefusal(
  reply: FastifyReply,
  result: Exclude<InviteFinishResult, { status: 'connected' }>,
): FastifyReply {
  switch (result.status) {
    case 'used':
      return reply.code(409).send({ error: 'this connection step was already completed' });
    case 'expired':
      return reply.code(410).send({ error: 'this connection step expired before it was finished' });
    case 'invalid_account':
      return reply.code(400).send({ error: 'that account is not one of the accounts offered' });
    case 'failed':
      return reply.code(502).send({ error: result.error });
    case 'not_found':
      return reply
        .code(404)
        .send({ error: 'this connection step is not available in this browser' });
  }
}

const SESSION_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);

/** Session cookie options. `Secure` is env-gated so dev/test over http still sends the cookie. */
function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  };
}

/**
 * CSRF helper (issue #10). SameSite=Lax on the session cookie is the primary defense; this Origin
 * check is belt-and-suspenders for cookie-authed state changes. An absent Origin is allowed (browsers
 * send Origin on cross-site mutations; we lean on SameSite there). API-key requests aren't checked —
 * bearer headers aren't auto-sent by browsers, so they aren't CSRF-exposed.
 */
function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = [appUrl().replace(/\/$/, '')];
  const extra = process.env.EXTRA_ALLOWED_ORIGINS;
  if (extra) for (const o of extra.split(',')) if (o.trim()) allowed.push(o.trim());
  return allowed.includes(origin);
}

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}

// Largest per-platform spec today is IG reels at 1GB (RESEARCH.md) — leave a little headroom.
const MAX_UPLOAD_BYTES = 1200 * 1024 * 1024;

/**
 * Fire-and-forget request-log write, shared by the `onResponse` hook (covers /v1 routes) and the
 * /mcp handler (which calls `reply.hijack()` — Fastify skips onResponse for hijacked replies, so
 * /mcp logs itself explicitly on the raw socket's `close` event). Never awaited by callers; never
 * throws.
 */
function logRequest(
  ctx: AuthContext | undefined,
  route: string,
  status: number,
  durationMs: number,
): void {
  if (!ctx) return; // unauthed (incl. /healthz, rejected-auth) requests are not logged
  void recordApiRequestLog({ workspaceId: ctx.workspaceId, route, status, durationMs }).catch(
    () => {
      // Logging must never surface as a request failure.
    },
  );
}

/**
 * Which peers may tell us the client's address in `X-Forwarded-For` (Fastify's `trustProxy`).
 *
 * The API is only ever reached through a reverse proxy (Caddy → 127.0.0.1:8990 → the container),
 * so the socket's peer is always the proxy or the Docker gateway — `req.ip` without this is the
 * same private address for every client, which made per-IP anything impossible. The default
 * trusts the header only when the peer is itself loopback/link-local/private, so `req.ip` becomes
 * the right-most address a trusted hop vouches for: the real client. A caller reaching the port
 * directly from a public address is NOT trusted, so it cannot pick its own `req.ip`.
 *
 * `TRUST_PROXY` overrides: `false` (use the socket peer), `true` (trust every hop — only behind a
 * proxy that overwrites the header), or a comma-separated list of addresses/CIDRs — which is what
 * a second proxy on a public address (a CDN in front of Caddy) needs.
 */
export function trustProxySetting(raw = process.env.TRUST_PROXY): boolean | string[] {
  const value = raw?.trim();
  if (!value) return ['loopback', 'linklocal', 'uniquelocal'];
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 429 for a rate-limited password check, in the `{ error }` shape every route here uses. */
function tooManyAttempts(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  return reply
    .code(429)
    .header('retry-after', String(retryAfterSeconds))
    .send({ error: 'too many attempts, try again later' });
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: trustProxySetting() });
  await app.register(cors, { origin: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

  // Disk-backed media is served straight off disk in dev/test; prod (MEDIA_STORAGE_DRIVER=s3)
  // serves public URLs directly from S3 and never needs this route.
  if ((process.env.MEDIA_STORAGE_DRIVER ?? 'disk') !== 's3') {
    await app.register(fastifyStatic, {
      root: resolve(process.env.MEDIA_DISK_DIR ?? DEFAULT_MEDIA_DISK_DIR),
      prefix: '/media/',
      decorateReply: false,
    });
  }

  app.get('/healthz', async () => ({ ok: true }));

  // API-key OR session-cookie auth for everything except health, the public OAuth callback (a
  // browser redirect with no credential — its opaque state is the credential), the public media
  // route, and the public login endpoint.
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (
      path === '/healthz' ||
      path === '/connect/callback' ||
      path === '/v1/auth/login' ||
      // Public connect-invite endpoints — the token in the path is the credential (a client opening
      // the link has no session). The mint endpoint (POST /v1/connections/:p/invite) IS authed.
      path.startsWith('/v1/invite/') ||
      path.startsWith('/media/')
    ) {
      return;
    }
    const key = bearer(req);
    let ctx: AuthContext | null = key ? await authenticateApiKey(key) : null;
    if (!ctx) {
      const token = req.cookies[SESSION_COOKIE];
      if (token) ctx = await authenticateSession(token);
    }
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    req.authContext = ctx;
    if (ctx.sessionId && req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
      return reply.code(403).send({ error: 'cross-origin request blocked' });
    }
  });

  // Request-logging hook (PRD F8.1): records every authed /v1 call into event_logs. Does NOT
  // fire for /mcp — that route hijacks the reply (see below) which Fastify excludes from
  // onResponse, so /mcp logs itself explicitly.
  app.addHook('onResponse', async (req, reply) => {
    logRequest(
      req.authContext,
      req.routeOptions.url ?? req.url,
      reply.statusCode,
      reply.elapsedTime,
    );
  });

  // --- Human auth (issue #10): email+password sessions, invite-only. No public signup. ---
  app.post('/v1/auth/login', async (req, reply) => {
    const parsed = loginInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    // Brute-force limited in core, per client address and per submitted email.
    const login = await loginWithPassword(parsed.data.email, parsed.data.password, req.ip);
    if (!login.ok) {
      if (login.reason === 'rate_limited') return tooManyAttempts(reply, login.retryAfterSeconds);
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const creds = login.user;
    const session = await createSession(creds.id);
    const user = await buildUserView(creds.id);
    if (!user) return reply.code(500).send({ error: 'user not found' });
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions());
    return reply.send({ user, activeWorkspaceId: session.activeWorkspaceId });
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    if (req.authContext?.sessionId) await revokeSession(req.authContext.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/v1/auth/me', async (req, reply) => {
    const userId = req.authContext?.userId;
    if (!userId) return reply.code(401).send({ error: 'session required' });
    const user = await buildUserView(userId);
    if (!user) return reply.code(404).send({ error: 'not found' });
    return { user, activeWorkspaceId: req.authContext!.workspaceId };
  });

  // Switch the workspace this session targets (dashboard workspace switcher, #16). Session-only.
  app.post('/v1/auth/session/workspace', async (req, reply) => {
    const ctx = req.authContext!;
    if (!ctx.sessionId || !ctx.userId) {
      return reply.code(401).send({ error: 'session required' });
    }
    const parsed = switchWorkspaceInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const ok = await switchActiveWorkspace(ctx.sessionId, ctx.userId, parsed.data.workspaceId);
    if (!ok) return reply.code(403).send({ error: 'not a member of that workspace' });
    return { activeWorkspaceId: parsed.data.workspaceId };
  });

  // Cross-client control-tower rollup for the dashboard home (redesign). Session-only — it spans
  // every workspace the user belongs to, which needs their identity, not a single workspace key.
  app.get('/v1/overview', async (req, reply) => {
    const userId = req.authContext?.userId;
    if (!userId) return reply.code(401).send({ error: 'session required' });
    return overviewForUser(userId);
  });

  // Add a client: create a workspace and make the caller its owner. Session-only.
  app.post('/v1/workspaces', async (req, reply) => {
    const userId = req.authContext?.userId;
    if (!userId) return reply.code(401).send({ error: 'session required' });
    const parsed = createWorkspaceInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const created = await createClientWorkspace(userId, parsed.data.name);
    return reply.code(201).send(created);
  });

  // Rotate the session token (sliding renewal). Session-only.
  app.post('/v1/auth/session/rotate', async (req, reply) => {
    const sessionId = req.authContext?.sessionId;
    if (!sessionId) return reply.code(401).send({ error: 'session required' });
    const rotated = await rotateSession(sessionId);
    if (!rotated) return reply.code(401).send({ error: 'session required' });
    reply.setCookie(SESSION_COOKIE, rotated.token, sessionCookieOptions());
    return { ok: true };
  });

  // Change your own password. Session-only: an API key has no user, so a key-authed call is
  // refused before the body is even looked at. Signs the user out everywhere else and re-issues
  // this session's cookie. The body is never logged (the onResponse hook records route/status only).
  // Wrong current passwords are brute-force limited in core, per client address and per user.
  app.post('/v1/auth/password', async (req, reply) => {
    const ctx = req.authContext!;
    if (!ctx.sessionId || !ctx.userId) {
      return reply.code(401).send({ error: 'session required' });
    }
    const parsed = changePasswordInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = await changePasswordWithLimit(
      ctx.userId,
      ctx.sessionId,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      req.ip,
    );
    if (!result.ok) {
      switch (result.reason) {
        case 'rate_limited':
          return tooManyAttempts(reply, result.retryAfterSeconds);
        case 'invalid_current_password':
          // 422, not 401: the session is fine, and a client must not read this as "signed out".
          return reply.code(422).send({ error: 'current password is incorrect' });
        case 'session_not_found':
          return reply.code(401).send({ error: 'session required' });
        case 'same_password':
          return reply
            .code(400)
            .send({ error: 'new password must differ from the current password' });
        case 'invalid_new_password':
          return reply.code(400).send({ error: 'new password does not meet the password policy' });
      }
    }
    reply.setCookie(SESSION_COOKIE, result.token, sessionCookieOptions());
    return { ok: true };
  });

  // --- Connections ---
  app.get<{ Params: { provider: string } }>(
    '/v1/connections/:provider/auth-url',
    async (req, reply) => {
      const provider = providerIdentifier.safeParse(req.params.provider);
      if (!provider.success) return reply.code(400).send({ error: 'unknown provider' });
      const { url } = await startConnect(req.authContext!.workspaceId, provider.data, appUrl());
      return { url };
    },
  );

  // Mint a per-platform connect-invite link (operator action). The client opens the returned URL to
  // connect their own account into the workspace. Defaults to the active client; a session may name
  // another client it belongs to (`workspaceId`), so the Clients page can mint for any row without
  // switching the operator's active client underneath them.
  app.post<{ Params: { provider: string } }>(
    '/v1/connections/:provider/invite',
    async (req, reply) => {
      const provider = providerIdentifier.safeParse(req.params.provider);
      if (!provider.success) return reply.code(400).send({ error: 'unknown provider' });
      const parsed = createInviteInput.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const ctx = req.authContext!;
      const userId = ctx.userId ?? null;
      const workspaceId = parsed.data.workspaceId ?? ctx.workspaceId;
      if (workspaceId !== ctx.workspaceId) {
        // An API key is one workspace's credential; only a human member may reach across clients.
        if (!userId || !(await isWorkspaceMember(userId, workspaceId))) {
          return reply.code(403).send({ error: 'not a member of that workspace' });
        }
      }
      const invite = await createConnectInvite(workspaceId, provider.data, userId ?? workspaceId);
      return reply.code(201).send({
        url: `${appUrl().replace(/\/$/, '')}/i/${invite.token}`,
        token: invite.token,
        provider: invite.provider,
        expiresAt: invite.expiresAt,
      });
    },
  );

  // Public: the invite landing reads what it's for (client name + platform).
  app.get<{ Params: { token: string } }>('/v1/invite/:token', async (req, reply) => {
    const invite = await getConnectInvite(req.params.token);
    if (!invite) return reply.code(404).send({ error: 'this invite link is invalid or expired' });
    return {
      workspaceName: invite.workspaceName,
      provider: invite.provider,
      providerDisplayName: invite.providerDisplayName,
    };
  });

  // Public: the client clicked Connect — start the OAuth for the invite's workspace + provider. The
  // flow carries the workspaceId, so no session on the client's side is needed; the proof cookie is
  // what lets this browser, and no other, pick the account afterwards.
  app.post<{ Params: { token: string } }>('/v1/invite/:token/start', async (req, reply) => {
    const started = await startInviteConnect(req.params.token, appUrl());
    if (!started) return reply.code(404).send({ error: 'this invite link is invalid or expired' });
    reply.setCookie(inviteFlowCookie(started.flowId), started.proof, inviteFlowCookieOptions());
    return { url: started.url };
  });

  // Public: the account picker of an invite-started flow. No session — the flow's proof cookie is
  // the credential (see core `finishInviteConnect`); without it the answer is the same 404 as for
  // a flow that does not exist.
  app.get<{ Params: { flowId: string } }>('/v1/invite/flow/:flowId', async (req, reply) => {
    const { flowId } = req.params;
    const state = await getInviteFlow(flowId, req.cookies[inviteFlowCookie(flowId)]);
    if (state.status !== 'choose_account') return inviteFlowRefusal(reply, state);
    return {
      workspaceName: state.workspaceName,
      provider: state.provider,
      providerDisplayName: state.providerDisplayName,
      accounts: state.accounts,
    };
  });

  // Public: the client picked an account — create the connection in the invite's workspace.
  app.post<{ Params: { flowId: string } }>('/v1/invite/flow/:flowId/finish', async (req, reply) => {
    if (!originAllowed(req)) return reply.code(403).send({ error: 'cross-origin request blocked' });
    const parsed = finishInviteFlowInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { flowId } = req.params;
    const result = await finishInviteConnect(
      flowId,
      req.cookies[inviteFlowCookie(flowId)],
      parsed.data.externalId,
    );
    if (result.status !== 'connected') return inviteFlowRefusal(reply, result);
    reply.clearCookie(inviteFlowCookie(flowId), { path: '/' });
    return reply.code(201).send({
      connectionId: result.connectionId,
      accountName: result.accountName,
      workspaceName: result.workspaceName,
      providerDisplayName: result.providerDisplayName,
    });
  });

  // Public: provider redirects the user's browser here after consent. From the dashboard this lands
  // in the popup it opened, so it answers with a tiny HTML page that hands the result to the opener
  // and closes itself (#45) — a two-phase provider's flowId only exists here, and JSON in a popup
  // is unusable. From an invite there is no opener and no session: when this browser holds the
  // flow's proof and an account still has to be picked, it is sent on to the public picker instead.
  // handleCallback still returns the CallbackResult contract; only the transport differs.
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    '/connect/callback',
    async (req, reply) => {
      const { state, code, error } = req.query;
      const send = (payload: unknown, status: number): void => {
        void reply.code(status).type('text/html; charset=utf-8').send(connectPopupHtml(payload));
      };
      if (!state || !code) {
        // A fixed phrase, never the query's own text: this page must not echo what a link says.
        const reason =
          error === 'access_denied'
            ? 'access was not approved on the platform’s screen'
            : 'missing state or code';
        return send({ status: 'error', error: reason }, 400);
      }
      try {
        const result = await handleCallback(state, code);
        if (
          result.status === 'choose_account' &&
          verifyConnectFlowProof(result.flowId, req.cookies[inviteFlowCookie(result.flowId)])
        ) {
          return reply.redirect(`${appUrl().replace(/\/$/, '')}/i/finish/${result.flowId}`);
        }
        return send(result, 200);
      } catch (err) {
        return send(
          { status: 'error', error: err instanceof Error ? err.message : 'callback failed' },
          400,
        );
      }
    },
  );

  app.post('/v1/connections/finish', async (req, reply) => {
    const parsed = finishConnectInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const connectionId = await finishConnect(
      req.authContext!.workspaceId,
      parsed.data.flowId,
      parsed.data.externalId,
    );
    return reply.code(201).send({ connectionId });
  });

  // --- API keys (#8) ---------------------------------------------------------------------------
  // Deliberately NOT exposed over MCP: an agent that can mint or revoke credentials for its own
  // workspace is a footgun, and nothing in the agent flows needs it. Key management is a human
  // action. (Role gating — only admins — arrives with memberships enforcement in M2; for now any
  // valid key of the workspace can manage that workspace's keys, per the issue.)
  app.post('/v1/api-keys', async (req, reply) => {
    const parsed = createApiKeyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const created = await createApiKeyForWorkspace(req.authContext!.workspaceId, parsed.data.name);
    // The only response that ever carries the secret — it is not stored and cannot be re-shown.
    return reply.code(201).send(created);
  });

  app.get('/v1/api-keys', async (req) => ({
    apiKeys: await listApiKeys(req.authContext!.workspaceId),
  }));

  app.delete<{ Params: { id: string } }>('/v1/api-keys/:id', async (req, reply) => {
    const ok = await revokeApiKey(req.authContext!.workspaceId, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { revoked: true };
  });

  // Which platforms this environment can actually connect. Real providers are registered only when
  // their credentials are set, and core hides the test-only fakes in production, so dev/CI return
  // the fakes and production returns the real providers — the dashboard renders a button per entry
  // rather than hardcoding one (#45).
  app.get('/v1/providers', async () => ({
    providers: listConnectableProviders().map((p) => ({
      identifier: p.identifier,
      displayName: p.displayName,
      isBetweenSteps: p.isBetweenSteps,
    })),
  }));

  app.get('/v1/connections', async (req) => ({
    connections: await listConnections(req.authContext!.workspaceId),
  }));

  // Account health, from stored state only — no live platform call (see `listConnectionHealth`).
  // Static path: registered alongside the parametric routes below, and wins over them.
  app.get('/v1/connections/health', async (req) => ({
    connections: await listConnectionHealth(req.authContext!.workspaceId),
  }));

  app.get<{ Params: { id: string } }>('/v1/connections/:id/health', async (req, reply) => {
    const health = await getConnectionHealth(req.authContext!.workspaceId, req.params.id);
    if (!health) return reply.code(404).send({ error: 'not found' });
    return { health };
  });

  app.delete<{ Params: { id: string } }>('/v1/connections/:id', async (req, reply) => {
    const ok = await deleteConnection(req.authContext!.workspaceId, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { deleted: true };
  });

  // Follower trend for one connection (#9), newest first.
  app.get<{ Params: { id: string } }>('/v1/connections/:id/followers', async (req, reply) => {
    const conns = await listConnections(req.authContext!.workspaceId);
    if (!conns.some((c) => c.id === req.params.id)) {
      return reply.code(404).send({ error: 'not found' });
    }
    return { followers: await getConnectionFollowers(req.authContext!.workspaceId, req.params.id) };
  });

  app.post('/v1/posts', async (req, reply) => {
    const parsed = createPostInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    // D2 — `Idempotency-Key`: a retried create returns the original posts instead of duplicating
    // them. Bounded so a hostile key can't bloat the index; empty/whitespace is treated as absent.
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = (Array.isArray(rawKey) ? rawKey[0] : rawKey)?.trim() || undefined;
    if (idempotencyKey && idempotencyKey.length > 255) {
      return reply.code(400).send({ error: 'Idempotency-Key must be at most 255 characters' });
    }
    try {
      const posts = await createPost(req.authContext!.workspaceId, parsed.data, { idempotencyKey });
      return reply.code(201).send({ posts });
    } catch (err) {
      if (err instanceof QueueNotFoundError) return reply.code(404).send({ error: err.message });
      // A variant names a connection this workspace does not have — its own or anyone else's.
      if (err instanceof ConnectionNotFoundError)
        return reply.code(404).send({ error: err.message });
      if (err instanceof QueueInactiveError) return reply.code(400).send({ error: err.message });
      // A provider's own rules rejected the post at create time (#44) — client error, not a 500.
      if (err instanceof ProviderBadRequestError)
        return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Dry run of POST /v1/posts: same body, nothing created. Always 200 — an invalid post is the
  // answer, not a failed request — so the body is handed to core unparsed and core reports the
  // contract failures as issues alongside the rest.
  app.post('/v1/posts/validate', async (req) =>
    validatePost(req.authContext!.workspaceId, req.body),
  );

  app.get('/v1/posts', async (req, reply) => {
    const parsed = listPostsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { posts: await listPosts(req.authContext!.workspaceId, parsed.data) };
  });

  // Registered before /:id so the static path wins (find-my-way prefers static over parametric).
  app.get('/v1/posts/calendar', async (req, reply) => {
    const parsed = calendarPostsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return calendarPosts(req.authContext!.workspaceId, parsed.data);
  });

  // Per-post metrics (#9): newest value per metric name + the full append-only series. 404s when
  // the post doesn't exist, rather than returning an empty series that looks like "no data yet".
  app.get<{ Params: { id: string } }>('/v1/posts/:id/metrics', async (req, reply) => {
    const post = await getPost(req.authContext!.workspaceId, req.params.id);
    if (!post) return reply.code(404).send({ error: 'not found' });
    return getPostMetrics(req.authContext!.workspaceId, req.params.id);
  });

  app.get<{ Params: { id: string } }>('/v1/posts/:id', async (req, reply) => {
    const post = await getPost(req.authContext!.workspaceId, req.params.id);
    if (!post) return reply.code(404).send({ error: 'not found' });
    return { post };
  });

  app.patch<{ Params: { id: string } }>('/v1/posts/:id', async (req, reply) => {
    const parsed = updatePostInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const post = await updatePost(req.authContext!.workspaceId, req.params.id, parsed.data);
      if (!post) return reply.code(404).send({ error: 'not found' });
      return { post };
    } catch (err) {
      if (err instanceof PostStateError) return reply.code(409).send({ error: err.message });
      if (err instanceof ProviderBadRequestError)
        return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/v1/posts/:id', async (req, reply) => {
    try {
      const ok = await cancelPost(req.authContext!.workspaceId, req.params.id);
      if (!ok) return reply.code(404).send({ error: 'not found' });
      return { cancelled: true };
    } catch (err) {
      if (err instanceof PostStateError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // Re-enqueue a failed post through the scheduler. 409 for any other status, like edit/cancel.
  app.post<{ Params: { id: string } }>('/v1/posts/:id/retry', async (req, reply) => {
    try {
      const post = await retryPost(req.authContext!.workspaceId, req.params.id);
      if (!post) return reply.code(404).send({ error: 'not found' });
      return { post };
    } catch (err) {
      if (err instanceof PostStateError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/v1/post-groups/:id', async (req, reply) => {
    const group = await getPostGroup(req.authContext!.workspaceId, req.params.id);
    if (!group) return reply.code(404).send({ error: 'not found' });
    return { group };
  });

  app.post('/v1/media', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'multipart "file" field is required' });
    const data = await file.toBuffer();
    const media = await uploadMedia(req.authContext!.workspaceId, {
      filename: file.filename,
      contentType: file.mimetype,
      data,
    });
    return reply
      .code(201)
      .send({ mediaId: media.id, url: media.url, kind: media.kind, meta: media.meta });
  });

  app.post('/v1/media/register', async (req, reply) => {
    const parsed = registerMediaFromUrlInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const media = await registerMediaFromUrl(req.authContext!.workspaceId, parsed.data);
    return reply
      .code(201)
      .send({ mediaId: media.id, url: media.url, kind: media.kind, meta: media.meta });
  });

  app.get<{ Params: { id: string } }>('/v1/media/:id', async (req, reply) => {
    const media = await getMedia(req.authContext!.workspaceId, req.params.id);
    if (!media) return reply.code(404).send({ error: 'not found' });
    return { media };
  });

  app.post<{ Params: { id: string } }>('/v1/media/:id/validate', async (req, reply) => {
    const parsed = validateMediaInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const result = await validateMediaAgainstPlatform(
        req.authContext!.workspaceId,
        req.params.id,
        parsed.data.provider,
      );
      return result;
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Queues (PRD F3.4) ---
  app.post('/v1/queues', async (req, reply) => {
    const parsed = createQueueInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const queue = await createQueue(req.authContext!.workspaceId, parsed.data);
    return reply.code(201).send({ queue });
  });

  app.get('/v1/queues', async (req) => ({
    queues: await listQueues(req.authContext!.workspaceId),
  }));

  app.get<{ Params: { id: string } }>('/v1/queues/:id', async (req, reply) => {
    const queue = await getQueue(req.authContext!.workspaceId, req.params.id);
    if (!queue) return reply.code(404).send({ error: 'not found' });
    return { queue };
  });

  // The next N slots add-to-queue would assign — core replays the real slot picker, takes nothing.
  app.get<{ Params: { id: string } }>('/v1/queues/:id/slots', async (req, reply) => {
    const parsed = queueSlotsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return await previewQueueSlots(
        req.authContext!.workspaceId,
        req.params.id,
        parsed.data.count,
      );
    } catch (err) {
      if (err instanceof QueueNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof QueueInactiveError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/v1/queues/:id', async (req, reply) => {
    const parsed = updateQueueInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const queue = await updateQueue(req.authContext!.workspaceId, req.params.id, parsed.data);
    if (!queue) return reply.code(404).send({ error: 'not found' });
    return { queue };
  });

  app.delete<{ Params: { id: string } }>('/v1/queues/:id', async (req, reply) => {
    const deleted = await deleteQueue(req.authContext!.workspaceId, req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  // Logs & observability (PRD F8) — thin parse → call core → serialize, per AX-PRD §2.
  app.get('/v1/logs/aggregate', async (req, reply) => {
    const parsed = logsAggregateInput.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return aggregateEventLogs(req.authContext!.workspaceId, parsed.data);
  });

  app.get('/v1/logs', async (req, reply) => {
    const parsed = logsQueryInput.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return queryEventLogs(req.authContext!.workspaceId, parsed.data);
  });

  // Stateless MCP endpoint — same core services, authed by the same API key.
  app.post('/mcp', async (req, reply) => {
    const server = buildMcpServer(req.authContext!);
    const transport = newStatelessTransport();
    const startedAt = performance.now();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
      logRequest(req.authContext, '/mcp', reply.raw.statusCode, performance.now() - startedAt);
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.hijack();
  });

  // Stateless means POST only: there is no server-to-client stream to open (GET) and no session
  // to end (DELETE). The MCP spec's answer for both is 405, which SDK clients treat as "not
  // offered" and carry on from — a 404 reads as "no MCP server here". These sit behind the auth
  // preHandler like every non-public route, so a caller with no key still gets 401 first: the
  // method table is not readable without a credential, and 401 is what POST /mcp answers too.
  app.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    handler: async (_req, reply) =>
      reply
        .code(405)
        .header('allow', 'POST')
        .send({ error: 'method not allowed: /mcp accepts POST only' }),
  });

  return app;
}
