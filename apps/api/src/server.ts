import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {
  createPostInput,
  createQueueInput,
  finishConnectInput,
  logsAggregateInput,
  logsQueryInput,
  providerIdentifier,
  registerMediaFromUrlInput,
  updateQueueInput,
  validateMediaInput,
} from '@meegrow-social/contracts';
import {
  aggregateEventLogs,
  authenticateApiKey,
  createPost,
  createQueue,
  DEFAULT_MEDIA_DISK_DIR,
  deleteConnection,
  deleteQueue,
  finishConnect,
  getMedia,
  getPost,
  getQueue,
  handleCallback,
  listConnections,
  listPosts,
  listQueues,
  queryEventLogs,
  QueueInactiveError,
  QueueNotFoundError,
  recordApiRequestLog,
  registerMediaFromUrl,
  startConnect,
  updateQueue,
  uploadMedia,
  validateMediaAgainstPlatform,
  type AuthContext,
} from '@meegrow-social/core';
import { buildMcpServer, newStatelessTransport } from './mcp.js';

function appUrl(): string {
  return process.env.APP_URL ?? `http://localhost:${process.env.API_PORT ?? 8990}`;
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

  // API-key auth for everything except health, the public OAuth callback (a browser redirect with
  // no API key — its opaque state is the credential), and the public media route.
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (path === '/healthz' || path === '/connect/callback' || path.startsWith('/media/')) return;
    const key = bearer(req);
    const ctx = key ? await authenticateApiKey(key) : null;
    if (!ctx) return reply.code(401).send({ error: 'invalid or missing API key' });
    req.authContext = ctx;
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

  // Public: provider redirects the user's browser here after consent.
  app.get<{ Querystring: { state?: string; code?: string } }>(
    '/connect/callback',
    async (req, reply) => {
      const { state, code } = req.query;
      if (!state || !code) return reply.code(400).send({ error: 'missing state or code' });
      try {
        return await handleCallback(state, code);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : 'callback failed' });
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

  app.get('/v1/connections', async (req) => ({
    connections: await listConnections(req.authContext!.workspaceId),
  }));

  app.delete<{ Params: { id: string } }>('/v1/connections/:id', async (req, reply) => {
    const ok = await deleteConnection(req.authContext!.workspaceId, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { deleted: true };
  });

  app.post('/v1/posts', async (req, reply) => {
    const parsed = createPostInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const posts = await createPost(req.authContext!.workspaceId, parsed.data);
      return reply.code(201).send({ posts });
    } catch (err) {
      if (err instanceof QueueNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof QueueInactiveError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get('/v1/posts', async (req) => ({ posts: await listPosts(req.authContext!.workspaceId) }));

  app.get<{ Params: { id: string } }>('/v1/posts/:id', async (req, reply) => {
    const post = await getPost(req.authContext!.workspaceId, req.params.id);
    if (!post) return reply.code(404).send({ error: 'not found' });
    return { post };
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
