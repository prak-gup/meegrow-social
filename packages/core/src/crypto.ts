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

/** MAC key for sealed callback outcomes — its own label, for the reason `flowProofKey` has one. */
function outcomeKey(): Buffer {
  return createHmac('sha256', key()).update('meegrow-social/connect-outcome/v1').digest();
}

/**
 * Seal for the result of a connect callback that is reported by redirect (see
 * `sealCallbackOutcome` in services/connections.ts). The result page is public and reads its
 * result from the URL, so without this anyone could write a link that makes this app say
 * "Connected".
 */
export function signConnectOutcome(outcome: string): string {
  return createHmac('sha256', outcomeKey()).update(outcome).digest('base64url');
}

/** Constant-time check of a seal from `signConnectOutcome`. */
export function verifyConnectOutcome(outcome: string, seal: unknown): boolean {
  if (typeof seal !== 'string' || seal === '') return false;
  const expected = Buffer.from(signConnectOutcome(outcome));
  const given = Buffer.from(seal);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** MAC key for site-check tickets — its own label, for the reason `flowProofKey` has one. */
function siteCheckKey(): Buffer {
  return createHmac('sha256', key()).update('meegrow-social/site-check/v1').digest();
}

/**
 * Seal what a site check established (see `checkConnectSite` in services/connections.ts) so the
 * browser can carry it to the next request without being able to change it. The payload is
 * readable — it holds nothing secret — but only this server can produce a ticket that opens.
 */
export function sealSiteCheck(payload: string): string {
  const body = Buffer.from(payload, 'utf8').toString('base64url');
  return `${body}.${createHmac('sha256', siteCheckKey()).update(body).digest('base64url')}`;
}

/** The payload of a ticket from `sealSiteCheck`, or null for anything this server did not seal. */
export function openSiteCheck(ticket: unknown): string | null {
  if (typeof ticket !== 'string') return null;
  const [body, seal, ...rest] = ticket.split('.');
  if (!body || !seal || rest.length > 0) return null;
  const expected = Buffer.from(
    createHmac('sha256', siteCheckKey()).update(body).digest('base64url'),
  );
  const given = Buffer.from(seal);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return Buffer.from(body, 'base64url').toString('utf8');
}
