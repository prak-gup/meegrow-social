import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  calendarPostsQuery,
  createPostInput,
  listPostsQuery,
  postOptions,
  providerIdentifier,
  scheduleMode,
  updatePostInput,
  type CreatePostInput,
  type ScheduleMode,
} from '@meegrow-social/contracts';
import {
  calendarPosts,
  cancelPost,
  createPost,
  duplicatePost,
  getPost,
  getPostGroup,
  listPosts,
  updatePost,
} from '@meegrow-social/core';
import type { AuthContext } from '@meegrow-social/core';
import { idempotencyKey, notFound, PUBLISH, READ, respond, ToolError, WRITE } from './shared.js';

/**
 * What to post and where — the arguments `create_post` and `add_to_queue` share. `variants` is the
 * `createPostInput` contract; `connectionId` / `provider` / `options` are the single-target
 * shorthand these two tools took before they accepted variants, kept so existing callers still work.
 */
export const postTargetShape = {
  caption: createPostInput.shape.caption.describe(
    'Text of the post. Each variant may override it.',
  ),
  media: createPostInput.shape.media.describe(
    'Media attached to every variant, in carousel order. `mediaId` and `kind` come from ' +
      'register_media_from_url. Each variant may override it.',
  ),
  variants: createPostInput.shape.variants
    .optional()
    .describe(
      'One entry per social account to post to; each creates its own post. `connectionId` and ' +
        '`provider` come from list_connections. `options` carries per-platform settings and is ' +
        'required for youtube (its title lives there).',
    ),
  connectionId: z
    .string()
    .uuid()
    .optional()
    .describe('Shorthand for a single target: use with `provider` instead of `variants`.'),
  provider: providerIdentifier
    .optional()
    .describe('Shorthand for a single target: the provider of `connectionId`.'),
  options: postOptions
    .optional()
    .describe('Shorthand for a single target: per-platform options for `connectionId`.'),
  idempotencyKey,
};

type PostTargetArgs = z.infer<z.ZodObject<typeof postTargetShape>>;

/** Folds the single-target shorthand into `variants` and validates against the REST contract. */
export function toCreatePostInput(args: PostTargetArgs, schedule: ScheduleMode): CreatePostInput {
  const shorthand =
    args.connectionId !== undefined || args.provider !== undefined || args.options !== undefined;
  if (args.variants && shorthand) {
    throw new ToolError(
      'invalid_request',
      'pass either `variants` or the single-target shorthand (`connectionId` + `provider`), not both',
    );
  }
  if (!args.variants && !(args.connectionId && args.provider)) {
    throw new ToolError(
      'invalid_request',
      'name at least one target: `variants`, or `connectionId` + `provider`',
    );
  }
  return createPostInput.parse({
    caption: args.caption,
    media: args.media,
    variants: args.variants ?? [
      { connectionId: args.connectionId, provider: args.provider, options: args.options },
    ],
    schedule,
  });
}

const postId = z
  .string()
  .uuid()
  .describe('Id of one per-platform post, as returned by list_posts.');

