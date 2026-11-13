// UX lint: the mechanical rules of .claude/skills/ux-audit/rules.md, run against a live server on every page.
// Needs a server with data (see the ux-audit skill): AVN_WEB_URL=http://127.0.0.1:8202 npm run ux-lint
// Every finding names its rule. The run fails when there are any, and writes test-results/ux-lint.json.
import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

type Finding = { rule: string; page: string; where: string; detail: string };

const TOKEN = process.env.AVN_ADMIN_TOKEN || 'local-dev-token-not-a-secret-0123456789';
const SECTIONS = ['overview', 'levels', 'players', 'sessions', 'ads', 'acquisition', 'exports', 'dictionary', 'event-setup', 'keys', 'settings'];
const WORKSPACE_PAGES = ['/', '/status', '/settings', '/team', '/workspaces', '/agent-access'];

test.use({ launchOptions: { args: ['--js-flags=--max-old-space-size=1536'] }, extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` }, viewport: { width: 1440, height: 900 } });

/** Static checks: read the DOM as it is now. Runs inside the page. */
function staticChecks(): Array<Omit<Finding, 'page'>> {
  const out: Array<Omit<Finding, 'page'>> = [];
  const add = (rule: string, where: string, detail: string) => out.push({ rule, where, detail });
  const visible = (el: Element): boolean => {
    const box = (el as HTMLElement).getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width <= 1 || box.height <= 1 || /(^|\s)(sr-only|visually-hidden)(\s|$)/.test((el as HTMLElement).className?.toString?.() || '')) return false;
    return style.visibility !== 'hidden' && style.display !== 'none' && !(el as HTMLElement).closest('[hidden]');
  };
  const text = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = (el: Element): string => {
    const node = el as HTMLElement;
    return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.className && typeof node.className === 'string' ? `.${node.className.trim().split(/\s+/)[0]}` : ''} “${text(el).slice(0, 40)}”`;
  };
  const words = (value: string): number => value.split(/\s+/).filter(Boolean).length;
  const inChat = (el: Element): boolean => !!el.closest('dialog, [role=dialog], .nutbot, [class*=nutbot]');

  // R1.1 the same words twice in one region
  const reported = new Set<string>();
  for (const region of document.querySelectorAll('aside, nav, header, .panel, .card, [role=toolbar], .toolbar')) {
    if (!visible(region)) continue;
    const seen = new Map<string, number>();
    for (const el of region.querySelectorAll('h1,h2,h3,h4,label,legend,button,a,span,small,strong,p,div')) {
      if (el.children.length > 0 || !visible(el) || el.closest('table, ol.journey-events, [role=row], ul[role=listbox], select, option, [role=listbox]')) continue;
      const value = text(el).toLowerCase();
      if (value.length < 4 || value.length > 30 || /^[\d\s.,%$:·—–/+-]+$/.test(value)) continue;
      seen.set(value, (seen.get(value) || 0) + 1);
    }
    for (const [value, count] of seen) if (count > 1 && !reported.has(value)) { reported.add(value); add('R1.1', label(region), `“${value}” appears ${count} times in one region`); }
  }

  // R1.2 subtitle under a title
  for (const heading of document.querySelectorAll('h1, h2, .panel-header h2, .panel-header h3')) {
    if (!visible(heading) || inChat(heading)) continue;
    const next = heading.nextElementSibling || heading.parentElement?.nextElementSibling;
    if (next && next.matches('p, .help, .subtitle, .lede, small') && visible(next) && words(text(next)) > 2) add('R1.2', label(heading), `subtitle under the title: “${text(next).slice(0, 70)}”`);
  }

  // R1.3 help paragraphs
  for (const el of document.querySelectorAll('p, .help, .foot-note, .note')) {
    if (!visible(el) || inChat(el) || el.closest('table, button, [role=status]:empty')) continue;
    if (el.children.length > 4) continue;
    if (words(text(el)) > 12) add('R1.3', label(el), `${words(text(el))} words of explanation`);
  }

  // R10.2 / R10.3 / R2.2 tables
  const empties = new Set(['—', '–', '-', '·', '']);
  const placeholders = new Set<string>();
  for (const table of document.querySelectorAll('table')) {
    if (!visible(table) || inChat(table)) continue;
    const heads = [...table.querySelectorAll('thead th')];
    const rows = [...table.querySelectorAll('tbody tr')].filter(visible);
    heads.forEach((head, column) => {
      const cells = rows.map((row) => row.children[column]).filter(Boolean) as Element[];
      if (cells.length < 3) return;
      const values = cells.map(text);
      const name = text(head) || `column ${column + 1}`;
      if (new Set(values).size === 1 && values[0] !== '' && (!/^(\d+|[A-Za-z ]+)$/.test(values[0]!) || empties.has(values[0]!))) add('R10.2', `${label(table)} › ${name}`, `every row says “${values[0] || '(blank)'}”`);
      for (const value of values) if (value && value.length <= 8 && /^(—|–|·|-|cost 0|not sent|n\/a)$/i.test(value)) placeholders.add(value.toLowerCase());
      // R2.2 cells in one column made of different parts
      const shape = (value: string): string => value.replace(/[\d,.]+/g, '#').replace(/[A-Za-z]+/g, 'a');
      const shapes = new Set(values.filter((value) => !empties.has(value)).map(shape));
      if (shapes.size > 2) add('R2.2', `${label(table)} › ${name}`, `cells have ${shapes.size} different shapes (e.g. ${[...shapes].slice(0, 3).join(' | ')})`);
      // R2.1 cells in one column with different backgrounds
      const tints = new Set(cells.map((cell) => getComputedStyle(cell).backgroundColor).concat(cells.map((cell) => getComputedStyle(cell.firstElementChild || cell).backgroundColor)));
      const real = [...tints].filter((color) => color !== 'rgba(0, 0, 0, 0)');
      if (real.length > 2) add('R2.1', `${label(table)} › ${name}`, `${real.length} different cell backgrounds in one column`);
    });
    // R3.1 sort consistency
    const sortable = heads.filter((head) => head.hasAttribute('aria-sort') || head.querySelector('button, [role=button]') || (head as HTMLElement).onclick);
    if (sortable.length > 0 && sortable.length < heads.filter((head) => text(head)).length) {
      const plain = heads.filter((head) => text(head) && !sortable.includes(head)).map(text);
      add('R3.1', label(table), `some headers sort, these don't: ${plain.join(', ')}`);
    }
  }
  if (placeholders.size > 1) add('R10.3', 'page', `different placeholders for “no value”: ${[...placeholders].join('  ')}`);

  // R3.4 controls in one row match in height
  for (const parent of document.querySelectorAll('.toolbar, [role=toolbar], .panel-header, .filter-bar, .segmented, .actions, header')) {
    if (!visible(parent)) continue;
    const controls = [...parent.querySelectorAll('button, select, input:not([type=checkbox]):not([type=radio]), [role=combobox], .segmented, .range-modes')].filter(visible);
    const rows = new Map<number, number[]>();
    for (const control of controls) {
      // The buttons of a segmented group sit inside the group's frame: the frame is the control.
      if (control.parentElement?.closest('.segmented, .range-modes, [role=group]') && control.tagName === 'BUTTON') continue;
      const box = control.getBoundingClientRect();
      if (box.height < 20) continue;
      const key = Math.round((box.top + box.height / 2) / 6);
      rows.set(key, [...(rows.get(key) || []), Math.round(box.height)]);
    }
    for (const heights of rows.values()) if (heights.length > 1 && Math.max(...heights) - Math.min(...heights) > 3) add('R3.4', label(parent), `controls in one row are ${[...new Set(heights)].join(' / ')}px tall`);
  }

  // R4.1 long native selects
  for (const select of document.querySelectorAll('select')) if (visible(select) && select.options.length > 7) add('R4.1', label(select), `native select with ${select.options.length} options and no search`);

  // R8.2 clipped text
  for (const el of document.querySelectorAll('h1,h2,h3,p,span,td,th,button,a,label,strong')) {
    if (!visible(el) || el.children.length > 2) continue;
    const node = el as HTMLElement;
    if (node.scrollWidth > node.clientWidth + 2 && !node.title && !node.getAttribute('aria-label') && getComputedStyle(node).overflowX !== 'visible' && getComputedStyle(node).textOverflow !== 'ellipsis') add('R8.2', label(el), 'text is cut off with no tooltip');
  }

  // R8.3 nested vertical scroll
  const pageScrolls = document.documentElement.scrollHeight > innerHeight + 4;
  if (pageScrolls) {
    for (const el of document.querySelectorAll('main *, #main *')) {
      const node = el as HTMLElement;
      const style = getComputedStyle(node);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 8 && visible(node) && !node.closest('dialog, [role=dialog], [role=listbox], [role=menu], .nutbot')) add('R8.3', label(node), 'a box scrolls inside a page that also scrolls');
    }
  }

  // R5.6 the first data row is in the top half of the first screen
  const firstRow = [...document.querySelectorAll('tbody tr, ol.journey-events li, [role=row]')].find((row) => visible(row) && !row.closest('thead'));
  if (firstRow && firstRow.getBoundingClientRect().top > 450) add('R5.6', label(firstRow), `first data row starts at y = ${Math.round(firstRow.getBoundingClientRect().top)} (limit 450)`);

  // R13.1 too many rows in the DOM
  const rowCount = document.querySelectorAll('tbody tr, ol.journey-events li, [role=row]').length;
  if (rowCount > 500) add('R13.1', 'page', `${rowCount} rows in the DOM (virtualize above ~200)`);

  return out;
}

