import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { createPostInput, logsAggregateInput, logsQueryInput } from '@meegrow-social/contracts';
import {
  aggregateEventLogs,
  authenticateApiKey,
  createPost,
  getPost,
  listPosts,
  queryEventLogs,
  recordApiRequestLog,
  type AuthContext,
} from '@meegrow-social/core';
import { buildMcpServer, newStatelessTransport } from './mcp.js';

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

  app.get('/healthz', async () => ({ ok: true }));

  // API-key auth for everything except health.
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz') return;
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

  app.post('/v1/posts', async (req, reply) => {
    const parsed = createPostInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const posts = await createPost(req.authContext!.workspaceId, parsed.data);
    return reply.code(201).send({ posts });
  });

  app.get('/v1/posts', async (req) => ({ posts: await listPosts(req.authContext!.workspaceId) }));

  app.get<{ Params: { id: string } }>('/v1/posts/:id', async (req, reply) => {
    const post = await getPost(req.authContext!.workspaceId, req.params.id);
    if (!post) return reply.code(404).send({ error: 'not found' });
    return { post };
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
