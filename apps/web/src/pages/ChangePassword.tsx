import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  EMPTY_PASSWORD_FORM,
  PASSWORD_HINT,
  changePasswordFailure,
  hasErrors,
  validatePasswordForm,
  type ChangePasswordFailure,
  type PasswordField,
  type PasswordForm,
} from '../lib/password';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Label } from '../components/ui/Label';
import { PageHeader } from '../components/ui/PageHeader';
import { CheckCircle, Eye, EyeSlash } from '../lib/icons';

const FIELDS: PasswordField[] = ['current', 'next', 'confirm'];

/**
 * Change your own password. The three values live only in this component's state: never logged,
 * never persisted, wiped on success, and gone with the component when the page unmounts.
 */
export function ChangePassword() {
  const { me } = useAuth();
  const [form, setForm] = useState<PasswordForm>(EMPTY_PASSWORD_FORM);
  const [touched, setTouched] = useState<Partial<Record<PasswordField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ChangePasswordFailure | null>(null);
  const [reveal, setReveal] = useState(false);
  const [done, setDone] = useState(false);

  const refs: Record<PasswordField, RefObject<HTMLInputElement>> = {
    current: useRef<HTMLInputElement>(null),
    next: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };
  const doneRef = useRef<HTMLHeadingElement>(null);

  // The form (and its focused button) is replaced by the confirmation — move focus with it.
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const problems = validatePasswordForm(form);
  // A field's own problem shows once it has been left or a submit was tried; a problem the server
  // reported for that field shows until the user edits anything.
  const errorFor = (field: PasswordField): string | undefined => {
    const local = submitted || touched[field] ? problems[field] : undefined;
    return local ?? (failure?.field === field ? failure.message : undefined);
  };

  const set = (field: PasswordField, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setFailure(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setFailure(null);
    if (hasErrors(problems)) {
      const first = FIELDS.find((f) => problems[f]);
      if (first) refs[first].current?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(form.current, form.next);
      setForm(EMPTY_PASSWORD_FORM);
      setReveal(false);
      setDone(true);
    } catch (err) {
      const next = changePasswordFailure(err instanceof ApiError ? err.status : null);
      setFailure(next);
      if (next.field) refs[next.field].current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setTouched({});
    setSubmitted(false);
    setFailure(null);
    setDone(false);
  };

  if (done) {
    return (
      <div className="max-w-lg">
        <PageHeader title="Change password" />
        <Card>
          <CardContent className="pt-6">
            <div className="flex gap-3" role="status">
              <CheckCircle
                size={24}
                weight="fill"
                className="mt-0.5 flex-none text-status-ok"
                aria-hidden="true"
              />
              <div>
                <h2
                  ref={doneRef}
                  tabIndex={-1}
                  className="text-base font-semibold text-ink focus:outline-none"
                >
                  Password changed
                </h2>
                <p className="mt-1 text-sm text-muted">
                  You are still signed in here. Every other device and browser has been signed out
                  and will need the new password.
                </p>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={reset}>
                Change it again
              </Button>
              <Button asChild>
                <Link to="/overview">Back to overview</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const field = (
    name: PasswordField,
    label: string,
    autoComplete: 'current-password' | 'new-password',
    hint?: string,
  ) => {
    const error = errorFor(name);
    const id = `password-${name}`;
    const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          ref={refs[name]}
          name={name === 'current' ? 'current-password' : 'new-password'}
          type={reveal ? 'text' : 'password'}
          value={form[name]}
          onChange={(e) => set(name, e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, [name]: true }))}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          readOnly={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        {error ? (
          <p id={`${id}-error`} role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : (
          hint && (
            <p id={`${id}-hint`} className="text-sm text-muted">
              {hint}
            </p>
          )
        )}
      </div>
    );
  };

  return (
    <div className="max-w-lg">
      <PageHeader
        title="Change password"
        subtitle={me ? `For ${me.user.email}.` : undefined}
        className="mb-6"
      />
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
            {/* Lets a password manager tie the new password to the right account. */}
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={me?.user.email ?? ''}
              readOnly
              hidden
            />
            {field('current', 'Current password', 'current-password')}
            {field('next', 'New password', 'new-password', PASSWORD_HINT)}
            {field('confirm', 'Confirm new password', 'new-password')}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-3"
              aria-pressed={reveal}
              onClick={() => setReveal((r) => !r)}
            >
              {reveal ? <EyeSlash size={16} /> : <Eye size={16} />}
              Show passwords
            </Button>

            <p className="rounded-sm border border-hairline bg-surface-soft px-3.5 py-3 text-sm text-ink">
              Changing your password signs you out on every other device and browser. You stay
              signed in here.
            </p>

            {failure && !failure.field && (
              <p role="alert" className="text-sm text-error">
                {failure.message}
              </p>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={busy}>
                {busy ? 'Changing…' : 'Change password'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
