import { z } from 'zod';
import { providerIdentifier, type ProviderIdentifier } from './providers.js';

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
 * Per-platform post options (#44). `caption` + `media` are not enough to express a post on any
 * platform past Meta's feed: YouTube needs a title, GBP needs a topic type and a CTA button, and
 * a reel is not a feed video. One arm per platform *family* — IG and FB share `meta`, because a
 * provider-keyed union would duplicate that arm and let the two drift.
 *
 * Discriminated on `kind` rather than reusing the variant's `provider` for exactly that reason;
 * `postVariant` asserts below that the arm matches the provider, so the two can't disagree.
 *
 * This is SHAPE validation only. Semantic rules (a GBP EVENT needs event dates, a YouTube post
 * needs exactly one video) live on the provider's `assertPublishable`, so adding a platform never
 * edits this file — the sealed-provider invariant in README.md.
 */
const metaOptions = z.object({
  kind: z.literal('meta'),
  format: z.enum(['feed', 'reel', 'story']).default('feed'),
  /** IG reels only: also surface the reel on the main feed. */
  shareToFeed: z.boolean().optional(),
  coverUrl: z.string().url().optional(),
});

const gmbOptions = z.object({
  kind: z.literal('gmb'),
  topicType: z.enum(['STANDARD', 'EVENT', 'OFFER', 'ALERT']).default('STANDARD'),
  /** The post's button. `url` is absent for CALL — the provider enforces that pairing. */
  cta: z
    .object({
      actionType: z.enum(['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL']),
      url: z.string().url().optional(),
    })
    .optional(),
  event: z
    .object({
      title: z.string().min(1).max(58),
      start: z.coerce.date(),
      end: z.coerce.date(),
    })
    .optional(),
  offer: z
    .object({
      couponCode: z.string().optional(),
      redeemUrl: z.string().url().optional(),
      terms: z.string().optional(),
    })
    .optional(),
});

const youtubeOptions = z.object({
  kind: z.literal('youtube'),
  /**
   * Mandatory, and deliberately NOT defaulted from `caption`: titles cap at 100 chars while
   * captions run to 5000, so a fallback would silently truncate mid-sentence onto every client's
   * channel. Better to reject at create time.
   */
  title: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  /**
   * NB: until the YouTube compliance audit clears, `videos.insert` from this project locks every
   * upload to private regardless of what is requested here. The provider reads the status back
   * after upload rather than trusting this value.
   */
  privacyStatus: z.enum(['public', 'unlisted', 'private']).default('public'),
  categoryId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  madeForKids: z.boolean().default(false),
});

export const postOptions = z.discriminatedUnion('kind', [metaOptions, gmbOptions, youtubeOptions]);
export type PostOptions = z.infer<typeof postOptions>;

/**
 * Re-parse options read back out of jsonb. REQUIRED on every read path — a bare `as PostOptions`
 * cast is a lie: storage round-trips `Date` to an ISO string, so `event.start` comes back a string
 * and any date arithmetic inside a provider throws at publish time. `z.coerce.date()` restores it.
 */
export function parseStoredOptions(value: unknown): PostOptions | null {
  return value == null ? null : postOptions.parse(value);
}

/** Which options arm a provider takes. Absent = takes no options (yet). */
const OPTIONS_ARM: Partial<Record<ProviderIdentifier, PostOptions['kind']>> = {
  instagram: 'meta',
  facebook: 'meta',
  gmb: 'gmb',
  youtube: 'youtube',
};

/** Providers whose options carry a field with no sensible default, so the post is invalid without. */
const OPTIONS_REQUIRED: ReadonlySet<ProviderIdentifier> = new Set(['youtube']);

/**
 * Which options arm a provider takes, or undefined if it takes none. Exported so `updatePost` can
 * re-run the arm check against a STORED post — a patch carries options but not a provider, so the
 * `postVariant` refinement can't cover that path.
 */
export function optionsArmForProvider(
  provider: ProviderIdentifier,
): PostOptions['kind'] | undefined {
  return OPTIONS_ARM[provider];
}

/**
 * A per-platform child of a post-group. This is the "per-platform variant" the PRD (F3.1) and
 * the future template engine (RESEARCH §1.5) require: each target can override caption/media.
 */
export const postVariant = z
  .object({
    connectionId: z.string().uuid(),
    provider: providerIdentifier,
    /** Overrides the group caption when set. */
    caption: z.string().max(5000).optional(),
    /** Overrides the group media when set. Array order = carousel / thread order. */
    media: z.array(mediaRef).max(10).optional(),
    /** Per-platform options (#44). Required for providers in `OPTIONS_REQUIRED`. */
    options: postOptions.optional(),
  })
  .superRefine((variant, ctx) => {
    const arm = OPTIONS_ARM[variant.provider];
    if (!variant.options) {
      if (OPTIONS_REQUIRED.has(variant.provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: `"${variant.provider}" posts require options (a YouTube post has no title without them)`,
        });
      }
      return;
    }
    if (!arm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `"${variant.provider}" takes no per-platform options`,
      });
    } else if (variant.options.kind !== arm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', 'kind'],
        message: `"${variant.provider}" needs options.kind "${arm}", got "${variant.options.kind}"`,
      });
    }
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

/**
 * A media item as a post view shows it: enough to draw a thumbnail, nothing about where it is
 * stored. `url` is the public URL the platform itself is given (null when the ref carries none and
 * no stored media answers to its id). `thumbnailUrl` is a still for a video where one exists — today
 * only the cover of a `meta` post (`options.coverUrl`); no thumbnail is generated on upload.
 */
