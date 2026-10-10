import { describe, expect, it } from 'vitest';
import type { CalendarDay, PostView } from '@meegrow-social/contracts';
import {
  buildMonthGrid,
  canShiftMonth,
  parseDateKey,
  prepareDays,
  shiftMonth,
  todayKey,
} from './calendarGrid';

const dates = (weeks: ReturnType<typeof buildMonthGrid>) => weeks.map((w) => w.map((d) => d.date));

describe('buildMonthGrid', () => {
  it('pads a Monday-first month with the previous and next months', () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const weeks = buildMonthGrid(2026, 10);
    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.[0]).toEqual({ date: '2026-09-28', day: 28, inMonth: false });
    expect(weeks[0]?.[3]).toEqual({ date: '2026-10-01', day: 1, inMonth: true });
    expect(weeks[4]?.[5]).toEqual({ date: '2026-10-31', day: 31, inMonth: true });
    expect(weeks[4]?.[6]).toEqual({ date: '2026-11-01', day: 1, inMonth: false });
  });

  it('honours a Sunday week start', () => {
    const weeks = buildMonthGrid(2026, 10, 0);
    expect(weeks[0]?.[0]?.date).toBe('2026-09-27');
    expect(weeks[0]?.[4]?.date).toBe('2026-10-01');
  });

  it('needs only four weeks when February starts on the first weekday', () => {
    // 1 Feb 2027 is a Monday and the month has 28 days.
    const weeks = buildMonthGrid(2027, 2);
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().every((d) => d.inMonth)).toBe(true);
  });

  it('needs six weeks when a long month starts late in the week', () => {
    // 1 Aug 2026 is a Saturday: 5 leading days + 31 days spans six Monday-first weeks.
    const weeks = buildMonthGrid(2026, 8);
    expect(weeks).toHaveLength(6);
    expect(weeks[5]?.map((d) => d.date)).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
  });

  it('knows leap years', () => {
    const feb = buildMonthGrid(2028, 2)
      .flat()
      .filter((d) => d.inMonth);
    expect(feb).toHaveLength(29);
    expect(feb.at(-1)?.date).toBe('2028-02-29');
  });

  it('rolls the year over at both ends of December/January', () => {
    const dec = buildMonthGrid(2026, 12);
    expect(dec.at(-1)?.at(-1)?.date).toBe('2027-01-03');
    expect(dec.at(-1)?.at(-1)?.inMonth).toBe(false);
    const jan = buildMonthGrid(2027, 1);
    expect(jan[0]?.[0]?.date).toBe('2026-12-28');
    expect(jan[0]?.[0]?.inMonth).toBe(false);
  });

  it('always yields full, contiguous weeks', () => {
    for (let month = 1; month <= 12; month++) {
      const flat = dates(buildMonthGrid(2026, month)).flat();
      expect(flat.length % 7).toBe(0);
      flat.slice(1).forEach((d, i) => {
        const prev = new Date(`${flat[i]}T00:00:00Z`).getTime();
        expect(new Date(`${d}T00:00:00Z`).getTime() - prev).toBe(86_400_000);
      });
    }
  });
});

describe('shiftMonth / canShiftMonth', () => {
  it('rolls over the year in both directions', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2027, 1, -1)).toEqual({ year: 2026, month: 12 });
    expect(shiftMonth(2026, 10, 0)).toEqual({ year: 2026, month: 10 });
    expect(shiftMonth(2026, 3, -15)).toEqual({ year: 2024, month: 12 });
  });

  it('stops at the years the API accepts', () => {
    expect(canShiftMonth(2000, 1, -1)).toBe(false);
    expect(canShiftMonth(2000, 2, -1)).toBe(true);
    expect(canShiftMonth(2100, 12, 1)).toBe(false);
    expect(canShiftMonth(2100, 11, 1)).toBe(true);
  });
});

describe('date keys', () => {
  it('formats today from local date parts', () => {
    expect(todayKey(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
    expect(todayKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });

  it('parses a key to the same local calendar day', () => {
    const d = parseDateKey('2026-12-31');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 11, 31]);
  });
});

describe('prepareDays', () => {
  const post = (id: string, provider: string, publishAt: string | null): PostView =>
    ({ id, provider, publishAt }) as unknown as PostView;
  const days: CalendarDay[] = [
    {
      date: '2026-10-12',
      posts: [
        post('late', 'x', '2026-10-12T15:00:00Z'),
        post('early', 'x', '2026-10-12T08:00:00Z'),
      ],
    },
    {
      date: '2026-10-03',
      posts: [post('fake', 'fakeprovider', '2026-10-03T08:00:00Z'), post('nodate', 'x', null)],
    },
    { date: '2026-10-05', posts: [post('epoch', 'x', '1970-01-01T00:00:00Z')] },
    { date: '2026-10-04', posts: [post('ok', 'facebook', '2026-10-04T08:00:00Z')] },
  ];

  it('drops hidden providers, undated posts and empty days, and sorts what is left', () => {
    const out = prepareDays(days, (p) => !p.startsWith('fake'));
    expect(out.map((d) => d.date)).toEqual(['2026-10-04', '2026-10-12']);
    expect(out[1]?.posts.map((p) => p.id)).toEqual(['early', 'late']);
  });
});
