import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { InviteView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';
import {
  FacebookLogo,
  InstagramLogo,
  LinkedinLogo,
  YoutubeLogo,
  XLogo,
  GoogleLogo,
  Plugs,
} from '../lib/icons';

export const BRAND: Record<string, { Icon: typeof FacebookLogo; bg: string }> = {
  facebook: { Icon: FacebookLogo, bg: 'bg-brand-facebook' },
  instagram: { Icon: InstagramLogo, bg: 'bg-brand-instagram' },
  gmb: { Icon: GoogleLogo, bg: 'bg-brand-gmb' },
  linkedin: { Icon: LinkedinLogo, bg: 'bg-brand-linkedin' },
  'linkedin-page': { Icon: LinkedinLogo, bg: 'bg-brand-linkedin' },
  x: { Icon: XLogo, bg: 'bg-brand-x' },
  youtube: { Icon: YoutubeLogo, bg: 'bg-brand-youtube' },
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

  const start = async () => {
    setState('starting');
    setErr(null);
    try {
      const { url } = await api.startInvite(token);
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
            It may have expired or already been used. Ask your agency for a fresh link.
          </p>
        </>
      )}

      {invite && (state === 'ready' || state === 'starting') && (
        <>
          <InviteHeading
            provider={invite.provider}
            title={`Connect your ${invite.providerDisplayName}`}
            subtitle={`so ${invite.workspaceName} can publish on your behalf`}
          />
          <ul className="mb-6 space-y-2 text-sm text-body-ink">
            <li>• You’ll sign in with {invite.providerDisplayName} and approve access.</li>
            <li>• {invite.workspaceName} can post and read insights — nothing else.</li>
            <li>• Your password is never shared, and you can revoke access anytime.</li>
          </ul>
          {err && <p className="mb-4 text-sm text-error">{err}</p>}
          <button
            onClick={() => void start()}
            disabled={state === 'starting'}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-sm bg-rausch px-4 text-body font-medium text-white hover:bg-rausch-active disabled:opacity-60"
          >
            {state === 'starting' ? 'Redirecting…' : `Continue with ${invite.providerDisplayName}`}
          </button>
        </>
      )}
    </InviteCard>
  );
}
