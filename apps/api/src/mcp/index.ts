import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthContext } from '@meegrow-social/core';
import { registerAnalyticsTools } from './analytics.js';
import { registerConnectionTools } from './connections.js';
import { registerMediaTools } from './media.js';
import { registerPostTools } from './posts.js';
import { registerQueueTools } from './queues.js';
import { registerWorkspaceTools } from './workspaces.js';

/**
 * Builds a stateless MCP server bound to one workspace (resolved from the API key). Tools are
 * task-shaped and call the SAME `core` services the REST API uses — no business logic here. One
 * file per noun; every handler is parse → `core` with `ctx.workspaceId` → JSON, and no tool takes a
 * workspace id from the caller.
 *
 * DELIBERATELY ABSENT — api-key management (#8). There is no `create_api_key` / `revoke_api_key`
 * tool and there should not be: an agent authenticating *with* a key, able to mint more keys for
 * its own workspace, can silently escalate its own persistence beyond the key you handed it — and
 * revocation stops being a reliable off-switch. Key management is a human action over REST
 * (`POST/GET/DELETE /v1/api-keys`). Nothing in the agent flows needs it.
 */
export function buildMcpServer(ctx: AuthContext): McpServer {
  const server = new McpServer({ name: 'meegrow-social', version: '0.0.0' });
  registerWorkspaceTools(server, ctx);
  registerConnectionTools(server, ctx);
  registerPostTools(server, ctx);
  registerQueueTools(server, ctx);
  registerMediaTools(server, ctx);
  registerAnalyticsTools(server, ctx);
  return server;
}

/** Stateless transport factory — one per request, no server-held sessions (AX-PRD §1). */
export function newStatelessTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}
