import { describe, expect, it } from 'vitest';
import {
  aggregateEventRows,
  bucketStartFor,
  decodeLogCursor,
  encodeLogCursor,
  isErrorStatus,
  retentionCutoff,
} from './logs.js';

describe('isErrorStatus', () => {
  it('treats null/undefined/empty as not an error', () => {
    expect(isErrorStatus(null)).toBe(false);
    expect(isErrorStatus(undefined)).toBe(false);
    expect(isErrorStatus('')).toBe(false);
  });

  it('treats known failure words as errors, case-insensitively', () => {
    expect(isErrorStatus('failed')).toBe(true);
    expect(isErrorStatus('FAILED')).toBe(true);
    expect(isErrorStatus('error')).toBe(true);
  });

  it('treats success words and 2xx/3xx codes as not errors', () => {
    expect(isErrorStatus('published')).toBe(false);
    expect(isErrorStatus('delivered')).toBe(false);
    expect(isErrorStatus('200')).toBe(false);
    expect(isErrorStatus('301')).toBe(false);
  });

  it('treats numeric codes >= 400 as errors', () => {
    expect(isErrorStatus('400')).toBe(true);
    expect(isErrorStatus('404')).toBe(true);
    expect(isErrorStatus('500')).toBe(true);
  });
});

describe('log cursor encode/decode', () => {
  it('round-trips a cursor', () => {
    const row = { createdAt: new Date('2026-01-15T10:00:00.000Z'), id: 'abc-123' };
    const cursor = encodeLogCursor(row);
    const decoded = decodeLogCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(row.id);
    expect(decoded?.createdAt.toISOString()).toBe(row.createdAt.toISOString());
  });

  it('returns null for garbage input instead of throwing', () => {
    expect(decodeLogCursor('not-base64-json')).toBeNull();
    expect(decodeLogCursor('')).toBeNull();
    expect(decodeLogCursor(Buffer.from('{}').toString('base64url'))).toBeNull();
    expect(
      decodeLogCursor(
        Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: 'x' })).toString('base64url'),
      ),
    ).toBeNull();
  });
});

describe('retentionCutoff', () => {
  it('subtracts the retention window in days from now', () => {
    const now = new Date('2026-07-07T00:00:00.000Z');
    const cutoff = retentionCutoff(now, 90);
    expect(cutoff.toISOString()).toBe('2026-04-08T00:00:00.000Z');
  });

  it('defaults to 90 days', () => {
    const now = new Date('2026-07-07T00:00:00.000Z');
    expect(retentionCutoff(now).getTime()).toBe(retentionCutoff(now, 90).getTime());
  });
});

describe('bucketStartFor', () => {
  it('floors to the start of an hour bucket', () => {
    const d = new Date('2026-07-07T10:34:21.500Z');
    expect(bucketStartFor(d, 60).toISOString()).toBe('2026-07-07T10:00:00.000Z');
  });

  it('floors to the start of a 15-minute bucket', () => {
    const d = new Date('2026-07-07T10:34:21.500Z');
    expect(bucketStartFor(d, 15).toISOString()).toBe('2026-07-07T10:30:00.000Z');
  });

  it('is a no-op for a timestamp already on a bucket boundary', () => {
    const d = new Date('2026-07-07T10:00:00.000Z');
    expect(bucketStartFor(d, 60).getTime()).toBe(d.getTime());
  });
});

describe('aggregateEventRows', () => {
  const from = new Date('2026-07-07T00:00:00.000Z');
  const to = new Date('2026-07-07T02:00:00.000Z');

  it('zero-fills every bucket across the window even with no rows', () => {
    const buckets = aggregateEventRows([], from, to, 60);
    expect(buckets).toHaveLength(3); // 00:00, 01:00, 02:00
    expect(buckets.map((b) => b.bucketStart.toISOString())).toEqual([
      '2026-07-07T00:00:00.000Z',
      '2026-07-07T01:00:00.000Z',
      '2026-07-07T02:00:00.000Z',
    ]);
    expect(buckets.every((b) => b.total === 0 && b.errorCount === 0)).toBe(true);
  });

  it('counts rows into their bucket, tallies byStatus, and derives errorCount', () => {
    const rows = [
      { createdAt: new Date('2026-07-07T00:05:00.000Z'), status: '200' },
      { createdAt: new Date('2026-07-07T00:50:00.000Z'), status: '500' },
      { createdAt: new Date('2026-07-07T01:10:00.000Z'), status: 'failed' },
      { createdAt: new Date('2026-07-07T01:20:00.000Z'), status: 'published' },
      { createdAt: new Date('2026-07-07T01:25:00.000Z'), status: 'published' },
    ];
    const buckets = aggregateEventRows(rows, from, to, 60);

    const bucket0 = buckets.find(
      (b) => b.bucketStart.toISOString() === '2026-07-07T00:00:00.000Z',
    )!;
    expect(bucket0.total).toBe(2);
    expect(bucket0.errorCount).toBe(1);
    expect(bucket0.byStatus).toEqual({ '200': 1, '500': 1 });

    const bucket1 = buckets.find(
      (b) => b.bucketStart.toISOString() === '2026-07-07T01:00:00.000Z',
    )!;
    expect(bucket1.total).toBe(3);
    expect(bucket1.errorCount).toBe(1);
    expect(bucket1.byStatus).toEqual({ failed: 1, published: 2 });

    const bucket2 = buckets.find(
      (b) => b.bucketStart.toISOString() === '2026-07-07T02:00:00.000Z',
    )!;
    expect(bucket2.total).toBe(0);
  });

  it('ignores rows outside the [from, to] window after bucketing', () => {
    const rows = [
      { createdAt: new Date('2026-07-06T23:00:00.000Z'), status: '200' }, // before window
      { createdAt: new Date('2026-07-07T05:00:00.000Z'), status: '200' }, // after window
    ];
    const buckets = aggregateEventRows(rows, from, to, 60);
    expect(buckets.reduce((sum, b) => sum + b.total, 0)).toBe(0);
  });

  it('treats null status as an "unknown" bucket key, not an error', () => {
    const rows = [{ createdAt: new Date('2026-07-07T00:10:00.000Z'), status: null }];
    const buckets = aggregateEventRows(rows, from, to, 60);
    const bucket0 = buckets.find(
      (b) => b.bucketStart.toISOString() === '2026-07-07T00:00:00.000Z',
    )!;
    expect(bucket0.byStatus).toEqual({ unknown: 1 });
    expect(bucket0.errorCount).toBe(0);
  });
});
