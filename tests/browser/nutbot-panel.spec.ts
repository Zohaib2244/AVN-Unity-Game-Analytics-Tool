import type { Page } from '@playwright/test';
import { test, expect, installPlayerFixture } from '../../web/e2e/player-fixture';

const HARNESS = {
  id: 'codex', label: 'Codex', available: true, models: ['standard', 'small'], default_model: 'standard', cheap_model: 'small',
  efforts: { standard: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }, models_from: 'agent', reason: '', probe_error: '',
};

async function mockNutBot(page: Page, chat = '{"type":"text","text":"The selected levels have two players."}\n{"type":"done","seconds":1}\n'): Promise<string[]> {
  const sent: string[] = [];
  await installPlayerFixture(page);
  await page.route('**/v1/nutbot', (route) => route.fulfill({ json: {
    enabled: true, default: 'codex', daily_limit: 100, warn_percent: 80, harnesses: [HARNESS],
    skills: [{ name: 'digest', summary: 'Summarise the game', args: '' }],
  } }));
  await page.route('**/nutbot/chats', (route) => route.fulfill({ json: { chats: [] } }));
  await page.route('**/nutbot/reports', (route) => route.fulfill({ json: { reports: [] } }));
  await page.route('**/nutbot/chat', (route) => { sent.push(route.request().postData() || ''); return route.fulfill({ contentType: 'application/x-ndjson', body: chat }); });
  return sent;
}

async function openNutBot(page: Page): Promise<string[]> {
  const sent = await mockNutBot(page);
  await page.goto('/games/viewer-game/levels');
  await expect(page.locator('.nb-launcher')).toBeEnabled();
  await page.locator('.nb-launcher').click();
  await expect(page.getByRole('textbox', { name: 'Message NutBot' })).toBeFocused();
  return sent;
}

