import {
  createPostInput,
  providerIdentifier,
  type CreatePostInput,
  type PostValidationIssue,
  type PostValidationResult,
} from '@meegrow-social/contracts';
import { ProviderBadRequestError } from '../errors.js';
import { validateMedia } from '../media/validate.js';
import { findMissingConnectionIds } from './connections.js';
import { getMediaByIds } from './media.js';
import { assertVariantPublishable } from './posts.js';
import { nextFreeSlotForQueue, QueueInactiveError, QueueNotFoundError } from './queues.js';

/**
 * Contract failures as issues. An issue under `variants[i]` is tagged with that variant's
 * connection/provider, read off the RAW body (it never parsed) and only when they are well-formed.
 */
export function contractIssues(
  rawInput: unknown,
  error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> },
): PostValidationIssue[] {
  const variants = (rawInput as { variants?: unknown } | null)?.variants;
  return error.issues.map((issue) => {
    const out: PostValidationIssue = {
      code: 'invalid_request',
      message: `${issue.path.join('.') || 'input'}: ${issue.message}`,
    };
    const [head, index] = issue.path;
    if (head !== 'variants' || typeof index !== 'number' || !Array.isArray(variants)) return out;
    const variant = variants[index] as { connectionId?: unknown; provider?: unknown } | null;
    if (typeof variant?.connectionId === 'string') out.connectionId = variant.connectionId;
    const provider = providerIdentifier.safeParse(variant?.provider);
    if (provider.success) out.provider = provider.data;
    return out;
  });
}

/**
 * Each variant past its provider's own rules — the SAME `assertPublishable` call create makes, but
 * collected per variant instead of stopping at the first one that throws.
 */
export function publishabilityIssues(input: CreatePostInput): PostValidationIssue[] {
  const issues: PostValidationIssue[] = [];
  for (const v of input.variants) {
    try {
      assertVariantPublishable(input, v);
    } catch (err) {
      if (!(err instanceof ProviderBadRequestError)) throw err;
      issues.push({
        connectionId: v.connectionId,
        provider: v.provider,
        code: 'not_publishable',
        message: err.message,
      });
    }
  }
  return issues;
}

/**
 * Dry-run a create (`POST /v1/posts/validate`, MCP `validate_post`): same body as `createPost`,
 * nothing written, nothing scheduled, no queue slot taken, no platform called.
 *
 * Runs, in order: the `createPostInput` contract; every variant's provider rules; that each
 * connection belongs to this workspace; that a queue schedule names an existing, active queue with
 * a free slot — all four are exactly the checks `createPost` makes, through the same functions.
 * Then two checks create does NOT make, because the publish path is where they bite today: each
 * media ref resolves (a row of this workspace, or a `url` of its own — what `resolveMediaRefs`
 * needs), and stored media fits the platform's spec (`validateMedia`).
 *
 * NOT covered, because nothing stored can answer it: whether the platform still accepts the token,
 * rate limits and content policy on the platform's side, and whether a media URL is reachable.
 */
export async function validatePost(
  workspaceId: string,
  rawInput: unknown,
): Promise<PostValidationResult> {
  const parsed = createPostInput.safeParse(rawInput);
  if (!parsed.success) return { valid: false, issues: contractIssues(rawInput, parsed.error) };
  const input = parsed.data;
  const issues = publishabilityIssues(input);

  const missing = new Set(
    await findMissingConnectionIds(
      workspaceId,
      input.variants.map((v) => v.connectionId),
    ),
  );
  for (const v of input.variants) {
    if (!missing.has(v.connectionId)) continue;
    issues.push({
      connectionId: v.connectionId,
      provider: v.provider,
      code: 'connection_not_found',
      message: `connection ${v.connectionId} not found`,
    });
  }

  if (input.schedule.type === 'queue') {
    try {
      await nextFreeSlotForQueue(workspaceId, input.schedule.queueId);
    } catch (err) {
      if (err instanceof QueueNotFoundError) {
        issues.push({ code: 'queue_not_found', message: err.message });
      } else if (err instanceof QueueInactiveError) {
        issues.push({ code: 'queue_inactive', message: err.message });
      } else {
        throw err;
      }
    }
  }

  const stored = await getMediaByIds(
    workspaceId,
    input.variants.flatMap((v) => (v.media ?? input.media).map((m) => m.mediaId)),
  );
  for (const v of input.variants) {
    for (const ref of v.media ?? input.media) {
      const media = stored.get(ref.mediaId);
      if (!media) {
        // A ref that carries its own url publishes without a media row; one that doesn't cannot.
        if (ref.url) continue;
        issues.push({
          connectionId: v.connectionId,
          provider: v.provider,
          code: 'media_not_found',
          message: `media ${ref.mediaId} not found`,
        });
        continue;
      }
      const verdict = validateMedia(media.kind, media.meta, v.provider);
      if (verdict.valid) continue;
      issues.push({
        connectionId: v.connectionId,
        provider: v.provider,
        code: 'media_rejected',
        message: `media ${ref.mediaId}: ${verdict.reason ?? 'rejected by the platform spec'}`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}
