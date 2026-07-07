import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace, schema, closeDb } from '@meegrow-social/db';
import { eq } from 'drizzle-orm';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import { createPost } from './posts.js';
import { publishPost } from './publish.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

describe('publish (via FakeProvider)', () => {
  it('creates a scheduled post and publishes it end-to-end', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'fake');

    const posts = await createPost(ws, {
      caption: 'hello world',
      media: [],
      variants: [{ connectionId, provider: 'fake' }],
      schedule: { type: 'now' },
    });
    expect(posts).toHaveLength(1);
    const postId = posts[0]!.id;

    const outcome = await publishPost(ws, postId);
    expect(outcome.status).toBe('published');
    expect(outcome.releaseUrl).toContain('https://fake.local/p/');

    const stored = await withWorkspace(ws, (tx) =>
      tx.select().from(schema.posts).where(eq(schema.posts.id, postId)),
    );
    expect(stored[0]?.status).toBe('published');

    const logs = await withWorkspace(ws, (tx) => tx.select().from(schema.eventLogs));
    expect(logs.some((l) => l.kind === 'publish' && l.status === 'published')).toBe(true);
  });
});
