import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getWorkspace } from '@meegrow-social/core';
import type { AuthContext } from '@meegrow-social/core';
import { notFound, READ, respond } from './shared.js';

export function registerWorkspaceTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'get_workspace',
    {
      description:
        'Get the workspace this API key belongs to: its `id`, `name` and `slug`. A key is bound ' +
        'to exactly one workspace and every other tool acts on it; use this to confirm which ' +
        'client you are working for before you write. Takes no arguments. Read-only.',
      inputSchema: {},
      annotations: READ,
    },
    () =>
      respond(async () => {
        const workspace = await getWorkspace(ctx.workspaceId);
        if (!workspace) throw notFound('workspace');
        return workspace;
      }),
  );

  server.registerTool(
    'list_workspaces',
    {
      description:
        'List the workspaces this API key can act on. Always exactly one: the same workspace ' +
        'get_workspace returns. A key cannot see or switch to any other workspace. Read-only.',
      inputSchema: {},
      annotations: READ,
    },
    () =>
      respond(async () => {
        const workspace = await getWorkspace(ctx.workspaceId);
        return workspace ? [workspace] : [];
      }),
  );
}
