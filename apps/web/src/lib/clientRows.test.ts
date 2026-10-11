import { describe, expect, it } from 'vitest';
import type { ClientOverview } from '@meegrow-social/contracts';
import { filterClients, nextPublishLabel } from './clientRows';

const client = (over: Partial<ClientOverview>): ClientOverview => ({
  workspaceId: '00000000-0000-4000-8000-000000000001',
  name: 'Acme',
  slug: 'acme',
  health: 'ok',
  connectionCount: 3,
  publishedThisWeek: 2,
  failedThisWeek: 0,
  nextPublishAt: null,
  followers: null,
  automationLive: false,
  ...over,
});

describe('filterClients', () => {
  const rows = [
    client({ workspaceId: 'a', name: 'Acme' }),
    client({ workspaceId: 'b', name: 'Beta Co', health: 'bad' }),
    client({ workspaceId: 'c', name: 'Gamma', health: 'warn', failedThisWeek: 2 }),
  ];
  it('filters by name', () => {
    expect(filterClients(rows, { q: 'beta', status: '' }).map((c) => c.workspaceId)).toEqual(['b']);
  });
  it('filters by the rollup chip', () => {
    expect(filterClients(rows, { q: '', status: 'needs_reconnect' }).map((c) => c.name)).toEqual([
      'Beta Co',
    ]);
    expect(filterClients(rows, { q: '', status: 'failed' }).map((c) => c.name)).toEqual(['Gamma']);
  });
});

describe('nextPublishLabel', () => {
  const now = new Date('2026-10-11T09:00:00');
  it('says so when nothing is scheduled', () => {
    expect(nextPublishLabel(null, now)).toBe('Nothing scheduled');
  });
  it('uses Today and Tomorrow, and a dated label after that', () => {
    expect(nextPublishLabel(new Date('2026-10-11T15:00:00'), now)).toMatch(/^Today · /);
    expect(nextPublishLabel(new Date('2026-10-12T15:00:00'), now)).toMatch(/^Tomorrow · /);
    expect(nextPublishLabel(new Date('2026-10-20T15:00:00'), now)).not.toMatch(/Today|Tomorrow/);
  });
});
