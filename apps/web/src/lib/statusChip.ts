import type { ClientHealth, ConnectionHealth, PostStatus } from '@meegrow-social/contracts';

/** How a chip is tinted. Mirrors the Badge variants, so one palette serves every status. */
export type ChipTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/**
 * The one vocabulary of statuses a chip can show, across Connections, Clients, Content and
 * Calendar. Words always accompany colour: status never rests on colour alone.
 */
export type ChipStatus =
  | 'healthy'
  | 'connected'
  | 'expiring'
  | 'needs_reconnect'
  | 'draft'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled';

export const CHIP: Record<ChipStatus, { label: string; tone: ChipTone }> = {
  healthy: { label: 'Healthy', tone: 'success' },
  connected: { label: 'Connected', tone: 'success' },
  expiring: { label: 'Expiring soon', tone: 'warning' },
  needs_reconnect: { label: 'Needs reconnect', tone: 'danger' },
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  publishing: { label: 'Publishing', tone: 'info' },
  published: { label: 'Published', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** A connection's chip. An already-lapsed token needs a reconnect, whatever the stored health says. */
export function connectionChip(health: ConnectionHealth, expiresInDays: number | null): ChipStatus {
  if (health === 'needs_reconnect') return 'needs_reconnect';
  if (expiresInDays != null && expiresInDays < 0) return 'needs_reconnect';
  if (health === 'expiring') return 'expiring';
  return 'healthy';
}

/** A post's status is already a chip status; this keeps the mapping explicit and type-checked. */
export function postChip(status: PostStatus): ChipStatus {
  return status;
}

/** A client's rollup chip plus the words for it: why it is not simply healthy. */
export function clientChip(
  health: ClientHealth,
  failedThisWeek: number,
): { status: ChipStatus; label: string } {
  if (health === 'bad') return { status: 'needs_reconnect', label: CHIP.needs_reconnect.label };
  if (health === 'warn')
    return {
      status: failedThisWeek > 0 ? 'failed' : 'expiring',
      label: failedThisWeek > 0 ? `${failedThisWeek} failed` : 'Queue empty',
    };
  return { status: 'healthy', label: CHIP.healthy.label };
}
