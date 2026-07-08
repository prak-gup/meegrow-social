import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { computeNextFreeSlot, type Clock } from './queues.js';
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
