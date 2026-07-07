import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { createPostInput } from '@meegrow-social/contracts';
import {
  authenticateApiKey,
  createPost,
  getPost,
  listPosts,
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

  // Stateless MCP endpoint — same core services, authed by the same API key.
  app.post('/mcp', async (req, reply) => {
    const server = buildMcpServer(req.authContext!);
    const transport = newStatelessTransport();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.hijack();
  });

  return app;
}
