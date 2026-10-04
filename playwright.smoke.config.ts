import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error('Set BASE_URL to the deployed app, e.g. BASE_URL=https://synctrail.example.com npm run test:smoke');
}

export default defineConfig({
  testDir: './smoke',
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list']],
  use: { baseURL: BASE_URL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
