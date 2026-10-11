import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IMPORT_WINDOW_DAYS } from '@meegrow-social/contracts';
import {
  getConnectionHealth,
  listConnectionHealth,
  listConnections,
  requestPostImport,
} from '@meegrow-social/core';
import type { AuthContext } from '@meegrow-social/core';
import { notFound, READ, respond, WRITE } from './shared.js';

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

  server.registerTool(
    'import_past_posts',
    {
      description:
        'Import the posts a connected account ALREADY has on the platform — published there or ' +
        'through another tool — so they appear in list_posts and collect metrics. Queues the ' +
        'work and returns at once; read progress from `import` on list_connections (`status` ' +
        'queued | running | paused | done | failed, with counts). Imported posts have `source: ' +
        '"imported"`, are always `published`, and can never be edited, cancelled, retried or ' +
        'published from here. Posts this app published are recognised and not duplicated. Reads ' +
        'the platform only; nothing is posted. Facebook Pages and Instagram only. A new account ' +
        'is imported automatically (90 days) and re-checked every 6 hours, so this is for a ' +
        'longer window or an immediate re-check. Calling it while a run is queued or in progress ' +
        'changes nothing.',
      inputSchema: {
        connectionId: z.string().uuid().describe('An account, as returned by list_connections.'),
        windowDays: z
          .number()
          .int()
          .refine((d) => (IMPORT_WINDOW_DAYS as readonly number[]).includes(d), {
            message: `must be one of ${IMPORT_WINDOW_DAYS.join(', ')}`,
          })
          .optional()
          .describe(`How far back to read: ${IMPORT_WINDOW_DAYS.join(', ')} days. Default 90.`),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) =>
      respond(async () => {
        const state = await requestPostImport(ctx.workspaceId, args.connectionId, {
          windowDays: args.windowDays ?? 90,
        });
        if (!state) throw notFound('connection');
        return state;
      }),
  );
}
