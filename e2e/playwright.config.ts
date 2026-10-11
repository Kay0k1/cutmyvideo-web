import { defineConfig, devices } from '@playwright/test'

// An isolated Linux dependency wrapper can be supplied without changing the
// bundled browser or host packages. Normal CI uses Playwright's own executable.
const webkitLaunch = process.env.CUTMY_E2E_WEBKIT_EXECUTABLE
  ? { launchOptions: { executablePath: process.env.CUTMY_E2E_WEBKIT_EXECUTABLE } }
  : {}

export default defineConfig({
  testDir: '.',
  globalSetup: './setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: process.env.CUTMY_E2E_OUTPUT ? `${process.env.CUTMY_E2E_OUTPUT}/test-results` : '../test-results',
  reporter: [['list'], ['html', { outputFolder: process.env.CUTMY_E2E_OUTPUT ? `${process.env.CUTMY_E2E_OUTPUT}/playwright-report` : '../playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env.CUTMY_E2E_URL || 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', testMatch: /(?:batch-media|batch-settings|acceptance|security|editor|locale|workflow|collection|controls|platform|recovery|core-contract|resources|usability-components)\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', testMatch: /(?:batch-settings|mobile|usability-components)\.spec\.ts/, use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'layout-chromium', testMatch: /layout\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'layout-firefox', testMatch: /layout\.spec\.ts/, use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'layout-webkit', testMatch: /layout\.spec\.ts/, use: { ...devices['Desktop Safari'], ...webkitLaunch, viewport: { width: 1440, height: 900 } } },
    { name: 'usability-chromium', testMatch: /usability\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'usability-firefox', testMatch: /usability\.spec\.ts/, use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'usability-webkit', testMatch: /usability\.spec\.ts/, use: { ...devices['Desktop Safari'], ...webkitLaunch, viewport: { width: 1440, height: 900 } } },
  ],
})
