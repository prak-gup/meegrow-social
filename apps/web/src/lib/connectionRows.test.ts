import { describe, expect, it } from 'vitest';
import type { ConnectionView } from '@meegrow-social/contracts';
import { canReconnect, expiryLabel, filterConnections, shortDate } from './connectionRows';

const conn = (over: Partial<ConnectionView>): ConnectionView => ({
  id: '00000000-0000-4000-8000-000000000001',
  provider: 'instagram',
  externalId: 'acme_official',
  displayName: 'Acme Official',
  needsReconnect: false,
  expiresAt: null,
  expiresInDays: 30,
  health: 'healthy',
  createdAt: new Date('2026-06-06T00:00:00Z'),
  ...over,
});

describe('expiryLabel', () => {
  it('words each case', () => {
    expect(expiryLabel(null)).toBe('Never expires');
    expect(expiryLabel(42)).toBe('in 42d');
    expect(expiryLabel(0)).toBe('Today');
    expect(expiryLabel(-2)).toBe('Expired 2d ago');
  });
});

describe('canReconnect', () => {
  it('offers a reconnect only when the token is dead or dying', () => {
    expect(canReconnect('needs_reconnect')).toBe(true);
    expect(canReconnect('expiring')).toBe(true);
    expect(canReconnect('healthy')).toBe(false);
  });
});

describe('filterConnections', () => {
  const rows = [
    conn({ id: 'a', displayName: 'Acme Official', provider: 'instagram' }),
    conn({ id: 'b', displayName: 'Beta Page', externalId: 'beta_1', provider: 'facebook' }),
    conn({ id: 'c', displayName: 'Gamma', provider: 'facebook', health: 'expiring' }),
    conn({ id: 'd', displayName: 'Delta', provider: 'x', expiresInDays: -1 }),
  ];
  const none = { q: '', status: '' as const, provider: '' };
  it('returns everything for an empty filter', () => {
    expect(filterConnections(rows, none)).toHaveLength(4);
  });
  it('matches the name or handle, case-insensitively', () => {
    expect(filterConnections(rows, { ...none, q: ' BETA' }).map((c) => c.id)).toEqual(['b']);
    expect(filterConnections(rows, { ...none, q: 'beta_1' }).map((c) => c.id)).toEqual(['b']);
  });
  it('filters by platform and status together', () => {
    expect(filterConnections(rows, { ...none, provider: 'facebook' })).toHaveLength(2);
    expect(
      filterConnections(rows, { ...none, provider: 'facebook', status: 'expiring' }).map(
        (c) => c.id,
      ),
    ).toEqual(['c']);
  });
  it('counts a lapsed token under needs reconnect', () => {
    expect(
      filterConnections(rows, { ...none, status: 'needs_reconnect' }).map((c) => c.id),
    ).toEqual(['d']);
  });
});

describe('shortDate', () => {
  it('shows a dash when there is no date', () => {
    expect(shortDate(null)).toBe('—');
  });
  it('formats an ISO string', () => {
    expect(shortDate('2026-06-06T12:00:00Z')).toBe('6 Jun 2026');
  });
});
