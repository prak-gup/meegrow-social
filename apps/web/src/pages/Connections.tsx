import { useCallback, useEffect, useState } from 'react';
import type {
  CallbackResult,
  ConnectionHealth,
  ConnectionView,
  ProviderAccountView,
  ProviderView,
} from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';

const HEALTH_VARIANT: Record<ConnectionHealth, 'success' | 'warning' | 'danger'> = {
  healthy: 'success',
  expiring: 'warning',
  needs_reconnect: 'danger',
};

/** What the OAuth popup posts back to us (#45). `error` is the popup's own failure shape. */
type ConnectMessage = CallbackResult | { status: 'error'; error: string };

/** Pending two-phase selection: the popup is gone, but the flow needs an account picked. */
interface PendingPick {
  flowId: string;
  accounts: ProviderAccountView[];
}

export function Connections() {
  const [conns, setConns] = useState<ConnectionView[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<ConnectionView | null>(null);
  const [pick, setPick] = useState<PendingPick | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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

  // The popup hands us the callback result (single-step: done; two-step: pick an account).
  // Only same-origin messages carrying our marker are trusted — the popup posts to our origin.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { source?: string; payload?: ConnectMessage } | null;
      if (data?.source !== 'meegrow-social-connect' || !data.payload) return;

      const payload = data.payload;
      if (payload.status === 'error') {
        setMsg(`Connect failed: ${payload.error}`);
      } else if (payload.status === 'choose_account') {
        setPick({ flowId: payload.flowId, accounts: payload.accounts });
      } else {
        setMsg('Connected.');
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
      setMsg('Authorize in the popup…');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'failed to start connect');
    }
  };

  const choose = async (externalId: string) => {
    if (!pick) return;
    try {
      await api.finishConnect(pick.flowId, externalId);
      setPick(null);
      setMsg('Connected.');
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'failed to finish connect');
    }
  };

  const disconnect = async (id: string) => {
    await api.deleteConnection(id);
    void load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Connections</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
          {/* One button per provider registered in this environment — real platforms appear only
              where their credentials are configured, so dev shows the fakes and prod shows Meta. */}
          {providers.map((p) => (
            <Button key={p.identifier} size="sm" onClick={() => void connect(p.identifier)}>
              Connect {p.displayName}
            </Button>
          ))}
        </div>
      </div>

      {msg && <p className="text-sm text-muted">{msg}</p>}

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : conns.length === 0 ? (
        <p className="text-muted">No connections yet.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {conns.map((c) => (
            <Card key={c.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{c.displayName}</CardTitle>
                  <Badge variant={HEALTH_VARIANT[c.health]}>{c.health.replace('_', ' ')}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <dl className="space-y-1 text-sm">
                  <div>
                    <dt className="inline text-muted">Provider: </dt>
                    <dd className="inline">{c.provider}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted">Account: </dt>
                    <dd className="inline">{c.externalId}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted">Expires in: </dt>
                    <dd className="inline">
                      {c.expiresInDays == null ? 'never' : `${c.expiresInDays}d`}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setDetail(c)}>
                    Account health
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => void disconnect(c.id)}>
                    Disconnect
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Two-phase providers (FB Page, IG account, LinkedIn org, YouTube channel, GBP location):
          the user authorized, now they pick which asset to connect. */}
      {pick && (
        <Modal title="Choose an account to connect" onClose={() => setPick(null)}>
          {pick.accounts.length === 0 ? (
            <p className="text-sm text-muted">
              This login didn&apos;t return any manageable accounts. Check you granted access to at
              least one, then try connecting again.
            </p>
          ) : (
            <ul className="space-y-2">
              {pick.accounts.map((a) => (
                <li key={a.externalId} className="flex items-center justify-between gap-3">
                  <div className="text-sm">
                    <p className="font-medium">{a.displayName}</p>
                    <p className="text-muted">{a.externalId}</p>
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

      {detail && (
        <Modal title="Account health" onClose={() => setDetail(null)}>
          <dl className="space-y-1 text-sm">
            <div>
              <dt className="inline text-muted">Status: </dt>
              <dd className="inline">{detail.health}</dd>
            </div>
            <div>
              <dt className="inline text-muted">Provider: </dt>
              <dd className="inline">{detail.provider}</dd>
            </div>
            <div>
              <dt className="inline text-muted">External ID: </dt>
              <dd className="inline">{detail.externalId}</dd>
            </div>
            <div>
              <dt className="inline text-muted">Expires at: </dt>
              <dd className="inline">
                {detail.expiresAt ? new Date(detail.expiresAt).toLocaleString() : 'no expiry'}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted">Expires in: </dt>
              <dd className="inline">
                {detail.expiresInDays == null ? 'never' : `${detail.expiresInDays} days`}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted">Needs reconnect: </dt>
              <dd className="inline">{String(detail.needsReconnect)}</dd>
            </div>
          </dl>
        </Modal>
      )}
    </div>
  );
}
