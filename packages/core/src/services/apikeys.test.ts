import { describe, expect, it } from 'vitest';
import { generateApiKey, hashKey } from './apikeys.js';

describe('api keys', () => {
  it('generates a prefixed secret whose hash matches', () => {
    const key = generateApiKey();
    expect(key.secret.startsWith('sk_live_')).toBe(true);
    expect(key.prefix.startsWith('sk_live_')).toBe(true);
    expect(key.hash).toBe(hashKey(key.secret));
    expect(key.hash).toHaveLength(64); // sha-256 hex
  });

  it('produces distinct secrets each call', () => {
    expect(generateApiKey().secret).not.toBe(generateApiKey().secret);
  });
});
