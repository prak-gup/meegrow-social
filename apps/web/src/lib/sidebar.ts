import type { ClientOverview, OverviewView } from '@meegrow-social/contracts';

/**
 * Pure logic behind the sidebar: where a popover sits, which clients a search keeps, which badges
 * the nav rows carry, and how the collapsed state is stored. Kept out of the components so it can
 * be tested without a browser.
 */

// --- Popover placement ---------------------------------------------------------------------

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlaceInput {
  /** The trigger's bounding box, in viewport coordinates. */
  anchor: Box;
  viewport: { width: number; height: number };
  /** The popover's natural height with nothing constraining it. */
  contentHeight: number;
  /** Where to open if there is room. */
  prefer: 'below' | 'above';
  /** Minimum width; the popover is never narrower than its trigger either. */
  minWidth: number;
  /** Longest the popover may grow. */
  maxWidth: number;
  /** Space kept free at every viewport edge. Default 8. */
  margin?: number;
  /** Gap between trigger and popover. Default 4. */
  gap?: number;
}

export interface Placement {
  left: number;
  width: number;
  side: 'below' | 'above';
  /** Set when the popover opens downward: distance from the viewport top. */
  top?: number;
  /** Set when it opens upward: distance from the viewport bottom, so growth never moves the edge. */
  bottom?: number;
  /** Tallest the popover may be on this side; its list scrolls beyond that. */
  maxHeight: number;
}

/**
 * Aligns the popover to the trigger's left edge, then shifts it to stay inside the viewport and
 * flips it to the other side when the preferred one is too short and the other is roomier.
 */
export function placePopover(i: PlaceInput): Placement {
  const margin = i.margin ?? 8;
  const gap = i.gap ?? 4;
  const usable = Math.max(0, i.viewport.width - margin * 2);
  const wanted = Math.max(i.minWidth, i.anchor.right - i.anchor.left);
  const width = Math.min(wanted, i.maxWidth, usable);
  const left = Math.max(margin, Math.min(i.anchor.left, i.viewport.width - width - margin));

  const below = Math.max(0, i.viewport.height - i.anchor.bottom - gap - margin);
  const above = Math.max(0, i.anchor.top - gap - margin);
  const fitsPreferred = (i.prefer === 'below' ? below : above) >= i.contentHeight;
  const fitsOther = (i.prefer === 'below' ? above : below) >= i.contentHeight;
  const roomier = i.prefer === 'below' ? above > below : below > above;
  const side = fitsPreferred ? i.prefer : fitsOther || roomier ? flip(i.prefer) : i.prefer;

  return side === 'below'
    ? { left, width, side, top: i.anchor.bottom + gap, maxHeight: below }
    : {
        left,
        width,
        side,
        bottom: i.viewport.height - i.anchor.top + gap,
        maxHeight: above,
      };
}

function flip(side: 'below' | 'above'): 'below' | 'above' {
  return side === 'below' ? 'above' : 'below';
}

// --- Keyboard movement ---------------------------------------------------------------------

/** Where an arrow, Home or End key moves a highlight in a list of `count` rows. Wraps. */
export function moveIndex(current: number, key: string, count: number): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count;
  return current;
}

// --- Client switcher -----------------------------------------------------------------------

export interface SwitcherClient {
  workspaceId: string;
  name: string;
  /** From the overview; absent until it has loaded (or if it failed). */
  connectionCount?: number;
  health?: ClientOverview['health'];
  failedThisWeek?: number;
}

/** Joins the session's memberships with the overview's per-client numbers. */
export function joinClients(
  memberships: readonly { workspaceId: string; name: string }[],
  overview: OverviewView | null,
): SwitcherClient[] {
  const byId = new Map((overview?.clients ?? []).map((c) => [c.workspaceId, c]));
  return memberships.map((m) => {
    const o = byId.get(m.workspaceId);
    return o
      ? {
          workspaceId: m.workspaceId,
          name: m.name,
          connectionCount: o.connectionCount,
          health: o.health,
          failedThisWeek: o.failedThisWeek,
        }
      : { workspaceId: m.workspaceId, name: m.name };
  });
}

/** Type-to-filter over the name. Case-insensitive, ignores surrounding space. */
export function filterSwitcherClients<T extends { name: string }>(
  clients: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return q ? clients.filter((c) => c.name.toLowerCase().includes(q)) : [...clients];
}

/** "No accounts", "1 account", "12 accounts" — or nothing while the count is unknown. */
export function accountsLabel(count: number | undefined): string {
  if (count === undefined) return '';
  if (count === 0) return 'No accounts';
  return count === 1 ? '1 account' : `${count} accounts`;
}

/** A client needs attention when its rollup is not healthy. */
export function needsAttention(c: Pick<SwitcherClient, 'health'>): boolean {
  return c.health === 'warn' || c.health === 'bad';
}

/** Words for the attention marker, so it never rests on colour alone. */
export function attentionLabel(c: Pick<SwitcherClient, 'health' | 'failedThisWeek'>): string {
  if (c.health === 'bad') return 'Needs reconnect';
  if (c.health === 'warn') {
    return c.failedThisWeek ? `${c.failedThisWeek} failed this week` : 'Queue empty';
  }
  return '';
}

/**
 * Workspace-scoped screens keep the user where they are when the client changes; anything else
 * (the cross-client Overview and Clients, settings, the composer) lands on Content.
 */
const STAY_ON = ['/content', '/calendar', '/analytics', '/connections', '/settings/api-keys'];

export function switchTarget(pathname: string): string {
  return STAY_ON.includes(pathname) ? pathname : '/content';
}

// --- Nav badges ----------------------------------------------------------------------------

export interface NavBadges {
  /** Posts that failed to publish. */
  content: number;
  /** Connections that need reconnecting or are about to expire. */
  connections: number;
}

/** The overview's attention numbers, as the counts the nav rows carry. Zero means no badge. */
export function navBadges(overview: OverviewView | null): NavBadges {
  const a = overview?.attention;
  if (!a) return { content: 0, connections: 0 };
  return {
    content: Math.max(0, a.failedPublishes),
    connections: Math.max(0, a.needsReconnect + a.tokensExpiring),
  };
}

/** "7", "99+". */
export function formatBadge(n: number): string {
  return n > 99 ? '99+' : String(n);
}

// --- Collapsed rail ------------------------------------------------------------------------

export const COLLAPSED_KEY = 'meegrow.sidebar.collapsed';

/** Reads the stored flag. Anything but the exact value we write means "not collapsed". */
export function parseCollapsed(raw: string | null | undefined): boolean {
  return raw === '1';
}

export function serializeCollapsed(collapsed: boolean): string {
  return collapsed ? '1' : '0';
}

export function readCollapsed(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage(),
): boolean {
  try {
    return parseCollapsed(storage?.getItem(COLLAPSED_KEY));
  } catch {
    return false;
  }
}

export function writeCollapsed(
  collapsed: boolean,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(COLLAPSED_KEY, serializeCollapsed(collapsed));
  } catch {
    /* private mode or blocked storage: the sidebar still works, it just does not remember */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

// --- Shortcut ------------------------------------------------------------------------------

/** `c` opens the composer, but only when the user is not typing and nothing is held down. */
export function isComposeShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  target: EventTarget | { tagName?: string; isContentEditable?: boolean } | null;
}): boolean {
  const target = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (e.key !== 'c' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return false;
  const tag = target?.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  return !target?.isContentEditable;
}
