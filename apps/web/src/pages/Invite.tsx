import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { InviteView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import {
  FacebookLogo,
  InstagramLogo,
  LinkedinLogo,
  YoutubeLogo,
  XLogo,
  GoogleLogo,
  Plugs,
} from '../lib/icons';

const BRAND: Record<string, { Icon: typeof FacebookLogo; color: string }> = {
  facebook: { Icon: FacebookLogo, color: '#1877F2' },
  instagram: { Icon: InstagramLogo, color: '#E4405F' },
  gmb: { Icon: GoogleLogo, color: '#4285F4' },
  linkedin: { Icon: LinkedinLogo, color: '#0A66C2' },
  'linkedin-page': { Icon: LinkedinLogo, color: '#0A66C2' },
  x: { Icon: XLogo, color: '#000000' },
  youtube: { Icon: YoutubeLogo, color: '#FF0000' },
};

/**
 * Public connect-invite landing (no login). A client opens the link the operator sent, sees which
 * account they're granting for which agency, and starts the OAuth. The existing /connect/callback
 * finalises into the invite's workspace.
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

  const brand = invite ? (BRAND[invite.provider] ?? { Icon: Plugs, color: '#6a6a6a' }) : null;

  return (
    <div className="grid min-h-screen place-items-center bg-surface-soft px-4">
      <div className="w-full max-w-md rounded-lg border border-hairline bg-canvas p-8 shadow-1">
        <div className="mb-6 flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <rect width="32" height="32" rx="9" fill="#fff" stroke="#dddddd" />
            <path
              d="M8 21 L14 14 L18 17 L24 9"
              stroke="#ff385c"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="24" cy="9" r="2.6" fill="#222222" />
          </svg>
          <span className="text-[17px] font-bold tracking-tight text-rausch">
            meegrow<span className="text-ink">·social</span>
          </span>
        </div>

        {state === 'loading' && <p className="text-muted">Loading…</p>}

        {state === 'invalid' && (
          <>
            <h1 className="text-xl font-semibold">This link isn’t valid</h1>
            <p className="mt-2 text-[15px] text-muted">
              It may have expired or already been used. Ask your agency for a fresh link.
            </p>
          </>
        )}

        {invite && brand && (state === 'ready' || state === 'starting') && (
          <>
            <div className="mb-5 flex items-center gap-4">
              <span
                className="grid h-14 w-14 flex-none place-items-center rounded-md text-white"
                style={{ background: brand.color }}
              >
                <brand.Icon size={30} weight="fill" />
              </span>
              <div>
                <h1 className="text-xl font-semibold leading-tight">
                  Connect your {invite.providerDisplayName}
                </h1>
                <p className="text-[15px] text-muted">
                  so {invite.workspaceName} can publish on your behalf
                </p>
              </div>
            </div>
            <ul className="mb-6 space-y-2 text-sm text-body-ink">
              <li>• You’ll sign in with {invite.providerDisplayName} and approve access.</li>
              <li>• {invite.workspaceName} can post and read insights — nothing else.</li>
              <li>• Your password is never shared, and you can revoke access anytime.</li>
            </ul>
            {err && <p className="mb-4 text-sm text-error">{err}</p>}
            <button
              onClick={() => void start()}
              disabled={state === 'starting'}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-sm bg-rausch px-4 text-[15px] font-medium text-white hover:bg-rausch-active disabled:opacity-60"
            >
              {state === 'starting'
                ? 'Redirecting…'
                : `Continue with ${invite.providerDisplayName}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
