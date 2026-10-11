import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { clientHue } from '../lib/clientHue';
import { ClientSwitcher } from './ClientSwitcher';
import { AddClientModal } from './AddClientModal';
import { Logo } from './Logo';
import { Button } from './ui/Button';
import { RowMenu } from './ui/RowMenu';
import {
  House,
  CalendarBlank,
  SquaresFour,
  ChartLineUp,
  UsersThree,
  Plugs,
  Key,
  LockKey,
  Plus,
  List,
  CloseIcon,
  SignOut,
  CaretUpDown,
} from '../lib/icons';

const TABS = [
  { to: '/overview', label: 'Overview', Icon: House },
  { to: '/calendar', label: 'Calendar', Icon: CalendarBlank },
  { to: '/content', label: 'Content', Icon: SquaresFour },
  // Always listed. Until the numbers are validated against the platforms the page itself carries a
  // "Preview" badge (VITE_ANALYTICS_UI, see pages/Analytics.tsx and docs/dev/ANALYTICS-UI-BRIEF.md §1).
  { to: '/analytics', label: 'Analytics', Icon: ChartLineUp },
  { to: '/clients', label: 'Clients', Icon: UsersThree },
  { to: '/connections', label: 'Connections', Icon: Plugs },
  { to: '/settings/api-keys', label: 'API keys', Icon: Key },
];

/** Everything the sidebar holds. Rendered once as the desktop rail and once inside the mobile drawer. */
function SidebarContent({
  onNavigate,
  onAddClient,
}: {
  onNavigate?: () => void;
  onAddClient: () => void;
}) {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The composer holds an unsaved draft and the keyed <main> remounts on a scope change, so the
  // client is read-only there: switch client, then compose.
  const scopeLocked = pathname.startsWith('/composer');
  const active = me?.user.memberships.find((m) => m.workspaceId === me.activeWorkspaceId);
  const displayName = me?.user.name ?? me?.user.email ?? 'Account';
  const initial = displayName.trim()[0]?.toUpperCase() ?? 'U';

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <Logo className="py-1 pl-1 pr-10 md:pr-1" size={24} />

      {scopeLocked ? (
        <div className="flex h-11 w-full items-center gap-2 rounded-sm border border-hairline bg-surface-soft px-2.5 md:h-8">
          <span
            className="inline-block h-2.5 w-2.5 flex-none rounded-full"
            style={{ background: active ? clientHue(active.name) : undefined }}
          />
          <span className="truncate text-base font-medium text-ink md:text-sm">
            <span className="sr-only">Posting as </span>
            {active?.name ?? 'No client'}
          </span>
        </div>
      ) : (
        <ClientSwitcher onAddClient={onAddClient} onNavigate={onNavigate} />
      )}

      <Button
        variant="accent"
        className="w-full"
        onClick={() => {
          onNavigate?.();
          navigate('/composer');
        }}
      >
        <Plus size={16} weight="bold" />
        Create post
      </Button>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {TABS.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} onClick={onNavigate} className={navClass}>
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Account-level actions live in one menu on the user row, so the name gets the row's full
          width instead of sharing it with icons. */}
      <div className="mt-auto border-t border-hairline-soft pt-2">
        <RowMenu
          label={`Account: ${displayName}`}
          align="start"
          items={[
            {
              label: 'Change password',
              icon: <LockKey size={14} />,
              onSelect: () => {
                onNavigate?.();
                navigate('/settings/password');
              },
            },
            {
              label: 'Sign out',
              icon: <SignOut size={14} />,
              onSelect: () => void logout().then(() => navigate('/login')),
            },
          ]}
          className="flex h-11 w-full items-center gap-2 rounded-sm px-1 text-left hover:bg-surface-soft aria-expanded:bg-surface-strong"
        >
          <span
            className="grid h-7 w-7 flex-none place-items-center rounded-full bg-surface-strong text-xs font-semibold text-ink"
            aria-hidden="true"
          >
            {initial}
          </span>
          {/* The name has the row to itself; the caret sits on the email line, which truncates
              anyway. */}
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium text-ink">{displayName}</span>
            <span className="flex items-center gap-1 text-micro text-muted">
              <span className="min-w-0 flex-1 truncate">
                {me?.user.name ? me.user.email : 'Account'}
              </span>
              <CaretUpDown size={10} className="flex-none" aria-hidden="true" />
            </span>
          </span>
        </RowMenu>
      </div>
    </div>
  );
}

