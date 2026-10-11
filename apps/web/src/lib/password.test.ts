import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_VERIFY_MAX_LENGTH,
  changePasswordInput,
} from '@meegrow-social/contracts';
import {
  CURRENT_PASSWORD_MAX,
  EMPTY_PASSWORD_FORM,
  PASSWORD_HINT,
  PASSWORD_MAX,
  PASSWORD_MIN,
  changePasswordFailure,
  hasErrors,
  validatePasswordForm,
  type PasswordForm,
} from './password';

const CURRENT = 'current-password-1';
const NEXT = 'a-brand-new-password';
const form = (over: Partial<PasswordForm> = {}): PasswordForm => ({
  current: CURRENT,
  next: NEXT,
  confirm: NEXT,
  ...over,
});

describe('policy limits', () => {
  it('mirror the server contract exactly', () => {
    expect(PASSWORD_MIN).toBe(PASSWORD_MIN_LENGTH);
    expect(PASSWORD_MAX).toBe(PASSWORD_MAX_LENGTH);
    expect(CURRENT_PASSWORD_MAX).toBe(PASSWORD_VERIFY_MAX_LENGTH);
  });

  it('are stated in the hint', () => {
    expect(PASSWORD_HINT).toContain(String(PASSWORD_MIN));
  });
});

describe('validatePasswordForm', () => {
  it('passes a complete, valid form', () => {
    expect(validatePasswordForm(form())).toEqual({});
    expect(hasErrors(validatePasswordForm(form()))).toBe(false);
  });

  it('asks for every field on an empty form', () => {
    const errors = validatePasswordForm(EMPTY_PASSWORD_FORM);
    expect(Object.keys(errors).sort()).toEqual(['confirm', 'current', 'next']);
    expect(hasErrors(errors)).toBe(true);
  });

  it('enforces the minimum length at the boundary', () => {
    const short = 'x'.repeat(PASSWORD_MIN - 1);
    expect(validatePasswordForm(form({ next: short, confirm: short })).next).toMatch(/at least 12/);
    const ok = 'x'.repeat(PASSWORD_MIN);
    expect(validatePasswordForm(form({ next: ok, confirm: ok }))).toEqual({});
  });

  it('enforces the maximum length at the boundary', () => {
    const long = 'x'.repeat(PASSWORD_MAX + 1);
    expect(validatePasswordForm(form({ next: long, confirm: long })).next).toMatch(/128/);
    const ok = 'x'.repeat(PASSWORD_MAX);
    expect(validatePasswordForm(form({ next: ok, confirm: ok }))).toEqual({});
  });

  it('rejects a new password equal to the current one', () => {
    const errors = validatePasswordForm(form({ next: CURRENT, confirm: CURRENT }));
    expect(errors.next).toMatch(/different/);
    expect(errors.confirm).toBeUndefined();
  });

  it('flags a confirmation that does not match, on the confirm field only', () => {
    const errors = validatePasswordForm(form({ confirm: `${NEXT}!` }));
    expect(errors).toEqual({ confirm: 'The two new passwords do not match.' });
  });

  it('does not trim: whitespace counts toward length and toward matching', () => {
    const padded = `  ${'x'.repeat(PASSWORD_MIN - 2)}`; // 12 with the two spaces
    expect(validatePasswordForm(form({ next: padded, confirm: padded }))).toEqual({});
    expect(
      validatePasswordForm(form({ next: padded, confirm: padded.trim() })).confirm,
    ).toBeDefined();
  });

  it('holds the current password only to its own, looser ceiling', () => {
    expect(validatePasswordForm(form({ current: 'short' })).current).toBeUndefined();
    expect(
      validatePasswordForm(form({ current: 'c'.repeat(CURRENT_PASSWORD_MAX + 1) })).current,
    ).toBeDefined();
  });

  it('never puts a password in an error message', () => {
    const errors = validatePasswordForm({ current: CURRENT, next: 'tiny-secret', confirm: 'nope' });
    const text = Object.values(errors).join(' ');
    for (const secret of [CURRENT, 'tiny-secret', 'nope']) expect(text).not.toContain(secret);
  });

  it('agrees with the server contract on which passwords are acceptable', () => {
    const cases: PasswordForm[] = [
      form(),
      form({ next: 'x'.repeat(11), confirm: 'x'.repeat(11) }),
      form({ next: 'x'.repeat(12), confirm: 'x'.repeat(12) }),
      form({ next: 'x'.repeat(128), confirm: 'x'.repeat(128) }),
      form({ next: 'x'.repeat(129), confirm: 'x'.repeat(129) }),
      form({ next: CURRENT, confirm: CURRENT }),
      form({ current: '' }),
      form({ current: 'c'.repeat(1025) }),
    ];
    for (const c of cases) {
      const server = changePasswordInput.safeParse({
        currentPassword: c.current,
        newPassword: c.next,
      }).success;
      expect(!hasErrors(validatePasswordForm(c))).toBe(server);
    }
  });
});

describe('changePasswordFailure', () => {
  it('pins a wrong current password (422) to the current field', () => {
    expect(changePasswordFailure(422)).toEqual({
      field: 'current',
      message: 'That is not your current password.',
    });
  });

  it('pins a server-side policy rejection (400) to the new-password field', () => {
    expect(changePasswordFailure(400).field).toBe('next');
  });

  it('explains an ended session, a network failure and anything else without a field', () => {
    expect(changePasswordFailure(401)).toEqual({
      message: 'Your session has ended. Sign in again, then change your password.',
    });
    expect(changePasswordFailure(null).message).toMatch(/reach the server/);
    expect(changePasswordFailure(500).field).toBeUndefined();
    expect(changePasswordFailure(403).message).toMatch(/Nothing was changed/);
  });
});
