import { test, expect, installPlayerFixture } from '../../web/e2e/player-fixture';

for (const appearance of [{ theme: 'dark', palette: 'nutmeg' }, { theme: 'light', palette: 'slate' }]) {
  test(`guided player groups · ${appearance.theme} · ${appearance.palette}`, async ({ page }, info) => {
    await installPlayerFixture(page);
    await page.addInitScript((appearance) => {
      localStorage.setItem('avn-theme', appearance.theme);
      localStorage.setItem('avn-palette', appearance.palette);
      localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10));
    }, appearance);
    let request: Record<string, unknown> | null = null;
    await page.route('**/insights/player-groups', async (route) => {
      const definition = route.request().postDataJSON();
      request = definition;
      await route.fulfill({ json: {
        definition, as_of: '2026-10-26T12:00:00Z', minimum_players: 30, interval_method: 'Wilson 95% score intervals',
        counts: { candidates: 190, eligible: 174, pending: 11, excluded: 5, outcome_before_group: 0 },
        exclusions: [{ reason: 'advanced_save', label: 'First recorded progression is not a start of the entry level', players: 5 }], missing_reasons: { no_recorded_completion: 23 },
        groups: [
          { id: 'a', label: 'A · ≤ 70 s', players: 115, reached: 72, rate: 62.61, interval: [53.49, 70.91], low_sample: false, examples: [{ player: 'player-one', value: 60, reached: true }] },
          { id: 'b', label: 'B · > 70 s', players: 36, reached: 17, rate: 47.22, interval: [32, 63], low_sample: false, examples: [] },
          { id: 'missing', label: 'No recorded behavior', players: 23, reached: 4, rate: 17.39, interval: [7, 37], low_sample: true, examples: [] },
        ], difference: { percentage_points: 15.39, interval: [-2.83, 32.74], includes_zero: true, method: 'Newcombe 95% interval, independent groups' },
      } });
    });
    await page.goto('/games/viewer-game/levels?view=groups');
    await page.getByRole('button', { name: 'New check', exact: true }).click();
    // Only one decision's fields appear at once; there is no predetermined 70-second threshold.
    await expect(page.getByRole('heading', { name: '1. Population', exact: true })).toBeVisible();
    await expect(page.getByLabel('Behavior level', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Next: Behavior', exact: true }).click();
    await expect(page.getByRole('heading', { name: '2. Behavior', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next: Groups', exact: true }).click();
    await expect(page.getByLabel('Split at (seconds)', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Next: Outcome', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('split');
    await page.getByLabel('Split at (seconds)', { exact: true }).fill('70');
    await page.getByRole('button', { name: 'Next: Outcome', exact: true }).click();
    await page.getByRole('button', { name: 'Compare groups', exact: true }).click();
    const results = page.getByRole('region', { name: 'Player group comparison results' });
    await expect(results).toContainText('72 / 115');
    await expect(results).toContainText('17 / 36');
    await expect(results).toContainText('4 / 23');
    await expect(results).toContainText('11 still observing');
    await expect(results).toContainText('Direction is unclear with this sample.');
    expect(request).toMatchObject({ behavior: { kind: 'level_duration', split: 70, level: 1 }, outcome: { level: 4, window_hours: 24 } });
    await results.getByText('Population exclusions and missing data', { exact: true }).click();
    await expect(results).toContainText('No recorded completion');
    await results.getByRole('button', { name: 'Players', exact: true }).first().click();
    await results.getByRole('button', { name: 'player-one', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Player details', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close ×', exact: true }).click();
    await expect(results).toBeVisible();
    if (info.project.name === 'phone') expect(await results.locator('.group-comparison-table').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await results.screenshot({ path: info.outputPath(`groups-${appearance.theme}-${appearance.palette}.png`), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await expect(results).toContainText('72 / 115');
    await page.getByRole('button', { name: 'Edit current check', exact: true }).click();
    await page.getByRole('group', { name: 'Comparison setup steps', exact: true }).getByRole('button', { name: /3.*Groups/ }).click();
    await expect(page.getByLabel('Split at (seconds)', { exact: true })).toHaveValue('70');
    await page.getByLabel('Split at (seconds)', { exact: true }).fill('90');
    await expect(page.getByRole('status').filter({ hasText: 'Setup changed.' })).toBeVisible();
    await expect(results).toContainText('A · ≤ 70 s');
  });
}

test('guided comparisons support exposure counts, parameter groups and event outcomes', async ({ page }) => {
  await installPlayerFixture(page);
  await page.addInitScript(() => localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10)));
  await page.route('**/insights/catalog?*', (route) => route.fulfill({ json: { events: [
    { name: 'ad_show', count: 20, params: [{ key: 'type', count: 20, values: ['interstitial', 'rewarded'] }] },
    { name: 'session_start', count: 20, params: [{ key: 'tier', count: 20, values: ['low', 'high'] }] },
    { name: 'purchase', count: 5, params: [] },
  ] } }));
  const queries: Array<Record<string, unknown>> = [];
  await page.route('**/insights/player-groups', (route) => {
    const definition = route.request().postDataJSON(); queries.push(definition);
    return route.fulfill({ json: { definition, as_of: '2026-10-26T12:00:00Z', minimum_players: 30, interval_method: 'Wilson 95% score intervals', counts: { candidates: 0, eligible: 0, pending: 0, excluded: 0, outcome_before_group: 0 }, exclusions: [], missing_reasons: {}, difference: null, groups: ['a', 'b', 'missing'].map((id) => ({ id, label: id, players: 0, reached: 0, rate: null, interval: null, low_sample: true, examples: [] })) } });
  });
  await page.goto('/games/viewer-game/levels?view=groups');
    await page.getByRole('button', { name: 'New check', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Behavior', exact: true }).click();
  await page.getByLabel('Early experience', { exact: true }).selectOption('event_count');
  const behavior = page.getByRole('group', { name: 'Behavior event', exact: true });
  await behavior.getByLabel('Event', { exact: true }).selectOption('ad_show');
  await behavior.getByLabel('Only when this parameter…', { exact: true }).selectOption('type');
  await behavior.getByLabel('Condition', { exact: true }).selectOption('eq');
  await behavior.getByLabel('Value', { exact: true }).fill('interstitial');
  await page.getByRole('button', { name: 'Next: Groups', exact: true }).click();
  await page.getByLabel('Split at (events)', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Next: Outcome', exact: true }).click();
  await page.getByRole('button', { name: 'Compare groups', exact: true }).click();
  await expect.poll(() => queries.length).toBe(1);
  expect(queries[0]).toMatchObject({ behavior: { kind: 'event_count', split: 0, event: { event: 'ad_show', param: 'type', op: 'eq', value: 'interstitial' } } });
  expect((queries[0]!.behavior as { event: unknown }).event).not.toHaveProperty('of');

  await page.getByRole('button', { name: 'Edit current check', exact: true }).click();
  await page.getByRole('group', { name: 'Comparison setup steps', exact: true }).getByRole('button', { name: /2.*Behavior/ }).click();
  await page.getByLabel('Early experience', { exact: true }).selectOption('parameter');
  await behavior.getByLabel('Event', { exact: true }).selectOption('session_start');
  await page.getByLabel('Parameter to compare', { exact: true }).fill('tier');
  await page.getByRole('button', { name: 'Next: Groups', exact: true }).click();
  await page.getByLabel('Compare values', { exact: true }).selectOption('equals');
  await page.getByLabel('Group A value', { exact: true }).fill('low');
  await page.getByRole('button', { name: 'Next: Outcome', exact: true }).click();
  await page.getByLabel('Later outcome', { exact: true }).selectOption('event');
  await page.getByRole('group', { name: 'Outcome event', exact: true }).getByLabel('Event', { exact: true }).selectOption('purchase');
  await page.getByRole('button', { name: 'Compare groups', exact: true }).click();
  await expect.poll(() => queries.length).toBe(2);
  expect(queries[1]).toMatchObject({ behavior: { kind: 'parameter', parameter: 'tier', comparison: 'equals', split: null, value: 'low' }, outcome: { kind: 'event', event: { event: 'purchase' } } });
});

test('saved shortcuts run directly; groups can be reused, edited and removed with Undo', async ({ page }, info) => {
  await installPlayerFixture(page);
  await page.addInitScript(() => localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10)));
  const items: Array<Record<string, any>> = [];
  const deleted = new Set<string>();
  await page.route('**/insights/group-library**', async (route) => {
    const request = route.request();
    const match = new URL(request.url()).pathname.match(/group-library(?:\/([^/]+))?(\/restore)?$/)!;
    const id = match[1];
    if (request.method() === 'GET') { await route.fulfill({ json: items.filter((item) => !deleted.has(item.id)) }); return; }
    if (request.method() === 'DELETE') { deleted.add(id!); await route.fulfill({ status: 204 }); return; }
    if (match[2]) { deleted.delete(id!); await route.fulfill({ json: items.find((item) => item.id === id) }); return; }
    const body = request.postDataJSON();
    const item = { ...body, id: id || `saved-${items.length}`, updated_at: '2026-10-26T12:00:00Z' };
    if (id) items[items.findIndex((value) => value.id === id)] = item; else items.push(item);
    await route.fulfill({ status: id ? 200 : 201, json: item });
  });
  const requests: Array<Record<string, any>> = [];
  await page.route('**/insights/player-groups', async (route) => {
    const definition = route.request().postDataJSON(); requests.push(definition);
    await route.fulfill({ json: { definition, as_of: '2026-10-26T12:00:00Z', minimum_players: 30, interval_method: 'Wilson', counts: { candidates: 0, eligible: 0, pending: 0, excluded: 0, outcome_before_group: 0 }, exclusions: [], missing_reasons: {}, difference: null, groups: [] } });
  });
  await page.goto('/games/viewer-game/levels?view=groups');
  await expect(page.getByRole('region', { name: 'Compare player groups setup' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Saved player comparisons' })).toContainText('No saved checks yet.');
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Behavior', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Groups', exact: true }).click();
  await page.getByLabel('Split at (seconds)', { exact: true }).fill('70');
  await page.getByRole('button', { name: 'Save groups', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('First level speed');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  const group = page.getByRole('listitem', { name: 'First level speed', exact: true });
  await expect(group).toBeVisible();
  expect(items[0]!.definition.outcome).toBeNull();
  await page.reload();
  await group.getByRole('button', { name: 'Use', exact: true }).click();
  await expect(page.getByRole('heading', { name: '4. Outcome', exact: true })).toBeVisible();
  await page.getByLabel('Outcome level', { exact: true }).fill('6');
  await page.getByRole('button', { name: 'Save shortcut', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Speed to level 6');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Close setup', exact: true }).click();
  const check = page.getByRole('listitem', { name: 'Speed to level 6', exact: true });
  await check.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Player group comparison results' })).toBeVisible();
  expect(requests.at(-1)).toMatchObject({ behavior: { split: 70 }, outcome: { level: 6 } });
  await expect(page.getByRole('region', { name: 'Compare player groups setup' })).toHaveCount(0);
  await group.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Behavior', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Groups', exact: true }).click();
  await page.getByLabel('Split at (seconds)', { exact: true }).fill('90');
  await page.getByRole('button', { name: 'Save groups', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toHaveValue('First level speed');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  expect(items[0]!.definition.behavior.split).toBe(90);
  expect(items[1]!.definition.behavior.split).toBe(70);
  await group.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(group).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(group).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('region', { name: 'Saved player comparisons' }).screenshot({ path: info.outputPath('saved-checks.png'), animations: 'disabled' });
});
