import { ProviderConflictError } from '@meegrow-social/core';
import { updateRemotePostInput, trashRemotePostInput } from '@meegrow-social/contracts';
import { updateRemotePost, trashRemotePost, refreshRemotePost } from '@meegrow-social/core';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {
  addClientPersonInput,
  analyticsReportQuery,
  overviewQuery,
  bulkPostMetricsInput,
  calendarPostsQuery,
  changePasswordInput,
  connectCredentialsInput,
  createApiKeyInput,
  createInviteInput,
  inviteIdParam,
  inviteScopeQuery,
  createPostInput,
  listPostGroupsQuery,
  createWorkspaceInput,
  createQueueInput,
  finishConnectInput,
  finishInviteFlowInput,
  importPostsInput,
  listPostsQuery,
  loginInput,
  logsAggregateInput,
  logsQueryInput,
  passwordConnectInput,
  providerIdentifier,
  queueSlotsQuery,
  registerMediaFromUrlInput,
  siteCheckInput,
  startConnectInput,
  switchWorkspaceInput,
  updatePostInput,
  updateQueueInput,
  validateMediaInput,
} from '@meegrow-social/contracts';
import {
  AccessDeniedError,
  PersonExistsError,
  addClientPerson,
  listClientPeople,
  removeClientPerson,
  manageWorkspaceApiKeys,
  aggregateEventLogs,
  authenticateApiKey,
  authenticateSession,
  encryptToken,
  decryptToken,
  buildUserView,
  createClientWorkspace,
  CONNECT_FLOW_MAX_AGE_MS,
  createConnectInvite,
  getConnectInvite,
  calendarPosts,
  callbackCarriesCredential,
  cancelPost,
  completeCredentialCallback,
  connectWithCredentials,
  changePasswordWithLimit,
  checkConnectSite,
  connectWithPassword,
  ConnectionNotFoundError,
  createPost,
  createQueue,
  createSession,
  DEFAULT_MEDIA_DISK_DIR,
  deleteConnection,
  deleteQueue,
  duplicatePostGroup,
  finishConnect,
  finishInviteConnect,
  AnalyticsQueryError,
  getAnalyticsReport,
  getAnalyticsReportForUser,
  getAnalyticsStatus,
  getConnectionHealth,
  getInviteFlow,
  getLatestPostMetrics,
  getMedia,
  getPost,
  getPostGroup,
  getConnectionFollowers,
  getPostMetrics,
  getQueue,
  handleCallback,
  ImportNotSupportedError,
  isWorkspaceMember,
  listConnectionHealth,
  MediaSourceError,
  listConnections,
  overviewForUser,
  listPostGroups,
  listPosts,
  loginWithPassword,
  previewQueueSlots,
  listConnectableProviders,
  listQueues,
  openCallbackOutcome,
  queryEventLogs,
  QueueInactiveError,
  QueueNotFoundError,
  recordApiRequestLog,
  registerMediaFromUrl,
  requestPostImport,
  retryPost,
  revokeSession,
  rotateSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  startConnect,
  startInviteConnect,
  listConnectInvites,
  revokeConnectInvite,
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
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
  tryGetProvider,
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
      title: 'Connected — you can close this tab',
      detail: 'The account is connected. You can close this tab.',
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
export function connectPopupHtml(payload: unknown, provider = 'unknown'): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const origin = JSON.stringify(appUrl().replace(/\/$/, ''));
  const outcome = connectOutcome(payload);
  const p = (payload ?? {}) as { provider?: unknown; status?: unknown; accounts?: unknown };
  const signalProvider =
    typeof p.provider === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(p.provider)
      ? p.provider
      : provider;
  const picker =
    p.status === 'choose_account' && Array.isArray(p.accounts)
      ? p.accounts
          .map((account) => {
            const a = account as { externalId?: unknown; displayName?: unknown };
            return typeof a.externalId === 'string' && typeof a.displayName === 'string'
              ? `<button type="button" data-account="${escapeHtml(a.externalId)}">${escapeHtml(a.displayName)}</button>`
              : '';
          })
          .join('')
      : '';
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
button,a{display:inline-block;margin:16px 8px 0 0;font:inherit}button{padding:8px 12px;cursor:pointer}#accounts button{display:block;width:100%;text-align:left}
</style>
</head>
<body>
<main>
<div class="logo"><svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x=".5" y=".5" width="31" height="31" rx="9" fill="#fff" stroke="#ddd"/><path d="M8 21 L14 14 L18 17 L24 9" stroke="#ff385c" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="9" r="2.6" fill="#222"/></svg>meegrow<span>·social</span></div>
<h1 id="t">${escapeHtml(outcome.title)}</h1>
<p id="m">${escapeHtml(outcome.detail)}</p>
<div id="accounts">${picker}</div>
<button type="button" id="close">Close this tab</button>
<a href="/connections">Back to Connections</a>
</main>
<script>
(function () {
  var payload = ${json};
  var provider = ${JSON.stringify(signalProvider)};
  function announce(outcome) {
    var signal = { provider: provider, outcome: outcome, time: Date.now() };
    try { var channel = new BroadcastChannel('meegrow-social-connect-completion'); channel.postMessage(signal); channel.close(); } catch (_) {}
    try { window.localStorage.setItem('mg_connect_completion', JSON.stringify(signal)); } catch (_) {}
  }
  if (payload.status === 'connected') announce('success');
  else if (payload.status === 'error' || (payload.status === 'choose_account' && !payload.accounts.length)) announce('failure');
  document.getElementById('close').onclick = function () { window.close(); };
  if (payload.status === 'choose_account' && payload.accounts.length && !window.opener) {
    document.getElementById('t').textContent = 'Choose the account to connect';
    document.getElementById('m').textContent = 'Access was approved. Choose an account below to finish connecting.';
    document.querySelectorAll('[data-account]').forEach(function (button) {
      button.onclick = async function () {
        button.disabled = true;
        try {
          var response = await fetch('/v1/connections/finish', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flowId: payload.flowId, externalId: button.getAttribute('data-account') }) });
          var result = await response.json();
          if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Could not connect this account. Return to Connections and try again.');
          document.getElementById('t').textContent = 'Connected — you can close this tab';
          document.getElementById('m').textContent = button.textContent + ' is now connected.';
          document.getElementById('accounts').hidden = true;
          announce('success');
        } catch (error) {
          document.getElementById('m').textContent = error.message;
          button.disabled = false;
          announce('failure');
        }
      };
    });
  }
  if (window.opener) {
    window.opener.postMessage({ source: 'meegrow-social-connect', payload: payload }, ${origin});
    if (payload.status === 'choose_account' && payload.accounts.length) {
      document.getElementById('m').textContent = 'Continue choosing an account in Connections. Nothing is connected yet.';
    }
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

/**
 * The client a connect-invite call is about: the caller's active one, or a named one. An API key is
 * one workspace's credential; only a human member may reach across clients. Null means refuse —
 * the same answer for a client the caller is not in and one that does not exist.
 */
async function inviteWorkspace(ctx: AuthContext, requested?: string): Promise<string | null> {
  if (!requested || requested === ctx.workspaceId) return ctx.workspaceId;
  if (!ctx.userId || !(await isWorkspaceMember(ctx.userId, requested))) return null;
  return requested;
}

function inviteUrl(token: string): string {
  return `${appUrl().replace(/\/$/, '')}/i/${token}`;
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

/** A fixed-vocabulary reason (core `CONNECT_FAILURE_MESSAGES`) as a sentence for a form. */
function sentence(reason: string): string {
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

/** The HTTP status for each way a username-and-password connect can be refused. */
const PASSWORD_CONNECT_STATUS: Record<string, number> = {
  // 422, not 401: the caller's own session is fine, and must not read this as "signed out".
  login_rejected: 422,
  role_cannot_publish: 422,
  check_expired: 409,
  site_unreachable: 502,
};

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: trustProxySetting() });
  // Authenticated, session-bound result cookie survives callback routing across API instances.
  const resultCookie = 'mg_connect_result';
  const resultPath = '/v1/connections/latest-connect-result';
  const resultKey = (req: FastifyRequest): string | null => {
    const token = req.cookies[SESSION_COOKIE];
    return token ? createHash('sha256').update(token).digest('hex') : null;
  };
  const recordConnectResult = (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const p = (payload ?? {}) as { status?: unknown; error?: unknown; accounts?: unknown };
    const empty =
      p.status === 'choose_account' && Array.isArray(p.accounts) && p.accounts.length === 0;
    if (p.status !== 'connected' && p.status !== 'error' && !empty) return;
    const session = resultKey(req);
    if (!session) return;
    const result = {
      session,
      outcome: p.status === 'connected' ? 'success' : 'failure',
      time: Date.now(),
      ...(typeof p.error === 'string'
        ? { reason: p.error.slice(0, 1000) }
        : empty
          ? { reason: connectOutcome(payload).detail }
          : {}),
    };
    reply.setCookie(resultCookie, encryptToken(JSON.stringify(result)), {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      path: resultPath,
      maxAge: 300,
    });
  };
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AccessDeniedError) return reply.code(403).send({ error: error.message });
    if (error instanceof PersonExistsError) return reply.code(409).send({ error: error.message });
    const path = req.url.split('?')[0] ?? '';
    if (
      req.method === 'POST' &&
      req.cookies[SESSION_COOKIE] &&
      (path === '/v1/connections/finish' || /^\/v1\/invite\/flow\/[^/]+\/finish$/.test(path))
    ) {
      recordConnectResult(req, reply, {
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not finish connecting this account.',
      });
    }
    return reply.send(error);
  });
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
      // Where a credential-bearing callback redirects to. Public for the callback's reason; what
      // it shows is sealed by the server (core `openCallbackOutcome`), not taken from the link.
      path === '/connect/done' ||
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
    // Viewers may read tenant data and change their own credentials, but may not mutate content.
    if (
      ctx.role === 'viewer' &&
      (path === '/mcp' ||
        path.startsWith('/v1/connections/invites') ||
        (path.startsWith('/v1/connections/') && path.endsWith('/auth-url')) ||
        (!['GET', 'HEAD'].includes(req.method) &&
          !path.startsWith('/v1/auth/') &&
          path !== '/v1/posts/metrics/latest'))
    )
      return reply.code(403).send({ error: 'viewer access is read-only' });
    if (ctx.sessionId && req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
      return reply.code(403).send({ error: 'cross-origin request blocked' });
    }
  });

  app.get('/v1/connections/latest-connect-result', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const session = resultKey(req);
    const sealed = req.cookies[resultCookie];
    if (!session || !sealed) return reply.send(null);
    try {
      const result = JSON.parse(decryptToken(sealed)) as {
        session?: unknown;
        outcome?: unknown;
        reason?: unknown;
        time?: unknown;
      };
      if (
        result.session !== session ||
        (result.outcome !== 'success' && result.outcome !== 'failure') ||
        typeof result.time !== 'number' ||
        !Number.isFinite(result.time) ||
        result.time > Date.now() ||
        Date.now() - result.time > 300_000
      )
        return reply.send(null);
      return reply.send({
        outcome: result.outcome,
        time: result.time,
        ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
      });
    } catch {
      return reply.send(null);
    }
  });

  // Request-logging hook (PRD F8.1): records every authed /v1 call into event_logs. Does NOT
  // fire for /mcp — that route hijacks the reply (see below) which Fastify excludes from
  // onResponse, so /mcp logs itself explicitly.
  // The route is logged as its pattern; the fallback (no route matched) drops the query string,
  // because a query can carry a secret — the connect callback's does — and a log is forever.
  app.addHook('onResponse', async (req, reply) => {
    logRequest(
      req.authContext,
      req.routeOptions.url ?? req.url.split('?')[0] ?? '',
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
    const parsed = overviewQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return await overviewForUser(userId, undefined, parsed.data.timezone);
    } catch (err) {
      if (err instanceof AnalyticsQueryError) return reply.code(400).send({ error: err.message });
      throw err;
    }
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

  // People management is owner-only in core, including the target workspace membership check.
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/people',
    async (req, reply) => {
      const id = inviteIdParam.safeParse(req.params.workspaceId);
      if (!id.success) return reply.code(404).send({ error: 'not found' });
      reply.header('cache-control', 'no-store');
      return { people: await listClientPeople(req.authContext!, id.data) };
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/people',
    async (req, reply) => {
      const id = inviteIdParam.safeParse(req.params.workspaceId);
      if (!id.success) return reply.code(404).send({ error: 'not found' });
      const parsed = addClientPersonInput.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: 'valid email and client role required' });
      const result = await addClientPerson(req.authContext!, id.data, parsed.data, req.ip);
      reply.header('cache-control', 'no-store');
      if ('rateLimited' in result) return tooManyAttempts(reply, result.retryAfterSeconds);
      return reply.code(201).send(result);
    },
  );
  app.delete<{ Params: { workspaceId: string; userId: string } }>(
    '/v1/workspaces/:workspaceId/people/:userId',
    async (req, reply) => {
      const id = inviteIdParam.safeParse(req.params.workspaceId);
      const user = inviteIdParam.safeParse(req.params.userId);
      if (!id.success || !user.success) return reply.code(404).send({ error: 'not found' });
      const removed = await removeClientPerson(req.authContext!, id.data, user.data);
      if (!removed) return reply.code(404).send({ error: 'not found or an owner' });
      return { removed: true };
    },
  );

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
      try {
        const { url } = await startConnect(req.authContext!.workspaceId, provider.data, appUrl());
        return { url };
      } catch (err) {
        // A provider that needs an answer first (WordPress: the site's address) says so here.
        if (err instanceof ProviderBadRequestError)
          return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  // Start connecting a provider that needs something from the person first (`connectInput` on
  // GET /v1/providers) — WordPress needs the site's address before there is anywhere to send them.
  // Works for every provider (the body is then ignored), so a client need not know which is which.
  // The flow's proof cookie is set when core returns one: that provider's callback carries a
  // credential, and core will only complete the flow in the browser holding this cookie.
  app.post<{ Params: { provider: string } }>(
    '/v1/connections/:provider/start',
    async (req, reply) => {
      const provider = providerIdentifier.safeParse(req.params.provider);
      if (!provider.success) return reply.code(400).send({ error: 'unknown provider' });
      const parsed = startConnectInput.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'enter the address of the site' });
      try {
        const started = await startConnect(
          req.authContext!.workspaceId,
          provider.data,
          appUrl(),
          undefined,
          parsed.data,
        );
        if (started.proof) {
          reply.setCookie(
            inviteFlowCookie(started.flowId),
            started.proof,
            inviteFlowCookieOptions(),
          );
        }
        return { url: started.url };
      } catch (err) {
        if (err instanceof ProviderBadRequestError)
          return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  // Look at a site address before anyone logs in: which connect methods it can use, and why not
  // when it cannot. The dialog asks this first, so a site that cannot be connected by approval is
  // offered the other method instead of a dead-end error. Unauthenticated requests to the site.
  app.post<{ Params: { provider: string } }>(
    '/v1/connections/:provider/site-check',
    async (req, reply) => {
      const provider = providerIdentifier.safeParse(req.params.provider);
      if (!provider.success) return reply.code(400).send({ error: 'unknown provider' });
      const parsed = siteCheckInput.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'enter the address of the site' });
      try {
        return await checkConnectSite(
          req.authContext!.workspaceId,
          provider.data,
          parsed.data.siteUrl,
        );
      } catch (err) {
        if (err instanceof ProviderBadRequestError)
          return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  // Connect a site with a username and LOGIN password, for sites that cannot issue this app a
  // password of its own (WordPress with Application Passwords switched off). The dashboard posts
  // the form here once; core verifies it against the site, stores it encrypted, and that is the
  // last place it exists outside the site.
  //
  // What keeps the password out of everything else:
  //  - the response is `{ connectionId, displayName, externalId, endpoint }` or `{ error, code }`
  //    with a sentence from core's fixed vocabulary — never the body, never the site's text;
  //  - a body that fails validation is answered with one fixed sentence, not the zod error (which
  //    can quote what was sent);
  //  - `errorHandler` below replaces Fastify's default for this route, which would answer with
  //    `error.message` — and a JSON parse error's message quotes the body it could not parse;
  //  - request logging (the onResponse hook) records the route pattern and status, never a body,
  //    and Fastify's own logger is off.
  // Attempts are limited in core, per site, per caller and per address: this server must not be a
  // way to guess at somebody's WordPress login.
  app.post<{ Params: { provider: string } }>(
    '/v1/connections/:provider/password',
    {
      errorHandler: (error, _req, reply) => {
        const status =
          typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500
            ? error.statusCode
            : 500;
        void reply
          .code(status)
          .header('cache-control', 'no-store')
          .send({
            error:
              status === 500 ? 'the site could not be connected' : 'the request could not be read',
          });
      },
    },
    async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      const provider = providerIdentifier.safeParse(req.params.provider);
      if (!provider.success) return reply.code(400).send({ error: 'unknown provider' });
      const parsed = passwordConnectInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'enter the username and password' });
      }
      const ctx = req.authContext!;
      const outcome = await connectWithPassword(ctx.workspaceId, provider.data, parsed.data, {
        ip: req.ip,
        actor: ctx.userId ?? `workspace:${ctx.workspaceId}`,
      });
      if (outcome.ok) {
        const { ok: _ok, ...connected } = outcome;
        return reply.code(201).send(connected);
      }
      if (outcome.reason === 'rate_limited') {
        const minutes = Math.ceil(outcome.retryAfterSeconds / 60);
        return reply
          .code(429)
          .header('retry-after', String(outcome.retryAfterSeconds))
          .send({
            error:
              'Too many login attempts for this site from here. Try again in ' +
              `${minutes} minute${minutes === 1 ? '' : 's'}.`,
            code: 'rate_limited',
          });
      }
      return reply
        .code(PASSWORD_CONNECT_STATUS[outcome.reason] ?? 400)
        .send({ error: sentence(outcome.message), code: outcome.reason });
    },
  );

  // Connect a provider that hands people a credential to paste (`connectInput: 'credentials'` on
  // GET /v1/providers): a Bluesky app password, a Telegram bot token, a Discord or Slack webhook
  // address. One authenticated POST: core verifies the credential against the platform and stores
  // it encrypted. The body is a secret from end to end — it is not logged (the onResponse hook
  // records route and status only; Fastify's logger is off) and no answer repeats any of it.
  // Attempts are limited in core, per client address and per workspace + platform.
  app.post<{ Params: { provider: string } }>(
    '/v1/connections/:provider/credentials',
    {
      // Fastify's default answers with `error.message`, and a JSON parse error's message quotes
      // the body it could not parse — here, a credential. (Same reason as the /password route.)
      errorHandler: (error, _req, reply) => {
        const status =
          typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500
            ? error.statusCode
            : 500;
        void reply
          .code(status)
          .header('cache-control', 'no-store')
          .send({
            error:
              status === 500
                ? 'the connection could not be completed'
                : 'the request could not be read',
          });
      },
    },
    async (req, reply) => {
      const provider = providerIdentifier.safeParse(req.params.provider);
      if (!provider.success) return reply.code(400).send({ error: 'unknown provider' });
      const parsed = connectCredentialsInput.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'fill in every field' });
      reply.header('cache-control', 'no-store');
      try {
        const result = await connectWithCredentials(
          req.authContext!.workspaceId,
          provider.data,
          parsed.data.fields,
          req.ip,
        );
        if (!result.ok) return tooManyAttempts(reply, result.retryAfterSeconds);
        return reply.code(201).send({
          connectionId: result.connectionId,
          displayName: result.displayName,
          reconnected: result.reconnected,
        });
      } catch (err) {
        if (err instanceof ProviderBadRequestError)
          return reply.code(400).send({ error: err.message });
        // 422, not 401: the platform refused ITS credential; this app's session is fine.
        if (err instanceof ProviderAuthError) return reply.code(422).send({ error: err.message });
        if (err instanceof ProviderTransientError)
          return reply.code(503).send({ error: err.message });
        // Anything else is ours. Its text is not sent: it was built around a secret-bearing call.
        return reply.code(500).send({ error: 'the connection could not be completed' });
      }
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
      // A pasted credential is entered in the dashboard only: the public invite page has no form
      // for one, and a link that asks a client for a token is not something to send around yet.
      if (tryGetProvider(provider.data)?.connectInput === 'credentials') {
        return reply
          .code(400)
          .send({ error: 'this platform is connected from the dashboard, not by invite link' });
      }
      const parsed = createInviteInput.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const ctx = req.authContext!;
      const workspaceId = await inviteWorkspace(ctx, parsed.data.workspaceId);
      if (!workspaceId) return reply.code(403).send({ error: 'not a member of that workspace' });
      const invite = await createConnectInvite(
        workspaceId,
        provider.data,
        ctx.userId ?? workspaceId,
      );
      return reply.code(201).send({
        url: inviteUrl(invite.token),
        token: invite.token,
        provider: invite.provider,
        expiresAt: invite.expiresAt,
      });
    },
  );

  // The links of a client that still work (operator view), and cancelling one. Same reach as the
  // mint route: the active client, or — for a session — any client the user belongs to.
  app.get<{ Querystring: { workspaceId?: string } }>(
    '/v1/connections/invites',
    async (req, reply) => {
      const parsed = inviteScopeQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const workspaceId = await inviteWorkspace(req.authContext!, parsed.data.workspaceId);
      if (!workspaceId) return reply.code(403).send({ error: 'not a member of that workspace' });
      const invites = await listConnectInvites(workspaceId);
      return {
        invites: invites.map(({ token, ...invite }) => ({ ...invite, url: inviteUrl(token) })),
      };
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { workspaceId?: string } }>(
    '/v1/connections/invites/:id',
    async (req, reply) => {
      const parsed = inviteScopeQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const workspaceId = await inviteWorkspace(req.authContext!, parsed.data.workspaceId);
      if (!workspaceId) return reply.code(403).send({ error: 'not a member of that workspace' });
      // Not a uuid → not an invite; answered here so it never reaches the database as a bad cast.
      const id = inviteIdParam.safeParse(req.params.id);
      if (!id.success || !(await revokeConnectInvite(workspaceId, id.data))) {
        return reply.code(404).send({ error: 'not found' });
      }
      return { revoked: true };
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
      ...(invite.connectInput ? { connectInput: invite.connectInput } : {}),
    };
  });

  // Public: the client clicked Connect — start the OAuth for the invite's workspace + provider. The
  // flow carries the workspaceId, so no session on the client's side is needed; the proof cookie is
  // what lets this browser, and no other, pick the account afterwards.
  app.post<{ Params: { token: string } }>('/v1/invite/:token/start', async (req, reply) => {
    // The body is optional: only an invite for a `connectInput` provider sends one (a site address).
    const parsed = startConnectInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'enter the address of the site' });
    let started: Awaited<ReturnType<typeof startInviteConnect>>;
    try {
      started = parsed.data.siteUrl
        ? await startInviteConnect(req.params.token, appUrl(), parsed.data)
        : await startInviteConnect(req.params.token, appUrl());
    } catch (err) {
      if (err instanceof ProviderBadRequestError)
        return reply.code(400).send({ error: err.message });
      throw err;
    }
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
    if (result.status !== 'connected') {
      recordConnectResult(req, reply, {
        status: 'error',
        error:
          result.status === 'failed'
            ? result.error
            : result.status === 'expired'
              ? 'this connection step expired before it was finished'
              : result.status === 'used'
                ? 'this connection step was already completed'
                : result.status === 'invalid_account'
                  ? 'that account is not one of the accounts offered'
                  : 'this connection step is not available in this browser',
      });
      return inviteFlowRefusal(reply, result);
    }
    recordConnectResult(req, reply, { status: 'connected' });
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
  // An invite-started flow is refused outright in any other browser (core `handleCallback`).
  // handleCallback still returns the CallbackResult contract; only the transport differs.
  //
  // WordPress does not send a `code`: its redirect carries the credential itself (`user_login` +
  // `password`, an application password) in this URL's query string. Such a callback is never
  // answered with a page. Core handles it and the reply is a 303 to /connect/done carrying only a
  // sealed result, so the secret does not stay in the address bar or the tab's history, is not
  // sent on as a Referer, and is not cached. Nothing in this app logs the query: request logging
  // (the onResponse hook) skips unauthenticated routes and records the route pattern, Fastify's own
  // logger is off, and no failure of this branch is rethrown into an error page.
  app.get<{ Querystring: Record<string, string | string[] | undefined> }>(
    '/connect/callback',
    async (req, reply) => {
      // A parameter given twice is not something a platform sends; it is dropped, not guessed at.
      const query: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.query)) {
        if (typeof value === 'string') query[name] = value;
      }
      const { state, code, error } = query;
      if (callbackCarriesCredential(query)) {
        const sealed = await completeCredentialCallback(
          query,
          state ? req.cookies[inviteFlowCookie(state)] : undefined,
        );
        if (state) reply.clearCookie(inviteFlowCookie(state), { path: '/' });
        return reply
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .redirect(`${appUrl().replace(/\/$/, '')}/connect/done?${sealed}`, 303);
      }
      const send = (payload: unknown, status: number): void => {
        recordConnectResult(req, reply, payload);
        void reply.code(status).type('text/html; charset=utf-8').send(connectPopupHtml(payload));
      };
      if (!state || !code) {
        // A fixed phrase, never the query's own text: this page must not echo what a link says.
        const reason =
          error === 'access_denied'
            ? 'access was not approved on the platform’s screen'
            : error === 'disabled'
              ? 'the site does not allow application passwords for that account'
              : 'missing state or code';
        return send({ status: 'error', error: reason }, 400);
      }
      try {
        const result = await handleCallback(state, code, req.cookies[inviteFlowCookie(state)]);
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

  // Public: where a credential-bearing callback lands after its redirect. Same page as the
  // callback's own (it hands the result to the dashboard that opened the popup, or says what
  // happened when there is none), but the result is read from a seal only this server can make.
  app.get<{ Querystring: Record<string, unknown> }>('/connect/done', async (req, reply) => {
    const payload = openCallbackOutcome(req.query);
    recordConnectResult(req, reply, payload);
    return reply
      .code(payload.status === 'connected' ? 200 : 400)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(connectPopupHtml(payload, 'wordpress'));
  });

  app.post('/v1/connections/finish', async (req, reply) => {
    const parsed = finishConnectInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const connectionId = await finishConnect(
      req.authContext!.workspaceId,
      parsed.data.flowId,
      parsed.data.externalId,
    );
    recordConnectResult(req, reply, { status: 'connected' });
    return reply.code(201).send({ connectionId });
  });

  // --- API keys (#8) ---------------------------------------------------------------------------
  // Deliberately NOT exposed over MCP: an agent that can mint or revoke credentials for its own
  // workspace is a footgun, and nothing in the agent flows needs it. Key management is a human
  // action. Core requires an owner/admin session; API keys cannot mint replacement credentials.
  app.post('/v1/api-keys', async (req, reply) => {
    const parsed = createApiKeyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const created = await manageWorkspaceApiKeys(req.authContext!, 'create', parsed.data.name);
    // The only response that ever carries the secret — it is not stored and cannot be re-shown.
    return reply.code(201).send(created);
  });

  app.get('/v1/api-keys', async (req) => ({
    apiKeys: await manageWorkspaceApiKeys(req.authContext!, 'list'),
  }));

  app.delete<{ Params: { id: string } }>('/v1/api-keys/:id', async (req, reply) => {
    const ok = await manageWorkspaceApiKeys(req.authContext!, 'revoke', req.params.id);
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
      ...(p.connectInput ? { connectInput: p.connectInput } : {}),
      ...(p.connectMethods ? { connectMethods: [...p.connectMethods] } : {}),
    })),
  }));

  app.get('/v1/connections', async (req) => ({
    connections: await listConnections(req.authContext!.workspaceId, {
      googleOAuthTesting: process.env.GOOGLE_OAUTH_TESTING === 'true',
    }),
  }));

  // Account health, from stored state only — no live platform call (see `listConnectionHealth`).
  // Static path: registered alongside the parametric routes below, and wins over them.
  app.get('/v1/connections/health', async (req) => ({
    connections: await listConnectionHealth(req.authContext!.workspaceId, undefined, {
      googleOAuthTesting: process.env.GOOGLE_OAUTH_TESTING === 'true',
    }),
  }));

  app.get<{ Params: { id: string } }>('/v1/connections/:id/health', async (req, reply) => {
    const health = await getConnectionHealth(req.authContext!.workspaceId, req.params.id, {
      googleOAuthTesting: process.env.GOOGLE_OAUTH_TESTING === 'true',
    });
    if (!health) return reply.code(404).send({ error: 'not found' });
    return { health };
  });

  app.delete<{ Params: { id: string } }>('/v1/connections/:id', async (req, reply) => {
    const ok = await deleteConnection(req.authContext!.workspaceId, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { deleted: true };
  });

  // "Import past posts": queue a read of the account's existing posts for the chosen window. The
  // worker does the reading; this only records the request, so it answers at once (202) with the
  // state to poll on `GET /v1/connections`. Asking while a run is queued or in progress changes
  // nothing and reports that run.
  app.post<{ Params: { id: string } }>('/v1/connections/:id/import', async (req, reply) => {
    const parsed = importPostsInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const state = await requestPostImport(
        req.authContext!.workspaceId,
        req.params.id,
        parsed.data,
      );
      if (!state) return reply.code(404).send({ error: 'not found' });
      return reply.code(202).send({ import: state });
    } catch (err) {
      // A platform whose provider cannot list its posts.
      if (err instanceof ImportNotSupportedError)
        return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Follower trend for one connection (#9), newest first.
  app.get<{ Params: { id: string } }>('/v1/connections/:id/followers', async (req, reply) => {
    const conns = await listConnections(req.authContext!.workspaceId, {
      googleOAuthTesting: process.env.GOOGLE_OAUTH_TESTING === 'true',
    });
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

  // Latest metrics for up to 200 posts in one read (#28) — the list screens need a number per card
  // and one request per post does not scale. Static path, so it wins over `/v1/posts/:id/…`. A POST
  // only because the id list does not fit a query string; it reads and writes nothing.
  app.post('/v1/posts/metrics/latest', async (req, reply) => {
    const parsed = bulkPostMetricsInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return {
      metrics: await getLatestPostMetrics(req.authContext!.workspaceId, parsed.data.postIds),
    };
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

  for (const action of ['refresh', 'update', 'trash'] as const) {
    app.post<{ Params: { id: string } }>(`/v1/posts/:id/remote/${action}`, async (req, reply) => {
      const ctx = req.authContext!;
      try {
        let post;
        if (action === 'refresh') post = await refreshRemotePost(ctx, req.params.id);
        else if (action === 'update') {
          const parsed = updateRemotePostInput.safeParse(req.body);
          if (!parsed.success)
            return reply.code(400).send({ error: 'Invalid remote article edit.' });
          post = await updateRemotePost(ctx, req.params.id, parsed.data);
        } else {
          const parsed = trashRemotePostInput.safeParse(req.body);
          if (!parsed.success)
            return reply
              .code(400)
              .send({ error: 'Explicit confirmation and modification date are required.' });
          post = await trashRemotePost(ctx, req.params.id, parsed.data);
        }
        if (!post) return reply.code(404).send({ error: 'not found' });
        return { post };
      } catch (err) {
        if (err instanceof PostStateError || err instanceof ProviderConflictError)
          return reply.code(409).send({ error: err.message });
        if (err instanceof ProviderBadRequestError)
          return reply.code(400).send({ error: err.message });
        if (err instanceof ProviderAuthError) return reply.code(401).send({ error: err.message });
        if (err instanceof ProviderTransientError)
          return reply.code(503).send({ error: err.message });
        throw err;
      }
    });
  }

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

  // One item per composed post, with every per-platform post in it. Paginated by group, so a
  // group is never split across pages the way grouping `GET /v1/posts` client-side would.
  app.get('/v1/post-groups', async (req, reply) => {
    const parsed = listPostGroupsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { groups: await listPostGroups(req.authContext!.workspaceId, parsed.data) };
  });

  // Copy a whole group into a new group of drafts. Never publishes. `Idempotency-Key` as on create.
  app.post<{ Params: { id: string } }>('/v1/post-groups/:id/duplicate', async (req, reply) => {
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = (Array.isArray(rawKey) ? rawKey[0] : rawKey)?.trim() || undefined;
    if (idempotencyKey && idempotencyKey.length > 255) {
      return reply.code(400).send({ error: 'Idempotency-Key must be at most 255 characters' });
    }
    try {
      const group = await duplicatePostGroup(req.authContext!.workspaceId, req.params.id, {
        idempotencyKey,
      });
      if (!group) return reply.code(404).send({ error: 'not found' });
      return reply.code(201).send({ group });
    } catch (err) {
      // An account of the source has since been disconnected: nothing is copied.
      if (err instanceof ConnectionNotFoundError)
        return reply.code(404).send({ error: err.message });
      if (err instanceof ProviderBadRequestError)
        return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/v1/post-groups/:id', async (req, reply) => {
    const group = await getPostGroup(req.authContext!.workspaceId, req.params.id);
    if (!group) return reply.code(404).send({ error: 'not found' });
    return { group };
  });

  // When this workspace's metrics were last collected and when the next poll falls due, with the
  // cadence rules as data — so no client hardcodes "refreshes hourly".
  app.get('/v1/analytics/status', async (req) => getAnalyticsStatus(req.authContext!.workspaceId));

  // The Analytics screen in one read: totals against the prior period, per-platform and over-time
  // breakdowns, best times, formats, top posts, the raw native metrics. All arithmetic is core's.
  // `scope=all` adds up every workspace the session's user belongs to, so it needs a session.
  app.get('/v1/analytics/report', async (req, reply) => {
    const parsed = analyticsReportQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const ctx = req.authContext!;
    try {
      if (parsed.data.scope === 'all') {
        if (!ctx.userId) return reply.code(401).send({ error: 'session required' });
        return await getAnalyticsReportForUser(ctx.userId, parsed.data);
      }
      return await getAnalyticsReport(ctx.workspaceId, parsed.data);
    } catch (err) {
      if (err instanceof AnalyticsQueryError) return reply.code(400).send({ error: err.message });
      throw err;
    }
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
    let media;
    try {
      media = await registerMediaFromUrl(req.authContext!.workspaceId, parsed.data);
    } catch (err) {
      // A refused or unreachable address is the caller's to fix, and the message says nothing
      // about what the address answered.
      if (err instanceof MediaSourceError) return reply.code(400).send({ error: err.message });
      throw err;
    }
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
