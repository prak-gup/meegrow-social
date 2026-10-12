import { describe, expect, it } from 'vitest';
import {
  sortApiKeys,
  sortClients,
  sortConnections,
  clientSortOptions,
  connectionSortOptions,
  keySortOptions,
} from './listSort';
import type { ApiKeyView, ClientOverview, ConnectionView } from '@meegrow-social/contracts';
import { validSort } from './useUrlSort';
const client = (workspaceId: string, name: string, followers: number | null): ClientOverview => ({
  workspaceId,
  name,
  followers,
  slug: name,
  health: 'ok',
  connectionCount: followers ?? 99,
  publishedThisWeek: followers ?? 99,
  failedThisWeek: 0,
  nextPublishAt: null,
  automationLive: false,
});
const connection = (
  id: string,
  displayName: string,
  provider: ConnectionView['provider'],
  health: ConnectionView['health'],
  createdAt: string,
): ConnectionView => ({
  id,
  displayName,
  provider,
  health,
  createdAt: new Date(createdAt),
  externalId: id,
  needsReconnect: health === 'needs_reconnect',
  expiresAt: null,
  expiresInDays: null,
});
const key = (id: string, name: string, createdAt: string) =>
  ({ id, name, createdAt: new Date(createdAt) }) as ApiKeyView;
describe('whole-list sorting', () => {
  it('sorts every client option, puts missing followers last, and resolves ties by identity', () => {
    const rows = [
      client('b', 'Beta', null),
      client('z', 'Acme', 3),
      client('a', 'Acme', 3),
      client('d', 'Delta', 10),
    ];
    expect(sortClients(rows, 'name').map((r) => r.workspaceId)).toEqual(['a', 'z', 'b', 'd']);
    expect(sortClients(rows, 'followers').map((r) => r.workspaceId)).toEqual(['d', 'a', 'z', 'b']);
    for (const sort of ['accounts', 'published'] as const)
      expect(sortClients(rows, sort).map((r) => r.workspaceId)).toEqual(['b', 'd', 'a', 'z']);
    expect(rows[0]?.workspaceId).toBe('b');
  });
  it('sorts connections by date, name, platform and attention with deterministic ties', () => {
    const rows = [
      connection('b', 'Beta', 'youtube', 'healthy', '2026-01-03'),
      connection('a', 'Acme', 'facebook', 'needs_reconnect', '2026-01-01'),
      connection('c', 'Beta', 'youtube', 'expiring', '2026-01-02'),
    ];
    expect(sortConnections(rows, 'recent').map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(sortConnections(rows, 'name').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortConnections(rows, 'platform').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortConnections(rows, 'status').map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(
      sortConnections([rows[0]!, { ...rows[0]!, id: 'a' }], 'recent').map((r) => r.id),
    ).toEqual(['a', 'b']);
  });
  it('sorts keys by creation date or name and ties by identity', () => {
    const rows = [
      key('b', 'Beta', '2026-01-03'),
      key('a', 'Acme', '2026-01-01'),
      key('c', 'Beta', '2026-01-03'),
    ];
    expect(sortApiKeys(rows, 'newest').map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(sortApiKeys(rows, 'oldest').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortApiKeys(rows, 'name').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('validates URL options and falls back for unknown values', () => {
    for (const options of [clientSortOptions, connectionSortOptions, keySortOptions]) {
      for (const option of options)
        expect(validSort(option.value, options, options[0].value)).toBe(option.value);
      expect(validSort('invalid', options, options[0].value)).toBe(options[0].value);
      expect(validSort(null, options, options[0].value)).toBe(options[0].value);
    }
  });
});
