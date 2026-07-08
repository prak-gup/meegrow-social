import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthMeView } from '@meegrow-social/contracts';
import { api } from './api';

/**
 * Session state (#10). Loads `/v1/auth/me` on mount (cookie is sent same-origin); exposes the
 * current user, their memberships (for the workspace switcher), and login/logout/switch actions.
 */
interface AuthState {
  me: AuthMeView | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AuthMeView | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      setMe(await api.me());
    } catch {
      setMe(null);
    }
  };

  useEffect(() => {
    void (async () => {
      await refresh();
      setLoading(false);
    })();
  }, []);

  const login = async (email: string, password: string) => {
    setMe(await api.login(email, password));
  };
  const logout = async () => {
    await api.logout();
    setMe(null);
  };
  const switchWorkspace = async (workspaceId: string) => {
    await api.switchWorkspace(workspaceId);
    setMe(await api.me());
  };

  return (
    <Ctx.Provider value={{ me, loading, login, logout, switchWorkspace, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