/** Interaction checks: open every popover trigger and test it (R4.2, R4.3). */
async function popoverChecks(page: Page, path: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const triggers = page.locator('#main button[aria-haspopup], #main button[aria-expanded="false"], header button[aria-haspopup]');
  const count = Math.min(await triggers.count(), 12);
  for (let index = 0; index < count; index += 1) {
    const trigger = triggers.nth(index);
    if (!(await trigger.isVisible().catch(() => false))) continue;
    const name = ((await trigger.innerText().catch(() => '')) || (await trigger.getAttribute('aria-label')) || `trigger ${index}`).replace(/\s+/g, ' ').trim().slice(0, 40);
    await page.evaluate(() => window.scrollTo(0, 0));
    try { await trigger.click({ timeout: 1500 }); } catch { continue; }
    await page.waitForTimeout(350);
    const popover = page.locator('[role=dialog]:visible, [role=menu]:visible, [role=listbox]:visible, [role=tooltip]:visible, .popover:visible, [data-radix-popper-content-wrapper]:visible, details[open] > :not(summary):visible').last();
    if (await popover.count()) {
      const box = await popover.boundingBox();
      const view = page.viewportSize()!;
      if (box) {
        if (box.height > view.height * 0.6 + 2) out.push({ rule: 'R4.3', page: path, where: `“${name}”`, detail: `opens ${Math.round(box.height)}px tall in a ${view.height}px window (limit 60%)` });
        const before = await page.evaluate(() => window.scrollY);
        await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120));
        await page.mouse.wheel(0, 500);
        await page.waitForTimeout(250);
        const after = await page.evaluate(() => window.scrollY);
        if (Math.abs(after - before) > 2) out.push({ rule: 'R4.3', page: path, where: `“${name}”`, detail: 'scrolling over it scrolls the page behind it' });
        const moved = await popover.boundingBox();
        const triggerBox = await trigger.boundingBox();
        if (moved && triggerBox && (moved.y < 0 || moved.y + Math.min(moved.height, 40) > view.height || Math.abs(moved.y - triggerBox.y) > view.height)) out.push({ rule: 'R4.2', page: path, where: `“${name}”`, detail: 'after scrolling it is detached from its trigger or outside the window' });
        const hasSearch = (await popover.locator('input[type=search], input[type=text], input:not([type])').count()) > 0;
        const rows = await popover.locator('[role=option], [role=menuitem], [role=menuitemcheckbox], .opt:not(.locked)').count();
        const items = rows || (await popover.locator('input[type=checkbox]').count());
        if (items > 7 && !hasSearch && !/^“(Last \d+ days|Today|Yesterday|This |All time)/.test(`“${name}”`)) out.push({ rule: 'R4.1', page: path, where: `“${name}”`, detail: `${items} choices and no search field` });
      }
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (await popover.count() && await popover.isVisible().catch(() => false)) {
      const stillOpen = await popover.evaluate((el) => document.body.contains(el) && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0).catch(() => false);
      if (stillOpen && (await trigger.getAttribute('aria-expanded')) === 'true') out.push({ rule: 'R4.3', page: path, where: `“${name}”`, detail: 'Esc does not close it' });
    }
    await page.mouse.click(2, 2).catch(() => undefined);
  }
  return out;
}

