/**
 * What the job engine holds for a post's publish job:
 * - `live`: a job is waiting, delayed or running — the post will be attempted without any help.
 * - `dead`: a job exists but has finished as failed and will not run again.
 * - `none`: there is no job at all.
 */
export type PublishJobState = 'live' | 'dead' | 'none';

/**
 * Port for the durable job engine. `core` defines the contract; `createQueueScheduler`
 * (publish-queue.ts) implements it over a BullMQ queue that the apps construct; tests provide a
 * fake. Keeps BullMQ out of the sealed core.
 */
export interface Scheduler {
  schedulePublish(input: {
    workspaceId: string;
    postId: string;
    when: Date | 'now';
  }): Promise<void>;
  /** Cancel a scheduled publish job so it never fires. No-op if it has already fired/finished. */
  cancelPublish(input: { postId: string }): Promise<void>;
  /** Whether a publish job stands behind this post — what the stranded-post sweep asks. */
  publishJobState(input: { postId: string }): Promise<PublishJobState>;
}

let _scheduler: Scheduler | undefined;

export function setScheduler(s: Scheduler): void {
  _scheduler = s;
}

export function getScheduler(): Scheduler {
  if (!_scheduler) throw new Error('scheduler not configured — call setScheduler() at startup');
  return _scheduler;
}
