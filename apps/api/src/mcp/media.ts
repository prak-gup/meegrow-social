import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listMediaQuery, registerMediaFromUrlInput } from '@meegrow-social/contracts';
import { getMedia, listMedia, registerMediaFromUrl } from '@meegrow-social/core';
import type { AuthContext } from '@meegrow-social/core';
import { notFound, READ, respond, WRITE } from './shared.js';

export function registerMediaTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'register_media_from_url',
    {
      description:
        'Register an image or video that is already hosted at a public URL, without re-uploading ' +
        'it. The server fetches the URL once to read its dimensions, duration and codec, then ' +
        'stores a media record pointing at that URL. Returns the media record: use its `id` as ' +
        '`mediaId` and its `kind` in the media refs of create_post. Each call creates a new ' +
        'record, even for a URL registered before. The URL must stay publicly reachable until ' +
        'the post publishes.',
      inputSchema: registerMediaFromUrlInput.shape,
      annotations: { ...WRITE, openWorldHint: true },
    },
    (args) => respond(() => registerMediaFromUrl(ctx.workspaceId, args)),
  );

  server.registerTool(
    'list_media',
    {
      description:
        'List the media records of this workspace, newest first. Paginate with `limit` (max ' +
        '100, default 50) and `offset`. Use it to find the `id` and `kind` of media registered ' +
        'or uploaded earlier, for the media refs of create_post. Read-only.',
      inputSchema: listMediaQuery.shape,
      annotations: READ,
    },
    (args) => respond(() => listMedia(ctx.workspaceId, args)),
  );

  server.registerTool(
    'get_media',
    {
      description:
        'Get one media record by id: kind, public URL, size, and the probed dimensions, duration ' +
        'and codec. Read-only.',
      inputSchema: { mediaId: z.string().uuid() },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        const media = await getMedia(ctx.workspaceId, args.mediaId);
        if (!media) throw notFound('media');
        return media;
      }),
  );
}
