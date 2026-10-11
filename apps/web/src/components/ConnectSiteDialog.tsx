import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  ConnectMethod,
  PasswordConnectResult,
  ProviderView,
  SiteCheck,
} from '@meegrow-social/contracts';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { PRODUCT_NAME, platformMeta } from '../lib/platforms';
import {
  defaultConnectMethod,
  methodGuidance,
  separateAddressesNote,
  siteAddressProblem,
  siteLoginProblems,
} from '../lib/wordpress';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import { Modal } from './ui/Modal';
import { ArrowSquareOut, Eye, EyeSlash, LockKey, WarningCircle } from '../lib/icons';

/**
 * Connecting a platform that has no login of its own to send people to — a WordPress site — starts
 * with its address. The dialog asks for it, has the server look at the site, and then offers the
 * ways that site can actually be connected:
 *
 *  - Approve on the site (recommended). The site's own approval screen opens in a popup and
 *    WordPress issues a separate password for this app. No password is typed here.
 *  - Use a username and password. For sites where the first is switched off (the host or a
 *    security plugin disables Application Passwords). This one DOES store a WordPress login
 *    password, and the form says so before anything can be typed.
 *
 * A site that cannot be approved is never a dead end: the reason is shown and the other method is
 * selected. Whatever the server learned about where a login would be sent is shown too, because
 * that is the address the password goes to.
 *
 * The popup is opened in the click itself (a window opened after an `await` is what popup blockers
 * block) and pointed at the site once the server has checked the address. If it was blocked anyway
 * the dialog offers the same destination as a link.
 */
