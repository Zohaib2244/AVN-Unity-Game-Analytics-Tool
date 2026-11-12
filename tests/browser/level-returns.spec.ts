import { test, expect, installPlayerFixture } from '../../web/e2e/player-fixture';

for (const theme of ['dark', 'light']) {
  for (const palette of ['nutmeg', 'slate']) {
    test(`Levels return filter · ${theme} · ${palette}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await installPlayerFixture(page);
      await page.addInitScript(({ theme, palette }) => {
        localStorage.setItem('avn-theme', theme);
        localStorage.setItem('avn-palette', palette);
        localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10));
      }, { theme, palette });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/games/viewer-game/levels');
      const toggle = page.getByRole('checkbox', { name: 'Exclude players who came back' });
      await expect(toggle).not.toBeChecked();
      await expect(page.locator('.levels-grid tbody tr')).toHaveCount(1);
      const request = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname.endsWith('/insights/levels') && url.searchParams.get('exclude_returners') === 'true';
      });
      await toggle.press('Space');
      await expect(toggle).toBeChecked();
      await request;
      const label = toggle.locator('..');
      expect((await label.boundingBox())!.height).toBeLessThanOrEqual(48);
      expect((await label.locator('span').boundingBox())!.width).toBeGreaterThan(150);
      await expect(page.getByRole('columnheader', { name: 'Drop to next level · no return' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`returns-${theme}-${palette}.png`), fullPage: true });

      await page.reload();
      await expect(toggle).toBeChecked();
      const drill = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname.endsWith('/levels/players') && url.searchParams.get('exclude_returners') === 'true';
      });
      await page.locator('.level-open').first().click();
      await drill;
      await expect(toggle).toBeChecked();
      await expect(page.getByRole('button', { name: /Came back later/ })).toBeVisible();
      await page.getByRole('button', { name: /Came back later/ }).click();
      await expect(page.getByText('Returners stay visible here', { exact: false })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`returned-players-${theme}-${palette}.png`), fullPage: true });

      const features = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname.endsWith('/levels/features') && url.searchParams.get('exclude_returners') === 'true';
      });
      await page.getByRole('button', { name: 'Occurrence & drop' }).click();
      await features;
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      await expect(toggle).not.toBeChecked();
      expect(errors).toEqual([]);
    });
  }
}

test('saved level views restore the return filter and release comparison scope', async ({ page }) => {
  await installPlayerFixture(page);
  await page.route('**/insights/facets?*', (route) => route.fulfill({ json: {
    latest_app_version: '1.4.2', app_version: [{ value: '1.4.2', players: 2 }, { value: '1.4.1', players: 2 }],
  } }));
  await page.goto('/games/viewer-game/levels');
  await expect(page.locator('.levels-grid tbody tr')).toHaveCount(1);
  const toggle = page.getByRole('checkbox', { name: 'Exclude players who came back' });
  await toggle.check();
  await page.getByRole('button', { name: 'New players · first session', exact: true }).click();
  const comparison = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname.endsWith('/insights/levels') && url.searchParams.get('version') === '1.4.1'
      && url.searchParams.get('exclude_returners') === 'true' && url.searchParams.get('scope') === 'first_session';
  });
  await page.getByRole('button', { name: 'Compare releases', exact: true }).click();
  await comparison;
  await page.getByText('Saved views on this device', { exact: true }).click();
  await page.getByRole('button', { name: 'Save current view' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save level view' });
  await dialog.getByLabel('Name', { exact: true }).fill('No return');
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await toggle.uncheck();
  await page.getByRole('button', { name: 'Everyone', exact: true }).click();
  const saved = page.getByRole('combobox', { name: 'Saved level view' });
  await saved.selectOption('');
  await saved.selectOption('No return');
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('button', { name: 'New players · first session', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
