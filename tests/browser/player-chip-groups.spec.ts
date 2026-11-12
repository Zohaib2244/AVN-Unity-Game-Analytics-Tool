import { test, expect, installPlayerFixture } from '../../web/e2e/player-fixture';

const chipGroups = [
  { id: 'paid', name: 'Paid campaign', kind: 'players', definition: { chips: [{ kind: 'campaign', values: ['Campaign A'] }] }, updated_at: '' },
  { id: 'earners', name: 'Earners', kind: 'players', definition: { chips: [{ kind: 'earned', min: 0.3 }] }, updated_at: '' },
];

for (const theme of ['dark', 'light']) {
  test(`chips preserve legacy tests after refresh and saved counts · ${theme}`, async ({ page }, info) => {
    await installPlayerFixture(page);
    await page.addInitScript((theme) => {
      localStorage.setItem('avn-theme', theme);
      localStorage.setItem('avn-palette', theme === 'light' ? 'slate' : 'nutmeg');
      // Only seed once: a second load must read the migrated group.
      if (!localStorage.getItem('migration-seeded')) {
        localStorage.setItem('avn-players-view-viewer-game', JSON.stringify({ conditions: [{ event: 'Reward', param: 'amount', op: 'gte', value: '5', min_times: 3 }] }));
        localStorage.setItem('migration-seeded', 'yes');
      }
    }, theme);
    await page.route('**/insights/group-library?kind=players', (route) => route.fulfill({ json: chipGroups }));
    await page.route('**/insights/player-group-counts?**', (route) => route.fulfill({ json: { all: 2, counts: { paid: 1, earners: 2 } } }));
    await page.goto('/games/viewer-game/players');
    const chip = page.getByRole('button', { name: 'did Reward with amount ≥ 5 at least 3 times', exact: true });
    await expect(chip).toBeVisible();
    await page.reload();
    await expect(chip).toBeVisible();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('avn-players-group-viewer-game')!));
    expect(stored.chips[0]).toMatchObject({ op: 'gte', rule_value: '5', min: 3 });
    await chip.click();
    await expect(page.getByLabel('Condition', { exact: true })).toHaveValue('gte');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    if (info.project.name === 'phone' || info.project.name === 'tablet') {
      const toggle = page.getByRole('button', { name: /Show player groups/ });
      if (await toggle.count()) await toggle.click();
    }
    const groups = page.getByRole('complementary', { name: 'Player groups' });
    await expect(groups.getByRole('button', { name: /Paid campaign/ })).toContainText('1');
    await expect(groups.getByRole('button', { name: /Earners/ })).toContainText('2');
    await groups.getByRole('button', { name: /Paid campaign/ }).click();
    await expect(page.getByLabel('Group name', { exact: true })).toHaveValue('Paid campaign');
    await page.reload();
    await expect(page.getByLabel('Group name', { exact: true })).toHaveValue('Paid campaign');
    await page.getByLabel('Group name', { exact: true }).fill('Temporary rename');
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.getByLabel('Group name', { exact: true })).toHaveValue('Paid campaign');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`chip-groups-${theme}.png`), fullPage: true });
  });

  test(`saved player groups enter guided comparisons · ${theme}`, async ({ page }) => {
    await installPlayerFixture(page);
    await page.addInitScript((theme) => localStorage.setItem('avn-theme', theme), theme);
    await page.route('**/insights/group-library?kind=players', (route) => route.fulfill({ json: chipGroups }));
    await page.goto('/games/viewer-game/levels?view=groups');
    await page.getByRole('button', { name: 'New check', exact: true }).click();
    await page.getByRole('button', { name: 'Next: Behavior', exact: true }).click();
    await page.getByLabel('Early experience', { exact: true }).selectOption('saved_groups');
    await page.getByLabel('Group A', { exact: true }).selectOption({ label: 'Paid campaign' });
    await page.getByLabel('Group B', { exact: true }).selectOption({ label: 'Earners' });
    await page.getByRole('button', { name: 'Next: Groups', exact: true }).click();
    await expect(page.getByText('Players in both or neither group are listed separately.', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Split at (seconds)', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Next: Outcome', exact: true }).click();
    const request = page.waitForRequest((request) => request.url().endsWith('/insights/player-groups'));
    await page.getByRole('button', { name: 'Compare groups', exact: true }).click();
    expect((await request).postDataJSON().behavior).toMatchObject({ kind: 'saved_groups', event: null, split: null, group_a: { name: 'Paid campaign', chips: chipGroups[0]!.definition.chips }, group_b: { name: 'Earners', chips: chipGroups[1]!.definition.chips } });
  });
}
