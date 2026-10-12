import { describe, expect, it } from 'vitest';
import type { ConnectionImportView } from '@meegrow-social/contracts';
import {
  syncFinished,
  syncMoving,
  syncResult,
  syncShouldPoll,
  syncSites,
  syncStatus,
} from './blogSync';
const view = (patch: Partial<ConnectionImportView> = {}): ConnectionImportView => ({
  supported: true,
  status: null,
  kind: null,
  windowDays: null,
  requestedAt: null,
  startedAt: null,
  finishedAt: null,
  resumeAt: null,
  lastSyncedAt: null,
  imported: 0,
  matched: 0,
  removed: 0,
  capped: false,
  message: null,
  ...patch,
});
const site = (id: string, patch: Partial<ConnectionImportView> = {}, provider = 'wordpress') => ({
  id,
  provider,
  displayName: id,
  import: view(patch),
});
describe('blog sync decisions', () => {
  it('selects all WordPress sites or the filtered site, never another provider', () => {
    const sites = [site('a'), site('b'), site('c', {}, 'facebook')];
    expect(syncSites(sites).map((c) => c.id)).toEqual(['a', 'b']);
    expect(syncSites(sites, 'b').map((c) => c.id)).toEqual(['b']);
    expect(syncSites(sites, 'missing')).toEqual([]);
    expect(syncSites([])).toEqual([]);
  });
  it('polls queued, running and paused states until terminal states', () => {
    for (const status of ['queued', 'running', 'paused'] as const) {
      expect(syncShouldPoll([site('a', { status })])).toBe(true);
      expect(syncMoving([site('a', { status })])).toBe(status !== 'paused');
      expect(syncFinished([site('a', { status })], [site('a', { status: 'done' })])).toBe(true);
    }
    expect(syncShouldPoll([site('a', { status: 'failed' })])).toBe(false);
    expect(syncFinished([site('a', { status: 'done' })], [site('a', { status: 'done' })])).toBe(
      false,
    );
    expect(
      syncFinished([site('a', { status: 'running' })], [site('a', { status: 'paused' })]),
    ).toBe(false);
    expect(syncFinished([site('a', { status: 'running' })], [])).toBe(false);
  });
  it('uses real counts without treating matches as updates', () => {
    expect(syncResult([site('a', { status: 'done', matched: 12 })])).toBe('Up to date');
    expect(
      syncResult([
        site('a', { status: 'done', imported: 12 }),
        site('b', { status: 'done', removed: 3 }),
      ]),
    ).toBe('12 new, 3 removed on platform');
    expect(syncResult([site('a', { status: 'running', imported: 2 })])).toBeNull();
  });
  it('reports real sync timestamps, pause/resume messages, failures and capped runs', () => {
    expect(syncStatus([site('a')])).toContain('Not synced yet · syncs automatically every 6 hours');
    expect(syncStatus([site('a', { lastSyncedAt: new Date('2026-10-12T10:42:00Z') })])).toContain(
      'Last synced 12 Oct',
    );
    const paused = syncStatus([
      site('a', {
        status: 'paused',
        resumeAt: new Date('2026-10-12T12:00:00Z'),
        message: 'Rate limit reached',
      }),
    ]);
    expect(paused).toContain('resumes 12 Oct');
    expect(paused).toContain('Rate limit reached');
    expect(syncStatus([site('a', { status: 'failed', message: 'Credentials refused' })])).toContain(
      'Sync failed · Credentials refused',
    );
    expect(
      syncStatus([site('a', { status: 'done', capped: true, message: 'Stopped at 500 posts' })]),
    ).toContain('Stopped at 500 posts');
    expect(syncStatus([site('a'), site('b')])).toContain('b: Not synced yet');
  });
});
