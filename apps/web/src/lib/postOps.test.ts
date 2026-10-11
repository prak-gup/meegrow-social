import { describe, expect, it } from 'vitest';
import type { PostView } from '@meegrow-social/contracts';
import { partialFailureText, runOnPosts } from './postOps';

const post = (id: string): PostView =>
  ({ id, provider: 'facebook', status: 'scheduled', caption: '' }) as PostView;
const name = (p: PostView) => `Account ${p.id}`;

describe('runOnPosts', () => {
  it('runs every variant in order and keeps going past a failure', async () => {
    const seen: string[] = [];
    const result = await runOnPosts([post('a'), post('b'), post('c')], async (p) => {
      seen.push(p.id);
      if (p.id === 'b') throw new Error("a 'published' post cannot be cancelled");
      return { ...p, status: 'cancelled' };
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(result.done.map((p) => [p.id, p.status])).toEqual([
      ['a', 'cancelled'],
      ['c', 'cancelled'],
    ]);
    expect(result.failed).toEqual([
      { post: post('b'), message: "a 'published' post cannot be cancelled" },
    ]);
  });

  it('has words for a failure that is not an Error', async () => {
    const result = await runOnPosts([post('a')], async () => {
      throw 'nope';
    });
    expect(result.failed[0]?.message).toBe('Request failed.');
  });
});

describe('partialFailureText', () => {
  const failed = (id: string, message: string) => ({ post: post(id), message });

  it('is just the reason for a single account', () => {
    expect(
      partialFailureText({ done: [], failed: [failed('a', 'Too late.')] }, 'saved', name),
    ).toBe('Too late.');
  });

  it('says how many went through and names the accounts that did not', () => {
    const text = partialFailureText(
      { done: [post('a')], failed: [failed('b', 'Too late.')] },
      'cancelled',
      name,
    );
    expect(text).toBe('Cancelled for 1 of 2 accounts. Account b: Too late.');
  });

  it('says so when none went through', () => {
    const text = partialFailureText(
      { done: [], failed: [failed('a', 'No.'), failed('b', 'No.')] },
      'saved',
      name,
    );
    expect(text).toBe('Not saved for any of the 2 accounts. Account a: No. Account b: No.');
  });
});
