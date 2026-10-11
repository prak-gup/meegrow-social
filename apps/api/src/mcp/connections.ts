import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listConnections } from '@meegrow-social/core';
import type { AuthContext } from '@meegrow-social/core';
import { notFound, READ, respond } from './shared.js';

export function registerConnectionTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'list_connections',
    {
      description:
        'List the social accounts connected to this workspace. Each has the `id` and `provider` ' +
        'that create_post needs, plus token health: `health` is healthy | expiring | ' +
        'needs_reconnect and `expiresInDays` counts down to token expiry (null = no expiry, ' +
        'negative = expired). A needs_reconnect account cannot publish until a human reconnects ' +
        'it in the dashboard. Read-only.',
      inputSchema: {},
      annotations: READ,
    },
    () => respond(() => listConnections(ctx.workspaceId)),
  );

  server.registerTool(
    'get_connection',
    {
      description:
        'Get one connected social account by id, with the same token-health fields as ' +
        'list_connections. Use it to check an account can publish before scheduling to it. ' +
        'Read-only.',
      inputSchema: { connectionId: z.string().uuid() },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        const connections = await listConnections(ctx.workspaceId);
        const connection = connections.find((c) => c.id === args.connectionId);
        if (!connection) throw notFound('connection');
        return connection;
      }),
  );
}
