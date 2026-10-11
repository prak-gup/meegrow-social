import { describe, expect, it } from 'vitest';
import {
  METRIC_RETENTION_DAYS,
  METRIC_RETENTION_SWEEP_MS,
  metricRetentionCutoff,
} from './metrics-retention.js';

/**
 * The pure half of metric retention (#61). Which rows the DELETE matches is SQL and is covered by
 * metrics-retention.integration.test.ts.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-11T09:30:00.000Z');

describe('METRIC_RETENTION_DAYS', () => {
  it('limits YouTube to 30 days and nothing else', () => {
    expect(METRIC_RETENTION_DAYS).toEqual({ youtube: 30 });
  });
});

describe('metricRetentionCutoff', () => {
  it('is a day plus one sweep interval inside the limit', () => {
    const cutoff = metricRetentionCutoff(NOW, 30);
    expect(NOW.getTime() - cutoff.getTime()).toBe(29 * DAY - METRIC_RETENTION_SWEEP_MS);
  });

  it('means a row is gone before its 30th day even if the sweep that would catch it runs late', () => {
    const cutoff = metricRetentionCutoff(NOW, 30);
    // A row stored the instant after the cutoff survives this sweep and is caught by the next one.
    const storedAt = cutoff.getTime() + 1;
    const nextSweep = NOW.getTime() + METRIC_RETENTION_SWEEP_MS;
    expect(metricRetentionCutoff(new Date(nextSweep), 30).getTime()).toBeGreaterThan(storedAt);
    expect(nextSweep - storedAt).toBeLessThan(29 * DAY);
    // Even a worker that was down for a further day deletes it inside the limit.
    expect(nextSweep + DAY - storedAt).toBeLessThan(30 * DAY);
  });

  it('keeps yesterday’s rows', () => {
    expect(metricRetentionCutoff(NOW, 30).getTime()).toBeLessThan(NOW.getTime() - 28 * DAY);
  });
});
