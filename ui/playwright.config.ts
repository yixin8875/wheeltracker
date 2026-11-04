import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', fullyParallel: true, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1420', channel: 'msedge', viewport: { width: 1280, height: 900 } },
});
