import { test, expect, installPlayerFixture } from '../../web/e2e/player-fixture';

for (const theme of ['dark', 'light']) {
  for (const palette of ['nutmeg', 'slate']) {
    test(`centred player viewer from Levels · ${theme} · ${palette}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      if (theme === 'light' && palette === 'slate') await page.emulateMedia({ reducedMotion: 'reduce' });
      await installPlayerFixture(page);
      await page.addInitScript(({ theme, palette }) => {
        localStorage.setItem('avn-theme', theme);
        localStorage.setItem('avn-palette', palette);
        localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10));
        localStorage.setItem('avn-story-view-viewer-game', JSON.stringify('info'));
      }, { theme, palette });

      for (const section of ['levels?level=12']) {
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
        await expect(dialog.getByRole('button', { name: 'Raw events', exact: true })).toHaveAttribute('aria-pressed', 'true');
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
        expect((await dialog.boundingBox())!.height).toBe(bounds!.height);
        expect((await dialog.boundingBox())!.y).toBe(bounds!.y);
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

test('a player opened from Players is a page with a way back, not a popup', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installPlayerFixture(page, { rich: true });
  await page.addInitScript(() => { localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10)); });
  await page.goto('/games/viewer-game/players');
  await page.locator('a.row-title').first().click();
  const view = page.locator('.player-page');
  await expect(view).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(view.locator('.player-view-id')).toHaveText('player-one');
  await expect(view.getByRole('button', { name: 'Raw events', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.get('player')).toBe('player-one');

  // The copy icon confirms itself: a tick, then back.
  await view.getByRole('button', { name: 'Copy player ID' }).click();
  await expect(view.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Copy player ID' })).toBeVisible();

  // Ready-made highlights: levels as started / completed / failed, ads by kind; only started events light up.
  await expect(view.locator('.journey-events li').first()).toBeAttached();
  const group = view.getByRole('group', { name: 'Highlights', exact: true });
  await expect(group.getByRole('button', { name: /Level started/ })).toBeVisible();
  await expect(group.getByRole('button', { name: /Rewarded ads/ })).toBeVisible();
  await expect(group.getByRole('button', { name: /App open ads/ })).toHaveCount(0);
  await group.getByRole('button', { name: /Level started/ }).click();
  await expect(group.getByRole('button', { name: /Level started/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await view.locator('.journey-events li.timeline-match').count()).toBe(12);
  await group.getByRole('button', { name: /Level started/ }).click();
  expect(await view.locator('.journey-events li.timeline-match').count()).toBe(0);

  // Sessions are listed beside the timeline.
  const rail = view.getByRole('complementary', { name: 'Sessions' });
  if (page.viewportSize()!.width > 900) {
    await expect(rail).toBeVisible();
    await rail.getByRole('button', { name: /Session 2/ }).click();
    await expect(view.locator('.journey-session')).toHaveCount(1);
  }

  // Event Analysis keeps the picked event beside the list.
  await view.getByRole('button', { name: 'Event Analysis', exact: true }).click();
  await view.getByRole('button', { name: 'LEVEL_ANALYSIS', exact: true }).click();
  const detail = view.getByLabel('Selected event');
  await expect(detail.getByRole('button', { name: 'STATE', exact: true })).toBeVisible();
  const list = (await view.locator('.ea-list').boundingBox())!;
  const side = (await detail.boundingBox())!;
  if (page.viewportSize()!.width > 900) expect(Math.abs(side.y - list.y)).toBeLessThan(40);
  await page.screenshot({ path: info.outputPath('player-page-analysis.png'), animations: 'disabled' });

  // Next / Previous walk the list; Back returns to it.
  await view.getByRole('button', { name: 'Next ›', exact: true }).click();
  await expect(view.locator('.player-view-id')).toHaveText('player-two');
  await view.getByRole('button', { name: '← Players', exact: true }).click();
  await expect(page.locator('a.row-title').first()).toBeVisible();
  expect(new URL(page.url()).searchParams.has('player')).toBe(false);
  expect(errors).toEqual([]);
});

