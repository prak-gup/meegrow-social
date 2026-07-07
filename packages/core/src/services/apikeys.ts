import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'sk_live_';

export interface GeneratedKey {
  /** Full secret — shown to the user exactly once, never stored. */
  secret: string;
  /** Stored for display, e.g. sk_live_abcd…. */
  prefix: string;
  /** SHA-256 of the full secret — what we persist and compare against. */
  hash: string;
}

export function hashKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateApiKey(): GeneratedKey {
  const body = randomBytes(24).toString('base64url');
  const secret = `${PREFIX}${body}`;
  return { secret, prefix: `${PREFIX}${body.slice(0, 6)}…`, hash: hashKey(secret) };
}
