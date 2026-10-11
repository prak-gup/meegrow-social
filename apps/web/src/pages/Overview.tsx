import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OverviewView, ClientOverview } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clientHue } from '../lib/clientHue';
import { clientChip } from '../lib/statusChip';
import { nextPublishLabel } from '../lib/clientRows';
import { AddClientModal } from '../components/AddClientModal';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusChip } from '../components/ui/StatusChip';
import { Table } from '../components/ui/Table';
import { Warning, WarningCircle, SquaresFour, CheckCircle, Plus } from '../lib/icons';

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
  const attention = attn
    ? [
        {
          n: attn.failedPublishes,
          label: attn.failedPublishes === 1 ? 'post failed to publish' : 'posts failed to publish',
          Icon: WarningCircle,
          tone: 'text-status-bad',
        },
        {
          n: attn.needsReconnect + attn.tokensExpiring,
          label: 'connections need attention',
          Icon: Warning,
          tone: 'text-status-warn',
        },
        {
          n: attn.emptyQueues,
          label: attn.emptyQueues === 1 ? 'queue is empty' : 'queues are empty',
          Icon: SquaresFour,
          tone: 'text-status-warn',
        },
      ]
    : [];
  const anyAttention =
    attn &&
    (attn.failedPublishes || attn.needsReconnect || attn.tokensExpiring || attn.emptyQueues);

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

      {/* attention: one strip, not three tiles */}
      {anyAttention ? (
        <ul
          aria-label="Needs attention"
          className="grid divide-y divide-hairline-soft rounded-md border border-hairline bg-canvas sm:grid-cols-3 sm:divide-x sm:divide-y-0"
        >
          {attention.map((a) => (
            <li key={a.label} className="flex items-center gap-2.5 px-3 py-2.5">
              <a.Icon size={16} aria-hidden="true" className={a.n > 0 ? a.tone : 'text-muted'} />
              <span
                className={
                  'tnum text-xl font-semibold leading-none ' + (a.n > 0 ? a.tone : 'text-muted')
                }
              >
                {a.n}
              </span>
              <span className="text-sm text-body-ink">{a.label}</span>
            </li>
          ))}
        </ul>
      ) : (
        !loading && (
          <div className="flex items-center gap-2 rounded-md border border-hairline bg-surface-soft px-3 py-2.5 text-sm text-muted">
            <CheckCircle size={16} className="text-status-ok" aria-hidden="true" />
            All clear — nothing needs you right now.
          </div>
        )
      )}

      {/* clients */}
      <div className="mb-2 mt-5 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Your clients</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="min-h-11 text-sm text-muted underline underline-offset-4 hover:text-ink md:min-h-0"
            onClick={() => navigate('/clients')}
          >
            Manage all
          </button>
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus size={14} weight="bold" />
            Add client
          </Button>
        </div>
      </div>
      <Table
        caption="Your clients"
        dense
        rows={ov?.clients ?? []}
        rowKey={(c) => c.workspaceId}
        onRowClick={(c) => void openClient(c)}
        empty={{
          title: loading ? 'Loading…' : 'No clients yet',
          description: loading ? undefined : 'Add your first one to start publishing.',
        }}
        columns={[
          {
            key: 'client',
            header: 'Client',
            cell: (c) => (
              <span className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 flex-none rounded-full"
                  style={{ background: clientHue(c.name) }}
                />
                <button
                  type="button"
                  className="min-h-11 truncate text-left font-medium text-ink hover:underline md:min-h-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openClient(c);
                  }}
                >
                  {c.name}
                </button>
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
            align: 'right',
            className: 'hidden sm:table-cell',
            cell: (c) => c.connectionCount,
          },
          {
            key: 'published',
            header: 'Published this week',
            align: 'right',
            className: 'hidden whitespace-nowrap md:table-cell',
            cell: (c) => c.publishedThisWeek,
          },
          {
            key: 'followers',
            header: 'Followers',
            align: 'right',
            className: 'hidden lg:table-cell',
            cell: (c) =>
              c.followers != null ? (
                c.followers.toLocaleString()
              ) : (
                <span className="text-muted">—</span>
              ),
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
            cell: (c) => {
              const chip = clientChip(c.health, c.failedThisWeek);
              return <StatusChip status={chip.status} label={chip.label} />;
            },
          },
        ]}
      />

      {/* publishing next */}
      {ov && ov.upcoming.length > 0 && (
        <>
          <h2 className="mb-2 mt-5 text-base font-semibold text-ink">Publishing next</h2>
          <Table
            caption="Publishing next"
            dense
            rows={ov.upcoming}
            rowKey={(u, i) => `${i}-${u.workspaceName}`}
            columns={[
              {
                key: 'when',
                header: 'When',
                className: 'whitespace-nowrap text-muted',
                cell: (u) => nextPublishLabel(u.publishAt),
              },
              {
                key: 'client',
                header: 'Client',
                className: 'hidden whitespace-nowrap sm:table-cell',
                cell: (u) => (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 flex-none rounded-full"
                      style={{ background: clientHue(u.workspaceName) }}
                    />
                    {u.workspaceName}
                  </span>
                ),
              },
              {
                key: 'caption',
                header: 'Post',
                className: 'w-full max-w-0 truncate',
                cell: (u) => u.caption || '(no caption)',
              },
            ]}
          />
        </>
      )}

      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  );
}
