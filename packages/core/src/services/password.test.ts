import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@meegrow-social/contracts';
import { hashPassword, newPasswordProblem, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('produces an argon2id hash (locks the variant — drives the refresh/auth security model)', async () => {
    const h = await hashPassword('hunter2');
    expect(h.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('salts each hash (same password → different hashes)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same')).toBe(true);
    expect(await verifyPassword(b, 'same')).toBe(true);
  });

  it('fails closed on a malformed hash (no throw)', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false);
  });
});

describe('newPasswordProblem', () => {
  it('accepts both ends of the allowed range', () => {
    expect(newPasswordProblem('x'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(newPasswordProblem('x'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });

  it('names the bound that is broken', () => {
    expect(newPasswordProblem('')).toBe('too_short');
    expect(newPasswordProblem('x'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('too_short');
    expect(newPasswordProblem('x'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe('too_long');
  });

  it('pins the policy: 12 to 128 characters', () => {
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([12, 128]);
  });
});
