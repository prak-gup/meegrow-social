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
      <header className="sticky top-0 z-30 grid h-20 grid-cols-[1fr_auto_1fr] items-center border-b border-hairline bg-canvas px-10">
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

        <nav className="flex justify-self-center">
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
            className="inline-flex h-11 items-center gap-2 rounded-sm bg-rausch px-4 text-[15px] font-medium text-white hover:bg-rausch-active"
          >
            <Plus size={18} weight="bold" />
            Create post
          </button>
          <button
            type="button"
            onClick={() => void logout().then(() => navigate('/login'))}
            className="grid h-9 w-9 place-items-center rounded-full bg-surface-strong text-sm font-semibold text-ink"
            title="Sign out"
          >
            {initial}
          </button>
        </div>
      </header>

      {showSwitcher && (
        <div className="flex justify-center border-b border-hairline-soft px-10 py-5">
          <div className="w-full max-w-3xl">
            <ClientSwitcher onAddClient={() => setAdding(true)} />
          </div>
        </div>
      )}

      <main className="mx-auto max-w-content px-10 py-6">
        <Outlet />
      </main>

      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  );
}
