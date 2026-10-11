import type { ApiKeyView } from '@meegrow-social/contracts';

/** The API client returns JSON as-is, so dates arrive as ISO strings despite the contract's Date type. */
type DateValue = Date | string | number | null | undefined;

function parseDate(value: DateValue): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

/**
 * What a key can do right now. Revoked wins over expired: revoking is the deliberate act, and it is
 * what the operator needs to see on a key that was killed and has since also lapsed.
 */
export function apiKeyStatus(
  key: Pick<ApiKeyView, 'revokedAt' | 'expiresAt'>,
  now: Date = new Date(),
): ApiKeyStatus {
  if (parseDate(key.revokedAt)) return 'revoked';
  const expires = parseDate(key.expiresAt);
  if (expires && expires.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** Badge label + colour per key status. */
export const API_KEY_STATUS: Record<
  ApiKeyStatus,
  { label: string; variant: 'neutral' | 'success' | 'warning' }
> = {
  active: { label: 'Active', variant: 'success' },
  revoked: { label: 'Revoked', variant: 'neutral' },
  expired: { label: 'Expired', variant: 'warning' },
};

/** Calendar date for the list, e.g. "11 Oct 2026"; "—" when missing or unparseable. */
export function formatKeyDate(value: DateValue): string {
  return (
    parseDate(value)?.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }) ?? '—'
  );
}

/** A key that has never authenticated a request has no last-used date — say so rather than "—". */
export function lastUsedLabel(value: DateValue): string {
  return parseDate(value) ? formatKeyDate(value) : 'Never';
}

export const KEY_NAME_MAX = 100;

/** Mirrors `createApiKeyInput` (1–100 chars) on the trimmed name. Returns the problem, or null. */
export function validateKeyName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the key a name.';
  if (trimmed.length > KEY_NAME_MAX) return `Keep the name to ${KEY_NAME_MAX} characters or fewer.`;
  return null;
}

/** Stands in for the secret in every example — the real one is only ever shown at creation. */
export const KEY_PLACEHOLDER = 'YOUR_API_KEY';

const trimOrigin = (origin: string) => origin.replace(/\/+$/, '');

export function mcpUrl(origin: string): string {
  return `${trimOrigin(origin)}/mcp`;
}

/** A first REST call: list this client's posts. */
export function curlSnippet(origin: string, key: string = KEY_PLACEHOLDER): string {
  return `curl ${trimOrigin(origin)}/v1/posts \\\n  -H "Authorization: Bearer ${key}"`;
}
