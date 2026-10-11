import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepStrandedPublishes } from './deps.js';
import { runPublishSweep } from './publish-sweep.js';

vi.mock('./deps.js', () => ({
  PUBLISH_SWEEP_INTERVAL_MS: 300_000,
  sweepStrandedPublishes: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

describe('runPublishSweep', () => {
  it('stays quiet when nothing was stranded', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errored = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(sweepStrandedPublishes).mockResolvedValue({
      examined: 2,
      requeued: 0,
      failed: 0,
      errors: [],
    });
    expect(await runPublishSweep()).toEqual({ examined: 2, requeued: 0, failed: 0, errors: 0 });
    expect(warned).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
  });

  it('says what it resolved and names each post it could not, without failing the job', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errored = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(sweepStrandedPublishes).mockResolvedValue({
      examined: 3,
      requeued: 1,
      failed: 1,
      errors: ['post post-9 (workspace ws-1): redis is down'],
    });
    expect(await runPublishSweep()).toEqual({ examined: 3, requeued: 1, failed: 1, errors: 1 });
    expect(String(warned.mock.calls[0]![0])).toContain('1 stranded post(s) queued again');
    expect(String(errored.mock.calls[0]![0])).toContain('post-9');
  });
});
