import { describe, expect, it } from 'vitest';
import {
  EXPIRING_WINDOW_MS,
  ONE_TIME_EXPIRING_WINDOW_MS,
  computeHealth,
  describeConnectionHealth,
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

describe('describeConnectionHealth — status, reason and next step from stored state', () => {
  const base = {
    tokenModel: 'auto-refresh',
    needsReconnect: false,
    hasRefreshToken: true,
  } as const;

  it('needs_reconnect wins over everything, and asks for a human', () => {
    const report = describeConnectionHealth({ ...base, needsReconnect: true, expiresAt: at(-DAY) });
    expect(report.status).toBe('needs_reconnect');
    expect(report.recommendedAction).toMatch(/Reconnect/);
  });

  it('healthy: no expiry, or expiry beyond the window', () => {
    expect(describeConnectionHealth({ ...base, expiresAt: null })).toMatchObject({
      status: 'healthy',
      reason: 'The stored token has no expiry.',
      recommendedAction: 'None.',
    });
    const far = describeConnectionHealth({ ...base, expiresAt: at(30 * DAY + 1000) });
    expect(far.status).toBe('healthy');
    expect(far.reason).toMatch(/another 30 days/);
  });

  it('expiring + auto-refreshable needs no action', () => {
    const report = describeConnectionHealth({ ...base, expiresAt: at(3 * DAY + 1000) });
    expect(report).toMatchObject({ status: 'expiring', autoRefresh: true });
    expect(report.reason).toMatch(/expires in 3 day/);
    expect(report.recommendedAction).toMatch(/^None/);
  });

  it('expiring + one-time token asks for a reconnect before it lapses', () => {
    const report = describeConnectionHealth({
      ...base,
      tokenModel: 'one-time',
      expiresAt: at(10 * DAY),
    });
    expect(report).toMatchObject({ status: 'expiring', autoRefresh: false });
    expect(report.recommendedAction).toMatch(/Reconnect/);
  });

  it('a refreshable model with no stored refresh token cannot auto-refresh', () => {
    const report = describeConnectionHealth({
      ...base,
      hasRefreshToken: false,
      expiresAt: at(2 * DAY),
    });
    expect(report.autoRefresh).toBe(false);
    expect(report.recommendedAction).toMatch(/Reconnect/);
  });

  it('expired is split out of expiring, which the badge folds together', () => {
    const expiresAt = at(-1.5 * DAY);
    expect(computeHealth('one-time', false, expiresAt)).toBe('expiring');
    const report = describeConnectionHealth({ ...base, tokenModel: 'one-time', expiresAt });
    expect(report.status).toBe('expired');
    expect(report.reason).toMatch(/expired 2 day/);
    expect(report.recommendedAction).toMatch(/^Reconnect/);
  });

  it('expired + auto-refreshable points at the sweeper first', () => {
    const report = describeConnectionHealth({ ...base, expiresAt: at(-DAY) });
    expect(report).toMatchObject({ status: 'expired', autoRefresh: true });
    expect(report.recommendedAction).toMatch(/refreshes automatically/);
  });

  it.each(['auto-refresh', 'refresh-cron', 'one-time'] as const)(
    '%s: never disagrees with computeHealth, except to refine expiring into expired',
    (tokenModel) => {
      for (const needsReconnect of [true, false]) {
        for (const expiresAt of [null, at(-DAY), at(DAY), at(10 * DAY), at(60 * DAY)]) {
          const { status } = describeConnectionHealth({
            ...base,
            tokenModel,
            needsReconnect,
            expiresAt,
          });
          const badge = computeHealth(tokenModel, needsReconnect, expiresAt);
          expect(status === 'expired' ? 'expiring' : status).toBe(badge);
        }
      }
    },
  );
});
