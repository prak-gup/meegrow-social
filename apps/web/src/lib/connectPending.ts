/** Completion is confirmed from the refreshed account list, never from URL identifiers. */
export const CONNECT_POLL_MS = 3_000;
export const CONNECT_TIMEOUT_MS = 3 * 60_000;
export interface PendingConnect {
  provider: string;
  startedAt: number;
  before: string[];
  reconnectId?: string;
}
export function connectPendingExpired(pending: PendingConnect, now: number): boolean {
  return now - pending.startedAt >= CONNECT_TIMEOUT_MS;
}
export function addedAccount<T extends { id: string; provider: string }>(
  before: readonly string[],
  accounts: readonly T[],
  provider?: string,
): T | undefined {
  return accounts.find((c) => !before.includes(c.id) && (!provider || c.provider === provider));
}
