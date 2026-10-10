import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OverviewView, ClientOverview } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clientHue, initial } from '../lib/clientHue';
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

/** The connect-invite link a client opens to grant access to their own accounts. */
function inviteSlug(c: ClientOverview): string {
  return `${c.slug}-${c.workspaceId.slice(0, 4)}`;
}

export function Clients() {
  const { switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const [ov, setOv] = useState<OverviewView | null>(null);
  const [adding, setAdding] = useState(false);
  const [openInvite, setOpenInvite] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setOv(await api.overview());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://social.meegrowlabs.com';

  const connectNow = async (c: ClientOverview) => {
    await switchWorkspace(c.workspaceId);
    navigate('/connections');
  };

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle={`${ov?.clients.length ?? '…'} clients · add one, or send a connect link a client opens to grant you access to their accounts`}
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
                    onClick={() => {
                      setCopied(false);
                      setOpenInvite(showing ? null : c.workspaceId);
                    }}
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-hairline px-3.5 text-sm font-medium hover:border-ink"
                  >
                    <LinkSimple size={16} />
                    <span className="sm:hidden">Invite</span>
                    <span className="hidden sm:inline">Invite to connect</span>
                  </button>
                </div>
              </div>

              {showing && (
                <div className="mx-6 mb-4 rounded-md bg-surface-soft p-4">
                  <div className="text-caption font-semibold text-ink">
                    Requesting Instagram · Facebook for {c.name}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <div className="flex min-w-field flex-1 items-center gap-2.5 rounded-sm border border-hairline bg-canvas px-3.5 py-2.5">
                      <LinkSimple size={16} className="text-muted" />
                      <code className="truncate font-mono text-sm text-ink">
                        {origin}/connect/{inviteSlug(c)}
                      </code>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(`${origin}/connect/${inviteSlug(c)}`)
                          .then(() => setCopied(true));
                      }}
                    >
                      <Copy size={16} />
                      {copied ? 'Copied' : 'Copy link'}
                    </Button>
                    <Button onClick={() => void connectNow(c)}>
                      <PlugsConnected size={16} />
                      Connect now
                    </Button>
                  </div>
                  <p className="mt-3 text-caption text-muted">
                    Send this to {c.name}. They open it, sign into the accounts they want you to
                    manage, and approve — the account connects here without their password ever
                    touching you. External self-serve grants unlock with Meta App Review (issue
                    #53); until then, use <b className="text-ink">Connect now</b> to authorise on
                    their behalf.
                  </p>
                </div>
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
