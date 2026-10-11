import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** AES-256-GCM token-at-rest encryption. Key derived from TOKEN_ENCRYPTION_KEY (any length). */
function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  return createHash('sha256').update(raw).digest();
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptToken(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * MAC key for connect-flow proofs. Derived from the encryption key under its own label, so the same
 * secret is never used directly for both AES-GCM and HMAC.
 */
function flowProofKey(): Buffer {
  return createHmac('sha256', key()).update('meegrow-social/connect-flow-proof/v1').digest();
}

/**
 * Proof that a browser started a given connect flow. The public invite path has no session, and the
 * flow id alone is not a credential — it is the OAuth `state`, so it travels through the platform
 * and sits in the address bar. The server hands this MAC to the starting browser (HttpOnly cookie)
 * and requires it back on the unauthenticated account-pick step; nobody else can mint one.
 */
export function signConnectFlow(flowId: string): string {
  return createHmac('sha256', flowProofKey()).update(flowId).digest('base64url');
}

/** Constant-time check of a proof from `signConnectFlow`. False for a missing or malformed one. */
export function verifyConnectFlowProof(flowId: string, proof: string | undefined | null): boolean {
  if (!flowId || !proof) return false;
  const expected = Buffer.from(signConnectFlow(flowId));
  const given = Buffer.from(proof);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
