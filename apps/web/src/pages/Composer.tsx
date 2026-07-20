import { useEffect, useState } from 'react';
import type {
  ConnectionView,
  CreatePostInput,
  MediaRef,
  QueueView,
} from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Label } from '../components/ui/Label';
import { Select } from '../components/ui/Select';
import { Textarea } from '../components/ui/Textarea';

type ScheduleMode = 'draft' | 'now' | 'at' | 'queue';

export function Composer() {
  const [conns, setConns] = useState<ConnectionView[]>([]);
  const [queues, setQueues] = useState<QueueView[]>([]);
  const [caption, setCaption] = useState('');
  const [media, setMedia] = useState<MediaRef[]>([]);
  const [connId, setConnId] = useState('');
  const [mode, setMode] = useState<ScheduleMode>('draft');
  const [at, setAt] = useState('');
  const [queueId, setQueueId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([api.listConnections(), api.listQueues()]).then(([c, q]) => {
      setConns(c.connections);
      setQueues(q.queues);
      if (c.connections[0]) setConnId(c.connections[0].id);
      if (q.queues[0]) setQueueId(q.queues[0].id);
    });
  }, []);

  const upload = async (files: FileList | null) => {
    if (!files) return;
    setMsg(null);
    for (const f of Array.from(files)) {
      try {
        const m = await api.uploadMedia(f);
        setMedia((prev) => [...prev, { mediaId: m.id, kind: m.kind, url: m.url ?? undefined }]);
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'media upload failed');
      }
    }
  };

  const submit = async () => {
    if (!connId) {
      setMsg('Pick a connection first.');
      return;
    }
    const conn = conns.find((c) => c.id === connId);
    if (!conn) return;
    if (mode === 'at' && !at) {
      setMsg('Pick a date/time for the "at" schedule.');
      return;
    }
    if (mode === 'queue' && !queueId) {
      setMsg('Pick a queue.');
      return;
    }

    const schedule: CreatePostInput['schedule'] =
      mode === 'draft'
        ? { type: 'draft' }
        : mode === 'now'
          ? { type: 'now' }
          : mode === 'at'
            ? { type: 'at', publishAt: new Date(at) }
            : { type: 'queue', queueId };

    setBusy(true);
    setMsg(null);
    try {
      const res = await api.createPost({
        caption,
        media,
        variants: [{ connectionId: connId, provider: conn.provider }],
        schedule,
      });
      setMsg(`Created ${res.posts.length} post(s), status: ${res.posts[0]?.status ?? 'unknown'}.`);
      setCaption('');
      setMedia([]);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Composer</h1>
      <Card>
        <CardHeader>
          <CardTitle>New post</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="caption">Caption</Label>
            <Textarea
              id="caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write something…"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="media">Media</Label>
            <Input id="media" type="file" multiple onChange={(e) => void upload(e.target.files)} />
            {media.length > 0 && (
              <p className="text-xs text-muted">{media.length} media attached</p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="conn">Connection</Label>
              <Select id="conn" value={connId} onChange={(e) => setConnId(e.target.value)}>
                {conns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.provider})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="mode">Schedule</Label>
              <Select
                id="mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as ScheduleMode)}
              >
                <option value="draft">Save as draft</option>
                <option value="now">Publish now</option>
                <option value="at">Schedule at date/time</option>
                <option value="queue">Add to queue</option>
              </Select>
            </div>
          </div>

          {mode === 'at' && (
            <div className="space-y-1">
              <Label htmlFor="at">Publish at</Label>
              <Input
                id="at"
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
            </div>
          )}
          {mode === 'queue' && (
            <div className="space-y-1">
              <Label htmlFor="queue">Queue</Label>
              <Select id="queue" value={queueId} onChange={(e) => setQueueId(e.target.value)}>
                {queues.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {msg && <p className="text-sm text-muted">{msg}</p>}
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create post'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
