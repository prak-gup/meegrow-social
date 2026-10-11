import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppLayout } from './components/AppLayout';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Clients } from './pages/Clients';
import { Connections } from './pages/Connections';
import { composerBackground } from './lib/composer';
import { Calendar } from './pages/Calendar';
import { Posts } from './pages/Posts';
import { ApiKeys } from './pages/ApiKeys';
import { ChangePassword } from './pages/ChangePassword';
import { Analytics } from './pages/Analytics';
import { Invite } from './pages/Invite';
import { InviteFinish } from './pages/InviteFinish';

/** Gates the authenticated area: waits for the session probe, redirects to /login if absent. */
function Protected({ composerOver }: { composerOver: string | null }) {
  const { me, loading } = useAuth();
  if (loading) return <div className="p-10 text-muted">Loading…</div>;
  if (!me) return <Navigate to="/login" replace />;
  // AppLayout renders the <Outlet /> the nested routes fill.
  return <AppLayout composerOver={composerOver} />;
}

export function App() {
  const { me, loading } = useAuth();
  const location = useLocation();
  // The composer is a panel OVER a page, not a page: at /composer the routes below are matched
  // against the page it was opened from (or Content, for a direct link), and AppLayout draws the
  // panel on top. The address stays /composer, so it deep-links and Back closes it.
  // Everything under <Routes location> sees the page beneath as "the location", so the layout is
  // told about the panel through a prop rather than reading the address itself.
  const composerOver =
    location.pathname === '/composer' ? composerBackground(location.state) : null;
  return (
    <Routes location={composerOver ?? location}>
      {/* Public: the client-facing connect-invite landing (no session required). */}
      <Route path="/i/:token" element={<Invite />} />
      {/* Public: where /connect/callback sends an invited client to pick the account to connect. */}
      <Route path="/i/finish/:flowId" element={<InviteFinish />} />
      <Route
        path="/login"
        element={me && !loading ? <Navigate to="/overview" replace /> : <Login />}
      />
      <Route element={<Protected composerOver={composerOver} />}>
        <Route path="/overview" element={<Overview />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/content" element={<Posts />} />
        {/* Always registered so it can be validated by URL; the nav entry is flag-gated (AppLayout). */}
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/settings/api-keys" element={<ApiKeys />} />
        <Route path="/settings/password" element={<ChangePassword />} />
        {/* legacy alias */}
        <Route path="/posts" element={<Navigate to="/content" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  );
}
