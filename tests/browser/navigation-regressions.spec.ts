import { test, expect, installPlayerFixture } from '../../web/e2e/player-fixture';

test.beforeEach(async ({ page }) => {
  await installPlayerFixture(page);
  await page.addInitScript(() => {
    localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10));
  });
});

test('Undo restores a hidden parameter without closing player details', async ({ page }) => {
  await page.goto('/games/viewer-game/players?player=player-one');
  const dialog = page.getByRole('dialog', { name: 'Player details', exact: true });
  const parameter = dialog.locator('.chip-key[title="Hide score in every event"]').first();
  await parameter.click();
  await expect(dialog.locator('.chip-key').filter({ hasText: /^score$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.chip-key').filter({ hasText: /^score$/ }).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get('player')).toBe('player-one');
});

test('Levels view switches reliably and survives refresh and browser history', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('avn-levels-view-viewer-game', JSON.stringify('compare')));
  await page.goto('/games/viewer-game/levels');
  const views = page.getByRole('group', { name: 'Levels view', exact: true });
  for (let index = 0; index < 3; index++) {
    await views.getByRole('button', { name: 'Level by level', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Level by level', exact: true })).toBeVisible();
    await expect(views.getByRole('button', { name: 'Level by level', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Level by level', exact: true })).toBeVisible();
    await views.getByRole('button', { name: 'Compare releases', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Compare releases', exact: true })).toBeVisible();
  }
  await page.goto('/games/viewer-game/players');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Compare releases', exact: true })).toBeVisible();
});

test('Game selector stays beside its trigger on a scrolled page', async ({ page }, info) => {
  await installPlayerFixture(page, { levelCount: 60 });
  await page.goto('/games/viewer-game/levels?view=table');
  await expect(page.locator('[data-level-row]').first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 300));
  const trigger = page.locator(info.project.name === 'phone' ? '.m-switch' : '.game-switch');
  await trigger.click();
  const picker = page.locator('.game-pop');
  await expect(picker).toBeVisible();
  const viewport = page.viewportSize()!;
  if (info.project.name !== 'phone') {
    const anchor = (await trigger.boundingBox())!;
    await expect.poll(async () => Math.abs((await picker.boundingBox())!.y - anchor.y - anchor.height - 6)).toBeLessThan(2);
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect.poll(async () => Math.abs((await picker.boundingBox())!.y - (await trigger.boundingBox())!.y - anchor.height - 6)).toBeLessThan(2);
  }
  await expect.poll(async () => { const rect = (await picker.boundingBox())!; return rect.y >= 0 && rect.y + rect.height <= viewport.height + 1; }).toBe(true);
  await page.screenshot({ path: info.outputPath('game-selector.png'), animations: 'disabled' });
  if (info.project.name !== 'phone') {
    await page.keyboard.press('Escape');
    await page.locator('.fresh').evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
    const crumb = page.locator('.crumbs > span:nth-child(2) > .crumb-link');
    // Some browsers do not focus buttons on click. The old fallback used the unrelated focused footer.
    await crumb.dispatchEvent('click');
    const anchor = (await crumb.boundingBox())!;
    await expect.poll(async () => Math.abs((await picker.boundingBox())!.y - anchor.y - anchor.height - 6)).toBeLessThan(2);
  }
});

test('Continue toast offers each browser its own last view while Home and direct links stay predictable', async ({ page, browser }, info) => {
  await page.goto('/games/viewer-game/levels?view=table');
  await expect(page.getByRole('heading', { name: 'Level by level', exact: true })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Test games', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/games\/viewer-game\/levels\?view=table$/);

  const otherBrowser = await browser.newContext({ baseURL: info.project.use.baseURL });
  try {
    const other = await otherBrowser.newPage();
    await installPlayerFixture(other);
    await other.addInitScript(() => localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10)));
    await other.goto('/');
    await expect(other.getByRole('heading', { name: 'Test games', exact: true })).toBeVisible();
    await other.goto('/games/viewer-game/players');
    // Let the page finish opening, so it is the one this browser remembers.
    await expect(other.getByRole('heading', { name: 'Players', exact: true })).toBeVisible();
    await other.goto('/');
    await expect(other.getByRole('heading', { name: 'Test games', exact: true })).toBeVisible();
    await other.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(other).toHaveURL(/\/games\/viewer-game\/players$/);
    await page.goto('/');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page).toHaveURL(/\/games\/viewer-game\/levels\?view=table$/);
  } finally { await otherBrowser.close(); }

  // An explicit shared link wins over memory. In-app Home does not bounce back.
  await page.goto('/games/viewer-game/players?player=player-two');
  await expect(page.getByRole('dialog', { name: 'Player details' })).toBeVisible();
  await page.getByRole('button', { name: 'Close ×', exact: true }).click();
  if (info.project.name === 'phone') {
    await page.getByRole('button', { name: /Switch game$/ }).click();
    await page.locator('.game-pop').getByRole('button', { name: 'All games', exact: true }).click();
  } else {
    await page.locator('a.brand').click();
  }
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Test games', exact: true })).toBeVisible();
});
