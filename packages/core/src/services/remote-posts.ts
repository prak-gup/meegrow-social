import {
  parseStoredOptions,
  updateRemotePostInput,
  trashRemotePostInput,
  type UpdateRemotePostInput,
  type TrashRemotePostInput,
} from '@meegrow-social/contracts';
import { schema, withWorkspace } from '@meegrow-social/db';
import { eq } from 'drizzle-orm';
import { RemoteArticleMismatchError } from '../providers/wordpress/manage.js';
import { copyWordPressThumbnail } from './post-import.js';
import { decryptToken } from '../crypto.js';
import { ProviderAuthError, ProviderBadRequestError } from '../errors.js';
import { tryGetProvider } from '../providers/registry.js';
import type { PublishedPostItem } from '../providers/published-posts.js';
import { getPost, PostStateError } from './posts.js';
import type { AuthContext } from './auth.js';

export function assertRemoteEditable(
  row: {
    provider: string;
    status: string;
    externalPostId: string | null;
    platformRemovedAt: Date | null;
    options: unknown;
  },
  expected?: string,
  body?: string,
): 'html' | 'markdown' {
  if (row.status !== 'published' || !row.externalPostId || row.platformRemovedAt)
    throw new PostStateError('Only an existing article on the site can be managed.');
  const options = parseStoredOptions(row.options);
  const remote = options?.kind === 'wordpress' ? options.remote : undefined;
  if (expected !== undefined && (!remote || remote.modifiedAt !== expected))
    throw new PostStateError(
      'Article observation changed or is missing — refresh from site before saving or trashing.',
    );
  if (body !== undefined && remote?.bodyTruncated)
    throw new PostStateError(
      'Body truncated for storage; body editing is disabled to prevent content loss.',
    );
  return remote?.bodyFormat ?? 'markdown';
}

type Operation =
  | { kind: 'refresh' }
  | { kind: 'update'; input: UpdateRemotePostInput }
  | { kind: 'trash'; input: TrashRemotePostInput };
async function manage(ctx: AuthContext, postId: string, operation: Operation) {
  const outcome = await withWorkspace(ctx.workspaceId, async (tx) => {
    // Serializes this app's edits and import row updates; all reads and writes remain RLS scoped.
    const [row] = await tx
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId))
      .limit(1)
      .for('update');
    if (!row) return { missing: true } as const;
    const input = operation.kind === 'refresh' ? undefined : operation.input;
    const format = assertRemoteEditable(
      row,
      input?.expectedModifiedAt,
      operation.kind === 'update' ? operation.input.fields.body : undefined,
    );
    const provider = tryGetProvider(row.provider as Parameters<typeof tryGetProvider>[0]);
    if (
      !provider?.readPublishedPost ||
      (operation.kind === 'update' && !provider.updatePublishedPost) ||
      (operation.kind === 'trash' && !provider.deletePublishedPost)
    )
      throw new ProviderBadRequestError(
        'This provider does not support managing existing site articles.',
      );
    const [connection] = await tx
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, row.connectionId))
      .limit(1);
    if (!connection?.accessToken || connection.needsReconnect)
      throw new ProviderAuthError('Reconnect the site before managing its articles.');
    const tokens = {
      accessToken: decryptToken(connection.accessToken),
      externalId: connection.externalId,
      displayName: connection.displayName,
    };
    let observed: PublishedPostItem | undefined;
    let failure: unknown;
    const storeObservation = async (item: PublishedPostItem) => {
      const options = parseStoredOptions(row.options);
      const oldImage = options?.kind === 'wordpress' ? options.remote?.featuredMediaId : undefined;
      const newImage =
        item.options?.kind === 'wordpress' ? item.options.remote?.featuredMediaId : undefined;
      let media = row.media;
      if (oldImage !== newImage) {
        media = [];
        const copied = await copyWordPressThumbnail(ctx.workspaceId, item);
        if (copied) {
          const [image] = await tx
            .insert(schema.media)
            .values({
              workspaceId: ctx.workspaceId,
              kind: 'image',
              url: copied.url,
              s3Key: copied.key,
              bytes: copied.bytes,
              meta: { imported: true },
            })
            .returning({ id: schema.media.id });
          if (image) media = [{ mediaId: image.id, kind: 'image', url: copied.url }];
        }
      }
      await tx
        .update(schema.posts)
        .set({
          caption: item.caption,
          options: item.options,
          releaseUrl: item.permalink,
          platformRemovedAt: null,
          media,
        })
        .where(eq(schema.posts.id, postId));
    };
    try {
      if (operation.kind === 'trash') {
        await provider.deletePublishedPost!(
          tokens,
          row.externalPostId!,
          operation.input.expectedModifiedAt,
        );
        await tx
          .update(schema.posts)
          .set({ platformRemovedAt: new Date() })
          .where(eq(schema.posts.id, postId));
      } else {
        observed =
          operation.kind === 'refresh'
            ? await provider.readPublishedPost(tokens, row.externalPostId!)
            : await provider.updatePublishedPost!(
                tokens,
                row.externalPostId!,
                operation.input.expectedModifiedAt,
                operation.input.fields,
                format,
              );
        await storeObservation(observed);
      }
    } catch (error) {
      if (error instanceof RemoteArticleMismatchError) await storeObservation(error.observed);
      failure = error;
    }
    if (operation.kind !== 'refresh') {
      // Store field names and authenticated actor IDs only, never body values or credentials.
      await tx.insert(schema.eventLogs).values({
        workspaceId: ctx.workspaceId,
        kind: 'remote_post',
        status: failure ? 'unconfirmed' : operation.kind,
        platform: row.provider,
        account: connection.displayName,
        message: JSON.stringify({
          postId,
          actor: ctx.userId ? { userId: ctx.userId } : { apiKeyId: ctx.apiKeyId ?? 'internal' },
          fields: operation.kind === 'update' ? Object.keys(operation.input.fields) : ['status'],
          confirmed: !failure,
        }),
      });
    }
    return { failure };
  });
  if ('missing' in outcome) return null;
  if (outcome.failure) throw outcome.failure;
  return getPost(ctx.workspaceId, postId);
}
export async function refreshRemotePost(ctx: AuthContext, postId: string) {
  return manage(ctx, postId, { kind: 'refresh' });
}
export async function updateRemotePost(
  ctx: AuthContext,
  postId: string,
  input: UpdateRemotePostInput,
) {
  const parsed = updateRemotePostInput.parse(input);
  if (!Object.keys(parsed.fields).length)
    throw new ProviderBadRequestError('Choose at least one field to update.');
  return manage(ctx, postId, { kind: 'update', input: parsed });
}
export async function trashRemotePost(
  ctx: AuthContext,
  postId: string,
  input: TrashRemotePostInput,
) {
  return manage(ctx, postId, { kind: 'trash', input: trashRemotePostInput.parse(input) });
}
