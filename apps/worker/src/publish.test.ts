import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordPublishExhaustion } from './deps.js';
import { isFinalFailure, onPublishJobFailed, type FailedPublishJob } from './publish.js';

vi.mock('./deps.js', () => ({
  PUBLISH_QUEUE: 'publish',
  publishPost: vi.fn(),
  recordPublishExhaustion: vi.fn(),
}));

const data = { workspaceId: 'ws-1', postId: 'post-1' };
const job = (over: Partial<FailedPublishJob> = {}): FailedPublishJob => ({
  data,
  attemptsMade: 3,
  finishedOn: 1_760_000_000_000,
  opts: { attempts: 3 },
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(recordPublishExhaustion).mockResolvedValue({
    postMarkedFailed: true,
    dlqRecorded: true,
  });
});

describe('isFinalFailure', () => {
  it('is false while BullMQ still has attempts to make', () => {
    expect(isFinalFailure(job({ attemptsMade: 1, finishedOn: undefined }))).toBe(false);
    expect(isFinalFailure(job({ attemptsMade: 2, finishedOn: undefined }))).toBe(false);
  });

  it('is true on the last attempt', () => {
    expect(isFinalFailure(job({ attemptsMade: 3, finishedOn: undefined }))).toBe(true);
  });

  it('is true for a job BullMQ finished early (unrecoverable error)', () => {
    expect(isFinalFailure(job({ attemptsMade: 1 }))).toBe(true);
  });

  it('treats a job with no attempts option as single-shot', () => {
    expect(isFinalFailure(job({ attemptsMade: 1, finishedOn: undefined, opts: {} }))).toBe(true);
  });
});

describe('onPublishJobFailed', () => {
  it('leaves an intermediate failure to BullMQ: nothing is recorded', async () => {
    await onPublishJobFailed(job({ attemptsMade: 1, finishedOn: undefined }), new Error('503'));
    await onPublishJobFailed(job({ attemptsMade: 2, finishedOn: undefined }), new Error('503'));
    expect(recordPublishExhaustion).not.toHaveBeenCalled();
  });

  it('hands the exhausted job to core, with the last error and the attempt count', async () => {
    await onPublishJobFailed(job(), new Error('platform returned 503'));
    expect(recordPublishExhaustion).toHaveBeenCalledTimes(1);
    expect(recordPublishExhaustion).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      postId: 'post-1',
      queue: 'publish',
      payload: data,
      error: 'platform returned 503',
      attempts: 3,
    });
  });

  it('ignores the event BullMQ emits without a job', async () => {
    await onPublishJobFailed(undefined, new Error('gone'));
    expect(recordPublishExhaustion).not.toHaveBeenCalled();
  });

  it('never rejects when core cannot record it — it logs which post is stuck', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(recordPublishExhaustion).mockRejectedValue(new Error('db down'));
    await expect(onPublishJobFailed(job(), new Error('503'))).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toContain('post-1');
    logged.mockRestore();
  });
});
