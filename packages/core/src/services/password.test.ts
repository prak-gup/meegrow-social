import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

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
