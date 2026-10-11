import { describe, expect, it } from 'vitest';
import { cadenceText, cadenceWord, humanizeMetric, isClientRole, nextRefresh } from './analytics';

const NOW = new Date(2026, 9, 10, 12).getTime();

describe('sync line', () => {
  it('words the cadence from what the API reports, not from fixed text', () => {
    const HOUR = 3_600_000;
    expect(cadenceWord(HOUR)).toBe('hourly');
    expect(cadenceWord(24 * HOUR)).toBe('daily');
    expect(cadenceWord(6 * HOUR)).toBe('every 6 hours');
    expect(cadenceWord(HOUR / 2)).toBe('every 30 minutes');
    const cadence = {
      sweepIntervalMs: HOUR,
      freshPostWindowMs: 48 * HOUR,
      freshPostIntervalMs: HOUR,
      postIntervalMs: 24 * HOUR,
      accountIntervalMs: 24 * HOUR,
    };
    expect(cadenceText(cadence)).toBe(
      'posts refresh hourly for 48 h, then daily · followers daily',
    );
    expect(
      cadenceText({ ...cadence, freshPostWindowMs: 72 * HOUR, postIntervalMs: 12 * HOUR }),
    ).toBe('posts refresh hourly for 72 h, then every 12 hours · followers daily');
  });

  it('says that old posts are refreshed less often, when the API reports it', () => {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const cadence = {
      sweepIntervalMs: HOUR,
      freshPostWindowMs: 48 * HOUR,
      freshPostIntervalMs: HOUR,
      postIntervalMs: DAY,
      accountIntervalMs: DAY,
      olderPosts: [
        { afterMs: 30 * DAY, intervalMs: 7 * DAY },
        { afterMs: 90 * DAY, intervalMs: 28 * DAY },
      ],
    };
    expect(cadenceText(cadence)).toBe(
      'posts refresh hourly for 48 h, then daily, weekly after 30 days, every 28 days after 90 days · followers daily',
    );
    expect(cadenceWord(7 * DAY)).toBe('weekly');
    expect(cadenceWord(3 * DAY)).toBe('every 3 days');
  });

  it('says when the next collection falls due: never, already, or at a time', () => {
    const at = (d: Date | null) => nextRefresh({ nextDueAt: d }, NOW);
    expect(at(null)).toEqual({ kind: 'none' });
    expect(at(new Date(NOW - 1))).toEqual({ kind: 'due' });
    expect(at(new Date(NOW))).toEqual({ kind: 'due' });
    expect(at(new Date(NOW + 60_000))).toEqual({ kind: 'at', at: NOW + 60_000 });
    // The API client hands dates over as ISO strings.
    expect(
      nextRefresh({ nextDueAt: new Date(NOW + 5).toISOString() as unknown as Date }, NOW),
    ).toEqual({ kind: 'at', at: NOW + 5 });
  });
});

describe('formatting', () => {
  it('humanises a metric name cosmetically, without renaming it', () => {
    expect(humanizeMetric('post_video_views')).toBe('Post video views');
    expect(humanizeMetric('views')).toBe('Views');
    expect(humanizeMetric('LOCAL_POST_VIEWS_SEARCH')).toBe('LOCAL POST VIEWS SEARCH');
    expect(humanizeMetric('')).toBe('');
  });
});

describe('isClientRole', () => {
  it('is true for client, and for viewer until the roles matrix lands', () => {
    expect(isClientRole('client')).toBe(true);
    expect(isClientRole('viewer')).toBe(true);
  });

  it.each(['owner', 'admin', 'member', '', null, undefined])('is false for %s', (role) => {
    expect(isClientRole(role)).toBe(false);
  });
});
