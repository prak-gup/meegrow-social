import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import type { ProviderView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { PRODUCT_NAME, platformMeta } from '../lib/platforms';
import { siteAddressProblem } from '../lib/wordpress';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import { Modal } from './ui/Modal';
import { ArrowSquareOut, WarningCircle } from '../lib/icons';

/**
 * Connecting a platform that has no login of its own to send people to — a WordPress site — starts
 * with its address. The dialog asks for it, says what is about to happen, and then hands over to
 * the site's own approval screen in a popup. No password is ever typed here: the site issues a
 * separate one for this app after the person approves, and the server stores it.
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
  onClose,
}: {
  provider: ProviderView;
  clientName: string;
  /** The address of the connection being reconnected, when there is one. */
  initialAddress?: string;
  /** The approval screen is open in a popup; the page should now wait for its result. */
  onStarted: () => void;
  onClose: () => void;
}) {
  const label = platformMeta(provider).label;
  const [address, setAddress] = useState(initialAddress);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** Set when the popup was blocked: where the person has to go themselves. */
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const errorId = useId();
  const hintId = useId();

  // Escape and the backdrop must not dismiss mid-request (same pattern as EditCaptionModal).
  const inFlight = useRef(false);
  const guardedClose = useCallback(() => {
    if (!inFlight.current) onClose();
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    const typed = siteAddressProblem(address);
    if (typed) {
      setProblem(typed);
      return;
    }
    inFlight.current = true;
    setChecking(true);
    setProblem(null);
    setBlockedUrl(null);
    const popup = window.open('', '_blank', 'width=600,height=720');
    if (popup) {
      popup.document.title = `Connecting ${label}`;
      popup.document.body.textContent = 'Checking the site…';
    }
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
      setProblem(err instanceof Error ? err.message : 'Could not check the site.');
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  };

  return (
    <Modal title={`Connect a ${label} site`} onClose={guardedClose}>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="site-address">Site address</Label>
          <Input
            id="site-address"
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
            disabled={checking}
            aria-invalid={Boolean(problem)}
            aria-describedby={problem ? `${hintId} ${errorId}` : hintId}
          />
          <p id={hintId} className="text-caption text-muted">
            The site’s public address. It must use https.
          </p>
          {problem && (
            <p
              id={errorId}
              role="alert"
              className="flex items-start gap-1.5 text-caption text-error"
            >
              <WarningCircle size={16} className="mt-0.5 flex-none" aria-hidden="true" />
              <span>{problem}</span>
            </p>
          )}
        </div>

        <div className="rounded-sm border border-hairline bg-surface-soft px-3 py-2.5">
          <p className="text-sm font-medium text-ink">What happens next</p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-body-ink">
            <li>The site’s own WordPress login opens in a new window.</li>
            <li>
              Log in there as someone who can publish posts (an Author, Editor or Administrator) and
              approve “{PRODUCT_NAME}”.
            </li>
            <li>
              WordPress makes a separate password just for this app and the site is connected for{' '}
              {clientName}.
            </li>
          </ol>
          <p className="mt-2 text-caption text-muted">
            Your WordPress password is never entered here. Access can be removed at any time from
            the site: Users → Profile → Application Passwords.
          </p>
        </div>

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
          <Button type="button" variant="ghost" onClick={guardedClose} disabled={checking}>
            Cancel
          </Button>
          <Button type="submit" disabled={checking}>
            {checking ? 'Checking the site…' : `Continue to ${label}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
