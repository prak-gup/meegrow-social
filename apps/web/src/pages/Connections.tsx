import { useCallback, useEffect, useRef, useState } from 'react';
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
import { platformMeta } from '../lib/platforms';
import { missingAccountHelp } from '../lib/connectHelp';
import { InviteLinkRow, useInviteLinks } from '../components/InviteLinks';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import {
  Plugs,
  ArrowClockwise,
  LinkSimple,
  Copy,
  CheckCircle,
  Warning,
  WarningCircle,
  type IconComponent,
} from '../lib/icons';

type IconType = IconComponent;

const HEALTH: Record<ConnectionHealth, { label: string; cls: string; Icon: IconType }> = {
  healthy: { label: 'Healthy', cls: 'text-status-ok', Icon: CheckCircle },
  expiring: { label: 'Expiring soon', cls: 'text-status-warn', Icon: Warning },
  needs_reconnect: { label: 'Needs reconnect', cls: 'text-status-bad', Icon: WarningCircle },
};

type ConnectMessage = CallbackResult | { status: 'error'; error: string };
interface PendingPick {
  flowId: string;
  accounts: ProviderAccountView[];
  /** The platform the popup was opened for — the callback result does not carry it. */
  provider: ProviderView | null;
}

/** The picker came back empty: say why that happens, the fix for each cause, and offer a retry. */
function NoAccounts({
  provider,
  onRetry,
}: {
  provider: ProviderView | null;
  onRetry: (p: ProviderView) => void;
}) {
  const help = missingAccountHelp(
    {
      provider: provider?.identifier ?? '',
      providerDisplayName: provider ? platformMeta(provider).label : 'platform',
    },
    'operator',
  );
  return (
    <div className="text-sm text-body-ink">
      <p>Nothing was connected. {help.lead}</p>
      {help.causes.length > 0 && (
        <ol className="mt-3 list-decimal space-y-2.5 pl-5">
          {help.causes.map((c) => (
            <li key={c.cause}>
              <b className="text-ink">{c.cause}</b> {c.fix}
            </li>
          ))}
        </ol>
      )}
      {provider && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={() => onRetry(provider)}>
            <ArrowClockwise size={16} />
            Try again
          </Button>
        </div>
      )}
    </div>
  );
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
  const links = useInviteLinks();
  const reloadLinks = links.reload;
  // Which platform the open popup belongs to, for the account picker's guidance and retry.
  const connecting = useRef<ProviderView | null>(null);

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
        setPick({
          flowId: payload.flowId,
          accounts: payload.accounts,
          provider: connecting.current,
        });
      else {
        setMsg('Account connected.');
        void load();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [load]);

  const connect = async (p: ProviderView) => {
    setMsg(null);
    connecting.current = p;
    try {
      const { url } = await api.authUrl(p.identifier);
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
      setInvite({ provider: p.identifier, label: platformMeta(p).label, url: res.url });
      void reloadLinks();
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
              const m = platformMeta({ identifier: c.provider, displayName: c.provider });
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
            const m = platformMeta(p);
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
                  <Button variant="secondary" size="sm" onClick={() => void connect(p)}>
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

      {/* invite links that still work */}
      {links.invites && links.invites.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">
            Invite links that still work
          </h2>
          <ul className="space-y-3 rounded-md border border-hairline bg-canvas p-5">
            {links.invites.map((i) => (
              <li key={i.id}>
                <p className="mb-1 text-sm font-medium">
                  {platformMeta({ identifier: i.provider, displayName: i.provider }).label}
                </p>
                <InviteLinkRow invite={i} onCancel={links.cancel} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-caption text-muted">
            Anyone holding one of these can connect an account for {activeName}. A link stops
            working once it has connected an account; cancel any you no longer need.
          </p>
          {links.error && <p className="mt-2 text-caption text-error">{links.error}</p>}
        </section>
      )}

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
            <NoAccounts
              provider={pick.provider}
              onRetry={(p) => {
                setPick(null);
                void connect(p);
              }}
            />
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
