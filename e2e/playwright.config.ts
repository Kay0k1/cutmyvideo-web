import { defineConfig, devices } from '@playwright/test'
import type { ReporterDescription } from '@playwright/test'
import { localArtifactDirectory } from './local-artifacts'

const temporaryOutput = !process.env.CI && !process.env.CUTMY_E2E_OUTPUT
const resultRoot = process.env.CUTMY_E2E_OUTPUT || (temporaryOutput ? localArtifactDirectory() : undefined)
const reporters: ReporterDescription[] = temporaryOutput
  ? [['list'], ['./local-artifacts.ts', { root: resultRoot! }]]
  : [['list'], ['html', { outputFolder: resultRoot ? `${resultRoot}/playwright-report` : '../playwright-report', open: 'never' }]]
if (process.env.CUTMY_E2E_JSON_OUTPUT) {
  reporters.push(['json', { outputFile: process.env.CUTMY_E2E_JSON_OUTPUT }])
}

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
  outputDir: resultRoot ? `${resultRoot}/test-results` : '../test-results',
  reporter: reporters,
  metadata: { ci: { commit: process.env.GITHUB_SHA || 'local', run: process.env.GITHUB_RUN_ID || 'local', attempt: process.env.GITHUB_RUN_ATTEMPT || 'local' } },
  use: {
    baseURL: process.env.CUTMY_E2E_URL || 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', testMatch: /(?:agent-projects|timeline-section|unified-workspace|window-preview|efficient-cutting|project-safety|release-features|projects-history|cutting-ux|batch-media|batch-settings|acceptance|security|editor|locale|workflow|collection|controls|platform|recovery|core-contract|resources|usability-components)\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', testMatch: /(?:agent-projects|timeline-section|window-preview|efficient-cutting|project-safety|release-features|projects-history|cutting-ux|batch-settings|mobile|usability-components)\.spec\.ts/, use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'layout-chromium', testMatch: /layout\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'layout-firefox', testMatch: /layout\.spec\.ts/, use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'layout-webkit', testMatch: /layout\.spec\.ts/, use: { ...devices['Desktop Safari'], ...webkitLaunch, viewport: { width: 1440, height: 900 } } },
    { name: 'usability-chromium', testMatch: /(?:editor-responsive|agent-projects|timeline-section|unified-workspace|project-safety|window-preview|efficient-cutting|usability)\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'usability-firefox', testMatch: /(?:editor-responsive|agent-projects|timeline-section|unified-workspace|project-safety|window-preview|efficient-cutting|usability)\.spec\.ts/, use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'usability-webkit', testMatch: /(?:editor-responsive|agent-projects|timeline-section|unified-workspace|project-safety|window-preview|efficient-cutting|usability)\.spec\.ts/, use: { ...devices['Desktop Safari'], ...webkitLaunch, viewport: { width: 1440, height: 900 } } },
  ],
})
