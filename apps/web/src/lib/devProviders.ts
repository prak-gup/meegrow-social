/**
 * The `fake*` provider family exists for tests and the no-secrets scaffold (contracts/providers.ts);
 * the API lists it in every environment, so the dashboard filters at render time. Production builds
 * never show a fake as a connectable platform, a connected account, a Composer option, or a filter
 * value. Dev builds (`import.meta.env.DEV`, i.e. `pnpm dev`) keep them; a production build can opt
 * back in by setting VITE_SHOW_FAKE_PROVIDERS=true at build time.
 */
const showFakeProviders =
  import.meta.env.DEV || import.meta.env.VITE_SHOW_FAKE_PROVIDERS === 'true';

/** May this provider (or a connection to it) be rendered? Fakes are dev-only. */
export function providerVisible(identifier: string): boolean {
  return showFakeProviders || !identifier.startsWith('fake');
}
