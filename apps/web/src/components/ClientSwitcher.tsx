import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { OverviewView } from '@meegrow-social/contracts';
import { useAuth } from '../lib/auth';
import { clientHue } from '../lib/clientHue';
import { cn } from '../lib/cn';
import {
  accountsLabel,
  attentionLabel,
  filterSwitcherClients,
  joinClients,
  moveIndex,
  needsAttention,
  switchTarget,
  type SwitcherClient,
} from '../lib/sidebar';
import {
  CaretUpDown,
  Check,
  MagnifyingGlass,
  Plugs,
  Plus,
  UsersThree,
  Warning,
} from '../lib/icons';
import { Popover } from './ui/Popover';
import { Tooltip } from './ui/Tooltip';

type Option = { kind: 'all' } | { kind: 'client'; client: SwitcherClient } | { kind: 'add' };

const truncated = (el: HTMLElement) => {
  const t = el.querySelector<HTMLElement>('.truncate');
  return !!t && t.scrollWidth > t.clientWidth;
};

/**
 * The client scope switcher at the top of the sidebar. WHO (client) lives in a searchable
 * combobox rather than a nav list, so it stays usable at 10+ clients. Each client shows its colour,
 * its connected-account count and a marker when it needs attention (from the shell's overview).
 * "All clients" routes to the cross-client Overview; picking a client scopes the session to it and
 * keeps the user on the same screen when that screen is client-scoped.
 * Keys: type to filter, Up/Down/Home/End move, Enter picks, Escape closes.
 * Usage: <ClientSwitcher onAddClient={…} overview={ov} onOpen={refresh} collapsed={false} />
 */
export function ClientSwitcher({
  onAddClient,
  onNavigate,
  overview,
  onOpen,
  collapsed = false,
  disabled = false,
}: {
  onAddClient: () => void;
  /** Called after a pick so a surrounding drawer can close. */
  onNavigate?: () => void;
  overview: OverviewView | null;
  /** The list just opened: a chance to refresh the overview behind it. */
  onOpen?: () => void;
  /** Icon-rail form: the trigger shrinks to the client's colour dot. */
  collapsed?: boolean;
  /** The sidebar is inert (the composer is open): close and refuse to open. */
  disabled?: boolean;
}) {
  const { me, switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const memberships = useMemo(() => me?.user.memberships ?? [], [me]);
  const active = memberships.find((m) => m.workspaceId === me?.activeWorkspaceId);
  const onOverview = pathname.startsWith('/overview'); // router-state driven, not window.location
  const label = onOverview ? 'All clients' : (active?.name ?? 'All clients');
  const current = onOverview ? null : (active?.workspaceId ?? null);

  const clients = useMemo(() => joinClients(memberships, overview), [memberships, overview]);
  const filtered = useMemo(() => filterSwitcherClients(clients, q), [clients, q]);
  const canCreate = memberships.some((m) => m.role === 'owner');
  const options: Option[] = useMemo(
    () => [
      { kind: 'all' },
      ...filtered.map((client): Option => ({ kind: 'client', client })),
      ...(canCreate ? [{ kind: 'add' } as Option] : []),
    ],
    [filtered, canCreate],
  );

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setQ('');
    if (restoreFocus) triggerRef.current?.focus();
  };
  const openList = () => {
    if (disabled) return;
    const at = options.findIndex((o) => o.kind === 'client' && o.client.workspaceId === current);
    setHi(at >= 0 ? at : 0);
    setOpen(true);
    onOpen?.();
  };

  useEffect(() => {
    if (disabled && open) close(false);
  }, [disabled]);

  // Keep the highlighted row visible as the arrow keys move through a long list.
  useEffect(() => {
    if (open)
      listRef.current?.querySelector('[data-hi="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  const choose = async (o: Option) => {
    if (o.kind === 'add') {
      close(false);
      onAddClient();
    } else if (o.kind === 'all') {
      close(false);
      onNavigate?.();
      navigate('/overview');
    } else {
      close(false);
      onNavigate?.();
      await switchWorkspace(o.client.workspaceId);
      const target = switchTarget(pathname);
      if (target !== pathname) navigate(target);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      setHi((h) => moveIndex(h, e.key, options.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[hi];
      if (o) void choose(o);
    }
  };

  const optionId = (i: number) => `${id}-o${i}`;
  const triggerLabel = `Client: ${label}. Switch client`;

  return (
    <>
      <Tooltip label={label} when={collapsed ? undefined : truncated}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => (open ? close(false) : openList())}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open) {
              e.preventDefault();
              openList();
            }
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={triggerLabel}
          disabled={disabled}
          className={cn(
            'flex h-11 w-full items-center rounded-sm border border-hairline-strong bg-canvas text-left transition-colors hover:bg-surface-soft active:bg-surface-strong aria-expanded:bg-surface-strong md:h-8',
            collapsed ? 'justify-center px-0' : 'gap-2 px-2.5',
          )}
        >
          <Mark name={onOverview || !active ? null : active.name} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate text-base font-medium text-ink md:text-sm">
                {label}
              </span>
              <CaretUpDown size={12} className="flex-none text-muted" aria-hidden="true" />
            </>
          )}
        </button>
      </Tooltip>

      {open && (
        <Popover
          anchorRef={triggerRef}
          onClose={close}
          label="Switch client"
          minWidth={320}
          maxWidth={380}
          onKeyDown={onKey}
          onPlaced={(el) => el.querySelector('input')?.focus()}
        >
          <div className="mb-1.5 flex flex-none items-center gap-2 rounded-sm border border-hairline-strong px-2.5 py-1.5 focus-within:border-ink">
            <MagnifyingGlass size={14} className="flex-none text-muted" aria-hidden="true" />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={options[hi] ? optionId(hi) : undefined}
              aria-autocomplete="list"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setHi(1); // the first match; with no match this lands on "Add client" and Enter is harmless
              }}
              placeholder="Search clients…"
              aria-label="Search clients"
              autoComplete="off"
              spellCheck={false}
              className="w-full border-0 bg-transparent text-lg text-ink outline-none placeholder:text-muted focus-visible:outline-none md:text-sm"
            />
          </div>
          <div
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            aria-label="Clients"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {options.map((o, i) => {
              if (o.kind === 'add') {
                // Pinned to the foot of the scroll area, so it stays in reach at 12+ clients.
                return (
                  <Fragment key="add">
                    {filtered.length === 0 && (
                      <p role="presentation" className="px-2.5 py-2 text-sm text-muted">
                        No clients match “{q.trim()}”.
                      </p>
                    )}
                    <Row
                      id={optionId(i)}
                      highlighted={hi === i}
                      selected={false}
                      onHover={() => setHi(i)}
                      onPick={() => void choose(o)}
                      className="sticky bottom-0 mt-1 rounded-t-none border-t border-hairline-soft bg-canvas"
                    >
                      <Plus size={14} weight="bold" className="flex-none" aria-hidden="true" />
                      <span className="flex-1">Add client</span>
                    </Row>
                  </Fragment>
                );
              }
              const selected =
                o.kind === 'all' ? current === null : current === o.client.workspaceId;
              return (
                <Row
                  key={o.kind === 'all' ? 'all' : o.client.workspaceId}
                  id={optionId(i)}
                  highlighted={hi === i}
                  selected={selected}
                  onHover={() => setHi(i)}
                  onPick={() => void choose(o)}
                >
                  {o.kind === 'all' ? (
                    <>
                      <UsersThree size={14} className="flex-none text-muted" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">All clients</span>
                    </>
                  ) : (
                    <ClientRow client={o.client} />
                  )}
                  {selected && <Check size={14} className="flex-none" aria-hidden="true" />}
                </Row>
              );
            })}
          </div>
        </Popover>
      )}
    </>
  );
}

