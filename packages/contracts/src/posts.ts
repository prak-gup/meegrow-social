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
  /** Set when this post was created via a queue's next-free-slot assignment (PRD F3.4). */
  queueId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
});
export type PostView = z.infer<typeof postView>;

/**
 * Edit a draft/scheduled post (PRD F3.5). Any of caption/media/publishAt. `publishAt` is tri-state:
 * omitted = leave unchanged; a date = (re)schedule; null = demote to draft and cancel the job.
 * Rejected once the post is publishing/published/failed/cancelled.
 */
export const updatePostInput = z.object({
  caption: z.string().max(5000).optional(),
  media: z.array(mediaRef).max(10).optional(),
  publishAt: z.coerce.date().nullable().optional(),
});
export type UpdatePostInput = z.infer<typeof updatePostInput>;

/** Filterable post list (PRD F3.6). Single-value filters; stable ordering + offset pagination. */
export const listPostsQuery = z.object({
  status: postStatus.optional(),
  provider: providerIdentifier.optional(),
  connectionId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListPostsQuery = z.infer<typeof listPostsQuery>;

/** Calendar view (PRD F3.6): posts bucketed by their calendar day in the requested timezone. */
export const calendarPostsQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  timezone: z.string().min(1).default('UTC'),
});
export type CalendarPostsQuery = z.infer<typeof calendarPostsQuery>;

export const calendarDay = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD in the requested timezone
  posts: z.array(postView),
});
export type CalendarDay = z.infer<typeof calendarDay>;

export const calendarView = z.object({
  days: z.array(calendarDay),
});
export type CalendarView = z.infer<typeof calendarView>;

/** A post-group with all its per-platform children (PRD F3.1/F3.6). */
export const postGroupView = z.object({
  id: z.string().uuid(),
  caption: z.string(),
  media: z.array(mediaRef),
  createdAt: z.coerce.date(),
  posts: z.array(postView),
});
export type PostGroupView = z.infer<typeof postGroupView>;
