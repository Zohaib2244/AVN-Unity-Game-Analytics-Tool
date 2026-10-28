import type { Page } from '@playwright/test';
import { test, expect, installPlayerFixture } from '../../web/e2e/player-fixture';

async function openNutBot(page: Page): Promise<void> {
  await installPlayerFixture(page);
  await page.route('**/v1/nutbot', (route) => route.fulfill({ json: {
    enabled: true, default: 'codex', daily_limit: 100, warn_percent: 80,
    harnesses: [{ id: 'codex', label: 'Codex', available: true, models: ['standard', 'small'], default_model: 'standard', cheap_model: 'small' }],
    skills: [{ name: 'digest', summary: 'Summarise the game', args: '' }],
  } }));
  await page.route('**/nutbot/chats', (route) => route.fulfill({ json: { chats: [] } }));
  await page.route('**/nutbot/reports', (route) => route.fulfill({ json: { reports: [] } }));
  await page.route('**/nutbot/chat', (route) => route.fulfill({
    contentType: 'application/x-ndjson',
    body: '{"type":"text","text":"The selected levels have two players."}\n{"type":"done","seconds":1}\n',
  }));
  await page.goto('/games/viewer-game/levels');
  await expect(page.locator('.nb-launcher')).toBeEnabled();
  await page.locator('.nb-launcher').click();
  await expect(page.getByRole('textbox', { name: 'Message NutBot' })).toBeFocused();
}

async function expectComposerLayout(page: Page): Promise<void> {
  const dock = page.locator('.nb-dock');
  const composer = page.locator('.nb-in');
  const settings = page.getByRole('group', { name: 'NutBot settings' });
  const field = page.getByRole('textbox', { name: 'Message NutBot' });
  // The shared panel slides in; measure the resting layout after that transform settles.
  await expect.poll(() => dock.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const viewport = page.viewportSize()!;
  const composerBox = (await composer.boundingBox())!;
  const settingsBox = (await settings.boundingBox())!;
  const fieldBox = (await field.boundingBox())!;
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(settingsBox.y + 1);
  expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(fieldBox.width).toBeGreaterThan(Math.min(420, viewport.width) - 65);
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeVisible();
  await expect.poll(() => send.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  for (const name of ['Assistant', 'Model']) {
    const select = page.getByRole('combobox', { name, exact: true });
    const box = (await select.boundingBox())!;
    expect(box.width).toBeGreaterThan(130);
    expect(box.y).toBeGreaterThanOrEqual(settingsBox.y);
  }
}

for (const theme of ['dark', 'light']) {
  for (const palette of ['nutmeg', 'slate']) {
    test(`NutBot composer and settings stay separate · ${theme} · ${palette}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(({ theme, palette }) => {
        localStorage.setItem('avn-theme', theme);
        localStorage.setItem('avn-palette', palette);
        localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10));
      }, { theme, palette });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openNutBot(page);
      await expectComposerLayout(page);
      await page.screenshot({ path: info.outputPath(`nutbot-${theme}-${palette}.png`), animations: 'disabled' });

      // Expanding secondary content reserves its own space instead of covering Send.
      await page.getByRole('button', { name: 'Chats', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Recent chats' })).toBeVisible();
      await expectComposerLayout(page);
      await page.getByRole('button', { name: 'Reports', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Saved reports' })).toBeVisible();
      await expectComposerLayout(page);
      await page.getByRole('button', { name: 'Reports', exact: true }).click();

      const field = page.getByRole('textbox', { name: 'Message NutBot' });
      await field.fill('Review the levels');
      await field.press('Shift+Enter');
      await expect(field).toHaveValue('Review the levels\n');
      await field.press('Enter');
      await expect(page.locator('.nb-u')).toHaveText('Review the levels');
      await expect(page.locator('.nb-md')).toContainText('The selected levels have two players.');
      await expectComposerLayout(page);
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Ask about this page' })).toBeVisible();

      // The prompt's context menu remains above the input, within the panel.
      await field.fill('@');
      const context = page.getByRole('listbox', { name: 'Add context' });
      await expect(context).toBeVisible();
      const option = context.getByRole('option').first();
      await expect.poll(async () => Math.abs((await context.locator('.pbar-glow').boundingBox())!.height - (await option.boundingBox())!.height)).toBeLessThan(1);
      await option.click();
      await expect(field).toBeFocused();
      await field.press('Escape');
      await expect(page.locator('.nb-dock')).toBeHidden();
      await expect(page.locator('.nb-launcher')).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}

test('NutBot keeps the composer usable with a short phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await openNutBot(page);
  await expectComposerLayout(page);
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await expectComposerLayout(page);
});

test('NutBot Usage shows allowance limits without fetching token totals', async ({ page }, info) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await openNutBot(page);
  await page.route('**/v1/nutbot/limits', (route) => route.fulfill({ json: {
    warn_percent: 80,
    agents: { codex: { error: '', windows: [
      { name: '5 hours', used_percent: 60, resets_at: new Date(Date.now() + 3600000).toISOString() },
      { name: 'week', used_percent: 91, resets_at: new Date(Date.now() + 86400000).toISOString() },
    ] } },
  } }));
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  const usage = page.getByRole('region', { name: 'NutBot usage' });
  await expect(usage).toContainText('Codex · 5 hours: 60% used, resets');
  await expect(usage).toContainText('Codex · week: 91% used, resets');
  await expect(usage).toContainText('nearly used up');
  await expect(usage).not.toContainText(/tokens|answers|Today:|Last 7 days:|\$/i);
  expect(requests).not.toContain('/v1/nutbot/usage');
  await expectComposerLayout(page);
  await page.screenshot({ path: info.outputPath('nutbot-limits.png'), animations: 'disabled' });
});

test('NutBot Usage explains when no allowance limits are available', async ({ page }) => {
  await openNutBot(page);
  await page.route('**/v1/nutbot/limits', (route) => route.fulfill({ json: { agents: {}, warn_percent: 80 } }));
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(page.getByRole('region', { name: 'NutBot usage' })).toHaveText('No allowance limits are available.');
});

test('NutBot Usage can retry a failed allowance check', async ({ page }) => {
  await openNutBot(page);
  let attempts = 0;
  await page.route('**/v1/nutbot/limits', (route) => {
    attempts++;
    return attempts <= 2
      ? route.fulfill({ status: 503, json: { detail: 'Unavailable' } })
      : route.fulfill({ json: { agents: { codex: { error: '', windows: [] } }, warn_percent: 80 } });
  });
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  const usage = page.getByRole('region', { name: 'NutBot usage' });
  await expect(usage.getByRole('alert')).toContainText('Could not check the allowance limits.');
  await usage.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(usage).toHaveText('Codex: allowance unknown.');
  expect(attempts).toBe(3);
});
