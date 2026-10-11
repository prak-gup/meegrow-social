import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { clientHue } from '../lib/clientHue';
import { CaretUpDown, Check, MagnifyingGlass, Plus, UsersThree } from '../lib/icons';

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
        aria-label={`Client: ${label}. Switch client`}
        className="flex h-11 w-full items-center gap-2 rounded-sm border border-hairline-strong bg-canvas px-2.5 text-left hover:bg-surface-soft md:h-8"
      >
        {onOverview || !active ? (
          <UsersThree size={14} className="flex-none text-muted" aria-hidden="true" />
        ) : (
          <span
            className="inline-block h-2.5 w-2.5 flex-none rounded-full"
            style={{ background: clientHue(active.name) }}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-base font-medium text-ink md:text-sm">
          {label}
        </span>
        <CaretUpDown size={12} className="flex-none text-muted" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute left-0 z-40 mt-1 w-60 max-w-[calc(100vw-2rem)] rounded-md border border-hairline bg-canvas p-1.5 shadow-1">
          <div className="mb-1.5 flex items-center gap-2 rounded-sm border border-hairline-strong px-2.5 py-1.5">
            <MagnifyingGlass size={14} className="text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search clients…"
              aria-label="Search clients"
              className="w-full border-0 bg-transparent text-lg text-ink outline-none placeholder:text-muted md:text-sm"
            />
          </div>
          <button type="button" onClick={pickAll} className={rowClass}>
            <UsersThree size={14} className="flex-none text-muted" aria-hidden="true" />
            <span className="flex-1 truncate">All clients</span>
            {onOverview && <Check size={14} aria-hidden="true" />}
          </button>
          <div className="max-h-64 overflow-y-auto">
            {filtered.map((m) => (
              <button
                key={m.workspaceId}
                type="button"
                onClick={() => void pick(m.workspaceId)}
                className={rowClass}
              >
                <span
                  className="inline-block h-2.5 w-2.5 flex-none rounded-full"
                  style={{ background: clientHue(m.name) }}
                />
                <span className="flex-1 truncate">{m.name}</span>
                {!onOverview && active?.workspaceId === m.workspaceId && (
                  <Check size={14} aria-hidden="true" />
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-2.5 py-2 text-sm text-muted">No clients match “{q}”.</p>
            )}
          </div>
          <div className="mt-1 border-t border-hairline-soft pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAddClient();
              }}
              className={rowClass}
            >
              <Plus size={14} weight="bold" className="flex-none" />
              Add client
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const rowClass =
  'flex h-11 w-full items-center gap-2 rounded-sm px-2.5 text-left text-base text-ink hover:bg-surface-soft md:h-8 md:text-sm';
