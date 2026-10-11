import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { InviteView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';
import { PRODUCT_NAME, signInName } from '../lib/platforms';
import { siteAddressProblem } from '../lib/wordpress';
import { Input } from '../components/ui/Input';
import { Label } from '../components/ui/Label';
import { pickOnlyThisBusiness } from '../lib/connectHelp';
import {
  FacebookLogo,
  InstagramLogo,
  LinkedinLogo,
  YoutubeLogo,
  XLogo,
  GoogleLogo,
  WordpressLogo,
  Plugs,
} from '../lib/icons';

/**
 * Where the invite token waits while the browser is away on the platform's screens, so the picker
 * can restart the same invite ("try again"). Same tab only; losing it just means reopening the link.
 */
const TOKEN_KEY = 'mg_invite_token';

export function rememberInviteToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage can be blocked (private mode); "try again" then asks them to reopen the link.
  }
}

export function recallInviteToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export const BRAND: Record<string, { Icon: typeof FacebookLogo; bg: string }> = {
  facebook: { Icon: FacebookLogo, bg: 'bg-brand-facebook' },
  instagram: { Icon: InstagramLogo, bg: 'bg-brand-instagram' },
  gmb: { Icon: GoogleLogo, bg: 'bg-brand-gmb' },
  linkedin: { Icon: LinkedinLogo, bg: 'bg-brand-linkedin' },
  'linkedin-page': { Icon: LinkedinLogo, bg: 'bg-brand-linkedin' },
  x: { Icon: XLogo, bg: 'bg-brand-x' },
  youtube: { Icon: YoutubeLogo, bg: 'bg-brand-youtube' },
  wordpress: { Icon: WordpressLogo, bg: 'bg-brand-wordpress' },
};

/** The card every public invite screen sits in — the client never sees the dashboard chrome. */
export function InviteCard({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-surface-soft px-4">
      <div className="w-full max-w-md rounded-lg border border-hairline bg-canvas p-8 shadow-1">
        <Logo size={26} className="mb-6" />
        {children}
      </div>
    </div>
  );
}

/** Platform mark + what is being connected for whom, shared by the landing and the picker. */
export function InviteHeading({
  provider,
  title,
  subtitle,
}: {
  provider: string;
  title: string;
  subtitle: string;
}) {
  const brand = BRAND[provider] ?? { Icon: Plugs, bg: 'bg-muted' };
  return (
    <div className="mb-5 flex items-center gap-4">
      <span
        className={`grid h-14 w-14 flex-none place-items-center rounded-md text-white ${brand.bg}`}
      >
        <brand.Icon size={30} weight="fill" />
      </span>
      <div>
        <h1 className="text-xl font-semibold leading-tight">{title}</h1>
        <p className="text-body text-muted">{subtitle}</p>
      </div>
    </div>
  );
}

/**
 * Public connect-invite landing (no login). A client opens the link the operator sent, sees which
 * account they're granting for which agency, and starts the OAuth. /connect/callback then either
 * connects straight into the invite's workspace or, when an account has to be picked, sends this
 * browser on to InviteFinish.
 */
export function Invite() {
  const { token = '' } = useParams();
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'starting'>('loading');
  const [err, setErr] = useState<string | null>(null);
  // Only an invite for a site-address platform (WordPress) asks for this.
  const [siteAddress, setSiteAddress] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        setInvite(await api.getInvite(token));
        setState('ready');
      } catch {
        setState('invalid');
      }
    })();
  }, [token]);

  const needsSite = invite?.connectInput === 'site_url';

  const start = async () => {
    if (needsSite) {
      const problem = siteAddressProblem(siteAddress);
      if (problem) {
        setErr(problem);
        return;
      }
    }
    setState('starting');
    setErr(null);
    try {
      const { url } = await api.startInvite(token, needsSite ? siteAddress.trim() : undefined);
      rememberInviteToken(token);
      window.location.href = url; // full-page redirect to the platform's consent screen
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start. The link may have expired.');
      setState('ready');
    }
  };

  return (
    <InviteCard>
      {state === 'loading' && <p className="text-muted">Loading…</p>}

      {state === 'invalid' && (
        <>
          <h1 className="text-xl font-semibold">This link isn’t valid</h1>
          <p className="mt-2 text-body text-muted">
            It may have expired, been cancelled, or already been used to connect an account. Ask
            your agency for a fresh link.
          </p>
        </>
      )}

      {invite && (state === 'ready' || state === 'starting') && (
        <>
          <InviteHeading
            provider={invite.provider}
            title={
              needsSite
                ? `Connect your ${invite.providerDisplayName} site`
                : `Connect your ${invite.providerDisplayName}`
            }
            subtitle={`Requested for ${invite.workspaceName}, through ${PRODUCT_NAME}`}
          />
          {needsSite ? (
            <>
              <ul className="mb-5 space-y-2 text-sm text-body-ink">
                <li>• You’ll log in to your own WordPress site and approve access there.</li>
                <li>
                  • The team that manages content for {invite.workspaceName} uses {PRODUCT_NAME} to
                  publish blog articles to this site — nothing else.
                </li>
                <li>
                  • WordPress makes a separate password just for this. Your own password is never
                  shared, and you can remove access anytime from your WordPress profile (Application
                  Passwords).
                </li>
              </ul>
              <div className="mb-5 space-y-1.5">
                <Label htmlFor="invite-site">Your site’s address</Label>
                <Input
                  id="invite-site"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="https://example.com"
                  value={siteAddress}
                  onChange={(e) => {
                    setSiteAddress(e.target.value);
                    setErr(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void start();
                  }}
                  disabled={state === 'starting'}
                  aria-invalid={Boolean(err)}
                  aria-describedby={err ? 'invite-error' : undefined}
                />
              </div>
            </>
          ) : (
            <ul className="mb-6 space-y-2 text-sm text-body-ink">
              <li>• You’ll sign in with {signInName(invite)} and approve access.</li>
              {pickOnlyThisBusiness(invite) && <li>• {pickOnlyThisBusiness(invite)}</li>}
              <li>
                • The team that manages social media for {invite.workspaceName} uses {PRODUCT_NAME}{' '}
                to publish posts and read insights for this account — nothing else.
              </li>
              <li>• Your password is never shared, and you can revoke access anytime.</li>
            </ul>
          )}
          {err && (
            <p id="invite-error" role="alert" className="mb-4 text-sm text-error">
              {err}
            </p>
          )}
          <button
            onClick={() => void start()}
            disabled={state === 'starting'}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-sm bg-rausch px-4 text-body font-medium text-white hover:bg-rausch-active disabled:opacity-60"
          >
            {state === 'starting'
              ? needsSite
                ? 'Checking the site…'
                : 'Redirecting…'
              : needsSite
                ? 'Continue to WordPress'
                : `Continue with ${signInName(invite)}`}
          </button>
        </>
      )}
    </InviteCard>
  );
}
