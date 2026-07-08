import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { createPostInput, finishConnectInput, providerIdentifier } from '@meegrow-social/contracts';
import {
  authenticateApiKey,
  createPost,
  deleteConnection,
  finishConnect,
  getPost,
  handleCallback,
  listConnections,
  listPosts,
  startConnect,
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

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  app.get('/healthz', async () => ({ ok: true }));

  // API-key auth for everything except health and the public OAuth callback (a browser redirect
  // from the provider — it carries no API key; its own opaque state is the credential).
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/healthz' || path === '/connect/callback') return;
    const key = bearer(req);
    const ctx = key ? await authenticateApiKey(key) : null;
    if (!ctx) return reply.code(401).send({ error: 'invalid or missing API key' });
    req.authContext = ctx;
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
