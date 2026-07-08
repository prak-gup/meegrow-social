import { useCallback, useEffect, useState } from 'react';
import type { ConnectionHealth, ConnectionView } from '@meegrow-social/contracts';
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

export function Connections() {
  const [conns, setConns] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<ConnectionView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConns((await api.listConnections()).connections);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async (provider: string) => {
    setMsg(null);
    try {
      const { url } = await api.authUrl(provider);
      window.open(url, '_blank', 'width=600,height=700');
      setMsg('Authorize in the popup, then click Refresh to see the new connection.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'failed to start connect');
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
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => void connect('fake')}>
            Connect Fake Provider
          </Button>
        </div>
      </div>

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : conns.length === 0 ? (
        <p className="text-muted-foreground">No connections yet.</p>
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
                    <dt className="inline text-muted-foreground">Provider: </dt>
                    <dd className="inline">{c.provider}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Account: </dt>
                    <dd className="inline">{c.externalId}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Expires in: </dt>
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

      {detail && (
        <Modal title="Account health" onClose={() => setDetail(null)}>
          <dl className="space-y-1 text-sm">
            <div>
              <dt className="inline text-muted-foreground">Status: </dt>
              <dd className="inline">{detail.health}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Provider: </dt>
              <dd className="inline">{detail.provider}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">External ID: </dt>
              <dd className="inline">{detail.externalId}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Expires at: </dt>
              <dd className="inline">
                {detail.expiresAt ? new Date(detail.expiresAt).toLocaleString() : 'no expiry'}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Expires in: </dt>
              <dd className="inline">
                {detail.expiresInDays == null ? 'never' : `${detail.expiresInDays} days`}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Needs reconnect: </dt>
              <dd className="inline">{String(detail.needsReconnect)}</dd>
            </div>
          </dl>
        </Modal>
      )}
    </div>
  );
}
