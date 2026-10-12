import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@meegrow-social/db';
import { parseStoredOptions } from '@meegrow-social/contracts';
import { updateRemotePost, trashRemotePost, refreshRemotePost } from './remote-posts.js';
import { RemoteArticleMismatchError } from '../providers/wordpress/manage.js';

const state = vi.hoisted(() => ({
  supported: true,
  row: null as Record<string, unknown> | null,
  connection: null as Record<string, unknown> | null,
  writes: [] as Record<string, unknown>[],
  logs: [] as Record<string, unknown>[],
  workspaces: [] as string[],
}));
const provider = vi.hoisted(() => ({
  readPublishedPost: vi.fn(),
  updatePublishedPost: vi.fn(),
  deletePublishedPost: vi.fn(),
}));
vi.mock('../providers/registry.js', () => ({
  tryGetProvider: () => (state.supported ? provider : undefined),
}));
vi.mock('../crypto.js', () => ({ decryptToken: () => 'fixture-credential' }));
vi.mock('./posts.js', () => ({
  PostStateError: class extends Error {},
  getPost: vi.fn(async () => state.row),
}));
vi.mock('./post-import.js', () => ({ copyWordPressThumbnail: vi.fn(async () => null) }));
vi.mock('@meegrow-social/db', async (importOriginal) => {
  const original = await importOriginal<typeof DbModule>();
  return {
    ...original,
    withWorkspace: async (ws: string, fn: (tx: unknown) => unknown) => {
      state.workspaces.push(ws);
      const tx = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: () => {
                const result = Promise.resolve(
                  table === original.schema.posts
                    ? state.row
                      ? [state.row]
                      : []
                    : state.connection
                      ? [state.connection]
                      : [],
                );
                return Object.assign(result, { for: () => result });
              },
            }),
          }),
        }),
        update: () => ({
          set: (patch: Record<string, unknown>) => ({
            where: async () => {
              state.writes.push(patch);
              Object.assign(state.row!, patch);
            },
          }),
        }),
        insert: () => ({
          values: async (row: Record<string, unknown>) => {
            state.logs.push(row);
          },
        }),
      };
      return fn(tx);
    },
  };
});
const modifiedAt = '2026-10-10T11:00:00.000Z';
const options = {
  kind: 'wordpress',
  title: 'Title',
  remote: {
    title: 'Title',
    excerpt: '',
    slug: 'title',
    status: 'draft',
    modifiedAt,
    publishedAt: null,
    categories: [],
    tags: [],
    categoryIds: [],
    tagIds: [],
    featuredMediaId: 0,
    author: '',
    bodyFormat: 'html',
    bodyTruncated: false,
  },
};
const observed = () => ({
  externalPostId: '12',
  caption: '<p>New</p>',
  options: parseStoredOptions(options)!,
  permalink: 'https://example.test/new',
  publishedAt: new Date(),
  alternateIds: [],
  knownUrls: [],
  mediaKind: null,
  mediaCount: 0,
  thumbnailUrl: null,
});
const ctx = { workspaceId: 'workspace-a', userId: 'user-a' };
beforeEach(() => {
  vi.clearAllMocks();
  state.supported = true;
  state.writes = [];
  state.logs = [];
  state.workspaces = [];
  state.row = {
    id: 'post-a',
    provider: 'wordpress',
    connectionId: 'connection-a',
    status: 'published',
    externalPostId: '12',
    platformRemovedAt: null,
    caption: '<p>Old</p>',
    options,
    media: [],
  };
  state.connection = {
    accessToken: 'encrypted-fixture',
    needsReconnect: false,
    externalId: 'https://example.test',
    displayName: 'Blog',
  };
  provider.readPublishedPost.mockResolvedValue(observed());
  provider.updatePublishedPost.mockResolvedValue(observed());
  provider.deletePublishedPost.mockResolvedValue(undefined);
});
describe('workspace-scoped remote post services (in-memory transactions)', () => {
  it.each(['imported', 'app'])(
    'updates %s articles from verified read-back and logs actor/fields only',
    async (source) => {
      state.row!.source = source;
      await updateRemotePost(ctx, 'post-a', {
        expectedModifiedAt: modifiedAt,
        fields: { title: 'New' },
      });
      expect(state.workspaces).toEqual(['workspace-a']);
      expect(provider.updatePublishedPost).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'fixture-credential' }),
        '12',
        modifiedAt,
        { title: 'New' },
        'html',
      );
      expect(state.writes[0]).toMatchObject({
        caption: '<p>New</p>',
        releaseUrl: 'https://example.test/new',
      });
      expect(JSON.parse(String(state.logs[0]!.message))).toEqual({
        postId: 'post-a',
        actor: { userId: 'user-a' },
        fields: ['title'],
        confirmed: true,
      });
      expect(JSON.stringify(state.logs)).not.toContain('fixture-credential');
    },
  );
  it('cannot reach a provider when the workspace read returns no row', async () => {
    state.row = null;
    expect(
      await updateRemotePost(ctx, 'foreign-post', {
        expectedModifiedAt: modifiedAt,
        fields: { title: 'New' },
      }),
    ).toBeNull();
    expect(provider.updatePublishedPost).not.toHaveBeenCalled();
  });
  it('refuses a stale client version before contacting the site', async () => {
    await expect(
      updateRemotePost(ctx, 'post-a', {
        expectedModifiedAt: '2026-10-09T11:00:00.000Z',
        fields: { title: 'New' },
      }),
    ).rejects.toThrow('refresh');
    expect(provider.updatePublishedPost).not.toHaveBeenCalled();
  });
  it('requires a current observation for app-published rows and refresh fills it', async () => {
    state.row!.options = { kind: 'wordpress', title: 'Title' };
    await expect(
      updateRemotePost(ctx, 'post-a', { expectedModifiedAt: modifiedAt, fields: { title: 'New' } }),
    ).rejects.toThrow('refresh');
    await refreshRemotePost(ctx, 'post-a');
    expect(provider.readPublishedPost).toHaveBeenCalled();
    expect(state.row!.options).toEqual(observed().options);
  });
  it('never allows a truncated body to be written, but allows other fields', async () => {
    state.row!.options = { ...options, remote: { ...options.remote, bodyTruncated: true } };
    await expect(
      updateRemotePost(ctx, 'post-a', {
        expectedModifiedAt: modifiedAt,
        fields: { body: 'lost content' },
      }),
    ).rejects.toThrow('truncated');
    expect(provider.updatePublishedPost).not.toHaveBeenCalled();
    await updateRemotePost(ctx, 'post-a', {
      expectedModifiedAt: modifiedAt,
      fields: { title: 'New' },
    });
    expect(provider.updatePublishedPost).toHaveBeenCalled();
  });
  it('retains observed mismatches and audits failure without claiming success', async () => {
    provider.updatePublishedPost.mockRejectedValue(
      new RemoteArticleMismatchError('not stored', observed()),
    );
    await expect(
      updateRemotePost(ctx, 'post-a', { expectedModifiedAt: modifiedAt, fields: { title: 'New' } }),
    ).rejects.toThrow('not stored');
    expect(state.row!.caption).toBe('<p>New</p>');
    expect(state.logs[0]!.status).toBe('unconfirmed');
  });
  it('logs unconfirmed transport failures without changing stored values', async () => {
    provider.updatePublishedPost.mockRejectedValue(new Error('read-back unavailable'));
    await expect(
      updateRemotePost(ctx, 'post-a', { expectedModifiedAt: modifiedAt, fields: { title: 'New' } }),
    ).rejects.toThrow('unavailable');
    expect(state.writes).toEqual([]);
    expect(state.logs[0]!.status).toBe('unconfirmed');
  });
  it('requires confirm=true and only marks removal after confirmed trash', async () => {
    await expect(
      trashRemotePost(ctx, 'post-a', { expectedModifiedAt: modifiedAt, confirm: false } as never),
    ).rejects.toThrow();
    expect(provider.deletePublishedPost).not.toHaveBeenCalled();
    await trashRemotePost({ workspaceId: ctx.workspaceId, apiKeyId: 'key-a' }, 'post-a', {
      expectedModifiedAt: modifiedAt,
      confirm: true,
    });
    expect(state.row!.platformRemovedAt).toBeInstanceOf(Date);
    expect(JSON.parse(String(state.logs[0]!.message)).actor).toEqual({ apiKeyId: 'key-a' });
  });
  it('does not mark removal when trash cannot be confirmed', async () => {
    provider.deletePublishedPost.mockRejectedValue(new Error('not confirmed'));
    await expect(
      trashRemotePost(ctx, 'post-a', { expectedModifiedAt: modifiedAt, confirm: true }),
    ).rejects.toThrow('not confirmed');
    expect(state.row!.platformRemovedAt).toBeNull();
  });
  it.each(['draft', 'scheduled', 'publishing', 'failed', 'cancelled'])(
    'refuses lifecycle state %s',
    async (status) => {
      state.row!.status = status;
      await expect(refreshRemotePost(ctx, 'post-a')).rejects.toThrow('existing article');
      expect(provider.readPublishedPost).not.toHaveBeenCalled();
    },
  );
  it('refuses providers without remote capabilities before requesting anything', async () => {
    state.supported = false;
    await expect(
      updateRemotePost(ctx, 'post-a', { expectedModifiedAt: modifiedAt, fields: { title: 'New' } }),
    ).rejects.toThrow('does not support');
    expect(provider.updatePublishedPost).not.toHaveBeenCalled();
  });
  it('refuses disconnected/reconnect-required sites', async () => {
    state.connection!.needsReconnect = true;
    await expect(refreshRemotePost(ctx, 'post-a')).rejects.toThrow('Reconnect');
    expect(provider.readPublishedPost).not.toHaveBeenCalled();
  });
});
