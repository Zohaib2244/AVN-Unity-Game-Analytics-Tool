import { test, expect, installPlayerFixture } from '../../web/e2e/player-fixture';

for (const theme of ['dark', 'light']) {
  for (const palette of ['nutmeg', 'slate']) {
    test(`centred player viewer · ${theme} · ${palette}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      if (theme === 'light' && palette === 'slate') await page.emulateMedia({ reducedMotion: 'reduce' });
      await installPlayerFixture(page);
      await page.addInitScript(({ theme, palette }) => {
        localStorage.setItem('avn-theme', theme);
        localStorage.setItem('avn-palette', palette);
        localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10));
      }, { theme, palette });

      for (const section of ['levels?level=12', 'players']) {
        await page.goto(`/games/viewer-game/${section}`);
        const trigger = page.locator('a.row-title').first();
        await expect(trigger).toBeVisible();
        // Record the resting page position after its entrance transform has finished.
        await expect.poll(() => page.locator('main.content').evaluate((el) => getComputedStyle(el).transform)).toBe('none');
        await trigger.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        // Playwright may scroll the link into view again before clicking. Match the actual opening spot.
        await trigger.evaluate((el) => el.addEventListener('click', () => el.setAttribute('data-opening-scroll', String(window.scrollY)), { once: true, capture: true }));
        await trigger.click();
        const scroll = Number(await trigger.getAttribute('data-opening-scroll'));
        const dialog = page.getByRole('dialog', { name: 'Player details', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.player-view-id')).toHaveText('player-one');
        await expect(dialog.locator('.journey-events li').first()).toBeAttached();
        const bounds = await dialog.boundingBox();
        const viewport = page.viewportSize()!;
        expect(Math.abs(bounds!.x + bounds!.width / 2 - viewport.width / 2)).toBeLessThan(2);
        expect(Math.abs(bounds!.y + bounds!.height / 2 - viewport.height / 2)).toBeLessThan(2);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
        const body = dialog.locator('.player-view-body');
        expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
        await page.screenshot({ path: info.outputPath(`${section.split('?')[0]}-${theme}-${palette}.png`), animations: 'disabled' });
        await page.locator('.app').evaluate((el) => el.classList.add('nb-open'));
        expect((await dialog.boundingBox())!.x).toBe(bounds!.x);
        await page.locator('.app').evaluate((el) => el.classList.remove('nb-open'));

        // A fixed header remains available while the long timeline scrolls.
        const headerTop = (await dialog.locator('.player-view-head').boundingBox())!.y;
        await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        expect((await dialog.locator('.player-view-head').boundingBox())!.y).toBe(headerTop);
        await dialog.getByRole('button', { name: 'Next ›', exact: true }).click();
        await expect(dialog.locator('.player-view-id')).toHaveText('player-two');
        await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
        expect(new URL(page.url()).searchParams.get('player')).toBe('player-two');
        if (section.startsWith('levels')) expect(new URL(page.url()).searchParams.get('level')).toBe('"12"');
        await dialog.getByRole('button', { name: 'Player info', exact: true }).click();
        await expect(dialog.getByRole('heading', { name: 'Player information' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Raw events', exact: true }).click();

        // Calendar popovers must stay beneath their anchor rather than inheriting a centring transform.
        await dialog.getByRole('button', { name: 'Selected days', exact: true }).click();
        const calendar = dialog.locator('.range-pop');
        await expect(calendar).toBeVisible();
        if (viewport.width > 620) {
          const anchor = (await dialog.getByRole('button', { name: 'Selected days', exact: true }).boundingBox())!;
          await expect.poll(async () => Math.abs((await calendar.boundingBox())!.y - anchor.y - anchor.height - 6)).toBeLessThan(2);
        }
        await calendar.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Close ×', exact: true }).focus();
        await page.keyboard.press('Shift+Tab');
        expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(trigger).toBeFocused();
        // Wait for focus and scroll restoration to finish, allowing the shorter page to clamp the position.
        await expect.poll(() => page.evaluate((origin) => Math.abs(window.scrollY - Math.min(origin, Math.max(0, document.documentElement.scrollHeight - window.innerHeight))), scroll)).toBeLessThan(8);
        expect(new URL(page.url()).searchParams.has('player')).toBe(false);
      }
      expect(errors).toEqual([]);
    });
  }
}