export const postMediaView = z.object({
  /** The media id — `mediaRef.mediaId`. */
  id: z.string().uuid(),
  kind: mediaKind,
  url: z.string().url().nullable(),
  thumbnailUrl: z.string().url().nullable(),
});
export type PostMediaView = z.infer<typeof postMediaView>;

export const postView = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  provider: providerIdentifier,
  connectionId: z.string().uuid(),
  status: postStatus,
  caption: z.string(),
  /** Per-platform options (#44). Null for posts that carry none. */
  options: postOptions.nullable().default(null),
  publishAt: z.coerce.date().nullable(),
  releaseUrl: z.string().url().nullable(),
  error: z.string().nullable(),
  /** Set when this post was created via a queue's next-free-slot assignment (PRD F3.4). */
  queueId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  /**
   * This post's own media, in carousel order. Optional only so a consumer holding an older payload
   * still parses: every read and write in core fills it (an empty array for a text-only post).
   */
  media: z.array(postMediaView).optional(),
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
  /**
   * Per-platform options (#44). The arm-matches-provider check can't run here — the patch doesn't
   * carry the provider — so `updatePost` re-checks it against the stored row.
   */
  options: postOptions.optional(),
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

/** What a whole group reads as when its per-platform posts disagree. See `groupDisplayStatus`. */
export const postGroupStatus = z.enum([...postStatus.options, 'partly_failed']);
export type PostGroupStatus = z.infer<typeof postGroupStatus>;

/** Least advanced first: what is still owed on a group that has not fully gone out. */
const PENDING_ORDER: readonly PostStatus[] = ['draft', 'scheduled', 'publishing'];

/**
 * The ONE rule for a group's status, shared by the API (`GET /v1/post-groups`) and the dashboard's
 * calendar, which groups a day's posts itself. Each variant keeps its own status; this is only the
 * headline:
 *
 * 1. Cancelled variants are set aside — unless every variant is cancelled, then `cancelled`.
 * 2. Of the rest: all failed → `failed`; some failed → `partly_failed`. A failure outranks
 *    everything else, because it is the one state that needs a person.
 * 3. All published → `published`.
 * 4. Otherwise the least advanced pending state present: `draft`, then `scheduled`, then
 *    `publishing` — a group is only as far along as its slowest variant.
 *
 * An empty list reads `draft`; a group cannot be created without a variant, so that is a fallback.
 */
export function groupDisplayStatus(statuses: readonly PostStatus[]): PostGroupStatus {
  const live: readonly PostStatus[] = statuses.filter((s) => s !== 'cancelled');
  if (live.length === 0) return statuses.length > 0 ? 'cancelled' : 'draft';
  const failed = live.filter((s) => s === 'failed').length;
  if (failed === live.length) return 'failed';
  if (failed > 0) return 'partly_failed';
  if (live.every((s) => s === 'published')) return 'published';
  return PENDING_ORDER.find((s) => live.includes(s)) ?? 'published';
}

/**
 * Post groups, one item per composed post (`GET /v1/post-groups`). The filters are `listPostsQuery`'s
 * and apply to the VARIANTS: a group is listed when at least one of its posts matches, and it is then
 * returned with all of its posts. `q` matches a variant's caption, case-insensitively. Ordered by
 * the earliest `publishAt` among the matching variants — the group's creation time when none has
 * one — newest first unless `order=asc`. `limit`/`offset` count groups, so a group is never split
 * across pages.
 */
export const listPostGroupsQuery = listPostsQuery.extend({
  q: z.string().trim().min(1).max(200).optional(),
  order: z.enum(['desc', 'asc']).default('desc'),
});
export type ListPostGroupsQuery = z.infer<typeof listPostGroupsQuery>;

/** One item of the group list: the shared fields, the headline status, and every variant. */
export const postGroupSummary = z.object({
  id: z.string().uuid(),
  caption: z.string(),
  media: z.array(postMediaView),
  createdAt: z.coerce.date(),
  status: postGroupStatus,
  posts: z.array(postView),
});
export type PostGroupSummary = z.infer<typeof postGroupSummary>;

/**
 * Why a dry-run rejected a post (`POST /v1/posts/validate`, MCP `validate_post`). The first four
 * are exactly what create rejects; the `media_*` codes are checks create does NOT run — a post that
 * trips them is accepted by create and fails when it tries to publish.
 */
export const postValidationCode = z.enum([
  /** The body fails the `createPostInput` contract. */
  'invalid_request',
  /** The provider's own rules (`assertPublishable`) reject this variant. */
  'not_publishable',
  /** No such connection in this workspace. */
  'connection_not_found',
  'queue_not_found',
  'queue_inactive',
  /** A media ref names no media of this workspace and carries no `url` of its own. */
  'media_not_found',
  /** The stored media is outside the platform's spec (format, aspect ratio, duration, size). */
  'media_rejected',
]);
export type PostValidationCode = z.infer<typeof postValidationCode>;

export const postValidationIssue = z.object({
  /** Set when the issue belongs to one variant rather than the whole request. */
  connectionId: z.string().optional(),
  provider: providerIdentifier.optional(),
  code: postValidationCode,
  message: z.string(),
});
export type PostValidationIssue = z.infer<typeof postValidationIssue>;

/** Result of a dry run: nothing was created, scheduled or sent to a platform. */
export const postValidationResult = z.object({
  valid: z.boolean(),
  issues: z.array(postValidationIssue),
});
export type PostValidationResult = z.infer<typeof postValidationResult>;
