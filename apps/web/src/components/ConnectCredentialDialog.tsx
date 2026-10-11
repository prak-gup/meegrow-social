import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ProviderView } from '@meegrow-social/contracts';
import { ApiError, api } from '../lib/api';
import {
  connectFailure,
  credentialFields,
  credentialProblems,
  type CredentialGuide,
} from '../lib/credentialConnect';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import { Modal } from './ui/Modal';
import { ArrowSquareOut, WarningCircle } from '../lib/icons';

/**
 * Connecting a platform that issues a credential to paste: where to get it, the form, and one
 * request that verifies it and stores it. Driven entirely by the provider's `CredentialGuide`
 * (lib/credentialConnect) — a new platform of this kind adds a guide, not a dialog.
 *
 * What is typed here is a secret. It lives in this component's state until the request is made
 * and is dropped with the dialog; it is never put in the page's message, the URL or storage.
 */
export function ConnectCredentialDialog({
  provider,
  guide,
  clientName,
  reconnecting,
  onConnected,
  onClose,
}: {
  provider: ProviderView;
  guide: CredentialGuide;
  clientName: string;
  /** The connection being reconnected, when there is one. */
  reconnecting?: { displayName: string; externalId: string };
  onConnected: (result: { displayName: string; reconnected: boolean }) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    reconnecting && guide.prefill ? guide.prefill(reconnecting) : {},
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const baseId = useId();
  const failureId = `${baseId}-failure`;
  const formRef = useRef<HTMLFormElement>(null);
  const failureRef = useRef<HTMLParagraphElement>(null);

  // On a phone the guide fills the screen, so what went wrong must be brought to the person:
  // the platform's refusal is scrolled into view, and a field problem takes the focus.
  useEffect(() => {
    if (failure) failureRef.current?.scrollIntoView({ block: 'nearest' });
  }, [failure]);

  // Escape and the backdrop must not dismiss mid-request (same pattern as ConnectSiteDialog).
  const inFlight = useRef(false);
  const guardedClose = useCallback(() => {
    if (!inFlight.current) onClose();
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    const found = credentialProblems(guide, values);
    setProblems(found);
    setFailure(null);
    if (Object.keys(found).length > 0) {
      const first = guide.fields.find((f) => found[f.name]);
      formRef.current?.querySelector<HTMLInputElement>(`[name="${first?.name}"]`)?.focus();
      return;
    }
    inFlight.current = true;
    setChecking(true);
    try {
      const result = await api.connectCredentials(
        provider.identifier,
        credentialFields(guide, values),
      );
      onConnected(result);
    } catch (err) {
      setFailure(
        connectFailure(
          err instanceof ApiError ? err.status : undefined,
          err instanceof Error ? err.message : '',
        ),
      );
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  };

  return (
    <Modal title={guide.title} onClose={guardedClose}>
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="space-y-3">
        <div className="rounded-sm border border-hairline bg-surface-soft px-3 py-2.5">
          <p className="text-sm font-medium text-ink">Where to get this</p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-body-ink">
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <a
            href={guide.link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-ink underline md:min-h-0"
          >
            {guide.link.label}
            <ArrowSquareOut size={14} aria-hidden="true" />
          </a>
        </div>

        {guide.fields.map((f) => {
          const id = `${baseId}-${f.name}`;
          const problem = problems[f.name];
          return (
            <div key={f.name} className="space-y-1.5">
              <Label htmlFor={id}>{f.label}</Label>
              <Input
                id={id}
                name={f.name}
                type={f.secret ? 'password' : 'text'}
                // A pasted token is not a login: keep browsers and password managers out of it.
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={f.placeholder}
                value={values[f.name] ?? ''}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [f.name]: e.target.value }));
                  setProblems(({ [f.name]: _cleared, ...rest }) => rest);
                }}
                disabled={checking}
                aria-invalid={Boolean(problem)}
                aria-describedby={problem ? `${id}-hint ${id}-error` : `${id}-hint`}
              />
              <p id={`${id}-hint`} className="text-caption text-muted">
                {f.hint}
              </p>
              {problem && (
                <p
                  id={`${id}-error`}
                  role="alert"
                  className="flex items-start gap-1.5 text-caption text-error"
                >
                  <WarningCircle size={16} className="mt-0.5 flex-none" aria-hidden="true" />
                  <span>{problem}</span>
                </p>
              )}
            </div>
          );
        })}

        {guide.limits.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-caption text-body-ink">
            {guide.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        )}
        <p className="text-caption text-muted">{guide.keeping}</p>

        {failure && (
          <p
            ref={failureRef}
            id={failureId}
            role="alert"
            className="flex items-start gap-1.5 rounded-sm border border-hairline bg-surface-soft px-3 py-2 text-sm text-error"
          >
            <WarningCircle size={16} className="mt-0.5 flex-none" aria-hidden="true" />
            <span className="min-w-0 break-words">{failure}</span>
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={guardedClose} disabled={checking}>
            Cancel
          </Button>
          <Button type="submit" disabled={checking}>
            {checking ? 'Checking…' : reconnecting ? 'Reconnect' : `Connect for ${clientName}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
