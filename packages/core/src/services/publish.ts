import { withWorkspace, schema } from '@meegrow-social/db';
import { eq } from 'drizzle-orm';
import type { MediaRef } from '@meegrow-social/contracts';
import { getProvider } from '../providers/registry.js';
import type { AuthTokens, PostDetails } from '../providers/types.js';
import { decryptToken } from '../crypto.js';
import { ProviderAuthError, ProviderBadRequestError } from '../errors.js';
import { resolveMediaRefs } from './media.js';

export interface PublishOutcome {
  postId: string;
  status: 'published' | 'failed';
  releaseUrl?: string;
  error?: string;
}

/**
 * Publish one post to its platform. Called by the worker's BullMQ processor. Idempotent-ish:
 * a post already `published` is a no-op. Transient provider errors propagate (BullMQ retries);
 * auth/bad-request errors mark the post failed (and, for auth, the connection needs_reconnect).
 */
export async function publishPost(workspaceId: string, postId: string): Promise<PublishOutcome> {
  return withWorkspace(workspaceId, async (tx) => {
    const [post] = await tx.select().from(schema.posts).where(eq(schema.posts.id, postId)).limit(1);
    if (!post) throw new Error(`post ${postId} not found`);
    if (post.status === 'published') {
      return { postId, status: 'published', releaseUrl: post.releaseUrl ?? undefined };
    }

    const [conn] = await tx
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, post.connectionId))
      .limit(1);
    if (!conn) throw new Error(`connection ${post.connectionId} not found`);

    const provider = getProvider(post.provider as never);
    const tokens: AuthTokens = {
      accessToken: conn.accessToken ? decryptToken(conn.accessToken) : '',
      refreshToken: conn.refreshToken ? decryptToken(conn.refreshToken) : undefined,
      externalId: conn.externalId,
      displayName: conn.displayName,
    };
    // Posts may be created with only a mediaId (no url yet) — resolve public URLs here (PRD F3.3:
    // IG/GBP require them at publish time).
    const media = await resolveMediaRefs(tx, (post.media as MediaRef[]) ?? []);
    const details: PostDetails[] = [{ caption: post.caption, media }];

    await tx.update(schema.posts).set({ status: 'publishing' }).where(eq(schema.posts.id, postId));

    try {
      const result = await provider.post(tokens, details);
      await tx
        .update(schema.posts)
        .set({ status: 'published', releaseUrl: result.releaseUrl, error: null })
        .where(eq(schema.posts.id, postId));
      await tx.insert(schema.eventLogs).values({
        workspaceId,
        kind: 'publish',
        status: 'published',
        platform: post.provider,
        account: conn.displayName,
        message: result.releaseUrl,
      });
      return { postId, status: 'published', releaseUrl: result.releaseUrl };
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        await tx
          .update(schema.connections)
          .set({ needsReconnect: true })
          .where(eq(schema.connections.id, conn.id));
      } else if (!(err instanceof ProviderBadRequestError)) {
        throw err; // transient → let the job runner retry
      }
      const message = err instanceof Error ? err.message : String(err);
      await tx
        .update(schema.posts)
        .set({ status: 'failed', error: message })
        .where(eq(schema.posts.id, postId));
      await tx.insert(schema.eventLogs).values({
        workspaceId,
        kind: 'publish',
        status: 'failed',
        platform: post.provider,
        account: conn.displayName,
        message,
      });
      return { postId, status: 'failed', error: message };
    }
  });
}
