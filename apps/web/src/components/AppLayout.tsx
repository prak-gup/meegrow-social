import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { ClientSwitcher } from './ClientSwitcher';
import { AddClientModal } from './AddClientModal';
import { House, SquaresFour, UsersThree, Plugs, Plus } from '../lib/icons';

const TABS = [
  { to: '/overview', label: 'Overview', Icon: House },
  { to: '/content', label: 'Content', Icon: SquaresFour },
  { to: '/clients', label: 'Clients', Icon: UsersThree },
  { to: '/connections', label: 'Connections', Icon: Plugs },
];

/** Airbnb-style shell: 80px top nav (brand · centred tabs · account), then the pill switcher bar. */
export function AppLayout() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [adding, setAdding] = useState(false);

  const initial = (me?.user.name ?? me?.user.email ?? 'U').trim()[0]?.toUpperCase() ?? 'U';
  // The switcher bar is where scope lives; hide it on the composer (a focused, full-page task).
  const showSwitcher = !location.pathname.startsWith('/composer');

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-30 flex h-20 items-center justify-between gap-3 border-b border-hairline bg-canvas px-4 md:grid md:grid-cols-[1fr_auto_1fr] md:px-10">
        <div className="flex items-center gap-2.5">
          <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <rect width="32" height="32" rx="9" fill="#fff" stroke="#dddddd" />
            <path
              d="M8 21 L14 14 L18 17 L24 9"
              stroke="#ff385c"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="24" cy="9" r="2.6" fill="#222222" />
          </svg>
          <span className="text-[19px] font-bold tracking-tight text-rausch">
            meegrow<span className="text-ink">·social</span>
          </span>
        </div>

        {/* Desktop: centred product tabs. Mobile: a scroll strip below the header (see after). */}
        <nav className="hidden justify-self-center md:flex">
          {TABS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'mx-2.5 flex h-11 items-center gap-2 border-b-2 border-transparent px-1 text-base font-semibold text-muted hover:text-ink',
                  isActive && 'border-ink text-ink',
                )
              }
            >
              <Icon size={22} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2.5 justify-self-end">
          <button
            type="button"
            onClick={() => navigate('/composer')}
            className="inline-flex h-11 items-center gap-2 rounded-sm bg-rausch px-3 text-[15px] font-medium text-white hover:bg-rausch-active md:px-4"
          >
            <Plus size={18} weight="bold" />
            <span className="hidden sm:inline">Create post</span>
          </button>
          <button
            type="button"
            onClick={() => void logout().then(() => navigate('/login'))}
            className="grid h-9 w-9 place-items-center rounded-full bg-surface-strong text-sm font-semibold text-ink"
            aria-label="Sign out"
            title="Sign out"
          >
            {initial}
          </button>
        </div>
      </header>

      {/* Mobile tab strip — the centred desktop tabs don't fit a phone width. */}
      <nav className="flex gap-1 overflow-x-auto border-b border-hairline px-4 py-1.5 md:hidden">
        {TABS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex flex-none items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold text-muted',
                isActive && 'bg-surface-strong text-ink',
              )
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      {showSwitcher && (
        <div className="flex justify-center border-b border-hairline-soft px-10 py-5">
          <div className="w-full max-w-3xl">
            <ClientSwitcher onAddClient={() => setAdding(true)} />
          </div>
        </div>
      )}

      {/* Keyed on the active workspace so workspace-scoped pages (Content/Connections) remount and
          refetch when the client switcher changes scope — otherwise a same-route switch is a no-op
          and the page keeps showing the previous client's data. */}
      <main
        key={me?.activeWorkspaceId ?? 'none'}
        className="mx-auto max-w-content px-4 py-6 md:px-10"
      >
        <Outlet />
      </main>

      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  );
}
