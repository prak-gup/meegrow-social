/**
 * Port for the durable job engine. `core` defines the contract; `apps/worker` provides a
 * BullMQ-backed implementation; tests provide a fake. Keeps BullMQ out of the sealed core.
 */
export interface Scheduler {
  schedulePublish(input: {
    workspaceId: string;
    postId: string;
    when: Date | 'now';
  }): Promise<void>;
  /** Cancel a scheduled publish job so it never fires. No-op if it has already fired/finished. */
  cancelPublish(input: { postId: string }): Promise<void>;
}

let _scheduler: Scheduler | undefined;

export function setScheduler(s: Scheduler): void {
  _scheduler = s;
}

export function getScheduler(): Scheduler {
  if (!_scheduler) throw new Error('scheduler not configured — call setScheduler() at startup');
  return _scheduler;
}
