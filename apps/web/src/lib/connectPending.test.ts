import { describe, expect, it } from 'vitest';
import { addedAccount, connectPendingExpired, CONNECT_TIMEOUT_MS } from './connectPending';
describe('connect reconciliation', () => {
  it('names only a newly fetched account for the pending provider', () => {
    const accounts = [
      { id: 'old', provider: 'youtube' },
      { id: 'other', provider: 'facebook' },
      { id: 'new', provider: 'youtube' },
    ];
    expect(addedAccount(['old'], accounts, 'youtube')?.id).toBe('new');
    expect(
      addedAccount(
        accounts.map((c) => c.id),
        accounts,
      ),
    ).toBeUndefined();
  });
  it('bounds polling to three minutes', () => {
    const p = { provider: 'youtube', startedAt: 100, before: [] };
    expect(connectPendingExpired(p, 100 + CONNECT_TIMEOUT_MS - 1)).toBe(false);
    expect(connectPendingExpired(p, 100 + CONNECT_TIMEOUT_MS)).toBe(true);
  });
});
