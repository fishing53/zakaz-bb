import { defineConfig, devices } from '@playwright/test';

const localChrome = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4178', trace: 'retain-on-failure', serviceWorkers: 'block', launchOptions: localChrome ? { executablePath: localChrome } : undefined },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 4178', url: 'http://127.0.0.1:4178', reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
