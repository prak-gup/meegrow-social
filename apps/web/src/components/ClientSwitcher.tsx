import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { clientHue } from '../lib/clientHue';
import { CaretDown, MagnifyingGlass, Plus } from '../lib/icons';

/**
 * The signature Airbnb pill, repurposed as the client scope switcher — this is how the app scales
 * past a left rail: WHO (client) lives here, searchable, not in a sidebar that overflows at 10+.
 * "All clients" routes to the cross-client Overview; picking a client scopes the session to it.
 */
export function ClientSwitcher({ onAddClient }: { onAddClient: () => void }) {
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
    navigate('/overview');
  };
  const pick = async (workspaceId: string) => {
    setOpen(false);
    await switchWorkspace(workspaceId);
    navigate('/content');
  };

  return (
    <div className="relative" ref={ref}>
      <div className="mx-auto flex h-16 max-w-3xl items-stretch rounded-full border border-hairline bg-canvas shadow-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex min-w-[150px] flex-col justify-center rounded-full px-4 text-left hover:bg-surface-soft sm:min-w-[220px] sm:px-6"
        >
          <span className="text-xs font-bold text-ink">Client</span>
          <span className="flex items-center gap-2 text-sm text-muted">
            {onOverview || !active ? (
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{
                  background:
                    'conic-gradient(#7A5AF8,#08B5D6,#7BC62D,#F0A020,#FB6A4A,#EC4899,#7A5AF8)',
                }}
              />
            ) : (
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ background: clientHue(active.name) }}
              />
            )}
            {label}
            <CaretDown size={13} className="text-muted" />
          </span>
        </button>
        <div className="relative hidden flex-1 flex-col justify-center border-l border-hairline px-6 sm:flex">
          <span className="text-xs font-bold text-ink">Search</span>
          <span className="text-sm text-muted">Find a post, caption, or campaign…</span>
        </div>
        <button
          type="button"
          className="my-auto mr-2 grid h-12 w-12 flex-none place-items-center rounded-full bg-rausch text-white hover:bg-rausch-active"
          aria-label="Search"
        >
          <MagnifyingGlass size={20} weight="bold" />
        </button>
      </div>

      {open && (
        <div className="absolute left-1/2 z-40 mt-2 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-hairline bg-canvas p-2.5 shadow-1">
          <div className="mb-2 flex items-center gap-2.5 rounded-full border border-hairline px-3.5 py-2.5">
            <MagnifyingGlass size={16} className="text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search clients…"
              className="w-full border-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
            />
          </div>
          <button
            type="button"
            onClick={pickAll}
            className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left hover:bg-surface-soft"
          >
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{
                background:
                  'conic-gradient(#7A5AF8,#08B5D6,#7BC62D,#F0A020,#FB6A4A,#EC4899,#7A5AF8)',
              }}
            />
            <span className="text-[15px] font-medium">All clients</span>
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
                <span className="truncate text-[15px] font-medium">{m.name}</span>
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
