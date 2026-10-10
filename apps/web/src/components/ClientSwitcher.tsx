import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ALL_CLIENTS_SWATCH, clientHue } from '../lib/clientHue';
import { CaretDown, MagnifyingGlass, Plus } from '../lib/icons';

/**
 * The client scope switcher at the top of the sidebar. WHO (client) lives in a searchable
 * dropdown rather than a nav list, so it stays usable at 10+ clients. "All clients" routes to the
 * cross-client Overview; picking a client scopes the session to it.
 */
export function ClientSwitcher({
  onAddClient,
  onNavigate,
}: {
  onAddClient: () => void;
  /** Called after a pick so a surrounding drawer can close. */
  onNavigate?: () => void;
}) {
  const { me, switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const memberships = me?.user.memberships ?? [];
  const active = memberships.find((m) => m.workspaceId === me?.activeWorkspaceId);
  const onOverview = pathname.startsWith('/overview'); // router-state driven, not window.location
  const label = onOverview ? 'All clients' : (active?.name ?? 'All clients');

  const filtered = useMemo(
    () => memberships.filter((m) => m.name.toLowerCase().includes(q.toLowerCase())),
    [memberships, q],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pickAll = () => {
    setOpen(false);
    onNavigate?.();
    navigate('/overview');
  };
  const pick = async (workspaceId: string) => {
    setOpen(false);
    onNavigate?.();
    await switchWorkspace(workspaceId);
    navigate('/content');
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-12 w-full items-center gap-3 rounded-sm border border-hairline bg-canvas px-3 text-left hover:bg-surface-soft"
      >
        <span
          className="inline-block h-3 w-3 flex-none rounded-full"
          style={{
            background: onOverview || !active ? ALL_CLIENTS_SWATCH : clientHue(active.name),
          }}
        />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-micro font-bold uppercase tracking-wide text-muted">Client</span>
          <span className="truncate text-sm font-semibold text-ink">{label}</span>
        </span>
        <CaretDown size={14} className="flex-none text-muted" />
      </button>

      {open && (
        <div className="absolute left-0 z-40 mt-2 w-full rounded-md border border-hairline bg-canvas p-2 shadow-1">
          <div className="mb-2 flex items-center gap-2.5 rounded-sm border border-hairline px-3 py-2">
            <MagnifyingGlass size={16} className="text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search clients…"
              className="w-full border-0 bg-transparent text-body text-ink outline-none placeholder:text-muted"
            />
          </div>
          <button
            type="button"
            onClick={pickAll}
            className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left hover:bg-surface-soft"
          >
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ background: ALL_CLIENTS_SWATCH }}
            />
            <span className="text-body font-medium">All clients</span>
          </button>
          <div className="max-h-64 overflow-y-auto">
            {filtered.map((m) => (
              <button
                key={m.workspaceId}
                type="button"
                onClick={() => void pick(m.workspaceId)}
                className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left hover:bg-surface-soft"
              >
                <span
                  className="inline-block h-3 w-3 flex-none rounded-full"
                  style={{ background: clientHue(m.name) }}
                />
                <span className="truncate text-body font-medium">{m.name}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-3 text-sm text-muted">No clients match “{q}”.</p>
            )}
          </div>
          <div className="mt-1.5 border-t border-hairline-soft pt-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAddClient();
              }}
              className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left font-semibold text-ink hover:bg-surface-soft"
            >
              <Plus size={16} weight="bold" />
              Add client
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
