/**
 * Dashboard shell (scaffold). The dashboard is a pure API consumer (AX-PRD §1) — it will talk to
 * the same REST API that antidote uses. Real login + Tailwind/shadcn polish are M1/M2 issues.
 */
export function App(): JSX.Element {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        display: 'grid',
        placeItems: 'center',
        minHeight: '100vh',
      }}
    >
      <div style={{ width: 320 }}>
        <h1>Meegrow Social</h1>
        <p style={{ color: '#666' }}>Sign in to your workspace</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <input
            placeholder="Email"
            type="email"
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
          />
          <input
            placeholder="Password"
            type="password"
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
          />
          <button type="submit" style={{ width: '100%', padding: 8 }}>
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