/** The client's colour dot, or the group icon for "All clients". */
function Mark({ name }: { name: string | null }) {
  return name === null ? (
    <UsersThree size={14} className="flex-none text-muted" aria-hidden="true" />
  ) : (
    <span
      className="inline-block h-2.5 w-2.5 flex-none rounded-full"
      style={{ background: clientHue(name) }}
      aria-hidden="true"
    />
  );
}

function ClientRow({ client }: { client: SwitcherClient }) {
  const count = accountsLabel(client.connectionCount);
  return (
    <>
      <Mark name={client.name} />
      <span className="min-w-0 flex-1 truncate" title={client.name}>
        {client.name}
      </span>
      {needsAttention(client) && (
        <span
          role="img"
          aria-label={attentionLabel(client)}
          title={attentionLabel(client)}
          className={cn(
            'flex-none',
            client.health === 'bad' ? 'text-status-bad' : 'text-status-warn',
          )}
        >
          <Warning size={13} weight="fill" aria-hidden="true" />
        </span>
      )}
      {count && (
        <span
          className="tnum flex flex-none items-center gap-0.5 text-xs text-muted"
          title={count === 'No accounts' ? count : `${count} connected`}
          aria-label={count}
        >
          <Plugs size={11} aria-hidden="true" />
          {client.connectionCount}
        </span>
      )}
    </>
  );
}

function Row({
  id,
  highlighted,
  selected,
  onHover,
  onPick,
  className,
  children,
}: {
  id: string;
  highlighted: boolean;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-hi={highlighted}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(
        'flex h-11 w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 text-left text-base text-ink md:h-8 md:text-sm',
        highlighted ? 'bg-surface-strong' : 'active:bg-surface-strong',
        selected && 'font-medium',
        className,
      )}
    >
      {children}
    </div>
  );
}