/** A sidebar row: 44px on a phone drawer, 32px from md up. Active is a neutral fill, never the accent. */
const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-11 items-center gap-2.5 rounded-sm px-2.5 text-base font-medium text-muted hover:bg-surface-soft hover:text-ink md:h-8',
    isActive && 'bg-surface-strong text-ink',
  );

/**
 * Work-tool shell: fixed left sidebar (brand · client switcher · create · nav · account) on md+,
 * a top bar + slide-in drawer below that. Content is full width; pages own their header via
 * <PageHeader>.
 */
export function AppLayout() {
  const { me } = useAuth();
  const { pathname } = useLocation();
  const [adding, setAdding] = useState(false);
  const [drawer, setDrawer] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const backgroundRef = useRef<HTMLDivElement>(null);

  // Close the drawer on any navigation.
  useEffect(() => setDrawer(false), [pathname]);

  // Modal behaviour while the drawer is open: focus moves in and is trapped, Escape closes,
  // the page behind is inert + aria-hidden, and focus returns to the menu button on close.
  useEffect(() => {
    if (!drawer) return;
    const trigger = triggerRef.current;
    const bg = backgroundRef.current;
    bg?.setAttribute('inert', '');
    bg?.setAttribute('aria-hidden', 'true');
    const focusables = () =>
      Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawer(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const current = document.activeElement;
      if (!drawerRef.current?.contains(current)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      bg?.removeAttribute('inert');
      bg?.removeAttribute('aria-hidden');
      trigger?.focus();
    };
  }, [drawer]);

  return (
    <div className="min-h-screen bg-canvas md:pl-sidebar">
      <div ref={backgroundRef}>
        {/* Desktop rail */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-sidebar overflow-y-auto border-r border-hairline bg-canvas md:block">
          <SidebarContent onAddClient={() => setAdding(true)} />
        </aside>

        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-hairline bg-canvas px-4 md:hidden">
          <button
            type="button"
            ref={triggerRef}
            onClick={() => setDrawer(true)}
            className="-ml-2 grid h-11 w-11 place-items-center rounded-sm hover:bg-surface-soft"
            aria-label="Open menu"
            aria-expanded={drawer}
          >
            <List size={22} />
          </button>
          <Logo size={24} />
          <NavLink
            to="/composer"
            className="-mr-2 grid h-11 w-11 place-items-center rounded-sm bg-rausch text-white hover:bg-rausch-active"
            aria-label="Create post"
          >
            <Plus size={18} weight="bold" />
          </NavLink>
        </header>

        {/* Keyed on the active workspace so workspace-scoped pages (Content/Connections) remount and
          refetch when the client switcher changes scope — otherwise a same-route switch is a no-op
          and the page keeps showing the previous client's data. */}
        <main key={me?.activeWorkspaceId ?? 'none'} className="px-4 py-4 md:px-6 md:py-5">
          <Outlet />
        </main>
      </div>

      {/* Mobile drawer */}
      {drawer && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Main menu"
        >
          <button
            type="button"
            className="absolute inset-0 bg-scrim/40"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
          />
          <aside
            ref={drawerRef}
            className="absolute inset-y-0 left-0 w-64 max-w-[85vw] overflow-y-auto bg-canvas shadow-1"
          >
            <button
              type="button"
              onClick={() => setDrawer(false)}
              className="absolute right-1 top-1 grid h-11 w-11 place-items-center rounded-sm text-muted hover:bg-surface-soft"
              aria-label="Close menu"
            >
              <CloseIcon size={18} />
            </button>
            <SidebarContent
              onNavigate={() => setDrawer(false)}
              onAddClient={() => {
                setDrawer(false);
                setAdding(true);
              }}
            />
          </aside>
        </div>
      )}

      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  );
}
