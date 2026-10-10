import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createPost, listQueues } from '@meegrow-social/core';
import type { AuthContext } from '@meegrow-social/core';
import { postTargetShape, toCreatePostInput } from './posts.js';
import { PUBLISH, READ, respond } from './shared.js';

export function registerQueueTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'list_queues',
    {
      description:
        'List the publishing queues of this workspace. A queue is a set of weekly time slots ' +
        '(`dow` 0 = Sunday, `time` is HH:mm in the queue `timezone`). Use a queue `id` with ' +
        'add_to_queue. An inactive queue (`active` false) accepts no posts. Read-only.',
      inputSchema: {},
      annotations: READ,
    },
    () => respond(() => listQueues(ctx.workspaceId)),
  );

  server.registerTool(
    'add_to_queue',
    {
      description:
        'Create a post and give it the next free slot of a queue, instead of choosing a time ' +
        'yourself. The post is scheduled straight away and PUBLISHES TO THE REAL SOCIAL ' +
        'ACCOUNTS at that slot; the assigned time comes back as `publishAt`. All targets of one ' +
        'call share one slot. Set `idempotencyKey` whenever the call may be retried, or a retry ' +
        'takes a second slot and publishes a second copy. Fails with not_found for an unknown ' +
        'queue and invalid_request for an inactive one.',
      inputSchema: { ...postTargetShape, queueId: z.string().uuid() },
      annotations: PUBLISH,
    },
    (args) =>
      respond(() =>
        createPost(
          ctx.workspaceId,
          toCreatePostInput(args, { type: 'queue', queueId: args.queueId }),
          { idempotencyKey: args.idempotencyKey },
        ),
      ),
  );
}
