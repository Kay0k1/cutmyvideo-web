import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:5178'
const webkitLaunch = process.env.CUTMY_E2E_WEBKIT_EXECUTABLE
  ? { launchOptions: { executablePath: process.env.CUTMY_E2E_WEBKIT_EXECUTABLE } }
  : {}

// This suite intercepts every API and media request. It never needs an API,
// production session, network provider, or persistent media/database volume.
export default defineConfig({
  testDir: '.',
  testMatch: /editor-responsive\.spec\.ts/,
  globalSetup: './setup.ts',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  outputDir: process.env.CUTMY_E2E_OUTPUT ? `${process.env.CUTMY_E2E_OUTPUT}/test-results` : '/tmp/cutmy-responsive-results',
  reporter: [['list']],
  use: { baseURL, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev -- --port 5178 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'responsive-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'responsive-firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'responsive-webkit', use: { ...devices['Desktop Safari'], ...webkitLaunch } },
  ],
})