async function gameId(page: Page): Promise<string> {
  const games = await (await page.request.get('/v1/games')).json();
  const list = Array.isArray(games) ? games : games.games || [];
  const biggest = [...list].sort((a: { event_count?: number }, b: { event_count?: number }) => (b.event_count || 0) - (a.event_count || 0))[0];
  if (!biggest) throw new Error('The server has no games. Point AVN_WEB_URL at a server with synthetic data (scripts/benchmark.py generate).');
  return biggest.id;
}

// R13: a player with thousands of events must stay responsive: few DOM rows, fast scrolling.
async function rawEventsChecks(page: Page, name: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const rows = await page.evaluate(() => document.querySelectorAll('#main li, #main tr').length);
  if (rows > 600) out.push({ rule: 'R13.1', page: name, where: 'Raw events', detail: `${rows} list rows in the DOM; long lists must be virtualized` } as Finding);
  const started = Date.now();
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(50); }
  const spent = Date.now() - started - 500;
  if (spent > 2500) out.push({ rule: 'R13.2', page: name, where: 'Raw events', detail: `10 scroll steps took ${spent} ms extra; scrolling is janky` } as Finding);
  return out;
}

const findings: Finding[] = [];

test.describe.configure({ mode: 'serial' });

test('UX lint', async ({ page: first, context }) => {
  let page = first;
  test.setTimeout(15 * 60 * 1000);
  const id = await gameId(page);
  const heavy = process.env.AVN_HEAVY_PLAYERS ? process.env.AVN_HEAVY_PLAYERS.split(',') : [];
  const paths = [...WORKSPACE_PAGES, ...SECTIONS.map((section) => `/games/${id}/${section}`), ...heavy.map((player) => `/games/${id}/players?player=${player}`)];
  await page.addInitScript(() => { localStorage.setItem('avn-boot-day', new Date().toISOString().slice(0, 10)); });
  for (const path of paths) {
    const name = path.replace(id, ':game');
    mkdirSync('test-results', { recursive: true });
    appendFileSync('test-results/ux-lint-progress.log', `${new Date().toISOString()} ${name}\n`);
    try {
      await page.goto(path);
      await page.locator('#main').waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout(Number(process.env.AVN_LINT_WAIT || 800));
      for (const finding of await page.evaluate(staticChecks)) findings.push({ ...finding, page: name });
      findings.push(...(await popoverChecks(page, name)));
      if (path.includes('?player=')) findings.push(...(await rawEventsChecks(page, name)));
    } catch (error) {
      const message = String((error as Error).message).split('\n')[0];
      findings.push({ rule: 'R13.3', page: name, where: 'page', detail: `the page crashed or hung the browser: ${message}` });
      page = await context.newPage();
    }
  }
  const unique = [...new Map(findings.map((finding) => [`${finding.rule}|${finding.page}|${finding.where}|${finding.detail}`, finding])).values()];
  unique.sort((a, b) => a.rule.localeCompare(b.rule, undefined, { numeric: true }) || a.page.localeCompare(b.page));
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/ux-lint.json', JSON.stringify(unique, null, 2));
  const report = unique.map((finding) => `${finding.rule.padEnd(5)} ${finding.page}  ${finding.where}: ${finding.detail}`).join('\n');
  expect(unique, `\n${unique.length} UX findings (details in test-results/ux-lint.json)\n\n${report}\n`).toEqual([]);
});
