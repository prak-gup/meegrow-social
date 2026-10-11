/**
 * Pure change-password logic: field validation and the copy for a failed request. Kept out of the
 * page so it is unit-testable in node (apps/web vitest has no DOM).
 *
 * The limits mirror `changePasswordInput` in contracts — password.test.ts fails if they drift. The
 * server enforces the same policy; this only saves a round trip.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
/** Ceiling on the current password: looser, because existing passwords were never length-checked. */
export const CURRENT_PASSWORD_MAX = 1024;

export interface PasswordForm {
  current: string;
  next: string;
  confirm: string;
}
export type PasswordField = keyof PasswordForm;
export type PasswordErrors = Partial<Record<PasswordField, string>>;

export const EMPTY_PASSWORD_FORM: PasswordForm = { current: '', next: '', confirm: '' };

export const PASSWORD_HINT = `At least ${PASSWORD_MIN} characters. A long phrase works well.`;

/**
 * One problem per field at most, or none. Passwords are compared exactly as typed — never trimmed,
 * since a leading or trailing space is a legitimate part of one.
 */
export function validatePasswordForm({ current, next, confirm }: PasswordForm): PasswordErrors {
  const errors: PasswordErrors = {};

  if (!current) errors.current = 'Enter your current password.';
  else if (current.length > CURRENT_PASSWORD_MAX) {
    errors.current = 'That is longer than any password this account could have.';
  }

  if (!next) errors.next = 'Enter a new password.';
  else if (next.length < PASSWORD_MIN) errors.next = `Use at least ${PASSWORD_MIN} characters.`;
  else if (next.length > PASSWORD_MAX) {
    errors.next = `Keep it to ${PASSWORD_MAX} characters or fewer.`;
  } else if (next === current) {
    errors.next = 'Choose a password different from your current one.';
  }

  if (!confirm) errors.confirm = 'Enter the new password again.';
  else if (confirm !== next) errors.confirm = 'The two new passwords do not match.';

  return errors;
}

export function hasErrors(errors: PasswordErrors): boolean {
  return Object.keys(errors).length > 0;
}

export interface ChangePasswordFailure {
  /** Set when the problem belongs to one field; otherwise it is shown above the submit button. */
  field?: PasswordField;
  message: string;
}

/**
 * What to tell the user when POST /v1/auth/password fails, from the HTTP status (`null` when the
 * request never got a response). The server's own text is not shown: its 400 body is a zod object,
 * not a sentence, and the rest read better in the page's voice.
 */
export function changePasswordFailure(status: number | null): ChangePasswordFailure {
  switch (status) {
    case 422:
      return { field: 'current', message: 'That is not your current password.' };
    case 400:
      return {
        field: 'next',
        message: `The server did not accept that password. It needs ${PASSWORD_MIN} to ${PASSWORD_MAX} characters and must differ from your current one.`,
      };
    case 401:
      return { message: 'Your session has ended. Sign in again, then change your password.' };
    case null:
      return { message: 'Could not reach the server. Check your connection and try again.' };
    default:
      return { message: 'Could not change your password. Nothing was changed — try again.' };
  }
}
