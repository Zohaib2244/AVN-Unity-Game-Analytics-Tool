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

test('a new chat keeps its answer on screen after the chat is saved', async ({ page }) => {
  // The chat is fetched as soon as the stream names it, while only the question is stored; the answer must not vanish.
  const text = 'The first levels lose players in small steps.';
  const stream = `${JSON.stringify({ type: 'chat', id: 'c1', title: 'First levels', harness: 'codex' })}\n${JSON.stringify({ type: 'text', text })}\n{"type":"done","seconds":1}\n`;
  await mockNutBot(page, stream);
  let reads = 0;
  const row = { id: 'c1', game_id: 'viewer-game', email: '', title: 'First levels', harness: 'codex', model: 'standard', agent_session: '', created_at: '', updated_at: '', deleted: false, messages: 1 };
  await page.route('**/nutbot/chats/c1', async (route) => {
    reads++;
    const messages = reads === 1
      ? [{ id: 1, role: 'user', text: 'Why do players leave?' }]
      : [{ id: 1, role: 'user', text: 'Why do players leave?' }, { id: 2, role: 'assistant', text, tools: [], actions: [], scope: '', error: '', seconds: 1, harness: 'codex', model: 'standard', usage: {}, context: {}, created_at: '' }];
    if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ json: { chat: { ...row, messages: messages.length }, messages } });
  });
  await page.goto('/games/viewer-game/levels');
  await page.locator('.nb-launcher').click();
  const field = page.getByRole('textbox', { name: 'Message NutBot' });
  await field.fill('Why do players leave?');
  await field.press('Enter');
  await expect(page.locator('.nb-md')).toContainText(text);
  await page.waitForTimeout(1500);
  await expect(page.locator('.nb-md')).toContainText(text);
  expect(reads).toBeGreaterThan(1);
  // What to do with the answer is a real button, not a small link.
  await expect(page.getByRole('button', { name: 'Save as report', exact: true })).toBeVisible();
  expect((await page.getByRole('button', { name: 'Save as report', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(32);
});

test('the / list reads without overlapping, and Escape closes it wherever the focus is', async ({ page }, info) => {
  await mockNutBot(page);
  await page.route('**/v1/nutbot', (route) => route.fulfill({ json: {
    enabled: true, default: 'codex', daily_limit: 100, warn_percent: 80, harnesses: [HARNESS],
    skills: [
      { name: 'digest', summary: 'What players have been doing lately: habits, loops, unused features, changes', args: 'optional: a date range' },
      { name: 'exits', summary: 'Where and why players stop playing', args: 'optional: a date range' },
      { name: 'level-review', summary: 'Review one level (or the worst levels): where players leave, why, what to change', args: 'a level' },
    ],
  } }));
  await page.goto('/games/viewer-game/levels');
  await page.locator('.nb-launcher').click();
  const field = page.getByRole('textbox', { name: 'Message NutBot' });
  await field.fill('/');
  const rows = page.getByRole('listbox', { name: 'Commands' }).getByRole('option');
  await expect(rows).toHaveCount(3);
  const boxes = await rows.evaluateAll((items) => items.map((item) => { const box = item.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, inner: item.scrollHeight <= item.clientHeight + 1 }; }));
  for (let index = 1; index < boxes.length; index++) expect(boxes[index]!.top).toBeGreaterThanOrEqual(boxes[index - 1]!.bottom - 1);
  for (const box of boxes) expect(box.inner).toBe(true);
  await page.screenshot({ path: info.outputPath('nutbot-commands.png'), animations: 'disabled' });
  await page.locator('.nb-h').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Commands' })).toBeHidden();
  await expect(page.locator('.nb-dock')).toBeVisible();
});

test('@ changes the dates for the next question only', async ({ page }) => {
  const sent = await mockNutBot(page);
  await page.goto('/games/viewer-game/levels');
  await page.locator('.nb-launcher').click();
  const field = page.getByRole('textbox', { name: 'Message NutBot' });
  await field.fill('@');
  const menu = page.getByRole('listbox', { name: 'Add context' });
  await menu.getByRole('option', { name: /Dates/ }).click();
  await menu.getByRole('option', { name: 'Last 7 days' }).click();
  await expect(page.locator('.nb-ctx')).not.toContainText('Last 30');
  await field.fill('How were the last days?');
  await field.press('Enter');
  await expect(page.locator('.nb-md')).toBeVisible();
  const first = JSON.parse(sent[0]!).context.range;
  expect(Date.parse(first.to) - Date.parse(first.from)).toBe(6 * 86400000);
  await field.fill('And now?');
  await field.press('Enter');
  await expect(page.locator('.nb-md').nth(1)).toBeVisible();
  const second = JSON.parse(sent[1]!).context.range;
  expect(Date.parse(second.to) - Date.parse(second.from)).toBeGreaterThan(6 * 86400000);
});

test('NutBot hides from the top left, floats when unlocked and can be made wider', async ({ page }, info) => {
  await mockNutBot(page);
  await page.goto('/games/viewer-game/levels');
  await page.locator('.nb-launcher').click();
  const dock = page.locator('.nb-dock');
  await expect(dock).toBeVisible();
  const hide = dock.getByRole('button', { name: 'Hide NutBot', exact: true });
  // The hide control is at the start of the header, not at the screen edge (the panel slides in first).
  await expect.poll(async () => (await hide.boundingBox())!.x - (await dock.boundingBox())!.x).toBeLessThan(40);
  await expect(dock.getByRole('button', { name: 'Close NutBot' })).toHaveCount(0);
  const wide = page.viewportSize()!.width > 900;
  const app = page.locator('.app');
  if (wide) await expect(app).toHaveClass(/nb-open/);
  // Unlocked, the panel floats over the page and the page keeps its room.
  await dock.getByRole('button', { name: /^Unlock/ }).click();
  await expect(dock).toHaveClass(/floating/);
  await expect(app).not.toHaveClass(/nb-open/);
  await page.screenshot({ path: info.outputPath('nutbot-floating.png'), animations: 'disabled' });
  // Using the page behind it puts a floating panel away (on a phone the panel is a sheet over all of it: Escape does).
  if (page.viewportSize()!.width > 620) await page.locator('main.content').click({ position: { x: 20, y: 20 } });
  else await page.getByRole('textbox', { name: 'Message NutBot' }).press('Escape');
  await expect(dock).toBeHidden();
  await page.locator('.nb-launcher').click();
  await expect(dock).toBeVisible();
  await dock.getByRole('button', { name: /^Lock/ }).click();
  if (wide) {
    const before = (await dock.boundingBox())!.width;
    await dock.getByRole('button', { name: 'Wider', exact: true }).click();
    await expect.poll(async () => (await dock.boundingBox())!.width).toBeGreaterThan(before + 100);
    // A wide panel lies over the page instead of squeezing it.
    await expect(app).not.toHaveClass(/nb-open/);
    await page.screenshot({ path: info.outputPath('nutbot-wide.png'), animations: 'disabled' });
  }
  await hide.click();
  await expect(dock).toBeHidden();
  // The choice is remembered.
  await page.reload();
  await page.locator('.nb-launcher').click();
  await expect(page.locator('.nb-dock')).toBeVisible();
});
