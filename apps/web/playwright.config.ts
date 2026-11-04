import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const node = process.execPath;
export default defineConfig({
  testDir: '../../tests/e2e',
  testMatch: 'chat.spec.ts',
  fullyParallel: true,
  workers: 2,
  timeout: 20000,
  outputDir: '../../.local/ui-test-results',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'msedge',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `"${node}" node_modules/vite/bin/vite.js --config apps/web/vite.config.ts`,
    cwd: resolve('.'),
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
