import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {
  createPostInput,
  registerMediaFromUrlInput,
  validateMediaInput,
} from '@meegrow-social/contracts';
import {
  authenticateApiKey,
  createPost,
  DEFAULT_MEDIA_DISK_DIR,
  getMedia,
  getPost,
  listPosts,
  registerMediaFromUrl,
  uploadMedia,
  validateMediaAgainstPlatform,
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

// Largest per-platform spec today is IG reels at 1GB (RESEARCH.md) — leave a little headroom.
const MAX_UPLOAD_BYTES = 1200 * 1024 * 1024;

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

  // API-key auth for everything except health + the public media route.
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz' || req.url.startsWith('/media/')) return;
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
