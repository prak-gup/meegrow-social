import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMPORT_WINDOW_DAYS,
  IMPORT_WINDOW_DAYS,
  type ConnectionImportView,
} from '@meegrow-social/contracts';
import {
  DEFAULT_IMPORT_WINDOW,
  IMPORT_WINDOWS,
  canImport,
  importBusy,
  importCounts,
  importMoving,
  importRowNote,
  importSummary,
  importingAnalyticsNote,
  importingNote,
} from './postImport';

const NOW = new Date('2026-10-11T12:00:00Z');

const view = (over: Partial<ConnectionImportView> = {}): ConnectionImportView => ({
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
  ...over,
});

describe('import windows', () => {
  it('offers exactly the windows the API accepts, with the same default', () => {
    expect(IMPORT_WINDOWS.map((w) => w.days)).toEqual([...IMPORT_WINDOW_DAYS]);
    expect(DEFAULT_IMPORT_WINDOW).toBe(DEFAULT_IMPORT_WINDOW_DAYS);
  });
});

describe('canImport', () => {
  it('is true only for an account whose platform can list its posts', () => {
    expect(canImport({ import: view() })).toBe(true);
    expect(canImport({ import: view({ supported: false }) })).toBe(false);
    // An older API that sends no import state at all.
    expect(canImport({ import: undefined })).toBe(false);
  });
});

describe('importBusy / importMoving', () => {
  it('is busy while queued, reading or waiting out a limit; not once finished', () => {
    for (const status of ['queued', 'running', 'paused'] as const) {
      expect(importBusy(view({ status }))).toBe(true);
    }
    for (const status of ['done', 'failed', null] as const) {
      expect(importBusy(view({ status }))).toBe(false);
    }
    expect(importBusy(undefined)).toBe(false);
  });

  it('polls only for a run that changes soon — a paused one can sit for half an hour', () => {
    expect(importMoving(view({ status: 'queued' }))).toBe(true);
    expect(importMoving(view({ status: 'running' }))).toBe(true);
    expect(importMoving(view({ status: 'paused' }))).toBe(false);
    expect(importMoving(view({ status: 'done' }))).toBe(false);
  });
});

describe('importRowNote', () => {
  it('says what is happening while an import is under way', () => {
    expect(importRowNote(view({ status: 'queued' }), NOW)).toBe('Past posts: import queued');
    expect(importRowNote(view({ status: 'running' }), NOW)).toBe(
      'Importing past posts… · 0 read · 0 imported · page 0',
    );
    expect(
      importRowNote(view({ status: 'paused', resumeAt: new Date('2026-10-11T12:30:00Z') }), NOW),
    ).toMatch(/^Import paused · continues /);
    expect(importRowNote(view({ status: 'paused' }), NOW)).toBe(
      'Import paused · continues by itself',
    );
  });

  it('leaves the row alone once the import is finished, failed, or was never asked for', () => {
    expect(importRowNote(view({ status: 'done', imported: 12 }), NOW)).toBeNull();
    expect(importRowNote(view({ status: 'failed' }), NOW)).toBeNull();
    expect(importRowNote(view(), NOW)).toBeNull();
    expect(importRowNote(undefined, NOW)).toBeNull();
  });
});

describe('importCounts', () => {
  it('always says how many were imported, and the rest only when there is something to say', () => {
    expect(importCounts(view({ imported: 0 }))).toBe('0 imported');
    expect(importCounts(view({ imported: 42, matched: 3, removed: 1 }))).toBe(
      '42 imported · 3 already here · 1 removed on platform',
    );
    expect(importCounts(view({ imported: 1200 }))).toBe(`${(1200).toLocaleString()} imported`);
  });
});

