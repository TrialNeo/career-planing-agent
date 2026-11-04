import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 20000,
  globalSetup: './scripts/e2e-setup.mjs',
  use: {
    baseURL: 'http://127.0.0.1:3002',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge',
    headless: true,
    trace: 'retain-on-failure',
  },
});
