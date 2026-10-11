import { beforeAll, describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, signConnectFlow, verifyConnectFlowProof } from './crypto.js';

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

describe('connect-flow proof', () => {
  const FLOW = '0b6f1c1e-6f0a-4e0e-9a51-0d6c6f2f8a11';
  const OTHER = '7f0c2f0e-93a4-4d7b-8a0c-5b1d3c9e2f44';

  it('verifies the proof minted for that flow, deterministically', () => {
    const proof = signConnectFlow(FLOW);
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signConnectFlow(FLOW)).toBe(proof);
    expect(verifyConnectFlowProof(FLOW, proof)).toBe(true);
  });

  it("rejects another flow's proof — knowing one flow id proves nothing about a second", () => {
    expect(verifyConnectFlowProof(OTHER, signConnectFlow(FLOW))).toBe(false);
  });

  it('rejects a missing, empty, truncated or altered proof', () => {
    const proof = signConnectFlow(FLOW);
    const altered = `${proof.startsWith('A') ? 'B' : 'A'}${proof.slice(1)}`;
    for (const bad of [undefined, null, '', proof.slice(0, -1), `${proof}A`, altered, FLOW]) {
      expect(verifyConnectFlowProof(FLOW, bad)).toBe(false);
    }
    expect(verifyConnectFlowProof('', proof)).toBe(false);
  });

  it('cannot be minted without the server secret', () => {
    const proof = signConnectFlow(FLOW);
    process.env.TOKEN_ENCRYPTION_KEY = 'a-different-secret';
    try {
      expect(verifyConnectFlowProof(FLOW, proof)).toBe(false);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = 'unit-test-key-please-change';
    }
  });
});
