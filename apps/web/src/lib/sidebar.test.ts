import { describe, expect, it } from 'vitest';
import type { OverviewView } from '@meegrow-social/contracts';
import {
  COLLAPSED_KEY,
  accountsLabel,
  attentionLabel,
  filterSwitcherClients,
  formatBadge,
  isComposeShortcut,
  joinClients,
  moveIndex,
  navBadges,
  needsAttention,
  parseCollapsed,
  placePopover,
  readCollapsed,
  switchTarget,
  writeCollapsed,
} from './sidebar';

const vp = { width: 1512, height: 900 };
const box = (left: number, top: number, w = 152, h = 32) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

describe('placePopover', () => {
  it('lines up with the trigger edge and is wider than a narrow trigger', () => {
    const p = placePopover({
      anchor: box(12, 60),
      viewport: vp,
      contentHeight: 300,
      prefer: 'below',
      minWidth: 260,
      maxWidth: 340,
    });
    expect(p).toMatchObject({ left: 12, width: 260, side: 'below', top: 96 });
  });

  it('keeps the width of a wide trigger up to the maximum', () => {
    const p = placePopover({
      anchor: box(12, 60, 500),
      viewport: vp,
      contentHeight: 100,
      prefer: 'below',
      minWidth: 260,
      maxWidth: 340,
    });
    expect(p.width).toBe(340);
  });

  it('shifts left to stay inside the viewport', () => {
    const p = placePopover({
      anchor: box(1450, 60),
      viewport: vp,
      contentHeight: 100,
      prefer: 'below',
      minWidth: 260,
      maxWidth: 340,
    });
    expect(p.left + p.width).toBe(1512 - 8);
  });

  it('never exceeds a phone viewport', () => {
    const p = placePopover({
      anchor: box(12, 60, 232),
      viewport: { width: 390, height: 800 },
      contentHeight: 100,
      prefer: 'below',
      minWidth: 260,
      maxWidth: 340,
    });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(390 - 8);
  });

  it('squeezes into a viewport narrower than the minimum width', () => {
    const p = placePopover({
      anchor: box(0, 10, 100),
      viewport: { width: 200, height: 800 },
      contentHeight: 100,
      prefer: 'below',
      minWidth: 260,
      maxWidth: 340,
    });
    expect(p).toMatchObject({ left: 8, width: 184 });
  });

  it('opens upward from a bottom trigger, anchored by its bottom edge', () => {
    const p = placePopover({
      anchor: box(12, 840),
      viewport: vp,
      contentHeight: 150,
      prefer: 'above',
      minWidth: 240,
      maxWidth: 320,
    });
    expect(p.side).toBe('above');
    expect(p.bottom).toBe(900 - 840 + 4);
    expect(p.top).toBeUndefined();
    expect(p.maxHeight).toBe(840 - 4 - 8);
  });

  it('flips downward when there is no room above', () => {
    const p = placePopover({
      anchor: box(12, 40),
      viewport: vp,
      contentHeight: 150,
      prefer: 'above',
      minWidth: 240,
      maxWidth: 320,
    });
    expect(p.side).toBe('below');
  });

  it('flips upward when a tall list will not fit below but fits above', () => {
    const p = placePopover({
      anchor: box(12, 500),
      viewport: { width: 1000, height: 600 },
      contentHeight: 400,
      prefer: 'below',
      minWidth: 260,
      maxWidth: 340,
    });
    expect(p.side).toBe('above');
  });

  it('stays on the preferred side and caps the height when neither side fits', () => {
    const p = placePopover({
      anchor: box(12, 60),
      viewport: { width: 1000, height: 400 },
      contentHeight: 900,
      prefer: 'below',
      minWidth: 260,
      maxWidth: 340,
    });
    expect(p.side).toBe('below');
    expect(p.maxHeight).toBe(400 - 92 - 4 - 8);
  });
});

