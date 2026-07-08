import { describe, expect, it } from 'vitest';
import {
  EXPIRING_WINDOW_MS,
  ONE_TIME_EXPIRING_WINDOW_MS,
  computeHealth,
  expiresInDaysFrom,
} from './connections.js';

const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number): Date => new Date(Date.now() + offsetMs);

describe('computeHealth — token-model-aware matrix', () => {
  describe('needsReconnect wins for every model', () => {
    it.each(['auto-refresh', 'refresh-cron', 'one-time'] as const)(
      '%s → needs_reconnect when flagged',
      (model) => {
        expect(computeHealth(model, true, null)).toBe('needs_reconnect');
        expect(computeHealth(model, true, at(DAY))).toBe('needs_reconnect');
      },
    );
  });

  describe('no expiry → healthy', () => {
    it.each(['auto-refresh', 'refresh-cron', 'one-time'] as const)('%s', (model) => {
      expect(computeHealth(model, false, null)).toBe('healthy');
    });
  });

  it('auto-refresh surfaces expiring within the 7d window only', () => {
    expect(computeHealth('auto-refresh', false, at(EXPIRING_WINDOW_MS + DAY))).toBe('healthy');
    expect(computeHealth('auto-refresh', false, at(EXPIRING_WINDOW_MS - 1000))).toBe('expiring');
    expect(computeHealth('auto-refresh', false, at(-DAY))).toBe('expiring'); // already expired
  });

  it('refresh-cron shares the 7d window with auto-refresh', () => {
    expect(computeHealth('refresh-cron', false, at(EXPIRING_WINDOW_MS + DAY))).toBe('healthy');
    expect(computeHealth('refresh-cron', false, at(6 * DAY))).toBe('expiring');
  });

  it('one-time surfaces expiring within the wider 14d window (manual re-auth, never auto-refreshed)', () => {
    expect(computeHealth('one-time', false, at(ONE_TIME_EXPIRING_WINDOW_MS + DAY))).toBe('healthy');
    // 10d out: beyond the 7d refreshable window, but inside the 14d one-time window.
    expect(computeHealth('one-time', false, at(10 * DAY))).toBe('expiring');
    expect(computeHealth('one-time', false, at(6 * DAY))).toBe('expiring');
  });
});

describe('expiresInDaysFrom', () => {
  it('is null when there is no expiry', () => {
    expect(expiresInDaysFrom(null)).toBeNull();
  });

  it('floors whole days until expiry (future)', () => {
    expect(expiresInDaysFrom(at(2.5 * DAY))).toBe(2);
    expect(expiresInDaysFrom(at(0.9 * DAY))).toBe(0);
  });

  it('is negative for past expiry (floors toward negative infinity)', () => {
    expect(expiresInDaysFrom(at(-1.5 * DAY))).toBe(-2);
  });
});
