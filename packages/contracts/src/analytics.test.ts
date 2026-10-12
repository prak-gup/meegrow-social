import { describe, expect, it } from 'vitest';
import { analyticsReportQuery, analyticsPostSort } from './analytics.js';

describe('analytics report sort query', () => {
  it.each(analyticsPostSort.options)('accepts %s with either direction', (sort) => {
    for (const sortDir of ['asc', 'desc'])
      expect(analyticsReportQuery.parse({ sort, sortDir })).toMatchObject({ sort, sortDir });
  });
  it('rejects arbitrary sort keys and directions', () => {
    expect(analyticsReportQuery.safeParse({ sort: 'caption' }).success).toBe(false);
    expect(analyticsReportQuery.safeParse({ sortDir: 'sideways' }).success).toBe(false);
  });
});
