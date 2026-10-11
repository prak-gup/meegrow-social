import { describe, expect, it } from 'vitest';
import { queueSlotsQuery } from './queues.js';

describe('queueSlotsQuery (GET /v1/queues/:id/slots)', () => {
  it('defaults to 5 slots', () => {
    expect(queueSlotsQuery.parse({})).toEqual({ count: 5 });
  });

  it('coerces the query-string value', () => {
    expect(queueSlotsQuery.parse({ count: '12' })).toEqual({ count: 12 });
  });

  it.each(['0', '51', '-1', '2.5', 'many'])('rejects count=%s', (count) => {
    expect(queueSlotsQuery.safeParse({ count }).success).toBe(false);
  });

  it('accepts the bounds', () => {
    expect(queueSlotsQuery.parse({ count: '1' }).count).toBe(1);
    expect(queueSlotsQuery.parse({ count: '50' }).count).toBe(50);
  });
});
