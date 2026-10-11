import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConnectionHealth, listConnectionHealth, listConnections } from '@meegrow-social/core';
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

  server.registerTool(
    'connection_health',
    {
      description:
        'Report whether connected accounts can be expected to publish. With `connectionId`: one ' +
        'report; without: one per account of the workspace. `status` is healthy | expiring | ' +
        'expired | needs_reconnect, with a `reason` and a `recommendedAction` in plain words, ' +
        'plus token expiry and the latest failed post of the account. Derived from stored state ' +
        'only (`source: "stored"`): the platform is NOT contacted, so a token revoked on the ' +
        'platform side still reads healthy until a publish fails. Read-only.',
      inputSchema: {
        connectionId: z
          .string()
          .uuid()
          .optional()
          .describe('One account, as returned by list_connections. Omit for all of them.'),
      },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        if (!args.connectionId) return listConnectionHealth(ctx.workspaceId);
        const health = await getConnectionHealth(ctx.workspaceId, args.connectionId);
        if (!health) throw notFound('connection');
        return health;
      }),
  );
}
