import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OverviewView, ClientOverview, ProviderView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clientHue, initial } from '../lib/clientHue';
import { providerVisible } from '../lib/devProviders';
import { platformMeta } from '../lib/platforms';
import { AddClientModal } from '../components/AddClientModal';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { Plus, LinkSimple, Copy, PlugsConnected } from '../lib/icons';

function pip(c: ClientOverview): { text: string; cls: string } {
  if (c.health === 'bad') return { text: 'Reconnect an account', cls: 'bg-status-bad' };
  if (c.health === 'warn')
    return {
      text: c.failedThisWeek > 0 ? `${c.failedThisWeek} failed` : 'Queue empty',
      cls: 'bg-status-warn',
    };
  return { text: c.automationLive ? 'Healthy · bot live' : 'Healthy', cls: 'bg-status-ok' };
}

/**
 * The two ways to get a client's accounts connected, kept visibly apart: send the client a link
 * they open themselves (one per platform, minted for THIS client without switching the operator's
 * active client), or connect it yourself — which does switch, and says so.
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
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const mint = async (provider: string) => {
    setBusy(provider);
    setErr(null);
    try {
      const { url } = await api.createInvite(provider, client.workspaceId);
      setLinks((l) => ({ ...l, [provider]: url }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the link.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-6 mb-4 grid gap-4 rounded-md bg-surface-soft p-4 lg:grid-cols-[1fr_auto]">
      <div>
        <div className="text-caption font-semibold text-ink">Send {client.name} a link</div>
        <p className="mt-1 text-caption text-muted">
          One link per platform. They open it, sign in, and choose the account — no login here, and
          their password never reaches you. A link works for 14 days.
        </p>
        {providers === null && <p className="mt-3 text-caption text-muted">Loading platforms…</p>}
        {providers?.length === 0 && (
          <p className="mt-3 text-caption text-muted">
            No platform can be connected in this environment yet.
          </p>
        )}
        <ul className="mt-3 space-y-2">
          {(providers ?? []).map((p) => {
            const meta = platformMeta(p);
            const url = links[p.identifier];
            return (
              <li
                key={p.identifier}
                className="flex flex-wrap items-center gap-3 rounded-sm border border-hairline bg-canvas px-3.5 py-2.5"
              >
                <span
                  className={`grid h-7 w-7 flex-none place-items-center rounded-xs text-white ${meta.brand}`}
                >
                  <meta.Icon size={16} weight="fill" />
                </span>
                <span className="w-32 flex-none text-sm font-medium">{meta.label}</span>
                {url ? (
                  <>
                    <code className="min-w-0 flex-1 truncate font-mono text-sm text-ink">
                      {url}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(url)
                          .then(() => setCopied(p.identifier));
                      }}
                    >
                      <Copy size={16} />
                      {copied === p.identifier ? 'Copied' : 'Copy link'}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    disabled={busy !== null}
                    onClick={() => void mint(p.identifier)}
                  >
                    <LinkSimple size={16} />
                    {busy === p.identifier ? 'Creating…' : 'Create link'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {err && <p className="mt-3 text-caption text-error">{err}</p>}
      </div>

      <div className="lg:w-64 lg:border-l lg:border-hairline lg:pl-4">
        <div className="text-caption font-semibold text-ink">Or connect it yourself now</div>
        <p className="mt-1 text-caption text-muted">
          For accounts you can sign into. This switches you to {client.name} and opens their
          Connections page.
        </p>
        <Button className="mt-3" size="sm" onClick={onConnectYourself}>
          <PlugsConnected size={16} />
          Go to {client.name}’s connections
        </Button>
      </div>
    </div>
  );
}

export function Clients() {
  const { switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const [ov, setOv] = useState<OverviewView | null>(null);
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

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle={`${ov?.clients.length ?? '…'} clients · add one, or send a client a link they open to connect their own accounts`}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus size={18} weight="bold" />
            Add client
          </Button>
        }
      />

      <div className="overflow-hidden rounded-md border border-hairline">
        <div className="grid grid-cols-[1fr_auto] sm:grid-cols-clients gap-4 bg-surface-soft px-6 py-3 text-xs font-bold text-muted">
          <span>Client</span>
          <span className="hidden sm:block">This week</span>
          <span className="hidden sm:block">Health</span>
          <span />
        </div>
        {(ov?.clients ?? []).map((c) => {
          const p = pip(c);
          const showing = openInvite === c.workspaceId;
          return (
            <div key={c.workspaceId} className="border-t border-hairline-soft">
              <div className="grid grid-cols-[1fr_auto] sm:grid-cols-clients items-center gap-4 px-6 py-4">
                <div className="flex items-center gap-3.5">
                  <span
                    className="grid h-11 w-11 flex-none place-items-center rounded-md font-bold text-white"
                    style={{ background: clientHue(c.name) }}
                  >
                    {initial(c.name)}
                  </span>
                  <div>
                    <div className="text-base font-semibold">{c.name}</div>
                    <div className="text-caption text-muted">
                      {c.connectionCount} {c.connectionCount === 1 ? 'account' : 'accounts'}{' '}
                      connected
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-caption text-muted sm:hidden">
                      <span className={'h-2 w-2 flex-none rounded-full ' + p.cls} />
                      {p.text}
                    </div>
                  </div>
                </div>
                <div className="tnum hidden text-body sm:block">
                  {c.publishedThisWeek} published
                </div>
                <div className="hidden items-center gap-2 text-sm sm:flex">
                  <span className={'h-2 w-2 flex-none rounded-full ' + p.cls} />
                  {p.text}
                </div>
                <div className="flex items-center gap-2 justify-self-end">
                  <button
                    onClick={() => setOpenInvite(showing ? null : c.workspaceId)}
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-hairline px-3.5 text-sm font-medium hover:border-ink"
                  >
                    <LinkSimple size={16} />
                    <span className="sm:hidden">Connect</span>
                    <span className="hidden sm:inline">Connect accounts</span>
                  </button>
                </div>
              </div>

              {showing && (
                <ConnectPanel
                  client={c}
                  providers={providers}
                  onConnectYourself={() => void connectNow(c)}
                />
              )}
            </div>
          );
        })}
        {ov && ov.clients.length === 0 && (
          <div className="px-6 py-10 text-center text-muted">
            No clients yet. Add your first one to start publishing.
          </div>
        )}
      </div>

      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  );
}
