import { describe, expect, it } from 'vitest';
import { POST_STATUSES, STATUS_LABEL, canCancelPost, canEditPost } from './postStatus';

describe('post status rules', () => {
  // core/services/posts.ts: EDITABLE_STATUSES and CANCELABLE_STATUSES are both draft + scheduled.
  it.each([
    ['draft', true],
    ['scheduled', true],
    ['publishing', false],
    ['published', false],
    ['failed', false],
    ['cancelled', false],
  ] as const)('%s: editable and cancelable = %s', (status, allowed) => {
    expect(canEditPost(status)).toBe(allowed);
    expect(canCancelPost(status)).toBe(allowed);
  });

  it('labels every status in words', () => {
    for (const s of POST_STATUSES) expect(STATUS_LABEL[s]).toMatch(/^[A-Z][a-z]+$/);
    expect(new Set(POST_STATUSES.map((s) => STATUS_LABEL[s])).size).toBe(POST_STATUSES.length);
  });
});
