import { z } from 'zod';
import { providerIdentifier, type ProviderIdentifier } from './providers.js';
import { postSource } from './imports.js';

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
  description: z
    .string()
    .refine(
      (text) => new TextEncoder().encode(text).length <= 5000,
      'YouTube description must be at most 5000 UTF-8 bytes',
    )
    .optional(),
  /**
   * Requested visibility. Current upload docs differ from older private-lock audit guidance;
   * the provider reads YouTube’s actual visibility back into remote.privacyStatus.
   */
  privacyStatus: z.enum(['public', 'unlisted', 'private']).default('public'),
  categoryId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  madeForKids: z.boolean().default(false),
  remote: z
    .object({ privacyStatus: z.enum(['public', 'unlisted', 'private']).optional() })
    .optional(),
  durationSeconds: z.number().nonnegative().optional(),
  shortsHint: z.boolean().optional(),
});

/** A category or tag: its WordPress term id, or its name as the site shows it. */
const wordpressTerm = z.union([z.number().int().positive(), z.string().trim().min(1).max(200)]);

/** Site-owned article facts; imported HTML is never Markdown. No database migration. */
export const wordpressRemoteArticle = z.object({
  title: z.string(),
  excerpt: z.string(),
  slug: z.string(),
  status: z.enum(['publish', 'draft', 'pending', 'future', 'private']),
  modifiedAt: z.string(),
  publishedAt: z.string().nullable(),
  categories: z.array(z.string()),
  tags: z.array(z.string()),
  author: z.string(),
  categoryIds: z.array(z.number().int().positive()).optional(),
  tagIds: z.array(z.number().int().positive()).optional(),
  featuredMediaId: z.number().int().nonnegative().optional(),
  bodyFormat: z.literal('html'),
  bodyTruncated: z.boolean(),
});
export type WordPressRemoteArticle = z.infer<typeof wordpressRemoteArticle>;

/**
 * A WordPress article. The variant's `caption` is the article BODY, written in Markdown (the
 * provider converts it to HTML and escapes any raw HTML — see providers/wordpress/markdown.ts);
 * the first image in `media` is the featured image. Everything an article has that a social post
 * does not lives here.
 */
const wordpressOptions = z.object({
  kind: z.literal('wordpress'),
  remote: wordpressRemoteArticle.optional(),
  /** Mandatory, for YouTube's reason: there is no honest way to make a headline out of a body. */
  title: z.string().trim().min(1).max(300),
  /** Hand-written summary. Omitted, WordPress derives one from the body when a theme asks. */
  excerpt: z.string().max(2000).optional(),
  /** The URL segment. Omitted, WordPress derives it from the title. */
  slug: z
    .string()
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens only')
    .optional(),
  /** Must already exist on the site — a mistyped category must not quietly become a new one. */
  categories: z.array(wordpressTerm).max(20).optional(),
  /** A tag that does not exist yet is created, as WordPress's own editor does. */
  tags: z.array(wordpressTerm).max(50).optional(),
  /**
   * The state the article is created in ON WORDPRESS, at the moment this post publishes. `draft`
   * and `pending` hand it to the site's own editors and nothing goes public. WHEN it is sent is
   * this app's schedule, as for every platform — which is why WordPress's own `future` status is
   * deliberately not offered.
   */
  status: z.enum(['publish', 'draft', 'pending', 'private']).default('publish'),
});

export const postOptions = z.discriminatedUnion('kind', [
  metaOptions,
  gmbOptions,
  youtubeOptions,
  wordpressOptions,
]);
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
  wordpress: 'wordpress',
};

/** Providers whose options carry a field with no sensible default, so the post is invalid without. */
const OPTIONS_REQUIRED: ReadonlySet<ProviderIdentifier> = new Set(['youtube', 'wordpress']);

/** The longest caption a social post takes. */
export const CAPTION_MAX = 5000;
/**
 * The longest article body. An article does not fit in a social caption, so a provider listed in
 * `LONG_BODY` may carry up to this much — in the VARIANT's own `caption`. The group caption stays at
 * `CAPTION_MAX`, since every variant without its own caption inherits it.
 */
export const ARTICLE_BODY_MAX = 100_000;
const LONG_BODY: ReadonlySet<ProviderIdentifier> = new Set(['wordpress']);

/**
 * The longest caption one post on this provider may carry. Exported for `updatePost`, which has to
 * apply it to a STORED post for the same reason as `optionsArmForProvider`.
 */
export function captionLimitForProvider(provider: ProviderIdentifier): number {
  return LONG_BODY.has(provider) ? ARTICLE_BODY_MAX : CAPTION_MAX;
}

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
    /**
     * Overrides the group caption when set. At most `captionLimitForProvider` characters — 5000,
     * or 100000 for a WordPress article body (checked below, where the provider is known).
     */
    caption: z.string().max(ARTICLE_BODY_MAX).optional(),
    /** Overrides the group media when set. Array order = carousel / thread order. */
    media: z.array(mediaRef).max(10).optional(),
    /** Per-platform options (#44). Required for providers in `OPTIONS_REQUIRED`. */
    options: postOptions.optional(),
  })
  .superRefine((variant, ctx) => {
    const limit = captionLimitForProvider(variant.provider);
    if (variant.caption !== undefined && variant.caption.length > limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caption'],
        message: `String must contain at most ${limit} character(s)`,
      });
    }
    const arm = OPTIONS_ARM[variant.provider];
    if (!variant.options) {
      if (OPTIONS_REQUIRED.has(variant.provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: `"${variant.provider}" posts require options (the post has no title without them)`,
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
  caption: z.string().max(CAPTION_MAX).default(''),
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
   * `imported`: found on the platform, not published by this app. Always `published`; it can be
   * read, measured and duplicated as a draft, never edited, cancelled, retried or published.
   * Optional, like `media`, so an older payload still parses: absent means `app`.
   */
  source: postSource.optional(),
  /** Set once the platform no longer has the post (deleted there). Its status stays `published`. */
  platformRemovedAt: z.coerce.date().nullable().optional(),
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
  /**
   * The patch does not carry the provider, so only the outer bound is checked here; `updatePost`
   * applies `captionLimitForProvider` against the stored row.
   */
  caption: z.string().max(ARTICLE_BODY_MAX).optional(),
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
  /** `app`: published here. `imported`: found on the platform. Omitted = both. */
  source: postSource.optional(),
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
export { groupDisplayStatus, type PostGroupStatus } from './group-status.js';

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

/** Remote edits are independent of scheduler lifecycle edits. IDs refer to existing site terms/media. */
export const remotePostFields = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    body: z.string().max(ARTICLE_BODY_MAX).optional(),
    excerpt: z.string().max(2000).optional(),
    slug: z.string().max(200).optional(),
    status: z.enum(['draft', 'publish', 'pending', 'private']).optional(),
    categories: z.array(z.number().int().positive()).max(100).optional(),
    tags: z.array(z.number().int().positive()).max(100).optional(),
    featuredImage: z.number().int().nonnegative().optional(),
  })
  .strict();
export const remotePostVersion = z.object({ expectedModifiedAt: z.string().datetime() }).strict();
export const updateRemotePostInput = remotePostVersion.extend({ fields: remotePostFields });
export const trashRemotePostInput = remotePostVersion.extend({ confirm: z.literal(true) });
export type RemotePostFields = z.infer<typeof remotePostFields>;
export type UpdateRemotePostInput = z.infer<typeof updateRemotePostInput>;
export type TrashRemotePostInput = z.infer<typeof trashRemotePostInput>;
