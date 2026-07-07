import { beforeAll, describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from './crypto.js';

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = 'unit-test-key-please-change';
});

describe('token crypto', () => {
  it('round-trips a token', () => {
    const secret = 'ya29.super-secret-access-token';
    expect(decryptToken(encryptToken(secret))).toBe(secret);
  });

  it('produces different ciphertext each time (random IV)', () => {
    expect(encryptToken('same')).not.toBe(encryptToken('same'));
  });

  it('rejects a tampered payload (auth tag mismatch)', () => {
    const [iv, tag, data] = encryptToken('some-secret-value').split('.');
    const flipped = tag!.startsWith('A') ? `B${tag!.slice(1)}` : `A${tag!.slice(1)}`;
    expect(() => decryptToken(`${iv}.${flipped}.${data}`)).toThrow();
  });
});
