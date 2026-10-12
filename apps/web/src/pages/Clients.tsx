import { clientSortOptions, sortClients, type ClientSort } from '../lib/listSort';
import { SortSelect } from '../components/ui/SortSelect';
import { useUrlSort } from '../lib/useUrlSort';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OverviewView, ClientOverview, ProviderView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clientHue } from '../lib/clientHue';
import { clientChip, type ChipStatus } from '../lib/statusChip';
import { filterClients, nextPublishLabel } from '../lib/clientRows';
import { providerVisible } from '../lib/devProviders';
import { platformMeta } from '../lib/platforms';
import { ClientPeopleModal } from '../components/ClientPeopleModal';
import { AddClientModal } from '../components/AddClientModal';
import { InviteLinkRow, useInviteLinks } from '../components/InviteLinks';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { FilterBar, FilterSelect } from '../components/ui/FilterBar';
import { RowMenu } from '../components/ui/RowMenu';
import { StatusChip } from '../components/ui/StatusChip';
import { Table } from '../components/ui/Table';
import { Plus, LinkSimple, PlugsConnected, SquaresFour, UsersThree } from '../lib/icons';

/**
 * The two ways to get a client's accounts connected, kept visibly apart: send the client a link
 * they open themselves (one per platform, minted for THIS client without switching the operator's
 * active client), or connect it yourself — which does switch, and says so. Every link that still
 * works is listed under its platform, so a stale one can be cancelled rather than forgotten.
 */
