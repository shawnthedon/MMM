import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    // Dev convenience: serve the gateway through the app origin so the PWA can authenticate with
    // a same-origin HttpOnly cookie (no CORS, works behind the preview proxy).
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
});
