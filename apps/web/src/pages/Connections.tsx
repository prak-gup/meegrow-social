import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CallbackResult,
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
import { ConnectSiteDialog } from '../components/ConnectSiteDialog';
import { connectionChip, type ChipStatus } from '../lib/statusChip';
import { canReconnect, expiryLabel, filterConnections, shortDate } from '../lib/connectionRows';
import { clientHue } from '../lib/clientHue';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { FilterBar, FilterSelect } from '../components/ui/FilterBar';
import { PlatformBadge } from '../components/ui/PlatformBadge';
import { RowMenu } from '../components/ui/RowMenu';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusChip } from '../components/ui/StatusChip';
import { Table } from '../components/ui/Table';
import { Plugs, ArrowClockwise, LinkSimple, Copy, Plus, Trash } from '../lib/icons';

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
  /** The provider whose connect starts with a question (a site address), and any known answer. */
  const [asking, setAsking] = useState<{ provider: ProviderView; address?: string } | null>(null);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<ChipStatus | ''>('');
  const [platformFilter, setPlatformFilter] = useState('');
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

  const connect = async (p: ProviderView, address?: string) => {
    setMsg(null);
    connecting.current = p;
    if (p.connectInput === 'site_url') {
      // No login to redirect to until we know which site: ask for its address first.
      setAsking({ provider: p, address });
      return;
    }
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

  const shown = filterConnections(visibleConns, {
    q,
    status: statusFilter,
    provider: platformFilter,
  });
  const platformOptions = [
    { value: '', label: 'All platforms' },
    ...Array.from(new Set(visibleConns.map((c) => c.provider))).map((id) => ({
      value: id,
      label: platformMeta({ identifier: id, displayName: id }).label,
    })),
  ];
  const filtering = q.trim() !== '' || statusFilter !== '' || platformFilter !== '';
  const activeHue = clientHue(activeName);

  const goToAdd = () => {
    const el = document.getElementById('add-account');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        subtitle={`The accounts you publish to for ${activeName}.`}
        className="mb-0"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <ArrowClockwise size={14} />
              Refresh
            </Button>
            <Button size="sm" onClick={goToAdd}>
              <Plus size={14} weight="bold" />
              Add account
            </Button>
          </>
        }
      />

      {msg && (
        <div
          role="status"
          className="rounded-md border border-hairline bg-surface-soft px-3 py-2 text-sm text-ink"
        >
          {msg}
        </div>
      )}

      {/* connected accounts */}
      <section aria-label="Connected accounts">
        {loading ? (
          <div className="space-y-px" aria-busy="true" aria-label="Loading accounts">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : visibleConns.length === 0 ? (
          <EmptyState
            title="No accounts connected yet"
            description={`Connect one below, or send ${activeName} an invite link.`}
            icon={Plugs}
          />
        ) : (
          <>
            <FilterBar
              search={{
                value: q,
                onChange: setQ,
                placeholder: 'Search accounts…',
                label: 'Search accounts',
              }}
              filters={
                <>
                  <FilterSelect
                    label="Platform"
                    value={platformFilter}
                    onChange={setPlatformFilter}
                    options={platformOptions}
                  />
                  <FilterSelect
                    label="Status"
                    value={statusFilter}
                    onChange={(v) => setStatusFilter(v as ChipStatus | '')}
                    options={[
                      { value: '', label: 'All statuses' },
                      { value: 'healthy', label: 'Healthy' },
                      { value: 'expiring', label: 'Expiring soon' },
                      { value: 'needs_reconnect', label: 'Needs reconnect' },
                    ]}
                  />
                </>
              }
              actions={
                <span aria-live="polite" className="tnum text-caption text-muted">
                  {filtering ? `${shown.length} of ${visibleConns.length}` : visibleConns.length}{' '}
                  {visibleConns.length === 1 ? 'account' : 'accounts'}
                </span>
              }
            />
            <Table
              caption="Connected accounts"
              dense
              rows={shown}
              rowKey={(c) => c.id}
              empty={{
                title: 'No accounts match these filters',
                icon: Plugs,
                action: (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQ('');
                      setStatusFilter('');
                      setPlatformFilter('');
                    }}
                  >
                    Clear filters
                  </Button>
                ),
              }}
              columns={[
                {
                  key: 'account',
                  header: 'Account',
                  cell: (c) => {
                    const m = platformMeta({ identifier: c.provider, displayName: c.provider });
                    return (
                      <div className="flex min-w-0 items-center gap-2.5">
                        <PlatformBadge provider={c.provider} name={c.displayName} />
                        <div className="min-w-0 max-w-[15rem]">
                          <div className="truncate font-medium leading-4 text-ink">
                            {c.displayName}
                          </div>
                          <div className="truncate text-caption leading-4 text-muted">
                            {m.label} · {c.externalId}
                          </div>
                          {/* the Status column is hidden on a phone, so the chip rides here */}
                          <StatusChip
                            status={connectionChip(c.health, c.expiresInDays)}
                            className="mt-1 sm:hidden"
                          />
                        </div>
                      </div>
                    );
                  },
                },
                {
                  key: 'client',
                  header: 'Client',
                  className: 'hidden whitespace-nowrap lg:table-cell',
                  cell: () => (
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 flex-none rounded-full"
                        style={{ background: activeHue }}
                      />
                      {activeName}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  className: 'hidden sm:table-cell',
                  cell: (c) => <StatusChip status={connectionChip(c.health, c.expiresInDays)} />,
                },
                {
                  key: 'expiry',
                  header: 'Token expiry',
                  className: 'hidden whitespace-nowrap sm:table-cell',
                  cell: (c) => {
                    const chip = connectionChip(c.health, c.expiresInDays);
                    return (
                      <span
                        className={
                          'tnum ' +
                          (chip === 'needs_reconnect'
                            ? 'font-medium text-status-bad'
                            : chip === 'expiring'
                              ? 'font-medium text-status-warn'
                              : 'text-muted')
                        }
                      >
                        {expiryLabel(c.expiresInDays)}
                      </span>
                    );
                  },
                },
                {
                  key: 'connected',
                  header: 'Connected',
                  className: 'hidden whitespace-nowrap md:table-cell',
                  cell: (c) => <span className="tnum text-muted">{shortDate(c.createdAt)}</span>,
                },
              ]}
              rowActions={(c) => {
                const chip = connectionChip(c.health, c.expiresInDays);
                const provider = connectable.find((p) => p.identifier === c.provider);
                return (
                  <RowMenu
                    label={`Actions for ${c.displayName}`}
                    items={[
                      ...(canReconnect(chip) && provider
                        ? [
                            {
                              label: 'Reconnect',
                              icon: <ArrowClockwise size={14} />,
                              onSelect: () => void connect(provider, c.externalId),
                            },
                          ]
                        : []),
                      {
                        label: 'Disconnect',
                        icon: <Trash size={14} />,
                        danger: true,
                        onSelect: () => void disconnect(c.id),
                      },
                    ]}
                  />
                );
              }}
            />
          </>
        )}
      </section>

      {/* add an account */}
      <section id="add-account" aria-labelledby="add-account-h" className="scroll-mt-4">
        <h2 id="add-account-h" className="mb-2 text-sm font-semibold text-ink">
          Add an account
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {connectable.map((p) => {
            const m = platformMeta(p);
            return (
              <li
                key={p.identifier}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-hairline bg-canvas px-2.5 py-2"
              >
                <span
                  aria-hidden="true"
                  className={`grid h-6 w-6 flex-none place-items-center rounded-sm text-white ${m.brand}`}
                >
                  <m.Icon size={14} weight="fill" />
                </span>
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate font-medium text-ink">{m.label}</div>
                  <div className="truncate text-caption text-muted">{m.blurb}</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => void connect(p)}>
                  Connect
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void makeInvite(p)}>
                  <LinkSimple size={14} />
                  Invite client
                </Button>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-caption text-muted">
          <b className="font-semibold text-ink">Connect</b> authorises the account yourself.{' '}
          <b className="font-semibold text-ink">Invite client</b> makes a link {activeName} opens to
          connect their own account — no password shared.
        </p>
      </section>

      {/* invite links that still work */}
      {links.invites && links.invites.length > 0 && (
        <section aria-labelledby="invites-h">
          <h2 id="invites-h" className="mb-2 text-sm font-semibold text-ink">
            Invite links that still work
          </h2>
          <ul className="divide-y divide-hairline-soft rounded-md border border-hairline bg-canvas">
            {links.invites.map((i) => (
              <li key={i.id} className="px-3 py-2">
                <p className="mb-1 text-xs font-medium text-muted">
                  {platformMeta({ identifier: i.provider, displayName: i.provider }).label}
                </p>
                <InviteLinkRow invite={i} onCancel={links.cancel} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-caption text-muted">
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
            the account connects here. Their password never touches you.
            {(invite.provider === 'facebook' || invite.provider === 'instagram') &&
              ' (External sign-in needs Meta App Review, issue #53; you can already use it for accounts you can reach.)'}
          </p>
          <div className="flex items-center gap-2.5 rounded-sm border border-hairline bg-surface-soft px-3 py-2">
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

      {/* a platform that needs a site address before it can send anyone anywhere */}
      {asking && (
        <ConnectSiteDialog
          provider={asking.provider}
          clientName={activeName}
          initialAddress={asking.address}
          onStarted={() => {
            setAsking(null);
            setMsg(
              'Approve in the new window. This page updates when you are done — if it does not, press Refresh.',
            );
          }}
          onClose={() => setAsking(null)}
        />
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
            <ul className="space-y-1.5">
              {pick.accounts.map((a) => (
                <li
                  key={a.externalId}
                  className="flex items-center justify-between gap-3 rounded-sm border border-hairline px-3 py-2"
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
