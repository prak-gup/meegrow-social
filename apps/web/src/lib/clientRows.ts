import type { ClientOverview } from '@meegrow-social/contracts';
import { clientChip, type ChipStatus } from './statusChip';

export interface ClientFilter {
  q: string;
  /** A chip status, or '' for all. */
  status: ChipStatus | '';
}

/** Free-text over the name, plus the rollup health chip. */
export function filterClients(rows: readonly ClientOverview[], f: ClientFilter): ClientOverview[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((c) => {
    if (f.status && clientChip(c.health, c.failedThisWeek).status !== f.status) return false;
    return !q || c.name.toLowerCase().includes(q);
  });
}

/** When the next post goes out, in words a table cell can hold. Dates arrive as ISO strings. */
export function nextPublishLabel(value: Date | string | null, now: Date = new Date()): string {
  if (!value) return 'Nothing scheduled';
  const d = new Date(value);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const tomorrow = new Date(now.getTime() + 86400_000);
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow · ${time}`;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