export function ConnectSiteDialog({
  provider,
  clientName,
  initialAddress = '',
  onStarted,
  onConnected,
  onClose,
}: {
  provider: ProviderView;
  clientName: string;
  /** The address of the connection being reconnected, when there is one. */
  initialAddress?: string;
  /** The approval screen is open in a popup; the page should now wait for its result. */
  onStarted: () => void;
  /** The site was connected with a username and password, here, without leaving the dialog. */
  onConnected: (connection: PasswordConnectResult) => void;
  onClose: () => void;
}) {
  const label = platformMeta(provider).label;
  const [address, setAddress] = useState(initialAddress);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the server found at the address; null until it has looked. */
  const [check, setCheck] = useState<SiteCheck | null>(null);
  const [method, setMethod] = useState<ConnectMethod | null>(null);
  /** Set when the popup was blocked: where the person has to go themselves. */
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const errorId = useId();
  const hintId = useId();
  const addressRef = useRef<HTMLInputElement>(null);
  const methodsRef = useRef<HTMLFieldSetElement>(null);

  // The dialog swaps its whole content between the two steps, which would drop focus on the
  // floor. Put it where the next action is: the address, or the method that is selected.
  const checked = check !== null;
  useEffect(() => {
    if (checked) methodsRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
    else addressRef.current?.focus();
  }, [checked]);

  // Escape and the backdrop must not dismiss mid-request (same pattern as EditCaptionModal).
  const inFlight = useRef(false);
  const guardedClose = useCallback(() => {
    if (!inFlight.current) onClose();
  }, [onClose]);

  /** Run one request at a time, with the dialog locked while it is out. */
  const guarded = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const checkSite = async (e: FormEvent) => {
    e.preventDefault();
    const typed = siteAddressProblem(address);
    if (typed) {
      setProblem(typed);
      return;
    }
    await guarded(async () => {
      try {
        const found = await api.checkSite(provider.identifier, address.trim());
        setCheck(found);
        setMethod(defaultConnectMethod(found));
      } catch (err) {
        setProblem(err instanceof Error ? err.message : 'Could not check the site.');
      }
    });
  };

  const startApproval = async () => {
    if (inFlight.current) return;
    setBlockedUrl(null);
    const popup = window.open('', '_blank', 'width=600,height=720');
    if (popup) {
      popup.document.title = `Connecting ${label}`;
      popup.document.body.textContent = 'Opening the site…';
    }
    await guarded(async () => {
      try {
        const { url } = await api.startConnect(provider.identifier, { siteUrl: address.trim() });
        if (popup && !popup.closed) {
          popup.location.href = url;
          onStarted();
        } else {
          setBlockedUrl(url);
        }
      } catch (err) {
        popup?.close();
        setProblem(err instanceof Error ? err.message : 'Could not open the site.');
      }
    });
  };

  const startOver = () => {
    setCheck(null);
    setMethod(null);
    setProblem(null);
    setBlockedUrl(null);
  };

  if (!check) {
    return (
      <Modal title={`Connect a ${label} site`} onClose={guardedClose}>
        <form onSubmit={(e) => void checkSite(e)} noValidate className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="site-address">Site address</Label>
            <Input
              id="site-address"
              ref={addressRef}
              type="url"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://example.com"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setProblem(null);
              }}
              disabled={busy}
              aria-invalid={Boolean(problem)}
              aria-describedby={problem ? `${hintId} ${errorId}` : hintId}
            />
            <p id={hintId} className="text-caption text-muted">
              The site’s public address or its admin address. It must use https.
            </p>
            {problem && <Problem id={errorId}>{problem}</Problem>}
          </div>
          <p className="text-sm text-body-ink">
            We look at the site first — without logging in — to see how it can be connected for{' '}
            {clientName}.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={guardedClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Checking the site…' : 'Check the site'}
            </Button>
          </div>
        </form>
      </Modal>
    );
  }

  const guidance = methodGuidance(check);
  const twoAddresses = separateAddressesNote(check);

  return (
    <Modal title={`Connect a ${label} site`} onClose={guardedClose}>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3 rounded-sm border border-hairline bg-surface-soft px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">
              {check.name ?? 'WordPress site'}
            </p>
            <p className="break-all text-caption text-muted">{check.entered}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="flex-none"
            onClick={startOver}
            disabled={busy}
          >
            Change
          </Button>
        </div>
        {twoAddresses && <p className="break-words text-caption text-muted">{twoAddresses}</p>}

        {guidance && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-sm border border-status-warn/40 bg-status-warn/10 px-3 py-2"
          >
            <WarningCircle
              size={16}
              className="mt-0.5 flex-none text-status-warn"
              aria-hidden="true"
            />
            <div className="text-sm">
              <p className="font-medium text-ink">{guidance.title}</p>
              <p className="text-body-ink">{guidance.detail}</p>
            </div>
          </div>
        )}

        <fieldset ref={methodsRef} disabled={busy} className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">How to connect</legend>
          <MethodOption
            value="approval"
            selected={method}
            onSelect={setMethod}
            title="Approve on the site"
            badge="Recommended"
            unavailable={check.approval.available ? null : check.approval.message}
          >
            WordPress makes a separate password just for this app. No password is typed here.
          </MethodOption>
          <MethodOption
            value="password"
            selected={method}
            onSelect={setMethod}
            title="Use a username and password"
            unavailable={check.password.available ? null : check.password.message}
          >
            For sites where approval is switched off. A WordPress login password is stored here,
            encrypted.
          </MethodOption>
        </fieldset>

        {method === 'approval' && check.approval.available && (
          <>
            <div className="rounded-sm border border-hairline bg-surface-soft px-3 py-2.5">
              <p className="text-sm font-medium text-ink">What happens next</p>
              <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-body-ink">
                <li>The site’s own WordPress login opens in a new window.</li>
                <li>
                  Log in there as someone who can publish posts (an Author, Editor or Administrator)
                  and approve “{PRODUCT_NAME}”.
                </li>
                <li>
                  WordPress makes a separate password just for this app and the site is connected
                  for {clientName}.
                </li>
              </ol>
              <p className="mt-2 text-caption text-muted">
                Your WordPress password is never entered here. Access can be removed at any time
                from the site: Users → Profile → Application Passwords.
              </p>
            </div>
            {problem && <Problem>{problem}</Problem>}
            {blockedUrl && (
              <p role="status" className="text-sm text-body-ink">
                Your browser blocked the new window.{' '}
                <a
                  href={blockedUrl}
                  target="_blank"
                  rel="opener"
                  onClick={onStarted}
                  className="inline-flex items-center gap-1 font-medium text-ink underline"
                >
                  Open the site’s approval page
                  <ArrowSquareOut size={14} aria-hidden="true" />
                </a>
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={guardedClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void startApproval()} disabled={busy}>
                {busy ? 'Opening the site…' : `Continue to ${label}`}
              </Button>
            </div>
          </>
        )}

        {method === 'password' && check.password.available && check.ticket && (
          <SiteLoginForm
            provider={provider.identifier}
            ticket={check.ticket}
            endpoint={check.password.endpoint}
            clientName={clientName}
            busy={busy}
            guarded={guarded}
            onExpired={() => {
              startOver();
              setProblem('That check of the site is no longer valid. Check the site again.');
            }}
            onConnected={onConnected}
            onCancel={guardedClose}
          />
        )}

        {method === null && (
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={guardedClose}>
              Close
            </Button>
            <Button type="button" variant="outline" onClick={startOver}>
              Try another address
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Problem({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-caption text-error">
      <WarningCircle size={16} className="mt-0.5 flex-none" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** One of the two ways in. A real radio, so arrow keys move between them; off when unavailable. */
function MethodOption({
  value,
  selected,
  onSelect,
  title,
  badge,
  unavailable,
  children,
}: {
  value: ConnectMethod;
  selected: ConnectMethod | null;
  onSelect: (method: ConnectMethod) => void;
  title: string;
  badge?: string;
  /** Why this site cannot use the method, or null when it can. */
  unavailable: string | null;
  children: ReactNode;
}) {
  const active = selected === value;
  const noteId = useId();
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 rounded-sm border px-3 py-2.5',
        unavailable !== null
          ? 'border-hairline bg-surface-soft'
          : active
            ? 'cursor-pointer border-ink bg-surface-strong'
            : 'cursor-pointer border-hairline hover:bg-surface-soft',
      )}
    >
      <input
        type="radio"
        name="connect-method"
        className="mt-0.5 flex-none accent-ink"
        checked={active}
        disabled={unavailable !== null}
        onChange={() => onSelect(value)}
        aria-describedby={noteId}
      />
      <span className="min-w-0 text-sm">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className={cn('font-medium', unavailable !== null ? 'text-muted' : 'text-ink')}>
            {title}
          </span>
          {unavailable !== null ? (
            <span className="text-caption font-medium text-status-warn">
              Not available on this site
            </span>
          ) : (
            badge && <span className="text-caption text-muted">{badge}</span>
          )}
        </span>
        <span id={noteId} className="mt-0.5 block text-caption text-body-ink">
          {unavailable ?? children}
        </span>
      </span>
    </label>
  );
}

/**
 * The username-and-password form. It says what it is before it asks for anything: this stores a
 * WordPress LOGIN password, who that login should belong to, what is done with it, and how to
 * take it back. The password lives in this component's state only until the request returns; it
 * is cleared when the site refuses it and gone when the dialog closes.
 */
function SiteLoginForm({
  provider,
  ticket,
  endpoint,
  clientName,
  busy,
  guarded,
  onExpired,
  onConnected,
  onCancel,
}: {
  provider: string;
  ticket: string;
  /** The exact address the login is sent to, as the server found it. */
  endpoint: string;
  clientName: string;
  busy: boolean;
  guarded: (work: () => Promise<void>) => Promise<void>;
  onExpired: () => void;
  onConnected: (connection: PasswordConnectResult) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [problems, setProblems] = useState<{ username?: string; password?: string }>({});
  const [refused, setRefused] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = siteLoginProblems({ username, password });
    setProblems(found);
    setRefused(null);
    if (found.username) return usernameRef.current?.focus();
    if (found.password) return passwordRef.current?.focus();
    await guarded(async () => {
      try {
        const connection = await api.connectWithPassword(provider, {
          ticket,
          username: username.trim(),
          password,
        });
        setPassword('');
        onConnected(connection);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) return onExpired();
        setRefused(err instanceof Error ? err.message : 'Could not connect the site.');
        if (err instanceof ApiError && err.status === 422) {
          // The site said no to this login: do not leave a wrong password sitting in the field.
          setPassword('');
          passwordRef.current?.focus();
        }
      }
    });
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-3" autoComplete="off">
      <div className="rounded-sm border border-hairline bg-surface-soft px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <LockKey size={16} className="flex-none" aria-hidden="true" />
          This stores a WordPress login password
        </p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-body-ink">
          <li>
            It is the real password that user signs in to WordPress with — not a separate one made
            for this app.
          </li>
          <li>
            <b className="font-semibold text-ink">Create a WordPress user just for this</b>, with
            the Editor or Author role. Never use an administrator.
          </li>
          <li>
            We check it against the site now, keep it encrypted, and use it only to publish articles
            and their featured image to this site for {clientName}. It is never shown again.
          </li>
          <li>
            To take access away: change that user’s password or delete the user in WordPress, then
            disconnect the site here.
          </li>
        </ul>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-user`}>WordPress username</Label>
        <Input
          id={`${ids}-user`}
          ref={usernameRef}
          name="wordpress-username"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setProblems((p) => ({ ...p, username: undefined }));
          }}
          readOnly={busy}
          aria-invalid={problems.username ? true : undefined}
          aria-describedby={problems.username ? `${ids}-user-error` : undefined}
        />
        {problems.username && <Problem id={`${ids}-user-error`}>{problems.username}</Problem>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-pass`}>Password</Label>
        <div className="relative">
          <Input
            id={`${ids}-pass`}
            ref={passwordRef}
            name="wordpress-password"
            type={reveal ? 'text' : 'password'}
            // A client's WordPress login is not this app's: keep the browser from filling in the
            // operator's own password here, or offering to save this one against our address.
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            className="pr-11 md:pr-9"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setProblems((p) => ({ ...p, password: undefined }));
            }}
            readOnly={busy}
            aria-invalid={problems.password ? true : undefined}
            aria-describedby={
              problems.password ? `${ids}-pass-error ${ids}-pass-hint` : `${ids}-pass-hint`
            }
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? 'Hide password' : 'Show password'}
            aria-pressed={reveal}
            className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-sm text-muted hover:text-ink md:w-8"
          >
            {reveal ? <EyeSlash size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {problems.password && <Problem id={`${ids}-pass-error`}>{problems.password}</Problem>}
        <p id={`${ids}-pass-hint`} className="break-all text-caption text-muted">
          Sent once, to <span className="text-body-ink">{endpoint}</span>
        </p>
      </div>

      {refused && <Problem>{refused}</Problem>}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Checking the login…' : 'Connect the site'}
        </Button>
      </div>
    </form>
  );
}