/** The composer stays at the bottom of the panel, full width and clickable, whatever view is above it. */
async function expectComposerLayout(page: Page, panel = page.locator('.nb')): Promise<void> {
  const composer = panel.locator('.nb-in');
  const field = panel.getByRole('textbox', { name: 'Message NutBot' });
  // The shared panel slides in; measure the resting layout after that transform settles.
  await expect.poll(() => panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const panelBox = (await panel.boundingBox())!;
  const composerBox = (await composer.boundingBox())!;
  const fieldBox = (await field.boundingBox())!;
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  expect(fieldBox.width).toBeGreaterThan(Math.min(420, panelBox.width) - 65);
  const send = panel.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeVisible();
  await expect.poll(() => send.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  // Nothing sits under the composer: no settings strip, no help paragraph.
  await expect(panel.locator('.nb-extra, .nb-foot')).toHaveCount(0);
}

for (const theme of ['dark', 'light']) {
  for (const palette of ['nutmeg', 'slate']) {
    test(`NutBot keeps history and settings above the composer · ${theme} · ${palette}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(({ theme, palette }) => {
        localStorage.setItem('avn-theme', theme);
        localStorage.setItem('avn-palette', palette);
        localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10));
      }, { theme, palette });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const sent = await openNutBot(page);
      await expectComposerLayout(page);
      await expect(page.getByRole('button', { name: 'Cheap', exact: true })).toHaveCount(0);
      await expect(page.locator('.pbar-hint')).toBeHidden();
      await page.screenshot({ path: info.outputPath(`nutbot-${theme}-${palette}.png`), animations: 'disabled' });

      // History, reports and settings replace the conversation above the composer, and come back.
      const field = page.getByRole('textbox', { name: 'Message NutBot' });
      await field.fill('A draft');
      await page.getByRole('button', { name: 'Chat history', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Chat history' })).toBeVisible();
      await expectComposerLayout(page);
      await page.getByRole('button', { name: 'Reports', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Saved reports' })).toBeVisible();
      await expectComposerLayout(page);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('region', { name: 'NutBot settings' });
      await expect(settings).toBeVisible();
      for (const name of ['Assistant', 'Model', 'Effort']) expect((await settings.getByRole('combobox', { name, exact: true }).boundingBox())!.width).toBeGreaterThan(130);
      await expect(settings.getByRole('combobox', { name: 'Model', exact: true }).locator('option')).toHaveText(['standard', 'small']);
      await settings.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('high');
      await expectComposerLayout(page);
      await page.screenshot({ path: info.outputPath(`nutbot-settings-${theme}-${palette}.png`), animations: 'disabled' });
      // Escape leaves a view before it closes the panel.
      await field.focus();
      await field.press('Escape');
      await expect(page.getByRole('heading', { name: 'Ask about this page' })).toBeVisible();
      await expect(field).toHaveValue('A draft');

      await field.fill('/');
      const command = page.getByRole('listbox', { name: 'Commands' }).getByRole('option').first();
      await expect(command).toContainText('/digest');
      await expect(command.locator('.ic')).toBeHidden();
      await field.fill('Review the levels');
      await field.press('Shift+Enter');
      await expect(field).toHaveValue('Review the levels\n');
      await field.press('Enter');
      await expect(page.locator('.nb-u')).toHaveText('Review the levels');
      await expect(page.locator('.nb-md')).toContainText('The selected levels have two players.');
      expect(JSON.parse(sent[0]!)).toMatchObject({ harness: 'codex', model: 'standard', effort: 'high' });
      await expect(page.locator('.nb-b')).not.toContainText(/tokens|\$/);
      await expectComposerLayout(page);
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Ask about this page' })).toBeVisible();

      // The prompt's context menu remains above the input, within the panel; Escape closes the menu first.
      await field.fill('@');
      const context = page.getByRole('listbox', { name: 'Add context' });
      await expect(context).toBeVisible();
      const option = context.getByRole('option').first();
      await expect.poll(async () => Math.abs((await context.locator('.pbar-glow').boundingBox())!.height - (await option.boundingBox())!.height)).toBeLessThan(1);
      await option.click();
      await expect(field).toBeFocused();
      await field.fill('@');
      await field.press('Escape');
      await expect(context).toBeHidden();
      await expect(page.locator('.nb-dock')).toBeVisible();
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expectComposerLayout(page);
});

test('NutBot settings show allowance limits without fetching token totals', async ({ page }, info) => {
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const usage = page.getByRole('region', { name: 'Allowance limits' });
  await expect(usage).toContainText('Codex · 5 hours: 60% used, resets');
  await expect(usage).toContainText('Codex · week: 91% used, resets');
  await expect(usage).toContainText('nearly used up');
  await expect(usage).not.toContainText(/tokens|answers|Today:|Last 7 days:|\$/i);
  expect(requests).not.toContain('/v1/nutbot/usage');
  await expectComposerLayout(page);
  await page.screenshot({ path: info.outputPath('nutbot-limits.png'), animations: 'disabled' });
});

test('NutBot settings explain when no allowance limits are available', async ({ page }) => {
  await openNutBot(page);
  await page.route('**/v1/nutbot/limits', (route) => route.fulfill({ json: { agents: {}, warn_percent: 80 } }));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Allowance limits' })).toContainText('No allowance limits are available.');
});

test('NutBot settings can retry a failed allowance check', async ({ page }) => {
  await openNutBot(page);
  let attempts = 0;
  await page.route('**/v1/nutbot/limits', (route) => {
    attempts++;
    return attempts <= 2
      ? route.fulfill({ status: 503, json: { detail: 'Unavailable' } })
      : route.fulfill({ json: { agents: { codex: { error: '', windows: [] } }, warn_percent: 80 } });
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const usage = page.getByRole('region', { name: 'Allowance limits' });
  await expect(usage.getByRole('alert')).toContainText('Could not check the allowance limits.');
  await usage.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(usage).toContainText('Codex: allowance unknown.');
  expect(attempts).toBe(3);
});

test('a report card saves nothing until Save is pressed', async ({ page }) => {
  const posted: string[] = [];
  await mockNutBot(page, `${JSON.stringify({ type: 'proposal', kind: 'report', title: 'Level 12 review', why: '', game_id: 'viewer-game', plain: ['Saves “Level 12 review” to this game\'s Reports'], payload: { title: 'Level 12 review', body: 'Level 12 loses everyone.', headline: null } })}\n{"type":"text","text":"Here is the review."}\n{"type":"done","seconds":1}\n`);
  await page.route('**/nutbot/reports', (route) => {
    if (route.request().method() === 'POST') { posted.push(route.request().postData() || ''); return route.fulfill({ json: { id: 'r1' } }); }
    return route.fulfill({ json: { reports: [] } });
  });
  // "Apply straight away" covers page cards only; a report still waits for Save.
  await page.addInitScript(() => localStorage.setItem('avn-nutbot-apply', JSON.stringify('auto')));
  await page.goto('/games/viewer-game/levels');
  await page.locator('.nb-launcher').click();
  const field = page.getByRole('textbox', { name: 'Message NutBot' });
  await field.fill('/level-review 12');
  await field.press('Enter');
  await expect(page.locator('.nb-md')).toContainText('Here is the review.');
  expect(posted).toEqual([]);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved to Reports.')).toBeVisible();
  expect(JSON.parse(posted[0]!)).toMatchObject({ title: 'Level 12 review', body: 'Level 12 loses everyone.' });
});

test('the same NutBot conversation moves into the player viewer and back', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sent = await mockNutBot(page);
  await page.goto('/games/viewer-game/levels?level=12');
  await page.locator('a.row-title').first().click();
  const dialog = page.getByRole('dialog', { name: 'Player details', exact: true });
  await expect(dialog.getByRole('button', { name: 'Raw events', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Asking from the viewer draws NutBot inside it (the page behind is inert); the viewer stays centred.
  await dialog.getByRole('button', { name: 'Ask NutBot', exact: true }).click();
  const panel = dialog.locator('.nb');
  const field = panel.getByRole('textbox', { name: 'Message NutBot' });
  await expect(field).toBeFocused();
  await expect(page.locator('.nb-dock')).toHaveCount(0);
  await expect(panel.locator('.nb-ctx')).toContainText('Player player-one');
  const bounds = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThan(2);
  await expectComposerLayout(page, panel);
  await field.fill('What did this player do last?');
  await field.press('Enter');
  await expect(panel.locator('.nb-md')).toContainText('The selected levels have two players.');
  expect(JSON.parse(sent[0]!).context.player).toBe('player-one');
  await expect(panel.locator('.nb-mf')).toContainText('Player player-one');
  await page.screenshot({ path: info.outputPath('nutbot-in-player.png'), animations: 'disabled' });

  // A narrow viewer switches between the player and NutBot; a new player starts on the player again.
  if (viewport.width <= 1100) {
    await dialog.getByRole('button', { name: 'Player', exact: true }).click();
    await expect(panel).toBeHidden();
    await dialog.getByRole('button', { name: 'NutBot', exact: true }).click();
  }
  await field.fill('Half-typed');
  // Escape in the composer's open menu closes the menu, not the viewer.
  await field.fill('Half-typed /');
  await expect(panel.getByRole('listbox', { name: 'Commands' })).toBeVisible();
  await field.press('Escape');
  await expect(dialog).toBeVisible();
  await field.fill('Half-typed');

  // Closing the viewer brings the same conversation and draft back to the side panel.
  await dialog.getByRole('button', { name: 'Close ×', exact: true }).click();
  await expect(dialog).toBeHidden();
  const dock = page.locator('.nb-dock');
  await expect(dock).toBeVisible();
  await expect(dock.locator('.nb-u')).toHaveText('What did this player do last?');
  await expect(dock.getByRole('textbox', { name: 'Message NutBot' })).toHaveValue('Half-typed');
  await expect(dock.locator('.nb-ctx')).not.toContainText('Player player-one');
  expect(errors).toEqual([]);
});
