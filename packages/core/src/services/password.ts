import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

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
