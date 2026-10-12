import { keySortOptions, sortApiKeys, type KeySort } from '../lib/listSort';
import { SortSelect } from '../components/ui/SortSelect';
import { useUrlSort } from '../lib/useUrlSort';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ApiKeyView, CreatedApiKeyView } from '@meegrow-social/contracts';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import {
  API_KEY_STATUS,
  KEY_PLACEHOLDER,
  apiKeyStatus,
  curlSnippet,
  formatKeyDate,
  lastUsedLabel,
  mcpUrl,
  validateKeyName,
} from '../lib/apiKeys';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Input } from '../components/ui/Input';
import { Label } from '../components/ui/Label';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Copy, Key, Plus, Warning } from '../lib/icons';

// A 4xx body from these routes is not always a string, and HTTP/2 has no status text — fall back.
const messageOf = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

type CopyState = 'idle' | 'copied' | 'failed';

/** Clipboard write that reports failure instead of throwing (no clipboard on insecure origins). */
function useCopy() {
  const [state, setState] = useState<CopyState>('idle');
  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setState('copied');
      return true;
    } catch {
      setState('failed');
      return false;
    }
  }, []);
  return { state, copy };
}

export function ApiKeys() {
  const [sort, setSort] = useUrlSort('sort', keySortOptions, 'newest');
  const { me } = useAuth();
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyView | null>(null);

  const activeName =
    me?.user.memberships.find((m) => m.workspaceId === me.activeWorkspaceId)?.name ?? 'this client';

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const res = await api.listApiKeys();
      setKeys(res.apiKeys);
    } catch (e) {
      setLoadErr(messageOf(e, 'Could not load the API keys. Check your connection and try again.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Stable identities: Modal re-runs its focus effect whenever onClose changes.
  const closeCreate = useCallback(() => setCreating(false), []);
  const closeRevoke = useCallback(() => setRevoking(null), []);

  const createButton = (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus size={16} weight="bold" />
      Create key
    </Button>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="API keys"
        subtitle={`Keys that let scripts and agents post for ${activeName}.`}
        className="mb-0"
        actions={createButton}
      />

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wide text-muted">Keys</h2>
          <SortSelect
            value={sort}
            onChange={(v) => setSort(v as KeySort)}
            options={[...keySortOptions]}
          />
        </div>
        {loadErr ? (
          <ErrorState
            title="Could not load API keys"
            message={loadErr}
            onRetry={() => void load()}
          />
        ) : loading && keys.length === 0 ? (
          <p className="text-muted">Loading…</p>
        ) : keys.length === 0 ? (
          <EmptyState
            title="No API keys yet"
            description={`Create one to reach ${activeName} over the REST API or MCP.`}
            icon={Key}
            action={createButton}
          />
        ) : (
          <ul className="divide-y divide-hairline-soft rounded-md border border-hairline bg-canvas">
            {sortApiKeys(keys, sort).map((k) => (
              <KeyRow key={k.id} apiKey={k} onRevoke={() => setRevoking(k)} />
            ))}
          </ul>
        )}
      </section>

      <HowToUse activeName={activeName} />

      {creating && <CreateKeyModal onClose={closeCreate} onCreated={load} />}
      {revoking && <RevokeKeyModal apiKey={revoking} onClose={closeRevoke} onRevoked={load} />}
    </div>
  );
}

function KeyRow({ apiKey, onRevoke }: { apiKey: ApiKeyView; onRevoke: () => void }) {
  const status = apiKeyStatus(apiKey);
  const { label, variant } = API_KEY_STATUS[status];
  const inactive = status !== 'active';
  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5',
        inactive && 'bg-surface-soft',
      )}
    >
      <div className="min-w-0 flex-1 basis-full sm:basis-0">
        <div className="flex items-center gap-2.5">
          <span className={cn('truncate text-body font-semibold', inactive && 'text-muted')}>
            {apiKey.name}
          </span>
          <Badge variant={variant} className="flex-none">
            {label}
          </Badge>
        </div>
        <p className="mt-0.5 truncate font-mono text-caption text-muted">{apiKey.prefix}</p>
      </div>
      <dl className="tnum flex flex-1 gap-6 text-caption sm:flex-none">
        <div className="w-28">
          <dt className="text-muted">Created</dt>
          <dd className={inactive ? 'text-muted' : 'text-ink'}>
            {formatKeyDate(apiKey.createdAt)}
          </dd>
        </div>
        <div className="w-28">
          <dt className="text-muted">Last used</dt>
          <dd className={inactive ? 'text-muted' : 'text-ink'}>
            {lastUsedLabel(apiKey.lastUsedAt)}
          </dd>
        </div>
      </dl>
      {/* Fixed width so the columns line up whether or not the row still has an action. */}
      <div className="flex w-20 flex-none justify-end">
        {status !== 'revoked' && (
          <Button variant="ghost" size="sm" onClick={onRevoke} aria-label={`Revoke ${apiKey.name}`}>
            Revoke
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Create a key, then show its secret exactly once. The secret lives only in this component's state:
 * never logged, never persisted, and gone when the modal unmounts.
 */
function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKeyView | null>(null);
  const [nudged, setNudged] = useState(false);
  const { state: copyState, copy } = useCopy();
  const copied = copyState === 'copied';

  const nameRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);

  // Modal focuses its first focusable (the close button); send focus to where the work is, and
  // again when the form is swapped for the secret (its focused control has just unmounted).
  useEffect(() => {
    (created ? copyRef : nameRef).current?.focus();
  }, [created]);

  // Escape or a stray click outside would throw away a secret that can never be fetched again, so
  // the first dismissal of an uncopied key only warns. Read through a ref to keep onClose stable.
  const guard = useRef(false);
  useEffect(() => {
    guard.current = created !== null && !copied && !nudged;
  }, [created, copied, nudged]);
  const requestClose = useCallback(() => {
    if (guard.current) setNudged(true);
    else onClose();
  }, [onClose]);

  const problem = validateKeyName(name);
  const showProblem = problem !== null && (submitted || name.trim().length > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (problem || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setCreated(await api.createApiKey(name.trim()));
      onCreated(); // the new key joins the list behind the modal
    } catch (e) {
      setErr(messageOf(e, 'Could not create the key. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    if (!created) return;
    // If the clipboard is unavailable, leave the key selected so it can be copied by hand.
    if (!(await copy(created.secret))) secretRef.current?.select();
  };

  if (created) {
    return (
      <Modal title="Copy your key now" onClose={requestClose}>
        <p className="mb-4 text-sm text-muted">
          <b className="text-ink">{created.name}</b> is ready. Copy it and store it somewhere safe,
          like a password manager.
        </p>
        <div className="space-y-2">
          <Label htmlFor="api-key-secret">API key</Label>
          <div className="flex gap-2">
            <Input
              id="api-key-secret"
              ref={secretRef}
              readOnly
              value={created.secret}
              onFocus={(e) => e.currentTarget.select()}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 font-mono text-sm"
            />
            <Button
              ref={copyRef}
              variant="secondary"
              className="h-14 flex-none"
              onClick={() => void copySecret()}
            >
              <Copy size={16} />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p role="status" className="sr-only">
            {copied ? 'Key copied to clipboard.' : ''}
          </p>
          {copyState === 'failed' && (
            <p role="alert" className="text-sm text-error">
              Could not copy automatically. The key is selected — copy it by hand.
            </p>
          )}
        </div>
        <div className="mt-4 flex gap-2.5 rounded-sm border border-hairline bg-surface-soft px-3.5 py-3 text-sm text-ink">
          <Warning size={18} weight="fill" className="mt-0.5 flex-none text-status-warn" />
          <p>This key will not be shown again. If you lose it, revoke it and create a new one.</p>
        </div>
        {nudged && !copied && (
          <p role="alert" className="mt-3 text-sm text-error">
            You have not copied this key yet. Close again to leave without it.
          </p>
        )}
        <div className="mt-6 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create API key" onClose={requestClose}>
      <p className="mb-5 text-sm text-muted">
        Name it after what will use it, so you know which key to revoke later.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="space-y-2">
          <Label htmlFor="api-key-name">Key name</Label>
          <Input
            id="api-key-name"
            ref={nameRef}
            placeholder="e.g. Scheduling bot"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            aria-invalid={showProblem}
            aria-describedby={showProblem ? 'api-key-name-error' : undefined}
          />
          {showProblem && (
            <p id="api-key-name-error" role="alert" className="text-sm text-error">
              {problem}
            </p>
          )}
        </div>
        {err && (
          <p role="alert" className="mt-3 text-sm text-error">
            {err}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create key'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RevokeKeyModal({
  apiKey,
  onClose,
  onRevoked,
}: {
  apiKey: ApiKeyView;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.revokeApiKey(apiKey.id);
    } catch (e) {
      // 404 means it is already gone (revoked elsewhere) — the refreshed list will show that.
      if (!(e instanceof ApiError && e.status === 404)) {
        setErr(messageOf(e, 'Could not revoke the key. Try again.'));
        setBusy(false);
        return;
      }
    }
    onRevoked();
    onClose();
  };

  return (
    <Modal title="Revoke this key?" onClose={onClose}>
      <p className="text-sm text-muted">
        Anything using <b className="text-ink">{apiKey.name}</b>{' '}
        <span className="font-mono">({apiKey.prefix})</span> will stop working straight away. This
        cannot be undone.
      </p>
      {err && (
        <p role="alert" className="mt-3 text-sm text-error">
          {err}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Keep key
        </Button>
        <Button variant="destructive" onClick={() => void revoke()} disabled={busy}>
          {busy ? 'Revoking…' : 'Revoke key'}
        </Button>
      </div>
    </Modal>
  );
}

/** Examples only ever carry the placeholder — the real secret is shown once, in the create modal. */
function HowToUse({ activeName }: { activeName: string }) {
  const origin = window.location.origin;
  return (
    <Card>
      <CardHeader>
        <CardTitle>How to use it</CardTitle>
        <p className="text-sm text-muted">
          Send the key as a Bearer token. A key only reaches {activeName}. Replace{' '}
          <code className="font-mono text-ink">{KEY_PLACEHOLDER}</code> with the key you copied.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <Snippet label="REST API" text={curlSnippet(origin)} />
        <Snippet
          label="MCP endpoint"
          text={mcpUrl(origin)}
          note={
            <>
              Add it to your MCP client with the header{' '}
              <code className="font-mono text-ink">Authorization: Bearer {KEY_PLACEHOLDER}</code>.
            </>
          }
        />
      </CardContent>
    </Card>
  );
}

function Snippet({ label, text, note }: { label: string; text: string; note?: ReactNode }) {
  const { state, copy } = useCopy();
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted">{label}</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void copy(text)}
          aria-label={`Copy ${label} example`}
        >
          <Copy size={16} />
          {state === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {/* Focusable so a keyboard user can scroll a line that overflows on a phone. */}
      <pre
        tabIndex={0}
        aria-label={`${label} example`}
        className="overflow-x-auto rounded-sm border border-hairline bg-surface-soft px-3.5 py-3 font-mono text-caption text-ink"
      >
        <code>{text}</code>
      </pre>
      <p role="status" className="sr-only">
        {state === 'copied' ? 'Copied to clipboard.' : ''}
      </p>
      {state === 'failed' && (
        <p role="alert" className="mt-1.5 text-caption text-error">
          Could not copy automatically. Select the text and copy it by hand.
        </p>
      )}
      {note && <p className="mt-2 text-sm text-muted">{note}</p>}
    </div>
  );
}
