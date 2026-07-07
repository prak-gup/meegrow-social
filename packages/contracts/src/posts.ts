import { z } from 'zod';
import { providerIdentifier } from './providers.js';

/**
 * Post lifecycle. Kept flexible enough for the template engine (drafts) and the scheduler
 * (publishing/failed/cancelled) per PRD F3.5.
 */
export const postStatus = z.enum([
  'draft',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancelled',
]);
export type PostStatus = z.infer<typeof postStatus>;

export const mediaKind = z.enum(['image', 'video']);
export type MediaKind = z.infer<typeof mediaKind>;

export const mediaRef = z.object({
  mediaId: z.string().uuid(),
  kind: mediaKind,
  /** Public URL (required by IG/GBP). Populated once the media is stored. */
  url: z.string().url().optional(),
});
export type MediaRef = z.infer<typeof mediaRef>;

/**
 * A per-platform child of a post-group. This is the "per-platform variant" the PRD (F3.1) and
 * the future template engine (RESEARCH §1.5) require: each target can override caption/media.
 */
export const postVariant = z.object({
  connectionId: z.string().uuid(),
  provider: providerIdentifier,
  /** Overrides the group caption when set. */
  caption: z.string().max(5000).optional(),
  /** Overrides the group media when set. Array order = carousel / thread order. */
  media: z.array(mediaRef).max(10).optional(),
});
export type PostVariant = z.infer<typeof postVariant>;

export const scheduleMode = z.discriminatedUnion('type', [
  z.object({ type: z.literal('draft') }),
  z.object({ type: z.literal('now') }),
  z.object({ type: z.literal('at'), publishAt: z.coerce.date() }),
  z.object({ type: z.literal('queue'), queueId: z.string().uuid() }),
]);
export type ScheduleMode = z.infer<typeof scheduleMode>;

/** Input to create a post-group (one call → one group → N per-platform posts). API + MCP share this. */
export const createPostInput = z.object({
  caption: z.string().max(5000).default(''),
  media: z.array(mediaRef).max(10).default([]),
  variants: z.array(postVariant).min(1),
  schedule: scheduleMode.default({ type: 'draft' }),
});
export type CreatePostInput = z.infer<typeof createPostInput>;

export const postView = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  provider: providerIdentifier,
  connectionId: z.string().uuid(),
  status: postStatus,
  caption: z.string(),
  publishAt: z.coerce.date().nullable(),
  releaseUrl: z.string().url().nullable(),
  error: z.string().nullable(),
});
export type PostView = z.infer<typeof postView>;
