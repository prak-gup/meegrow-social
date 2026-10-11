import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { computeNextFreeSlot, computeUpcomingSlots, type Clock } from './queues.js';
import type { WeeklySlot } from '@meegrow-social/contracts';

function clockAt(iso: string, zone: string): Clock {
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) throw new Error(`bad test fixture time: ${iso} (${dt.invalidReason})`);
  return { now: () => dt.toJSDate() };
}

describe('computeNextFreeSlot — Asia/Kolkata (no DST)', () => {
  const slots: WeeklySlot[] = [
    { dow: 1, time: '09:00' }, // Monday
    { dow: 3, time: '09:00' }, // Wednesday
  ];

  it('picks the next upcoming weekly slot from "now"', () => {
    // 2026-07-05 is a Sunday in IST.
    const clock = clockAt('2026-07-05T10:00:00', 'Asia/Kolkata');
    const result = computeNextFreeSlot({ timezone: 'Asia/Kolkata', slots, occupied: [], clock });

    const resultIst = DateTime.fromJSDate(result, { zone: 'Asia/Kolkata' });
    expect(resultIst.weekday).toBe(1); // Monday
    expect(resultIst.toFormat('HH:mm')).toBe('09:00');
    expect(resultIst.toISODate()).toBe('2026-07-06');
    // IST is UTC+5:30 year-round — no DST to correct for.
    expect(resultIst.offset).toBe(330);
  });

  it('skips a slot already in `occupied` and lands on the next one — proves consecutive add-to-queue', () => {
    const clock = clockAt('2026-07-05T10:00:00', 'Asia/Kolkata');
    const first = computeNextFreeSlot({ timezone: 'Asia/Kolkata', slots, occupied: [], clock });
    const second = computeNextFreeSlot({
      timezone: 'Asia/Kolkata',
      slots,
      occupied: [first],
      clock,
    });

    expect(second.getTime()).toBeGreaterThan(first.getTime());
    const secondIst = DateTime.fromJSDate(second, { zone: 'Asia/Kolkata' });
    expect(secondIst.weekday).toBe(3); // Wednesday — the next configured slot after Monday
    expect(secondIst.toFormat('HH:mm')).toBe('09:00');
  });

  it('never returns a slot at or before "now"', () => {
    // Right at the Monday 09:00 slot itself — must roll to the next occurrence, not return "now".
    const clock = clockAt('2026-07-06T09:00:00', 'Asia/Kolkata');
    const result = computeNextFreeSlot({ timezone: 'Asia/Kolkata', slots, occupied: [], clock });
    expect(result.getTime()).toBeGreaterThan(clock.now().getTime());
  });
});

describe('computeNextFreeSlot — America/New_York (DST-observing)', () => {
  const dailySlot: WeeklySlot[] = Array.from({ length: 7 }, (_, dow) => ({ dow, time: '09:00' }));

  it('resolves to EST (UTC-5) just before the US 2026 spring-forward transition', () => {
    // 2026 spring-forward is Sunday 2026-03-08 at 02:00 local. Ask for a slot from a clock on 03-06.
    const clock = clockAt('2026-03-06T08:00:00', 'America/New_York');
    const result = computeNextFreeSlot({
      timezone: 'America/New_York',
      slots: dailySlot,
      occupied: [],
      clock,
    });
    const zoned = DateTime.fromJSDate(result, { zone: 'America/New_York' });
    expect(zoned.toISODate()).toBe('2026-03-06');
    expect(zoned.offset).toBe(-300); // EST
  });

  it('resolves to EDT (UTC-4) for a slot after the spring-forward transition', () => {
    const clock = clockAt('2026-03-09T08:00:00', 'America/New_York');
    const result = computeNextFreeSlot({
      timezone: 'America/New_York',
      slots: dailySlot,
      occupied: [],
      clock,
    });
    const zoned = DateTime.fromJSDate(result, { zone: 'America/New_York' });
    expect(zoned.toISODate()).toBe('2026-03-09');
    expect(zoned.offset).toBe(-240); // EDT
  });

  it('does not throw or misfire for a slot time inside the spring-forward gap itself', () => {
    // 2:30am on 2026-03-08 does not exist in America/New_York (clocks jump 2:00 -> 3:00).
    const gapSlot: WeeklySlot[] = [{ dow: 0, time: '02:30' }]; // 2026-03-08 is a Sunday
    // Start the clock the Monday after the *previous* Sunday (2026-03-01) so the next dow=0 match
    // the loop finds is 2026-03-08, not the (already past) start-of-week day itself.
    const clock = clockAt('2026-03-02T00:00:00', 'America/New_York');
    const result = computeNextFreeSlot({
      timezone: 'America/New_York',
      slots: gapSlot,
      occupied: [],
      clock,
    });
    const zoned = DateTime.fromJSDate(result, { zone: 'America/New_York' });
    expect(zoned.toISODate()).toBe('2026-03-08');
    // Luxon normalizes the non-existent local time forward across the gap rather than throwing.
    expect(zoned.isValid).toBe(true);
    expect(result.getTime()).toBeGreaterThan(clock.now().getTime());
  });

  it('resolves an ambiguous fall-back local time to a valid, non-throwing instant', () => {
    // US fall-back 2026 is Sunday 2026-11-01 at 02:00 local; 01:30 occurs twice that day.
    const ambiguousSlot: WeeklySlot[] = [{ dow: 0, time: '01:30' }];
    const clock = clockAt('2026-10-26T00:00:00', 'America/New_York');
    const result = computeNextFreeSlot({
      timezone: 'America/New_York',
      slots: ambiguousSlot,
      occupied: [],
      clock,
    });
    const zoned = DateTime.fromJSDate(result, { zone: 'America/New_York' });
    expect(zoned.toISODate()).toBe('2026-11-01');
    expect(zoned.isValid).toBe(true);
  });
});

