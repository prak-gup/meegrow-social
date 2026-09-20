import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@meegrow-social/db';
import { createWorkspace, resetDb } from '@meegrow-social/testing';
import {
  createHashtagGroup,
  deleteHashtagGroup,
  listHashtagGroups,
  updateHashtagGroup,
} from './hashtags.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
});
beforeEach(resetDb);
afterAll(closeDb);

describe('hashtag groups CRUD', () => {
  it('creates with empty default tags, lists, updates, and deletes', async () => {
    const workspaceId = await createWorkspace();
    const created = await createHashtagGroup(workspaceId, { name: 'Launch', tags: [] });
    expect(created.tags).toEqual([]);
    expect(await listHashtagGroups(workspaceId)).toEqual([created]);

    const updated = await updateHashtagGroup(workspaceId, created.id, {
      name: 'Campaign',
      tags: ['#launch', '#growth'],
    });
    expect(updated).toMatchObject({ name: 'Campaign', tags: ['#launch', '#growth'] });
    expect(await deleteHashtagGroup(workspaceId, created.id)).toBe(true);
    expect(await listHashtagGroups(workspaceId)).toEqual([]);
  });

  it('returns null or false for rows outside the workspace', async () => {
    const a = await createWorkspace('A');
    const b = await createWorkspace('B');
    const created = await createHashtagGroup(a, { name: 'Private', tags: ['#private'] });
    expect(await updateHashtagGroup(b, created.id, { name: 'Nope' })).toBeNull();
    expect(await deleteHashtagGroup(b, created.id)).toBe(false);
  });
});
