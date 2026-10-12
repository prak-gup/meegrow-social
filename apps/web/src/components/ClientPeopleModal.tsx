import { useCallback, useEffect, useState } from 'react';
import type {
  AddClientPersonInput,
  ClientPersonView,
  CreatedClientPersonView,
} from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import { Select } from './ui/Select';

export function ClientPeopleModal({
  workspaceId,
  name,
  onClose,
}: {
  workspaceId: string;
  name: string;
  onClose: () => void;
}) {
  const [people, setPeople] = useState<ClientPersonView[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AddClientPersonInput['role']>('member');
  const [created, setCreated] = useState<CreatedClientPersonView | null>(null);
  const [removing, setRemoving] = useState<ClientPersonView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setPeople((await api.listClientPeople(workspaceId)).people);
  }, [workspaceId]);
  useEffect(() => {
    void load().catch(() => setErr('Could not load people. Close and try again.'));
  }, [load]);

  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      const result = await api.addClientPerson(workspaceId, { email, role });
      setCreated(result);
      setEmail('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add the person.');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setErr(null);
    try {
      await api.removeClientPerson(workspaceId, removing.userId);
      setRemoving(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not remove the person.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a person to this client" onClose={onClose}>
      <p className="mb-4 text-sm text-muted">
        App access to {name} only. This is separate from an account connection invite.
      </p>
      {created ? (
        <div role="status" className="space-y-3 rounded-sm border border-hairline p-3">
          <p className="text-sm">
            Added {created.person.email} as {created.person.role}.
          </p>
          <Label htmlFor="temporary-password">Temporary password — shown once</Label>
          <Input
            id="temporary-password"
            readOnly
            autoComplete="off"
            value={created.temporaryPassword}
            onFocus={(e) => e.target.select()}
          />
          <p className="text-sm text-muted">
            Share it privately. Ask them to sign in and use Change password in their account menu.
            Closing this panel loses the password; it cannot be shown again.
          </p>
          <Button variant="outline" onClick={() => setCreated(null)}>
            I’ve saved it privately
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
          className="space-y-3"
        >
          <div>
            <Label htmlFor="person-email">Email</Label>
            <Input
              id="person-email"
              type="email"
              required
              maxLength={254}
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="person-role">Role for this client</Label>
            <Select
              id="person-role"
              value={role}
              onChange={(e) => setRole(e.target.value as AddClientPersonInput['role'])}
            >
              <option value="member">Member — publish and connect accounts</option>
              <option value="viewer">Viewer — read only</option>
              <option value="admin">Admin — member access and API keys</option>
            </Select>
          </div>
          <Button type="submit" disabled={busy || !email.trim()}>
            {busy ? 'Adding…' : 'Add person'}
          </Button>
        </form>
      )}
      <h4 className="mb-2 mt-5 text-sm font-semibold">People with access</h4>
      <ul className="space-y-2">
        {people.map((p) => (
          <li key={p.userId} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 break-words">
              {p.email} · {p.role}
            </span>
            {p.role !== 'owner' && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setRemoving(p)}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {removing && (
        <div className="mt-3 space-y-2 rounded-sm border border-hairline p-3">
          <p className="text-sm">
            Remove {removing.email} from {name}? They will be signed out of every session.
          </p>
          <Button disabled={busy} onClick={() => void remove()}>
            Remove person
          </Button>{' '}
          <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
            Cancel
          </Button>
        </div>
      )}
      {err && (
        <p role="alert" className="mt-3 text-sm text-error">
          {err}
        </p>
      )}
    </Modal>
  );
}
