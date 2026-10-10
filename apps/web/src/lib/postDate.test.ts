import { describe, expect, it } from 'vitest';
import { formatPublishAt, formatPublishTime, hasPublishDate, parsePublishAt } from './postDate';

describe('publish dates', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['the Unix epoch (ISO)', '1970-01-01T00:00:00.000Z'],
    ['the Unix epoch (number)', 0],
    ['the Unix epoch (Date)', new Date(0)],
    ['the last instant of 2000', '2000-12-31T23:59:59.999Z'],
    ['garbage', 'not a date'],
  ])('treats %s as no date', (_name, value) => {
    expect(parsePublishAt(value)).toBeNull();
    expect(hasPublishDate(value)).toBe(false);
    expect(formatPublishAt(value)).toBe('—');
    expect(formatPublishTime(value)).toBe('—');
  });

  it.each([
    ['the first instant of 2001', '2001-01-01T00:00:00.000Z'],
    ['an ISO string from the API', '2026-10-10T09:30:00.000Z'],
    ['a Date', new Date('2026-10-10T09:30:00.000Z')],
  ])('accepts %s', (_name, value) => {
    expect(hasPublishDate(value)).toBe(true);
    expect(formatPublishAt(value)).not.toBe('—');
    expect(formatPublishAt(value)).not.toContain('1970');
    expect(formatPublishTime(value)).not.toBe('—');
  });
});
