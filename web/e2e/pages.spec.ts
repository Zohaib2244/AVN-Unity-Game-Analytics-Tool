import { expect, test } from '@playwright/test';

const PAGES = ['/', '/games/new', '/status', '/settings'];

for (const theme of ['dark', 'light']) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme as 'dark' | 'light' });
    for (const path of PAGES) {
      test(`${path} renders without console errors`, async ({ page }, info) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript((value) => localStorage.setItem('avn-theme', value), theme);
        await page.goto(path);
        await expect(page.locator('#main')).toBeVisible();
        await page.screenshot({ path: info.outputPath(`${theme}-${path.replace(/\W+/g, '_') || 'home'}.png`), fullPage: true });
        expect(errors).toEqual([]);
      });
    }
  });
}
