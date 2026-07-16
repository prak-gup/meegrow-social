import { describe, expect, it } from 'vitest';
import { publishJobId } from './scheduler.js';

/**
 * Guards the BullMQ job-id contract.
 *
 * Why this file exists: `jobId: \`publish:${postId}\`` shipped and stranded EVERY scheduled post in
 * production — BullMQ throws "Custom Id cannot contain :" from queue.add(), so createPost committed
 * the post row and then blew up, leaving posts 'scheduled' with no job behind them. Nothing caught
 * it because our integration tests inject the recording scheduler (testing/), which accepts any id;
 * the real adapter's constraints were never exercised. See scheduler.integration.test.ts for the
 * test that actually talks to BullMQ.
 */
describe('publishJobId', () => {
  it('never contains a colon — BullMQ rejects custom ids that do', () => {
    const id = publishJobId('4e0a8d7e-4e80-4d00-aea2-fd055f0fdb08');
    expect(id).not.toContain(':');
  });

  it('is deterministic, so cancelPublish can find the job without storing the id', () => {
    const postId = '1465aeca-a729-4df2-8abd-ef63d20b0547';
    expect(publishJobId(postId)).toBe(publishJobId(postId));
    expect(publishJobId(postId)).toContain(postId);
  });

  it('is distinct per post', () => {
    expect(publishJobId('a')).not.toBe(publishJobId('b'));
  });
});
