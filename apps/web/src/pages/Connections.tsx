import { useCallback, useEffect, useState } from 'react';
import type {
  CallbackResult,
  ConnectionHealth,
  ConnectionView,
  ProviderAccountView,
  ProviderView,
} from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { providerVisible } from '../lib/devProviders';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import {
  FacebookLogo,
  InstagramLogo,
  LinkedinLogo,
  YoutubeLogo,
  XLogo,
  GoogleLogo,
  Plugs,
  ArrowClockwise,
  LinkSimple,
  Copy,
  CheckCircle,
  Warning,
  WarningCircle,
} from '../lib/icons';

type IconType = typeof FacebookLogo;
interface PlatformMeta {
  label: string;
  Icon: IconType;
  /** Tailwind bg class from the --brand-* tokens. */
  brand: string;
  blurb: string;
}
const PLATFORM: Record<string, PlatformMeta> = {
  facebook: {
    label: 'Facebook Page',
    Icon: FacebookLogo,
    brand: 'bg-brand-facebook',
    blurb: 'Publish to a Facebook Page',
  },
  instagram: {
    label: 'Instagram',
    Icon: InstagramLogo,
    brand: 'bg-brand-instagram',
    blurb: 'Publish to an Instagram Business account',
  },
  gmb: {
    label: 'Google Business',
    Icon: GoogleLogo,
    brand: 'bg-brand-gmb',
    blurb: 'Post to a Business Profile',
  },
  linkedin: {
    label: 'LinkedIn',
    Icon: LinkedinLogo,
    brand: 'bg-brand-linkedin',
    blurb: 'Post to a personal profile',
  },
  'linkedin-page': {
    label: 'LinkedIn Page',
    Icon: LinkedinLogo,
    brand: 'bg-brand-linkedin',
    blurb: 'Post to a Company Page',
  },
  x: { label: 'X', Icon: XLogo, brand: 'bg-brand-x', blurb: 'Post to X (Twitter)' },
  youtube: {
    label: 'YouTube',
    Icon: YoutubeLogo,
    brand: 'bg-brand-youtube',
    blurb: 'Upload to a channel',
  },
};
function meta(p: { identifier: string; displayName: string }): PlatformMeta {
  return (
    PLATFORM[p.identifier] ?? {
      label: p.displayName,
      Icon: Plugs,
      brand: 'bg-muted',
      blurb: 'Test provider (dev)',
    }
  );
}

const HEALTH: Record<ConnectionHealth, { label: string; cls: string; Icon: IconType }> = {
  healthy: { label: 'Healthy', cls: 'text-status-ok', Icon: CheckCircle },
  expiring: { label: 'Expiring soon', cls: 'text-status-warn', Icon: Warning },
  needs_reconnect: { label: 'Needs reconnect', cls: 'text-status-bad', Icon: WarningCircle },
};

type ConnectMessage = CallbackResult | { status: 'error'; error: string };
interface PendingPick {
  flowId: string;
  accounts: ProviderAccountView[];
}

