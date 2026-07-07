import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createPost, listConnections, listPosts } from '@meegrow-social/core';
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
    'list_connections',
    {
      description: 'List connected social accounts in the workspace, with token health.',
      inputSchema: {},
    },
    async () => {
      const connections = await listConnections(ctx.workspaceId);
      return { content: [{ type: 'text', text: JSON.stringify(connections) }] };
    },
  );

  return server;
}

/** Stateless transport factory — one per request, no server-held sessions (AX-PRD §1). */
export function newStatelessTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}