function ConnectPanel({
  client,
  providers,
  onConnectYourself,
}: {
  client: ClientOverview;
  providers: ProviderView[] | null;
  onConnectYourself: () => void;
}) {
  const { invites, error: linksError, reload, cancel } = useInviteLinks(client.workspaceId);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const mint = async (provider: string) => {
    setBusy(provider);
    setErr(null);
    try {
      await api.createInvite(provider, client.workspaceId);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the link.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
      <div>
        <div className="text-caption font-semibold text-ink">Send {client.name} a link</div>
        <p className="mt-1 text-caption text-muted">
          One link per platform. They open it, sign in, and choose the account — no login here, and
          their password never reaches you. A link works for 14 days, or until it has connected an
          account or you cancel it.
        </p>
        {providers === null && <p className="mt-3 text-caption text-muted">Loading platforms…</p>}
        {providers?.length === 0 && (
          <p className="mt-3 text-caption text-muted">
            No platform can be connected in this environment yet.
          </p>
        )}
        <ul className="mt-2 space-y-1.5">
          {(providers ?? []).map((p) => {
            const meta = platformMeta(p);
            const open = (invites ?? []).filter((i) => i.provider === p.identifier);
            return (
              <li
                key={p.identifier}
                className="rounded-sm border border-hairline bg-canvas px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`grid h-6 w-6 flex-none place-items-center rounded-xs text-white ${meta.brand}`}
                  >
                    <meta.Icon size={14} weight="fill" />
                  </span>
                  <span className="flex-1 text-sm font-medium">{meta.label}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void mint(p.identifier)}
                  >
                    <LinkSimple size={14} />
                    {busy === p.identifier
                      ? 'Creating…'
                      : open.length > 0
                        ? 'Create another'
                        : 'Create link'}
                  </Button>
                </div>
                {open.length > 0 && (
                  <ul className="mt-2.5 space-y-2.5 border-t border-hairline-soft pt-2.5">
                    {open.map((invite) => (
                      <li key={invite.id}>
                        <InviteLinkRow invite={invite} onCancel={cancel} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {(err ?? linksError) && <p className="mt-3 text-caption text-error">{err ?? linksError}</p>}
      </div>

      <div className="lg:w-64 lg:border-l lg:border-hairline lg:pl-4">
        <div className="text-caption font-semibold text-ink">Or connect it yourself now</div>
        <p className="mt-1 text-caption text-muted">
          For accounts you can sign into. This switches you to {client.name} and opens their
          Connections page.
        </p>
        <Button
          className="mt-2 h-auto min-h-11 whitespace-normal py-1.5 text-left md:min-h-7"
          size="sm"
          onClick={onConnectYourself}
        >
          <PlugsConnected size={14} />
          Go to {client.name}’s connections
        </Button>
      </div>
    </div>
  );
}

function HealthChip({ c, className }: { c: ClientOverview; className?: string }) {
  const chip = clientChip(c.health, c.failedThisWeek);
  return <StatusChip status={chip.status} label={chip.label} className={className} />;
}

export function Clients() {
  const { me, switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const [sort, setSort] = useUrlSort('sort', clientSortOptions, 'name');
  const [ov, setOv] = useState<OverviewView | null>(null);
  const [peopleClient, setPeopleClient] = useState<ClientOverview | null>(null);
  const canCreate = me?.user.memberships.some((m) => m.role === 'owner');
  const owns = (id: string) =>
    me?.user.memberships.some((m) => m.workspaceId === id && m.role === 'owner');
  const [adding, setAdding] = useState(false);
  const [openInvite, setOpenInvite] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderView[] | null>(null);

  const load = useCallback(async () => {
    setOv(await api.overview());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Only what this environment can really connect (and never a test fake in production).
  useEffect(() => {
    if (!openInvite || providers) return;
    void (async () => {
      try {
        const res = await api.listProviders();
        setProviders(res.providers.filter((p) => providerVisible(p.identifier)));
      } catch {
        setProviders([]);
      }
    })();
  }, [openInvite, providers]);

  const connectNow = async (c: ClientOverview) => {
    await switchWorkspace(c.workspaceId);
    navigate('/connections');
  };
  const openContent = async (c: ClientOverview) => {
    await switchWorkspace(c.workspaceId);
    navigate('/content');
  };

  const [q, setQ] = useState('');
  const [health, setHealth] = useState<ChipStatus | ''>('');
  const clients = ov?.clients ?? [];
  const shown = sortClients(filterClients(clients, { q, status: health }), sort);
  const filtering = q.trim() !== '' || health !== '';

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle={`${ov?.clients.length ?? '…'} clients · connect accounts yourself, or send a client a link to connect their own`}
        actions={
          canCreate ? (
            <Button onClick={() => setAdding(true)}>
              <Plus size={14} weight="bold" />
              Add client
            </Button>
          ) : undefined
        }
      />

      {ov && clients.length > 0 && (
        <FilterBar
          search={{
            value: q,
            onChange: setQ,
            placeholder: 'Search clients…',
            label: 'Search clients',
          }}
          filters={
            <FilterSelect
              label="Health"
              value={health}
              onChange={(v) => setHealth(v as ChipStatus | '')}
              options={[
                { value: '', label: 'All health' },
                { value: 'healthy', label: 'Healthy' },
                { value: 'expiring', label: 'Queue empty' },
                { value: 'failed', label: 'Failed posts' },
                { value: 'needs_reconnect', label: 'Needs reconnect' },
              ]}
            />
          }
          actions={
            <>
              <SortSelect
                value={sort}
                onChange={(v) => setSort(v as ClientSort)}
                options={[...clientSortOptions]}
              />
              <span aria-live="polite" className="tnum text-caption text-muted">
                {filtering ? `${shown.length} of ${clients.length}` : clients.length}{' '}
                {clients.length === 1 ? 'client' : 'clients'}
              </span>
            </>
          }
        />
      )}

      {ov === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <Table
          caption="Clients"
          dense
          rows={shown}
          sort={{ key: sort, dir: sort === 'name' ? 'asc' : 'desc' }}
          onSort={(key) => setSort(key as ClientSort)}
          rowKey={(c) => c.workspaceId}
          empty={
            clients.length === 0
              ? {
                  title: 'No clients yet',
                  description: 'Add your first one to start publishing.',
                  icon: UsersThree,
                }
              : {
                  title: 'No clients match these filters',
                  icon: UsersThree,
                  action: (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQ('');
                        setHealth('');
                      }}
                    >
                      Clear filters
                    </Button>
                  ),
                }
          }
          renderExpanded={(c) =>
            openInvite === c.workspaceId ? (
              <div id={`connect-${c.workspaceId}`}>
                <ConnectPanel
                  client={c}
                  providers={providers}
                  onConnectYourself={() => void connectNow(c)}
                />
              </div>
            ) : null
          }
          columns={[
            {
              key: 'client',
              header: 'Client',
              sortKey: 'name',
              cell: (c) => (
                <span className="flex items-center gap-2.5 font-medium text-ink">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 flex-none rounded-full"
                    style={{ background: clientHue(c.name) }}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{c.name}</span>
                    {/* the Health column is hidden on a phone, so the chip rides here */}
                    <HealthChip c={c} className="mt-1 sm:hidden" />
                  </span>
                  {c.automationLive && (
                    <span className="hidden text-micro font-medium text-status-ok sm:inline">
                      Bot live
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'accounts',
              header: 'Accounts',
              sortKey: 'accounts',
              align: 'right',
              className: 'hidden sm:table-cell',
              cell: (c) => c.connectionCount,
            },
            {
              key: 'published',
              header: 'Published this week',
              sortKey: 'published',
              align: 'right',
              className: 'hidden whitespace-nowrap md:table-cell',
              cell: (c) => c.publishedThisWeek,
            },
            {
              key: 'followers',
              header: 'Followers',
              sortKey: 'followers',
              align: 'right',
              className: 'hidden lg:table-cell',
              cell: (c) => c.followers?.toLocaleString() ?? '—',
            },
            {
              key: 'next',
              header: 'Next scheduled',
              className: 'hidden whitespace-nowrap lg:table-cell',
              cell: (c) => (
                <span className={c.nextPublishAt ? 'text-ink' : 'text-muted'}>
                  {nextPublishLabel(c.nextPublishAt)}
                </span>
              ),
            },
            {
              key: 'health',
              header: 'Health',
              className: 'hidden sm:table-cell',
              cell: (c) => <HealthChip c={c} />,
            },
          ]}
          rowActions={(c) => {
            const showing = openInvite === c.workspaceId;
            return (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={showing}
                  aria-controls={`connect-${c.workspaceId}`}
                  onClick={() => setOpenInvite(showing ? null : c.workspaceId)}
                >
                  <LinkSimple size={14} />
                  <span className="sm:hidden">Connect</span>
                  <span className="hidden sm:inline">Connect accounts</span>
                </Button>
                <RowMenu
                  label={`Actions for ${c.name}`}
                  items={[
                    ...(owns(c.workspaceId)
                      ? [
                          {
                            label: 'Add a person to this client',
                            icon: <UsersThree size={14} />,
                            onSelect: () => setPeopleClient(c),
                          },
                        ]
                      : []),
                    {
                      label: 'Open content',
                      icon: <SquaresFour size={14} />,
                      onSelect: () => void openContent(c),
                    },
                    {
                      label: 'Open connections',
                      icon: <PlugsConnected size={14} />,
                      onSelect: () => void connectNow(c),
                    },
                  ]}
                />
              </>
            );
          }}
        />
      )}

      {peopleClient && (
        <ClientPeopleModal
          workspaceId={peopleClient.workspaceId}
          name={peopleClient.name}
          onClose={() => setPeopleClient(null)}
        />
      )}
      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  );
}
