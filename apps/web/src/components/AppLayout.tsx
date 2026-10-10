import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { ClientSwitcher } from './ClientSwitcher';
import { AddClientModal } from './AddClientModal';
import { Logo } from './Logo';
import {
  House,
  SquaresFour,
  UsersThree,
  Plugs,
  Plus,
  List,
  CloseIcon,
  SignOut,
} from '../lib/icons';

const TABS = [
  { to: '/overview', label: 'Overview', Icon: House },
  { to: '/content', label: 'Content', Icon: SquaresFour },
  { to: '/clients', label: 'Clients', Icon: UsersThree },
  { to: '/connections', label: 'Connections', Icon: Plugs },
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
  const displayName = me?.user.name ?? me?.user.email ?? 'Account';
  const initial = displayName.trim()[0]?.toUpperCase() ?? 'U';

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <Logo className="py-1 pl-1 pr-8" />

      <ClientSwitcher onAddClient={onAddClient} onNavigate={onNavigate} />

      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          navigate('/composer');
        }}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-sm bg-rausch px-4 text-body font-medium text-white hover:bg-rausch-active"
      >
        <Plus size={18} weight="bold" />
        Create post
      </button>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {TABS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex h-10 items-center gap-3 rounded-sm px-3 text-body font-semibold text-muted hover:bg-surface-soft hover:text-ink',
                isActive && 'bg-surface-strong text-ink',
              )
            }
          >
            <Icon size={20} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex items-center gap-3 border-t border-hairline-soft pt-4">
        <span
          className="grid h-9 w-9 flex-none place-items-center rounded-full bg-surface-strong text-sm font-semibold text-ink"
          aria-hidden="true"
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{displayName}</p>
          {me?.user.name && <p className="truncate text-caption text-muted">{me.user.email}</p>}
        </div>
        <button
          type="button"
          onClick={() => void logout().then(() => navigate('/login'))}
          className="grid h-9 w-9 flex-none place-items-center rounded-sm text-muted hover:bg-surface-soft hover:text-ink"
          aria-label="Sign out"
          title="Sign out"
        >
          <SignOut size={18} />
        </button>
      </div>
    </div>
  );
}

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

  // Close the drawer on any navigation (and on Escape while it is open).
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  return (
    <div className="min-h-screen bg-canvas md:pl-sidebar">
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-sidebar overflow-y-auto border-r border-hairline bg-canvas md:block">
        <SidebarContent onAddClient={() => setAdding(true)} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-hairline bg-canvas px-4 md:hidden">
        <button
          type="button"
          onClick={() => setDrawer(true)}
          className="grid h-10 w-10 place-items-center rounded-sm hover:bg-surface-soft"
          aria-label="Open menu"
          aria-expanded={drawer}
        >
          <List size={22} />
        </button>
        <Logo size={26} />
        <NavLink
          to="/composer"
          className="grid h-10 w-10 place-items-center rounded-sm bg-rausch text-white hover:bg-rausch-active"
          aria-label="Create post"
        >
          <Plus size={18} weight="bold" />
        </NavLink>
      </header>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-scrim/40"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-sidebar overflow-y-auto bg-canvas shadow-1">
            <button
              type="button"
              onClick={() => setDrawer(false)}
              className="absolute right-2 top-3 grid h-9 w-9 place-items-center rounded-sm text-muted hover:bg-surface-soft"
              aria-label="Close menu"
            >
              <CloseIcon size={18} />
            </button>
            <SidebarContent
              onNavigate={() => setDrawer(false)}
              onAddClient={() => setAdding(true)}
            />
          </aside>
        </div>
      )}

      {/* Keyed on the active workspace so workspace-scoped pages (Content/Connections) remount and
          refetch when the client switcher changes scope — otherwise a same-route switch is a no-op
          and the page keeps showing the previous client's data. */}
      <main key={me?.activeWorkspaceId ?? 'none'} className="px-4 py-6 md:px-8">
        <Outlet />
      </main>

      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  );
}
