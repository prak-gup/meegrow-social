import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppLayout } from './components/AppLayout';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Clients } from './pages/Clients';
import { Connections } from './pages/Connections';
import { Composer } from './pages/Composer';
import { Calendar } from './pages/Calendar';
import { Posts } from './pages/Posts';
import { ApiKeys } from './pages/ApiKeys';
import { ChangePassword } from './pages/ChangePassword';
import { Analytics } from './pages/Analytics';
import { Invite } from './pages/Invite';

/** Gates the authenticated area: waits for the session probe, redirects to /login if absent. */
function Protected() {
  const { me, loading } = useAuth();
  if (loading) return <div className="p-10 text-muted">Loading…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <AppLayout />; // AppLayout renders the <Outlet /> the nested routes fill.
}

export function App() {
  const { me, loading } = useAuth();
  return (
    <Routes>
      {/* Public: the client-facing connect-invite landing (no session required). */}
      <Route path="/i/:token" element={<Invite />} />
      <Route
        path="/login"
        element={me && !loading ? <Navigate to="/overview" replace /> : <Login />}
      />
      <Route element={<Protected />}>
        <Route path="/overview" element={<Overview />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/content" element={<Posts />} />
        {/* Always registered so it can be validated by URL; the nav entry is flag-gated (AppLayout). */}
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/composer" element={<Composer />} />
        <Route path="/settings/api-keys" element={<ApiKeys />} />
        <Route path="/settings/password" element={<ChangePassword />} />
        {/* legacy alias */}
        <Route path="/posts" element={<Navigate to="/content" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  );
}
