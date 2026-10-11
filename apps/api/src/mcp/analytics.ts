import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getConnectionFollowers,
  getPost,
  getPostMetrics,
  listConnections,
} from '@meegrow-social/core';
import type { AuthContext } from '@meegrow-social/core';
import { notFound, READ, respond } from './shared.js';

export function registerAnalyticsTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'post_metrics',
    {
      description:
        'Get the engagement metrics collected for one published post. `latest` is the newest ' +
        'value per metric name and `series` is the full history, oldest first. Metric names are ' +
        "the platform's own and differ per platform. Both are empty until the first collection " +
        'sweep after publishing. Read-only.',
      inputSchema: { postId: z.string().uuid() },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        const post = await getPost(ctx.workspaceId, args.postId);
        if (!post) throw notFound('post');
        return getPostMetrics(ctx.workspaceId, args.postId);
      }),
  );

  server.registerTool(
    'connection_followers',
    {
      description:
        'Get the follower-count history of one connected social account, newest first. Empty ' +
        'until the first collection sweep after the account is connected. Read-only.',
      inputSchema: { connectionId: z.string().uuid() },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        const connections = await listConnections(ctx.workspaceId);
        if (!connections.some((c) => c.id === args.connectionId)) throw notFound('connection');
        return getConnectionFollowers(ctx.workspaceId, args.connectionId);
      }),
  );
}