describe('importSummary', () => {
  it('says so when nothing was ever imported', () => {
    expect(importSummary(view(), NOW)).toEqual({
      heading: 'Not imported yet',
      detail: null,
      message: null,
      tone: 'neutral',
    });
    expect(importSummary(undefined, NOW).heading).toBe('Not imported yet');
  });

  it('reports the last finished import: when, and what it did', () => {
    const summary = importSummary(
      view({
        status: 'done',
        windowDays: 90,
        finishedAt: new Date('2026-10-11T09:15:00Z'),
        imported: 42,
        matched: 3,
      }),
      NOW,
    );
    expect(summary.heading).toMatch(/^Last import · /);
    expect(summary.detail).toBe('42 imported · 3 already here');
    expect(summary).toMatchObject({ message: null, tone: 'neutral' });
  });

  it('makes a capped import visible: complete, but older posts were left out', () => {
    const summary = importSummary(
      view({
        status: 'done',
        finishedAt: NOW,
        imported: 500,
        capped: true,
        message: 'Stopped at 500 posts, the most one import reads.',
      }),
      NOW,
    );
    expect(summary.tone).toBe('warn');
    expect(summary.message).toMatch(/Stopped at 500 posts/);
  });

  it('does not repeat a stale message on an import that finished cleanly', () => {
    expect(importSummary(view({ status: 'done', message: 'left over' }), NOW).message).toBeNull();
  });

  it('shows a queued and a running import with its window', () => {
    expect(importSummary(view({ status: 'queued', windowDays: 365 }), NOW)).toMatchObject({
      heading: 'Import queued',
      detail: 'last 365 days · starts within a minute',
    });
    expect(
      importSummary(view({ status: 'running', windowDays: 90, imported: 25 }), NOW),
    ).toMatchObject({
      heading: 'Importing now',
      detail: 'last 90 days · 0 read · 25 imported · page 0 so far',
    });
  });

  it('explains a pause and when it continues', () => {
    const summary = importSummary(
      view({
        status: 'paused',
        resumeAt: new Date('2026-10-11T12:30:00Z'),
        imported: 50,
        message: 'Paused at 62% of the platform’s rate limit, to leave room for publishing.',
      }),
      NOW,
    );
    expect(summary.heading).toMatch(/^Paused · continues /);
    expect(summary.detail).toBe('0 read · 50 imported · page 0 so far');
    expect(summary.tone).toBe('warn');
    expect(summary.message).toMatch(/62%/);
  });

  it('shows a failure with its reason', () => {
    const summary = importSummary(
      view({
        status: 'failed',
        finishedAt: NOW,
        message: 'The platform refused the stored credentials: token expired',
      }),
      NOW,
    );
    expect(summary.heading).toMatch(/^Last import failed · /);
    expect(summary).toMatchObject({ tone: 'bad' });
    expect(summary.message).toMatch(/refused the stored credentials/);
  });

  it('reads dates handed over as ISO strings', () => {
    const summary = importSummary(
      view({ status: 'done', finishedAt: '2026-10-11T09:15:00Z' as unknown as Date }),
      NOW,
    );
    expect(summary.heading).toMatch(/^Last import · /);
  });
});

describe('importingNote — what an empty screen says for a newly connected account', () => {
  const account = (displayName: string, status: ConnectionImportView['status']) => ({
    displayName,
    import: view({ status }),
  });

  it('is null when no import is under way, so the screen’s own empty state stands', () => {
    expect(importingNote([])).toBeNull();
    expect(importingNote([account('City Hospital', 'done'), account('@cityhospital', null)])).toBe(
      null,
    );
    expect(importingNote([{ displayName: 'Old API', import: undefined }])).toBeNull();
  });

  it('names the account when there is one, counts them when there are more', () => {
    expect(importingNote([account('City Hospital', 'running'), account('Other', 'done')])).toBe(
      'Past posts from City Hospital are being imported. They appear here as they arrive — usually within a few minutes.',
    );
    expect(
      importingNote([account('City Hospital', 'queued'), account('@cityhospital', 'paused')]),
    ).toMatch(/^Past posts from 2 accounts are being imported\./);
  });

  it('adds, for Analytics, that the numbers follow the posts', () => {
    expect(importingAnalyticsNote([account('City Hospital', 'running')])).toMatch(
      /being imported\..*Their numbers are collected over the following hours, newest posts first\.$/,
    );
    expect(importingAnalyticsNote([account('City Hospital', 'done')])).toBeNull();
  });
});

it('shows page progress and an honest empty window without confusing deduplication with emptiness', () => {
  expect(importRowNote(view({ status: 'running', seen: 75, pages: 3, imported: 50 }))).toContain(
    '75 read · 50 imported · page 3',
  );
  expect(importRowNote(view({ status: 'done', windowDays: 90, postsInWindow: 0 }))).toBe(
    'No posts in the last 90 days',
  );
  expect(importSummary(view({ status: 'done', windowDays: 90, postsInWindow: 0 })).detail).toBe(
    'No posts in the last 90 days',
  );
  expect(importSummary(view({ status: 'done', windowDays: 90, postsInWindow: 25 })).detail).toBe(
    '0 imported',
  );
});