describe('computeNextFreeSlot — edge cases', () => {
  it('throws when the queue has no slots configured', () => {
    expect(() =>
      computeNextFreeSlot({
        timezone: 'Asia/Kolkata',
        slots: [],
        occupied: [],
        clock: clockAt('2026-07-05T10:00:00', 'Asia/Kolkata'),
      }),
    ).toThrow(/no slots configured/);
  });

  it('throws when every slot within the lookahead window is occupied', () => {
    const clock = clockAt('2026-07-05T10:00:00', 'Asia/Kolkata');
    const slot: WeeklySlot = { dow: 1, time: '09:00' };
    // Pre-fill 10 consecutive weekly Mondays (~70 days) — well within the default 90-day lookahead.
    const occupied: Date[] = [];
    for (let i = 0; i < 10; i++) {
      occupied.push(
        computeNextFreeSlot({ timezone: 'Asia/Kolkata', slots: [slot], occupied, clock }),
      );
    }
    // A 7-day lookahead only reaches the very next Monday, which is already occupied — must throw.
    expect(() =>
      computeNextFreeSlot({
        timezone: 'Asia/Kolkata',
        slots: [slot],
        occupied,
        clock,
        maxLookaheadDays: 7,
      }),
    ).toThrow(/no free slot found/);
  });
});

describe('computeUpcomingSlots — the slot preview', () => {
  const slots: WeeklySlot[] = [
    { dow: 1, time: '09:00' }, // Monday
    { dow: 3, time: '18:30' }, // Wednesday
    { dow: 5, time: '09:00' }, // Friday
  ];
  // 2026-07-05 is a Sunday in IST.
  const clock = clockAt('2026-07-05T10:00:00', 'Asia/Kolkata');
  const local = (d: Date) => DateTime.fromJSDate(d, { zone: 'Asia/Kolkata' }).toFormat('ccc HH:mm');

  it('is exactly what N consecutive add-to-queue calls would be assigned', () => {
    // The real path: pick a slot, the post occupies it, pick again.
    const occupied: Date[] = [];
    for (let i = 0; i < 7; i++) {
      occupied.push(computeNextFreeSlot({ timezone: 'Asia/Kolkata', slots, occupied, clock }));
    }
    const preview = computeUpcomingSlots({
      timezone: 'Asia/Kolkata',
      slots,
      occupied: [],
      clock,
      count: 7,
    });
    expect(preview).toEqual(occupied);
    expect(preview.slice(0, 4).map(local)).toEqual([
      'Mon 09:00',
      'Wed 18:30',
      'Fri 09:00',
      'Mon 09:00',
    ]);
  });

  it('skips slots that posts already hold, and starts where add-to-queue would', () => {
    const [monday, wednesday] = computeUpcomingSlots({
      timezone: 'Asia/Kolkata',
      slots,
      occupied: [],
      clock,
      count: 2,
    });
    const preview = computeUpcomingSlots({
      timezone: 'Asia/Kolkata',
      slots,
      occupied: [monday!],
      clock,
      count: 2,
    });
    expect(preview[0]).toEqual(wednesday);
    expect(preview[0]).toEqual(
      computeNextFreeSlot({ timezone: 'Asia/Kolkata', slots, occupied: [monday!], clock }),
    );
    expect(preview.map(local)).toEqual(['Wed 18:30', 'Fri 09:00']);
  });

  it('never repeats a slot and returns them in ascending order', () => {
    const preview = computeUpcomingSlots({
      timezone: 'Asia/Kolkata',
      slots,
      occupied: [],
      clock,
      count: 30,
    });
    expect(preview).toHaveLength(30);
    const times = preview.map((d) => d.getTime());
    expect(new Set(times).size).toBe(30);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('returns fewer than asked, without throwing, when the look-ahead runs out', () => {
    // One slot a week: a 90-day look-ahead holds 13 Mondays, not 50.
    const weekly: WeeklySlot[] = [{ dow: 1, time: '09:00' }];
    const preview = computeUpcomingSlots({
      timezone: 'Asia/Kolkata',
      slots: weekly,
      occupied: [],
      clock,
      count: 50,
    });
    expect(preview).toHaveLength(13);
    expect(
      computeUpcomingSlots({
        timezone: 'Asia/Kolkata',
        slots: weekly,
        occupied: preview,
        clock,
        count: 5,
      }),
    ).toEqual([]);
  });

  it('keeps the wall-clock time across a DST change', () => {
    const daily: WeeklySlot[] = Array.from({ length: 7 }, (_, dow) => ({ dow, time: '09:00' }));
    const preview = computeUpcomingSlots({
      timezone: 'America/New_York',
      slots: daily,
      occupied: [],
      clock: clockAt('2026-03-06T08:00:00', 'America/New_York'),
      count: 4,
    });
    const zoned = preview.map((d) => DateTime.fromJSDate(d, { zone: 'America/New_York' }));
    expect(zoned.map((z) => z.toFormat('HH:mm'))).toEqual(['09:00', '09:00', '09:00', '09:00']);
    // Fri + Sat in EST, then Sunday 2026-03-08 springs forward to EDT.
    expect(zoned.map((z) => z.offset)).toEqual([-300, -300, -240, -240]);
  });

  it('throws for a queue with no slots, like the real path', () => {
    expect(() =>
      computeUpcomingSlots({ timezone: 'Asia/Kolkata', slots: [], occupied: [], clock, count: 3 }),
    ).toThrow(/no slots configured/);
  });
});
