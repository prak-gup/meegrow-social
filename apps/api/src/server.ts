import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {
  calendarPostsQuery,
  createApiKeyInput,
  createPostInput,
  createWorkspaceInput,
  createQueueInput,
  finishConnectInput,
  listPostsQuery,
  loginInput,
  logsAggregateInput,
  logsQueryInput,
  providerIdentifier,
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
  createConnectInvite,
  getConnectInvite,
  calendarPosts,
  cancelPost,
  createPost,
  createQueue,
  createSession,
  DEFAULT_MEDIA_DISK_DIR,
  deleteConnection,
  deleteQueue,
  finishConnect,
  getMedia,
  getPost,
  getPostGroup,
  getConnectionFollowers,
  getPostMetrics,
  getQueue,
  handleCallback,
  listApiKeys,
  listConnections,
  overviewForUser,
  listPosts,
  listProviders,
  listQueues,
  queryEventLogs,
  QueueInactiveError,
  revokeApiKey,
  QueueNotFoundError,
  recordApiRequestLog,
  registerMediaFromUrl,
  revokeSession,
  rotateSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  startConnect,
  switchActiveWorkspace,
  updatePost,
  updateQueue,
  uploadMedia,
  validateMediaAgainstPlatform,
  verifyUserCredentials,
  type AuthContext,
  PostStateError,
  ProviderBadRequestError,
} from '@meegrow-social/core';
import { buildMcpServer, newStatelessTransport } from './mcp.js';

function appUrl(): string {
  return process.env.APP_URL ?? `http://localhost:${process.env.API_PORT ?? 8990}`;
}

/**
 * The page the OAuth popup lands on (#45). It hands the callback result to the dashboard that
 * opened it and closes; two-phase providers carry a flowId that exists nowhere else, so dumping
 * JSON into the popup left the user stranded. Falls back to rendering the outcome as text when
 * there's no opener (e.g. the provider redirected in the top-level window).
 *
 * The payload is provider-derived (Page names come from Meta), so it is embedded as JSON with `<`
 * escaped — that closes the `</script>` breakout, the only injection route into this page. The
 * message is posted to our own origin, never `*`, so nothing else can read it.
 */
export function connectPopupHtml(payload: unknown): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const origin = JSON.stringify(appUrl().replace(/\/$/, ''));
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Connecting…</title></head>
<body style="font:14px system-ui;padding:24px;color:#111">
<p id="m">Finishing up — you can close this window.</p>
<script>
(function () {
  var payload = ${json};
  if (window.opener) {
    window.opener.postMessage({ source: 'meegrow-social-connect', payload: payload }, ${origin});
    window.close();
  } else {
    document.getElementById('m').textContent =
      payload.status === 'error' ? 'Connect failed: ' + payload.error : 'Connected. You can close this window.';
  }
})();
</script>
</body>
</html>`;
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

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
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
    const creds = await verifyUserCredentials(parsed.data.email, parsed.data.password);
    if (!creds) return reply.code(401).send({ error: 'invalid credentials' });
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

  // Mint a per-platform connect-invite link for the active client (operator action). The client
  // opens the returned URL to connect their own account into this workspace.
  app.post<{ Params: { provider: string } }>(
    '/v1/connections/:provider/invite',
    async (req, reply) => {
      const provider = providerIdentifier.safeParse(req.params.provider);
      if (!provider.success) return reply.code(400).send({ error: 'unknown provider' });
      const userId = req.authContext?.userId ?? null;
      const invite = await createConnectInvite(
        req.authContext!.workspaceId,
        provider.data,
        userId ?? req.authContext!.workspaceId,
      );
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
  // existing /connect/callback finalizes into that workspace (the flow carries the workspaceId), so
  // no session on the client's side is needed.
  app.post<{ Params: { token: string } }>('/v1/invite/:token/start', async (req, reply) => {
    const invite = await getConnectInvite(req.params.token);
    if (!invite) return reply.code(404).send({ error: 'this invite link is invalid or expired' });
    const { url } = await startConnect(invite.workspaceId, invite.provider, appUrl());
    return { url };
  });

  // Public: provider redirects the user's browser here after consent. This lands in the popup the
  // dashboard opened, so it answers with a tiny HTML page that hands the result to the opener and
  // closes itself (#45) — a two-phase provider's flowId only exists here, and JSON in a popup is
  // unusable. handleCallback still returns the CallbackResult contract; only the transport differs.
  app.get<{ Querystring: { state?: string; code?: string } }>(
    '/connect/callback',
    async (req, reply) => {
      const { state, code } = req.query;
      const send = (payload: unknown, status: number): void => {
        void reply.code(status).type('text/html; charset=utf-8').send(connectPopupHtml(payload));
      };
      if (!state || !code) return send({ status: 'error', error: 'missing state or code' }, 400);
      try {
        return send(await handleCallback(state, code), 200);
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

  // Which platforms this environment can actually connect. Registration is env-gated, so dev/CI
  // return the fakes and production returns the real providers — the dashboard renders a button per
  // entry rather than hardcoding one (#45).
  app.get('/v1/providers', async () => ({
    providers: listProviders().map((p) => ({
      identifier: p.identifier,
      displayName: p.displayName,
      isBetweenSteps: p.isBetweenSteps,
    })),
  }));

  app.get('/v1/connections', async (req) => ({
    connections: await listConnections(req.authContext!.workspaceId),
  }));

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
      if (err instanceof QueueInactiveError) return reply.code(400).send({ error: err.message });
      // A provider's own rules rejected the post at create time (#44) — client error, not a 500.
      if (err instanceof ProviderBadRequestError)
        return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

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

  return app;
}