export function registerPostTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'create_post',
    {
      description:
        'Create a post for one or more connected social accounts. Returns the created posts, ' +
        'one per target, all sharing a `groupId`. `schedule` decides what happens next: ' +
        '{"type":"draft"} (the default) only saves it; {"type":"at","publishAt":"<ISO time>"} ' +
        'PUBLISHES TO THE REAL SOCIAL ACCOUNTS at that time; {"type":"now"} PUBLISHES ' +
        'IMMEDIATELY; {"type":"queue","queueId":"..."} takes the next free slot of a queue. A ' +
        'published post cannot be recalled by this server. Set `idempotencyKey` whenever the ' +
        'call may be retried, or a retry publishes a second copy.',
      inputSchema: {
        ...postTargetShape,
        schedule: scheduleMode
          .optional()
          .describe('When to publish. Omit to save a draft that publishes nothing.'),
        publishAt: z
          .string()
          .datetime()
          .optional()
          .describe('Shorthand for schedule {"type":"at"}. Do not combine with `schedule`.'),
      },
      annotations: PUBLISH,
    },
    (args) =>
      respond(async () => {
        if (args.schedule && args.publishAt) {
          throw new ToolError('invalid_request', 'pass either `schedule` or `publishAt`, not both');
        }
        const schedule: ScheduleMode =
          args.schedule ??
          (args.publishAt
            ? { type: 'at', publishAt: new Date(args.publishAt) }
            : { type: 'draft' });
        return createPost(ctx.workspaceId, toCreatePostInput(args, schedule), {
          idempotencyKey: args.idempotencyKey,
        });
      }),
  );

  server.registerTool(
    'list_posts',
    {
      description:
        'List posts in this workspace, soonest `publishAt` first (drafts last). Filter by ' +
        '`status` (draft | scheduled | publishing | published | failed | cancelled), `provider`, ' +
        '`connectionId`, and a `from`/`to` window on `publishAt`. Paginate with `limit` (max ' +
        '100, default 50) and `offset`. Each item is one per-platform post; a failed post ' +
        'carries the reason in `error` and a published one its `releaseUrl`. Read-only.',
      inputSchema: listPostsQuery.shape,
      annotations: READ,
    },
    (args) => respond(() => listPosts(ctx.workspaceId, args)),
  );

  server.registerTool(
    'get_post',
    {
      description:
        'Get one per-platform post by id: status, caption, options, `publishAt`, and after ' +
        'publishing its `releaseUrl` or `error`. Use it to read back the outcome of a scheduled ' +
        'post. Media is not included here; get_post_group returns it. Read-only.',
      inputSchema: { postId },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        const post = await getPost(ctx.workspaceId, args.postId);
        if (!post) throw notFound('post');
        return post;
      }),
  );

  server.registerTool(
    'get_post_group',
    {
      description:
        'Get a post group — everything one create_post call made — with its shared caption and ' +
        'media and every per-platform post in it. `groupId` is on each post. Read-only.',
      inputSchema: { groupId: z.string().uuid() },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        const group = await getPostGroup(ctx.workspaceId, args.groupId);
        if (!group) throw notFound('post group');
        return group;
      }),
  );

  server.registerTool(
    'update_post',
    {
      description:
        'Edit a draft or scheduled post in place: any of `caption`, `media`, `options`, ' +
        '`publishAt`. Fields left out are unchanged; `media` replaces the whole list. Setting ' +
        '`publishAt` to a time (re)schedules the post, which PUBLISHES TO THE REAL SOCIAL ' +
        'ACCOUNT at that time; setting it to null returns the post to draft. Fails with ' +
        'invalid_state once the post is publishing, published, failed or cancelled.',
      inputSchema: { postId, ...updatePostInput.shape },
      annotations: { ...PUBLISH, destructiveHint: true, idempotentHint: true },
    },
    ({ postId: id, ...patch }) =>
      respond(async () => {
        const post = await updatePost(ctx.workspaceId, id, patch);
        if (!post) throw notFound('post');
        return post;
      }),
  );

  server.registerTool(
    'schedule_post',
    {
      description:
        'Schedule a draft, or move an already scheduled post to a new time. The post PUBLISHES ' +
        'TO THE REAL SOCIAL ACCOUNT at `publishAt`. Only draft and scheduled posts can be ' +
        'scheduled; anything else fails with invalid_state. To undo, call unschedule_post ' +
        'before that time.',
      inputSchema: {
        postId,
        publishAt: z.coerce.date().describe('When to publish, as an ISO 8601 time with offset.'),
      },
      annotations: { ...PUBLISH, idempotentHint: true },
    },
    (args) =>
      respond(async () => {
        const post = await updatePost(ctx.workspaceId, args.postId, { publishAt: args.publishAt });
        if (!post) throw notFound('post');
        return post;
      }),
  );

  server.registerTool(
    'unschedule_post',
    {
      description:
        'Return a scheduled post to draft and stop its pending publish. The post and its ' +
        'content are kept and can be scheduled again. Has no effect on a post that has already ' +
        'started publishing: that fails with invalid_state.',
      inputSchema: { postId },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) =>
      respond(async () => {
        const post = await updatePost(ctx.workspaceId, args.postId, { publishAt: null });
        if (!post) throw notFound('post');
        return post;
      }),
  );

  const cancel = (args: { postId: string }) =>
    respond(async () => {
      const cancelled = await cancelPost(ctx.workspaceId, args.postId);
      if (!cancelled) throw notFound('post');
      return { cancelled: true };
    });

  server.registerTool(
    'cancel_post',
    {
      description:
        'Cancel a draft or scheduled post so it never publishes. IRREVERSIBLE: a cancelled post ' +
        'cannot be edited or rescheduled again (use duplicate_post to start over from it). The ' +
        'record is kept with status `cancelled`. Does not remove anything already published: a ' +
        'publishing, published or failed post fails with invalid_state. To pause a post and ' +
        'keep it editable, use unschedule_post.',
      inputSchema: { postId },
      annotations: { ...WRITE, destructiveHint: true },
    },
    cancel,
  );

  server.registerTool(
    'delete_post',
    {
      description:
        'Same as cancel_post, under the name agents look for. There is no hard delete: the post ' +
        'is marked `cancelled`, IRREVERSIBLY, and its record is kept. Does not remove a post ' +
        'from the social platform once it is published.',
      inputSchema: { postId },
      annotations: { ...WRITE, destructiveHint: true },
    },
    cancel,
  );

  server.registerTool(
    'duplicate_post',
    {
      description:
        'Copy one post into a new draft on the same social account, with the same caption, ' +
        'media and options. Works on a post in any status, including published and cancelled. ' +
        'The copy is always a draft in a new group and publishes nothing until it is scheduled.',
      inputSchema: { postId, idempotencyKey },
      annotations: WRITE,
    },
    (args) =>
      respond(async () => {
        const post = await duplicatePost(ctx.workspaceId, args.postId, {
          idempotencyKey: args.idempotencyKey,
        });
        if (!post) throw notFound('post');
        return post;
      }),
  );

  server.registerTool(
    'calendar',
    {
      description:
        'Get one month of posts grouped by calendar day. `timezone` is an IANA zone (default ' +
        'UTC) and decides which day each post falls on. Only posts with a `publishAt` appear, ' +
        'so drafts are left out; days with no posts are omitted. Read-only.',
      inputSchema: calendarPostsQuery.shape,
      annotations: READ,
    },
    (args) => respond(() => calendarPosts(ctx.workspaceId, args)),
  );
}
