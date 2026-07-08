import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppLayout } from './components/AppLayout';
import { Login } from './pages/Login';
import { Connections } from './pages/Connections';
import { Composer } from './pages/Composer';
import { Posts } from './pages/Posts';

/** Gates the authenticated area: waits for the session probe, redirects to /login if absent. */
function Protected() {
  const { me, loading } = useAuth();
  if (loading) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <AppLayout />; // AppLayout renders the <Outlet /> the nested routes fill.
}

export function App() {
  const { me, loading } = useAuth();
  return (
    <Routes>
      <Route
        path="/login"
        element={me && !loading ? <Navigate to="/connections" replace /> : <Login />}
      />
      <Route element={<Protected />}>
        <Route path="/connections" element={<Connections />} />
        <Route path="/composer" element={<Composer />} />
        <Route path="/posts" element={<Posts />} />
      </Route>
      <Route path="*" element={<Navigate to="/connections" replace />} />
    </Routes>
  );
}
