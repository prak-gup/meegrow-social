import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createPost, listPosts, registerMediaFromUrl } from '@meegrow-social/core';
import type { AuthContext } from '@meegrow-social/core';

/**
 * Builds a stateless MCP server bound to one workspace (resolved from the API key). Tools are
 * task-shaped and call the SAME `core` services the REST API uses — no business logic here.
 */
export function buildMcpServer(ctx: AuthContext): McpServer {
  const server = new McpServer({ name: 'meegrow-social', version: '0.0.0' });

  server.registerTool(
    'create_post',
    {
      description: 'Create a post-group with one per-platform variant and optional scheduling.',
      inputSchema: {
        caption: z.string().default(''),
        connectionId: z.string().uuid(),
        provider: z.string(),
        publishAt: z.string().datetime().optional(),
      },
    },
    async (args) => {
      const posts = await createPost(ctx.workspaceId, {
        caption: args.caption,
        media: [],
        variants: [{ connectionId: args.connectionId, provider: args.provider as never }],
        schedule: args.publishAt
          ? { type: 'at', publishAt: new Date(args.publishAt) }
          : { type: 'draft' },
      });
      return { content: [{ type: 'text', text: JSON.stringify(posts) }] };
    },
  );

  server.registerTool(
    'list_posts',
    { description: 'List all posts in the workspace.', inputSchema: {} },
    async () => {
      const posts = await listPosts(ctx.workspaceId);
      return { content: [{ type: 'text', text: JSON.stringify(posts) }] };
    },
  );

  server.registerTool(
    'register_media_from_url',
    {
      description:
        'Register media already hosted at a public URL (e.g. antidote-generated images) ' +
        'without re-uploading it — returns a mediaId usable in create_post media refs.',
      inputSchema: {
        url: z.string().url(),
        kind: z.enum(['image', 'video']).optional(),
      },
    },
    async (args) => {
      const media = await registerMediaFromUrl(ctx.workspaceId, { url: args.url, kind: args.kind });
      return { content: [{ type: 'text', text: JSON.stringify(media) }] };
    },
  );

  return server;
}

/** Stateless transport factory — one per request, no server-held sessions (AX-PRD §1). */
export function newStatelessTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}
