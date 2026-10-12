import { describe, expect, it } from 'vitest';
import { registerMediaFromUrl } from './media.js';

/**
 * No fetchImpl is passed, so these go through the real SSRF guard. Every address here is refused
 * before any DNS lookup or connection, so nothing leaves the process and no database is reached.
 */
describe('registerMediaFromUrl — refuses addresses that are not public https', () => {
  const ws = '00000000-0000-4000-8000-000000000001';
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'https://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8990/healthz',
    'https://127.0.0.1/x.jpg',
    'https://[::1]/x.jpg',
    'https://10.0.0.5/x.jpg',
    'https://user:pass@example.com/x.jpg',
    'https://example.com:8443/x.jpg',
  ]) {
    it(`refuses ${url}`, async () => {
      const attempt = registerMediaFromUrl(ws, { url });
      await expect(attempt).rejects.toThrow(/not allowed/);
      // The message must not echo anything learned from the target.
      await expect(attempt).rejects.not.toThrow(/HTTP \d|169\.254|127\.0/);
    });
  }
});
