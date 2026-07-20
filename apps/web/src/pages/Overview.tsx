import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OverviewView, ClientOverview } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clientCover, clientHue, initial } from '../lib/clientHue';
import { AddClientModal } from '../components/AddClientModal';
import { Warning, WarningCircle, SquaresFour, Lightning, Plus, CaretRight } from '../lib/icons';

function healthLabel(c: ClientOverview): { text: string; pip: string } {
  if (c.health === 'bad') return { text: 'Reconnect', pip: 'bg-status-bad' };
  if (c.health === 'warn')
    return {
      text: c.failedThisWeek > 0 ? `${c.failedThisWeek} failed` : 'Queue empty',
      pip: 'bg-status-warn',
    };
  return { text: 'Healthy', pip: 'bg-status-ok' };
}

function whenLabel(d: Date | null): string {
  if (!d) return 'Nothing scheduled';
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
      <h1 className="text-[26px] font-semibold tracking-tight">
        {greeting}
        {firstName ? `, ${firstName}` : ''}
      </h1>
      <p className="text-[15px] text-muted">
        {ov
          ? `${ov.clients.length} clients · ${ov.weekTotals.publishedThisWeek} posts published this week`
          : 'Loading your clients…'}
      </p>

      {/* attention */}
      {attn &&
      (attn.failedPublishes || attn.needsReconnect || attn.tokensExpiring || attn.emptyQueues) ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {attentionCards.map((a, i) => (
            <div
              key={i}
              className="flex items-center gap-3.5 rounded-md border border-hairline bg-canvas p-[18px] hover:shadow-1"
            >
              <span
                className={
                  'grid h-11 w-11 flex-none place-items-center rounded-full ' +
                  (a.tone === 'crit' ? 'bg-[#fdece8] text-error' : 'bg-[#fff6e8] text-[#a5670a]')
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
      <div className="grid grid-cols-[repeat(auto-fill,minmax(238px,1fr))] gap-x-5 gap-y-6">
        {(ov?.clients ?? []).map((c) => {
          const h = healthLabel(c);
          return (
            <button key={c.workspaceId} className="text-left" onClick={() => void openClient(c)}>
              <div
                className="relative grid aspect-[20/13] place-items-center overflow-hidden rounded-md text-white"
                style={{ background: clientCover(c.name) }}
              >
                <span className="text-4xl font-bold opacity-95">{initial(c.name)}</span>
                <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-ink shadow-1">
                  <span className={'h-2 w-2 rounded-full ' + h.pip} />
                  {h.text}
                </span>
                {c.automationLive && (
                  <span className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white">
                    <Lightning size={11} weight="fill" className="text-[#CBFB45]" />
                    Bot live
                  </span>
                )}
              </div>
              <div className="pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold">{c.name}</span>
                  <span className="tnum text-[15px] font-semibold">{c.publishedThisWeek}</span>
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
          className="grid aspect-[20/13] place-items-center rounded-md border-[1.5px] border-dashed border-hairline-strong bg-surface-soft text-muted hover:border-ink hover:bg-canvas hover:text-ink"
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
          <div className="overflow-hidden rounded-md border border-hairline">
            {ov.upcoming.map((u, i) => (
              <div
                key={i}
                className="grid grid-cols-[130px_1fr_auto] items-center gap-4 border-t border-hairline-soft px-5 py-3.5 first:border-t-0 hover:bg-surface-soft"
              >
                <div className="text-sm text-muted">{whenLabel(u.publishAt)}</div>
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className="h-2.5 w-2.5 flex-none rounded-full"
                    style={{ background: clientHue(u.workspaceName) }}
                  />
                  <span className="truncate text-[15px]">{u.caption || '(no caption)'}</span>
                </div>
                <CaretRight size={16} className="text-muted" />
              </div>
            ))}
          </div>
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
