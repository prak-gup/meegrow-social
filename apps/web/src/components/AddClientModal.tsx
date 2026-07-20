import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import { clientHue } from '../lib/clientHue';

/**
 * Add a client (creates a workspace + owner membership, then drops you into connecting its first
 * account). Shared by the switcher, the Overview add-tile, and the Clients page — three ways in.
 */
export function AddClientModal({ onClose }: { onClose: () => void }) {
  const { refresh, switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const ws = await api.createWorkspace(name.trim());
      await refresh(); // pull the new membership into the session view
      await switchWorkspace(ws.workspaceId); // scope to the new client
      onClose();
      navigate('/connections'); // connect its first account
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add the client. Try again.');
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a client" onClose={onClose}>
      <p className="mb-5 text-sm text-muted">
        Create a workspace for the client, then connect their first account.
      </p>
      <div className="space-y-2">
        <Label htmlFor="client-name">Client name</Label>
        <Input
          id="client-name"
          autoFocus
          placeholder="e.g. Blossom Wellbeing"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
      </div>
      {name.trim() && (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted">
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ background: clientHue(name) }}
          />
          Its colour across the app
        </div>
      )}
      {err && <p className="mt-3 text-sm text-error">{err}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!name.trim() || busy}>
          {busy ? 'Creating…' : 'Create & connect account'}
        </Button>
      </div>
    </Modal>
  );
}
