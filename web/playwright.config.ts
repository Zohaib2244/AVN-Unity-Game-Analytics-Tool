import { defineConfig, devices } from '@playwright/test';

// The screenshot self-check from the avn-ux process: every page at three widths (wide, tablet rail,
// phone tab bar), dark and light. Needs the admin server (scripts/dev.sh) and `npx playwright install chromium`.
export default defineConfig({
  testDir: '..',
  testMatch: ['web/e2e/**/*.spec.ts', 'tests/browser/**/*.spec.ts'],
  outputDir: 'test-results',
  use: { baseURL: process.env.AVN_WEB_URL || 'http://127.0.0.1:8201' },
  projects: [
    { name: 'wide', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 900, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
