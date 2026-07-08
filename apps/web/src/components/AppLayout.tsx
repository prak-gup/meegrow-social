import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button } from './ui/Button';
import { Select } from './ui/Select';
import { cn } from '../lib/cn';

const navBase = 'px-3 py-2 rounded-md text-sm font-medium';
const activeCls = 'bg-secondary text-secondary-foreground';

export function AppLayout() {
  const { me, switchWorkspace, logout } = useAuth();
  const navigate = useNavigate();
  const memberships = me?.user.memberships ?? [];

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="container flex h-14 items-center gap-4">
          <span className="font-semibold">Meegrow Social</span>
          <nav className="flex gap-1">
            <NavLink
              to="/connections"
              className={({ isActive }) => cn(navBase, isActive && activeCls)}
            >
              Connections
            </NavLink>
            <NavLink
              to="/composer"
              className={({ isActive }) => cn(navBase, isActive && activeCls)}
            >
              Composer
            </NavLink>
            <NavLink to="/posts" className={({ isActive }) => cn(navBase, isActive && activeCls)}>
              Posts
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {memberships.length >= 1 && (
              <Select
                value={me?.activeWorkspaceId ?? ''}
                onChange={(e) => void switchWorkspace(e.target.value)}
                className="w-60"
              >
                {memberships.map((m) => (
                  <option key={m.workspaceId} value={m.workspaceId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void logout().then(() => navigate('/login'));
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="container py-6">
        <Outlet />
      </main>
    </div>
  );
}
