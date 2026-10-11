import type { ConnectionView } from '@meegrow-social/contracts';
import { connectionChip, type ChipStatus } from './statusChip';

/** Token expiry as a table cell: when it lapses, or how long ago it did. */
export function expiryLabel(expiresInDays: number | null): string {
  if (expiresInDays == null) return 'Never expires';
  if (expiresInDays < 0) return `Expired ${-expiresInDays}d ago`;
  if (expiresInDays === 0) return 'Today';
  return `in ${expiresInDays}d`;
}

/** A connection can be reconnected only when its token is dead or about to be. */
export function canReconnect(chip: ChipStatus): boolean {
  return chip === 'needs_reconnect' || chip === 'expiring';
}

export interface ConnectionFilter {
  q: string;
  /** A chip status, or '' for all. */
  status: ChipStatus | '';
  /** A provider identifier, or '' for all. */
  provider: string;
}

/** Client-side filter for the Connections table: free text over name/handle, plus status and platform. */
export function filterConnections(
  rows: readonly ConnectionView[],
  f: ConnectionFilter,
): ConnectionView[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((c) => {
    if (f.provider && c.provider !== f.provider) return false;
    if (f.status && connectionChip(c.health, c.expiresInDays) !== f.status) return false;
    if (!q) return true;
    return c.displayName.toLowerCase().includes(q) || c.externalId.toLowerCase().includes(q);
  });
}

/** Short date for a cell, e.g. "6 Jun 2026". Dates arrive as ISO strings over the wire. */
export function shortDate(value: Date | string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
