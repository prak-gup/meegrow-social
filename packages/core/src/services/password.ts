import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@meegrow-social/contracts';

/**
 * Password hashing for human auth (issue #10). Uses argon2id — `@node-rs/argon2`'s default variant
 * (the produced hash is prefixed `$argon2id$`, asserted in password.test.ts) — with Lucia's
 * recommended memory/time cost. `verify` is constant-time. Fail closed on a malformed hash (returns
 * false rather than throwing) so a corrupt row never becomes a 500.
 *
 * (`algorithm` is left at the default rather than passing the `Algorithm` const enum, which the
 * repo's `verbatimModuleSyntax` TS flag forbids referencing by value.)
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hashed, password);
  } catch {
    return false;
  }
}

/**
 * Policy for a password a user sets: length only (contracts' PASSWORD_MIN_LENGTH..MAX_LENGTH).
 * Returns which bound is broken, or null. The ceiling is what bounds argon2id's input — the library
 * itself accepts inputs of any practical size, so without it one request could buy a large hash.
 */
export function newPasswordProblem(password: string): 'too_short' | 'too_long' | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  return null;
}
