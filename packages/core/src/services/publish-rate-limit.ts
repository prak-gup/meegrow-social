import type { ProviderRateLimitError } from '../errors.js';

export const RATE_LIMIT_DEADLINE_MS = 12 * 60 * 60_000;

/** Durable waiting state in the existing error field; publishAt keeps the original due time. */
export interface RateLimitWait {
  retryAt: Date;
  deadline: Date;
  pauses: number;
}

export function readRateLimitWait(error: string | null | undefined): RateLimitWait | null {
  const match =
    /^Waiting for .+ rate limit, retrying at (\S+)\. Pause (\d+); deadline (\S+)\.$/.exec(
      error ?? '',
    );
  if (!match) return null;
  const retryAt = new Date(match[1]!);
  const deadline = new Date(match[3]!);
  const pauses = Number(match[2]);
  return Number.isFinite(retryAt.getTime()) &&
    Number.isFinite(deadline.getTime()) &&
    Number.isSafeInteger(pauses) &&
    pauses > 0
    ? { retryAt, deadline, pauses }
    : null;
}

export function rateLimitWaitMessage(platform: string, wait: RateLimitWait): string {
  return `Waiting for ${platform} rate limit, retrying at ${wait.retryAt.toISOString()}. Pause ${wait.pauses}; deadline ${wait.deadline.toISOString()}.`;
}

export function rateLimitFailureMessage(platform: string): string {
  return `Rate limited by ${platform} — try again. The 12-hour retry deadline was reached.`;
}

export function nextRateLimitWait(
  error: ProviderRateLimitError,
  due: Date,
  previous: RateLimitWait | null,
  now: Date,
): RateLimitWait | null {
  const deadline = previous?.deadline ?? new Date(due.getTime() + RATE_LIMIT_DEADLINE_MS);
  const remaining = deadline.getTime() - now.getTime();
  if (remaining <= 0) return null;
  const pauses = (previous?.pauses ?? 0) + 1;
  const delay = error.delayForPause(pauses);
  // Never shorten a platform's requested window just to fit the deadline.
  if (delay > remaining) return null;
  return { retryAt: new Date(now.getTime() + delay), deadline, pauses };
}
