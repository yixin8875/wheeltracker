import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', fullyParallel: true, reporter: 'list',
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:1420', channel: 'msedge', viewport: { width: 1280, height: 900 } },
});
