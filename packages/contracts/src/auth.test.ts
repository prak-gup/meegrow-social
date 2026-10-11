import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_VERIFY_MAX_LENGTH,
  changePasswordInput,
} from './auth.js';

const current = 'old-password';
const parse = (newPassword: string, currentPassword = current) =>
  changePasswordInput.safeParse({ currentPassword, newPassword });

describe('changePasswordInput', () => {
  it('accepts a new password at the minimum and at the maximum length', () => {
    expect(parse('n'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(parse('n'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
  });

  it('rejects a new password one short of the minimum or one over the maximum', () => {
    expect(parse('n'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(parse('n'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('rejects a new password equal to the current one, on the newPassword field', () => {
    const same = 'same-password-123';
    const res = parse(same, same);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.flatten().fieldErrors.newPassword).toBeDefined();
  });

  it('does not trim: surrounding spaces are part of the password', () => {
    const res = parse('  padded pass  ');
    expect(res.success && res.data.newPassword).toBe('  padded pass  ');
  });

  it('requires a current password and bounds it, but not by the new-password policy', () => {
    expect(parse('a-new-password-1', '').success).toBe(false);
    // A short legacy password must still be accepted as the *current* one.
    expect(parse('a-new-password-1', 'short').success).toBe(true);
    expect(parse('a-new-password-1', 'c'.repeat(PASSWORD_VERIFY_MAX_LENGTH)).success).toBe(true);
    expect(parse('a-new-password-1', 'c'.repeat(PASSWORD_VERIFY_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it('never echoes a submitted password back in its error', () => {
    const secret = 'short-pw';
    const res = parse(secret, 'another-secret');
    expect(res.success).toBe(false);
    if (!res.success) {
      const flat = JSON.stringify(res.error.flatten());
      expect(flat).not.toContain(secret);
      expect(flat).not.toContain('another-secret');
    }
  });
});
