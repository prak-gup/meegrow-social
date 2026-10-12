import type { ApiKeyView, ClientOverview, ConnectionView } from '@meegrow-social/contracts';
import { connectionChip } from './statusChip';

export const clientSortOptions = [
  { value: 'name', label: 'Name A–Z' },
  { value: 'accounts', label: 'Most accounts' },
  { value: 'followers', label: 'Most followers' },
  { value: 'published', label: 'Published this week' },
] as const;
export type ClientSort = (typeof clientSortOptions)[number]['value'];
export const connectionSortOptions = [
  { value: 'recent', label: 'Recently connected' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'platform', label: 'Platform A–Z' },
  { value: 'status', label: 'Needs attention first' },
] as const;
export type ConnectionSort = (typeof connectionSortOptions)[number]['value'];
export const keySortOptions = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name A–Z' },
] as const;
export type KeySort = (typeof keySortOptions)[number]['value'];
const text = (a: string, b: string) =>
  a.localeCompare(b, 'en', { sensitivity: 'base' }) || a.localeCompare(b, 'en');
const numericDescending = (a: number | null, b: number | null) =>
  a == null ? (b == null ? 0 : 1) : b == null ? -1 : b - a;
const timestamp = (value: Date | string) => new Date(value).getTime();
export function sortClients(rows: readonly ClientOverview[], sort: ClientSort): ClientOverview[] {
  return [...rows].sort((a, b) => {
    const primary =
      sort === 'accounts'
        ? numericDescending(a.connectionCount, b.connectionCount)
        : sort === 'followers'
          ? numericDescending(a.followers, b.followers)
          : sort === 'published'
            ? numericDescending(a.publishedThisWeek, b.publishedThisWeek)
            : 0;
    return primary || text(a.name, b.name) || text(a.workspaceId, b.workspaceId);
  });
}
export function sortConnections(
  rows: readonly ConnectionView[],
  sort: ConnectionSort,
): ConnectionView[] {
  const rank = (row: ConnectionView) => {
    const status = connectionChip(row.health, row.expiresInDays);
    return status === 'needs_reconnect' ? 0 : status === 'expiring' ? 1 : 2;
  };
  return [...rows].sort((a, b) => {
    const primary =
      sort === 'name'
        ? text(a.displayName, b.displayName)
        : sort === 'platform'
          ? text(a.provider, b.provider)
          : sort === 'status'
            ? rank(a) - rank(b)
            : 0;
    return primary || timestamp(b.createdAt) - timestamp(a.createdAt) || text(a.id, b.id);
  });
}
export function sortApiKeys(rows: readonly ApiKeyView[], sort: KeySort): ApiKeyView[] {
  return [...rows].sort(
    (a, b) =>
      (sort === 'name'
        ? text(a.name, b.name)
        : (sort === 'oldest' ? 1 : -1) * (timestamp(a.createdAt) - timestamp(b.createdAt))) ||
      text(a.id, b.id),
  );
}