describe('moveIndex', () => {
  it('moves and wraps', () => {
    expect(moveIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(moveIndex(2, 'ArrowDown', 3)).toBe(0);
    expect(moveIndex(0, 'ArrowUp', 3)).toBe(2);
    expect(moveIndex(1, 'ArrowUp', 3)).toBe(0);
  });
  it('jumps to the ends', () => {
    expect(moveIndex(1, 'Home', 5)).toBe(0);
    expect(moveIndex(1, 'End', 5)).toBe(4);
  });
  it('starts from nothing highlighted', () => {
    expect(moveIndex(-1, 'ArrowDown', 3)).toBe(0);
    expect(moveIndex(-1, 'ArrowUp', 3)).toBe(2);
  });
  it('handles an empty list and unrelated keys', () => {
    expect(moveIndex(0, 'ArrowDown', 0)).toBe(-1);
    expect(moveIndex(1, 'a', 3)).toBe(1);
  });
});

describe('switcher data', () => {
  const ov = {
    generatedAt: new Date(),
    attention: { failedPublishes: 0, needsReconnect: 0, tokensExpiring: 0, emptyQueues: 0 },
    weekTotals: { publishedThisWeek: 0 },
    upcoming: [],
    upcomingGroups: [],
    clients: [
      {
        workspaceId: 'a',
        name: 'Alpha',
        slug: 'alpha',
        health: 'warn',
        connectionCount: 3,
        publishedThisWeek: 0,
        failedThisWeek: 2,
        nextPublishAt: null,
        followers: null,
        automationLive: false,
      },
    ],
  } as OverviewView;
  const members = [
    { workspaceId: 'a', name: 'Alpha' },
    { workspaceId: 'b', name: 'Beta Dental' },
  ];

  it('joins overview numbers onto memberships and tolerates a missing overview', () => {
    const joined = joinClients(members, ov);
    expect(joined[0]).toMatchObject({ connectionCount: 3, health: 'warn', failedThisWeek: 2 });
    expect(joined[1]).toEqual({ workspaceId: 'b', name: 'Beta Dental' });
    expect(joinClients(members, null)[0]).toEqual({ workspaceId: 'a', name: 'Alpha' });
  });

  it('filters by name, ignoring case and padding', () => {
    expect(filterSwitcherClients(members, '  DENT ').map((m) => m.name)).toEqual(['Beta Dental']);
    expect(filterSwitcherClients(members, '')).toHaveLength(2);
    expect(filterSwitcherClients(members, 'zzz')).toEqual([]);
  });

  it('words the account count', () => {
    expect(accountsLabel(undefined)).toBe('');
    expect(accountsLabel(0)).toBe('No accounts');
    expect(accountsLabel(1)).toBe('1 account');
    expect(accountsLabel(12)).toBe('12 accounts');
  });

  it('flags only unhealthy clients and says why', () => {
    expect(needsAttention({ health: 'ok' })).toBe(false);
    expect(needsAttention({ health: undefined })).toBe(false);
    expect(needsAttention({ health: 'warn' })).toBe(true);
    expect(needsAttention({ health: 'bad' })).toBe(true);
    expect(attentionLabel({ health: 'bad' })).toBe('Needs reconnect');
    expect(attentionLabel({ health: 'warn', failedThisWeek: 2 })).toBe('2 failed this week');
    expect(attentionLabel({ health: 'warn', failedThisWeek: 0 })).toBe('Queue empty');
    expect(attentionLabel({ health: 'ok' })).toBe('');
  });
});

describe('switchTarget', () => {
  it('keeps Blog and leaves a previous client’s article detail for the new client’s inventory', () => {
    expect(switchTarget('/blog')).toBe('/blog');
    expect(switchTarget('/blog/old-client-post')).toBe('/blog');
  });
  it('stays on workspace-scoped screens', () => {
    for (const p of ['/content', '/calendar', '/analytics', '/connections', '/settings/api-keys'])
      expect(switchTarget(p)).toBe(p);
  });
  it('lands on Content from anywhere else', () => {
    for (const p of ['/overview', '/clients', '/settings/password', '/composer', '/x'])
      expect(switchTarget(p)).toBe('/content');
  });
});

describe('navBadges', () => {
  it('derives counts from the attention numbers', () => {
    const ov = {
      attention: { failedPublishes: 4, needsReconnect: 2, tokensExpiring: 1, emptyQueues: 9 },
    } as OverviewView;
    expect(navBadges(ov)).toEqual({ content: 4, connections: 3 });
  });
  it('is zero (no badge) without data or with nothing wrong', () => {
    expect(navBadges(null)).toEqual({ content: 0, connections: 0 });
    const clear = {
      attention: { failedPublishes: 0, needsReconnect: 0, tokensExpiring: 0, emptyQueues: 2 },
    } as OverviewView;
    expect(navBadges(clear)).toEqual({ content: 0, connections: 0 });
  });
  it('caps what is displayed', () => {
    expect(formatBadge(7)).toBe('7');
    expect(formatBadge(99)).toBe('99');
    expect(formatBadge(120)).toBe('99+');
  });
});

describe('collapsed state', () => {
  it('only the exact stored value means collapsed', () => {
    expect(parseCollapsed('1')).toBe(true);
    for (const v of ['0', '', 'true', 'yes', null, undefined])
      expect(parseCollapsed(v)).toBe(false);
  });
  it('round-trips through a storage', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    writeCollapsed(true, storage);
    expect(mem.get(COLLAPSED_KEY)).toBe('1');
    expect(readCollapsed(storage)).toBe(true);
    writeCollapsed(false, storage);
    expect(readCollapsed(storage)).toBe(false);
  });
  it('survives storage that throws or is missing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readCollapsed(broken)).toBe(false);
    expect(() => writeCollapsed(true, broken)).not.toThrow();
    expect(readCollapsed(undefined)).toBe(false);
  });
});

describe('isComposeShortcut', () => {
  const ev = (over: Partial<Parameters<typeof isComposeShortcut>[0]> = {}) => ({
    key: 'c',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: { tagName: 'BODY' },
    ...over,
  });
  it('fires on a bare c', () => expect(isComposeShortcut(ev())).toBe(true));
  it('ignores modifiers, repeats and other keys', () => {
    expect(isComposeShortcut(ev({ metaKey: true }))).toBe(false);
    expect(isComposeShortcut(ev({ ctrlKey: true }))).toBe(false);
    expect(isComposeShortcut(ev({ altKey: true }))).toBe(false);
    expect(isComposeShortcut(ev({ shiftKey: true }))).toBe(false);
    expect(isComposeShortcut(ev({ repeat: true }))).toBe(false);
    expect(isComposeShortcut(ev({ key: 'x' }))).toBe(false);
  });
  it('ignores typing in a field', () => {
    for (const tagName of ['INPUT', 'textarea', 'SELECT'])
      expect(isComposeShortcut(ev({ target: { tagName } }))).toBe(false);
    expect(isComposeShortcut(ev({ target: { tagName: 'DIV', isContentEditable: true } }))).toBe(
      false,
    );
  });
});
