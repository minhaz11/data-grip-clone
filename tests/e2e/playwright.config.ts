import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

// UI end-to-end tests against the production Vite build, with the Rust backend replaced by a fake
// IPC layer (fake-ipc.js). WebKit is closest to the shipped WebViews (WebKitGTK, WKWebView);
// Chromium stands in for WebView2.
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Monaco is a lazily loaded 4 MB chunk; on a busy machine it can take longer than the 5 s default.
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1400, height: 900 } },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } },
    },
  ],
  webServer: {
    command: `npm -w apps/desktop run build && npm -w apps/desktop run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: '../..',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
