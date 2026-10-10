import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OverviewView, ClientOverview } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clientCover, clientHue, initial } from '../lib/clientHue';
import { AddClientModal } from '../components/AddClientModal';
import { PageHeader } from '../components/ui/PageHeader';
import { Table } from '../components/ui/Table';
import { Warning, WarningCircle, SquaresFour, Lightning, Plus } from '../lib/icons';

function healthLabel(c: ClientOverview): { text: string; pip: string } {
  if (c.health === 'bad') return { text: 'Reconnect', pip: 'bg-status-bad' };
  if (c.health === 'warn')
    return {
      text: c.failedThisWeek > 0 ? `${c.failedThisWeek} failed` : 'Queue empty',
      pip: 'bg-status-warn',
    };
  return { text: 'Healthy', pip: 'bg-status-ok' };
}

// The API client returns JSON as-is, so dates arrive as ISO strings despite the contract's Date type.
function whenLabel(value: Date | string | null): string {
  if (!value) return 'Nothing scheduled';
  const d = new Date(value);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tmr = new Date(now.getTime() + 86400_000);
  const isTomorrow = d.toDateString() === tmr.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today · ${time}`;
  if (isTomorrow) return `Tomorrow · ${time}`;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function Overview() {
  const { me, switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const [ov, setOv] = useState<OverviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOv(await api.overview());
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();
  const firstName = (me?.user.name ?? '').split(' ')[0] || '';

  const openClient = async (c: ClientOverview) => {
    await switchWorkspace(c.workspaceId);
    navigate('/content');
  };

  const attn = ov?.attention;
  const attentionCards = attn
    ? [
        {
          n: attn.failedPublishes,
          label: attn.failedPublishes === 1 ? 'Post failed to publish' : 'Posts failed to publish',
          Icon: WarningCircle,
          tone: 'crit' as const,
        },
        {
          n: attn.needsReconnect + attn.tokensExpiring,
          label: 'Connections need attention',
          Icon: Warning,
          tone: 'warn' as const,
        },
        {
          n: attn.emptyQueues,
          label: attn.emptyQueues === 1 ? 'Queue is empty' : 'Queues are empty',
          Icon: SquaresFour,
          tone: 'warn' as const,
        },
      ]
    : [];

  return (
    <div>
      <PageHeader
        title={`${greeting}${firstName ? `, ${firstName}` : ''}`}
        subtitle={
          ov
            ? `${ov.clients.length} clients · ${ov.weekTotals.publishedThisWeek} posts published this week`
            : 'Loading your clients…'
        }
      />

      {/* attention */}
      {attn &&
      (attn.failedPublishes || attn.needsReconnect || attn.tokensExpiring || attn.emptyQueues) ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {attentionCards.map((a, i) => (
            <div
              key={i}
              className="flex items-center gap-3.5 rounded-md border border-hairline bg-canvas p-4.5 hover:shadow-1"
            >
              <span
                className={
                  'grid h-11 w-11 flex-none place-items-center rounded-full ' +
                  (a.tone === 'crit'
                    ? 'bg-status-bad/10 text-status-bad'
                    : 'bg-status-warn/10 text-status-warn')
                }
              >
                <a.Icon size={22} />
              </span>
              <div className="flex flex-col gap-0.5">
                <span
                  className={
                    'tnum text-2xl font-semibold leading-none ' +
                    (a.tone === 'crit' ? 'text-error' : 'text-ink')
                  }
                >
                  {a.n}
                </span>
                <span className="text-sm text-ink">{a.label}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        !loading && (
          <div className="mt-5 rounded-md border border-hairline bg-surface-soft p-5 text-sm text-muted">
            All clear — nothing needs you right now.
          </div>
        )
      )}

      {/* clients */}
      <div className="mb-3.5 mt-9 flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Your clients</h2>
        <button
          className="text-sm underline underline-offset-4"
          onClick={() => navigate('/clients')}
        >
          Manage all
        </button>
      </div>
      <div className="grid grid-cols-tiles gap-x-5 gap-y-6">
        {(ov?.clients ?? []).map((c) => {
          const h = healthLabel(c);
          return (
            <button key={c.workspaceId} className="text-left" onClick={() => void openClient(c)}>
              <div
                className="relative grid aspect-cover place-items-center overflow-hidden rounded-md text-white"
                style={{ background: clientCover(c.name) }}
              >
                <span className="text-4xl font-bold opacity-95">{initial(c.name)}</span>
                <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-ink shadow-1">
                  <span className={'h-2 w-2 rounded-full ' + h.pip} />
                  {h.text}
                </span>
                {c.automationLive && (
                  <span className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-scrim/60 px-2.5 py-1 text-micro font-semibold text-white">
                    <Lightning size={11} weight="fill" className="text-status-ok" />
                    Bot live
                  </span>
                )}
              </div>
              <div className="pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold">{c.name}</span>
                  <span className="tnum text-body font-semibold">{c.publishedThisWeek}</span>
                </div>
                <div className="mt-0.5 text-sm text-muted">
                  {c.connectionCount} {c.connectionCount === 1 ? 'account' : 'accounts'}
                  {c.followers != null ? ` · ${c.followers.toLocaleString()} followers` : ''}
                </div>
                <div className="mt-0.5 text-sm text-muted">{whenLabel(c.nextPublishAt)}</div>
              </div>
            </button>
          );
        })}

        {/* add tile */}
        <button
          onClick={() => setAdding(true)}
          className="grid aspect-cover place-items-center rounded-md border-1.5 border-dashed border-hairline-strong bg-surface-soft text-muted hover:border-ink hover:bg-canvas hover:text-ink"
        >
          <span className="flex flex-col items-center gap-2 text-sm font-semibold">
            <span className="grid h-11 w-11 place-items-center rounded-full border border-hairline bg-canvas">
              <Plus size={18} weight="bold" />
            </span>
            Add client
          </span>
        </button>
      </div>

      {/* publishing next */}
      {ov && ov.upcoming.length > 0 && (
        <>
          <div className="mb-3.5 mt-9 flex items-baseline justify-between">
            <h2 className="text-xl font-semibold tracking-tight">Publishing next</h2>
          </div>
          <Table
            caption="Publishing next"
            rows={ov.upcoming}
            rowKey={(u, i) => `${i}-${u.workspaceName}`}
            columns={[
              {
                key: 'when',
                header: 'When',
                className: 'whitespace-nowrap text-muted',
                cell: (u) => whenLabel(u.publishAt),
              },
              {
                key: 'client',
                header: 'Client',
                className: 'hidden sm:table-cell',
                cell: (u) => (
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 flex-none rounded-full"
                      style={{ background: clientHue(u.workspaceName) }}
                    />
                    {u.workspaceName}
                  </span>
                ),
              },
              {
                key: 'caption',
                header: 'Post',
                className: 'max-w-0 w-full truncate',
                cell: (u) => u.caption || '(no caption)',
              },
            ]}
          />
        </>
      )}

      <div className="mt-7 rounded-md bg-surface-soft p-5 text-sm leading-relaxed text-body-ink">
        <b className="text-ink">Why this is the home screen, not a chart wall.</b> Your bot
        publishes through per-client API keys, so your attention belongs on what it got wrong or is
        about to send — failed posts, dead tokens, empty queues — then a glance at each client. Full
        analytics graphs live one click deeper, where you go on purpose.
      </div>

      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  );
}
