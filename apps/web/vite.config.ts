import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = 'http://localhost:8990';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Proxy the API surface so the dev SPA is same-origin with the API (session cookie + CSRF Origin
    // line up). In prod, Caddy serves the static bundle and reverse-proxies /v1 to the api service.
    proxy: {
      '/v1': API_TARGET,
      '/connect': API_TARGET,
      '/media': API_TARGET,
    },
  },
  build: { outDir: 'dist' },
});
