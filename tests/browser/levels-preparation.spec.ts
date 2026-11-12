import { test, expect, installPlayerFixture } from '../../web/e2e/player-fixture';

for (const theme of ['dark', 'light']) {
  for (const palette of ['nutmeg', 'slate']) {
    test(`Levels preparation and recovery · ${theme} · ${palette}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await installPlayerFixture(page, { levelCount: 400 });
      await page.addInitScript(({ theme, palette }) => {
        localStorage.setItem('avn-theme', theme);
        localStorage.setItem('avn-palette', palette);
        localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10));
      }, { theme, palette });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      let state: 'preparing' | 'failed' | 'ready' = 'preparing';
      let polls = 0;
      await page.route('**/insights/levels?*', async (route) => {
        expect(route.request().headers().prefer).toBe('respond-async');
        polls++;
        if (state === 'ready') { await route.fallback(); return; }
        await route.fulfill({
          status: state === 'preparing' ? 202 : 422,
          headers: { 'Retry-After': '1' },
          json: { detail: state === 'preparing'
            ? 'Preparing this view… It will appear here when ready.'
            : "This view couldn't be prepared. Try fewer days or players." },
        });
      });
      await page.goto('/games/viewer-game/levels');
      // Let facets settle the initial latest-version query, then observe repeated pending reads.
      await expect.poll(() => polls).toBeGreaterThanOrEqual(3);
      await expect(page.getByText('Preparing this view… It will appear here when ready.')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`preparing-${theme}-${palette}.png`), fullPage: true });

      state = 'failed';
      await expect(page.getByRole('alert')).toContainText("This view couldn't be prepared. Try fewer days or players.");
      expect(polls).toBeGreaterThanOrEqual(2);
      await page.screenshot({ path: info.outputPath(`failed-${theme}-${palette}.png`), fullPage: true });
      state = 'ready';
      const retry = page.getByRole('button', { name: 'Try again' });
      await retry.focus();
      await retry.press('Enter');
      await expect(page.locator('.levels-grid tbody tr').first()).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`ready-${theme}-${palette}.png`), fullPage: true });
      expect(errors).toEqual([]);
    });
  }
}
