import { z } from 'zod';
import { providerIdentifier } from './providers.js';
import { mediaKind } from './posts.js';

/**
 * Technical metadata captured by ffprobe (dimensions/duration/codec) plus the container derived
 * from the upload's content-type (PRD F3.3). Kept flexible (all optional, `container`/`codec` as
 * plain strings) because different kinds populate different subsets and new platforms will need
 * new fields without a schema migration.
 */
export const mediaMeta = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  codec: z.string().optional(),
  /** File type derived from content-type, e.g. "jpeg" | "png" | "mp4" | "mov". */
  container: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
});
export type MediaMeta = z.infer<typeof mediaMeta>;

export const mediaView = z.object({
  id: z.string().uuid(),
  kind: mediaKind,
  url: z.string().url().nullable(),
  bytes: z.number().int().nullable(),
  meta: mediaMeta,
  createdAt: z.coerce.date(),
});
export type MediaView = z.infer<typeof mediaView>;

/** Media library page (D1 `list_media`). Newest first; offset pagination like `listPostsQuery`. */
export const listMediaQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListMediaQuery = z.infer<typeof listMediaQuery>;

/** MCP tool + REST input for registering media antidote (or another producer) already hosts. */
export const registerMediaFromUrlInput = z.object({
  url: z.string().url(),
  /** Inferred from the fetched content-type when omitted. */
  kind: mediaKind.optional(),
});
export type RegisterMediaFromUrlInput = z.infer<typeof registerMediaFromUrlInput>;

/** Body for `POST /v1/media/:id/validate` — checks already-probed media against one platform's spec. */
export const validateMediaInput = z.object({
  provider: providerIdentifier,
});
export type ValidateMediaInput = z.infer<typeof validateMediaInput>;

export const mediaValidationResult = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
});
export type MediaValidationResult = z.infer<typeof mediaValidationResult>;
