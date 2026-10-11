import { describe, expect, it } from 'vitest';
import {
  API_KEY_STATUS,
  KEY_NAME_MAX,
  KEY_PLACEHOLDER,
  apiKeyStatus,
  curlSnippet,
  formatKeyDate,
  lastUsedLabel,
  mcpUrl,
  validateKeyName,
} from './apiKeys';

const NOW = new Date('2026-10-11T12:00:00.000Z');
// The API sends ISO strings where the contract says Date.
const iso = (value: string) => value as unknown as Date;

describe('apiKeyStatus', () => {
  it('is active with no revocation and no expiry', () => {
    expect(apiKeyStatus({ revokedAt: null, expiresAt: null }, NOW)).toBe('active');
  });

  it('is active while the expiry is still ahead', () => {
    expect(apiKeyStatus({ revokedAt: null, expiresAt: iso('2026-10-11T12:00:01.000Z') }, NOW)).toBe(
      'active',
    );
  });

  it('is expired at and after the expiry instant', () => {
    expect(apiKeyStatus({ revokedAt: null, expiresAt: iso('2026-10-11T12:00:00.000Z') }, NOW)).toBe(
      'expired',
    );
    expect(apiKeyStatus({ revokedAt: null, expiresAt: new Date('2026-01-01') }, NOW)).toBe(
      'expired',
    );
  });

  it('is revoked once revokedAt is set, even if it has also expired', () => {
    expect(apiKeyStatus({ revokedAt: iso('2026-10-01T00:00:00.000Z'), expiresAt: null }, NOW)).toBe(
      'revoked',
    );
    expect(
      apiKeyStatus(
        { revokedAt: iso('2026-10-01T00:00:00.000Z'), expiresAt: iso('2026-09-01T00:00:00.000Z') },
        NOW,
      ),
    ).toBe('revoked');
  });

  it('ignores unparseable dates rather than locking a key out', () => {
    expect(apiKeyStatus({ revokedAt: iso('nope'), expiresAt: iso('nope') }, NOW)).toBe('active');
  });

  it('has a label for every status', () => {
    expect(API_KEY_STATUS.active.label).toBe('Active');
    expect(API_KEY_STATUS.revoked.label).toBe('Revoked');
    expect(API_KEY_STATUS.expired.label).toBe('Expired');
  });
});

describe('key dates', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['garbage', 'not a date'],
  ])('treats %s as missing', (_name, value) => {
    expect(formatKeyDate(value)).toBe('—');
    expect(lastUsedLabel(value)).toBe('Never');
  });

  it('formats an ISO string from the API', () => {
    const label = formatKeyDate('2026-10-10T09:30:00.000Z');
    expect(label).toContain('2026');
    expect(lastUsedLabel('2026-10-10T09:30:00.000Z')).toBe(label);
  });
});

describe('validateKeyName', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])('rejects an %s name', (_name, value) => {
    expect(validateKeyName(value)).toBe('Give the key a name.');
  });

  it('accepts a name at the limit and rejects one past it', () => {
    expect(validateKeyName('a'.repeat(KEY_NAME_MAX))).toBeNull();
    expect(validateKeyName('a'.repeat(KEY_NAME_MAX + 1))).toContain(String(KEY_NAME_MAX));
  });

  it('measures the trimmed name, since that is what gets sent', () => {
    expect(validateKeyName(`  ${'a'.repeat(KEY_NAME_MAX)}  `)).toBeNull();
    expect(validateKeyName('  antidote bot  ')).toBeNull();
  });
});

describe('snippets', () => {
  it('builds the MCP endpoint from the origin', () => {
    expect(mcpUrl('https://social.example.com')).toBe('https://social.example.com/mcp');
    expect(mcpUrl('https://social.example.com/')).toBe('https://social.example.com/mcp');
  });

  it('builds a curl call against /v1/posts with a Bearer header', () => {
    expect(curlSnippet('http://localhost:5174')).toBe(
      `curl http://localhost:5174/v1/posts \\\n  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
    );
  });

  it('uses the placeholder unless a key is passed', () => {
    expect(curlSnippet('https://x.test')).toContain(`Bearer ${KEY_PLACEHOLDER}`);
    expect(curlSnippet('https://x.test', 'sk_live_abc')).toContain('Bearer sk_live_abc');
  });
});
