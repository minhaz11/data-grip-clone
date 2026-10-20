import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Monaco's package `exports` map cannot address its CSS files; point straight at the ESM tree.
    alias: {
      'monaco-esm': fileURLToPath(
        new URL('../../node_modules/monaco-editor/esm/vs', import.meta.url),
      ),
    },
  },
  optimizeDeps: {
    // Serve Monaco as plain ESM in dev: pre-bundling breaks its `?worker` import.
    exclude: ['monaco-esm'],
    // Discovered lazily otherwise, which forces a mid-session re-optimization (504s).
    include: ['sql-formatter'],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Monaco is one lazily loaded ~4 MB chunk, read from local disk by the desktop app.
    chunkSizeWarningLimit: 4500,
  },
});