export function Connections() {
  const { me } = useAuth();
  const [conns, setConns] = useState<ConnectionView[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [pick, setPick] = useState<PendingPick | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ provider: string; label: string; url: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const activeName =
    me?.user.memberships.find((m) => m.workspaceId === me.activeWorkspaceId)?.name ?? 'this client';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, p] = await Promise.all([api.listConnections(), api.listProviders()]);
      setConns(c.connections);
      setProviders(p.providers);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { source?: string; payload?: ConnectMessage } | null;
      if (data?.source !== 'meegrow-social-connect' || !data.payload) return;
      const payload = data.payload;
      if (payload.status === 'error') setMsg(`Connect failed: ${payload.error}`);
      else if (payload.status === 'choose_account')
        setPick({ flowId: payload.flowId, accounts: payload.accounts });
      else {
        setMsg('Account connected.');
        void load();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [load]);

  const connect = async (provider: string) => {
    setMsg(null);
    try {
      const { url } = await api.authUrl(provider);
      window.open(url, '_blank', 'width=600,height=700');
      setMsg('Approve in the popup…');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not start the connection.');
    }
  };
  const makeInvite = async (p: ProviderView) => {
    setCopied(false);
    try {
      const res = await api.createInvite(p.identifier);
      setInvite({ provider: p.identifier, label: meta(p).label, url: res.url });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not create the invite link.');
    }
  };
  const choose = async (externalId: string) => {
    if (!pick) return;
    try {
      await api.finishConnect(pick.flowId, externalId);
      setPick(null);
      setMsg('Account connected.');
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not finish connecting.');
    }
  };
  const disconnect = async (id: string) => {
    await api.deleteConnection(id);
    void load();
  };

  // Fakes are test-only. Dev builds keep them (the connect flow can be exercised without platform
  // secrets); production builds never front them — see lib/devProviders.
  const connectable = providers.filter((p) => providerVisible(p.identifier));
  const visibleConns = conns.filter((c) => providerVisible(c.provider));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Connections"
        subtitle={`The accounts you publish to for ${activeName}.`}
        className="mb-0"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <ArrowClockwise size={16} />
            Refresh
          </Button>
        }
      />

      {msg && (
        <div className="rounded-md border border-hairline bg-surface-soft px-4 py-3 text-sm text-ink">
          {msg}
        </div>
      )}

      {/* connected accounts */}
      <section>
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">
          Connected accounts
        </h2>
        {loading ? (
          <p className="text-muted">Loading…</p>
        ) : visibleConns.length === 0 ? (
          <EmptyState
            title="No accounts connected yet"
            description={`Connect one below, or send ${activeName} an invite link.`}
            icon={Plugs}
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {visibleConns.map((c) => {
              const m = meta({ identifier: c.provider, displayName: c.provider });
              const h = HEALTH[c.health];
              return (
                <div key={c.id} className="rounded-md border border-hairline bg-canvas p-5">
                  <div className="flex items-start gap-3.5">
                    <span
                      className={`grid h-11 w-11 flex-none place-items-center rounded-md text-white ${m.brand}`}
                    >
                      <m.Icon size={24} weight="fill" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-base font-semibold">{c.displayName}</span>
                        <span
                          className={'flex items-center gap-1.5 text-xs font-semibold ' + h.cls}
                        >
                          <h.Icon size={15} weight="fill" />
                          {h.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-caption text-muted">{m.label}</p>
                      <p className="tnum mt-0.5 text-caption text-muted">
                        {c.expiresInDays == null
                          ? 'Token never expires'
                          : `Renews in ${c.expiresInDays}d`}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <Button variant="ghost" size="sm" onClick={() => void disconnect(c.id)}>
                      Disconnect
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* add an account */}
      <section>
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">
          Add an account
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {connectable.map((p) => {
            const m = meta(p);
            return (
              <div key={p.identifier} className="rounded-md border border-hairline bg-canvas p-5">
                <div className="flex items-center gap-3.5">
                  <span
                    className={`grid h-11 w-11 flex-none place-items-center rounded-md text-white ${m.brand}`}
                  >
                    <m.Icon size={24} weight="fill" />
                  </span>
                  <div>
                    <div className="text-base font-semibold">{m.label}</div>
                    <div className="text-caption text-muted">{m.blurb}</div>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => void connect(p.identifier)}>
                    Connect
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void makeInvite(p)}>
                    <LinkSimple size={16} />
                    Invite client
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-caption text-muted">
          <b className="text-ink">Connect</b> authorises the account yourself.{' '}
          <b className="text-ink">Invite client</b> makes a link {activeName} opens to connect their
          own account — no password shared.
        </p>
      </section>

      {/* invite link panel */}
      {invite && (
        <Modal title={`Invite link — ${invite.label}`} onClose={() => setInvite(null)}>
          <p className="mb-3 text-sm text-muted">
            Send this to {activeName}. They open it, sign into their {invite.label}, and approve —
            the account connects here. Their password never touches you. (External sign-in needs
            Meta App Review, issue&nbsp;#53; you can already use it for accounts you can reach.)
          </p>
          <div className="flex items-center gap-2.5 rounded-sm border border-hairline bg-surface-soft px-3.5 py-2.5">
            <LinkSimple size={16} className="text-muted" />
            <code className="flex-1 truncate font-mono text-sm text-ink">{invite.url}</code>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setInvite(null)}>
              Done
            </Button>
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(invite.url).then(() => setCopied(true));
              }}
            >
              <Copy size={16} />
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        </Modal>
      )}

      {/* two-phase account picker */}
      {pick && (
        <Modal title="Choose an account to connect" onClose={() => setPick(null)}>
          {pick.accounts.length === 0 ? (
            <p className="text-sm text-muted">
              That login didn&apos;t return any manageable accounts. Grant access to at least one,
              then try again.
            </p>
          ) : (
            <ul className="space-y-2">
              {pick.accounts.map((a) => (
                <li
                  key={a.externalId}
                  className="flex items-center justify-between gap-3 rounded-sm border border-hairline px-3.5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{a.displayName}</p>
                    <p className="tnum truncate text-caption text-muted">{a.externalId}</p>
                  </div>
                  <Button size="sm" onClick={() => void choose(a.externalId)}>
                    Connect
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </div>
  );
}
