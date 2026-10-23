// App shell (AVN UX): grouped sidebar with one sliding highlight, top bar, account menu,
// command palette (Ctrl/Cmd + K), tablet rail and phone tab bar. Loaded before app.js and uses its
// helpers (icon, escapeHTML, me, overview, currentGame, gamePath, navigate…) at call time.

const NAV_GROUPS = [
  ['Analyze', [['overview', 'grid', 'Overview'], ['funnels', 'funnel', 'Funnels'], ['levels', 'game', 'Levels'], ['players', 'users', 'Players']]],
  ['Data', [['exports', 'export', 'Exports'], ['dictionary', 'book', 'Event dictionary'], ['event-setup', 'link', 'Event setup']]],
  ['Manage', [['keys', 'key', 'API keys'], ['settings', 'settings', 'Game settings']], true],
];
const PHONE_TABS = ['overview', 'funnels', 'levels', 'players'];
const closedGroups = new Set(['Manage']);

const shellAccountItems = () => [
  ...(me.can_manage_team ? [['/workspaces', 'grid', 'Workspaces'], ['/team', 'users', 'Team']] : []),
  ['/status', 'pulse', 'Server status'], ['/settings', 'settings', 'Settings'],
];

function gameMark(game) {
  const withIcon = variantsOf(game).find(item => item.icon_updated_at) || (game.icon_updated_at ? game : null);
  return withIcon ? `<img src="${iconURL(withIcon)}" alt="" width="30" height="30">` : escapeHTML(game.name.slice(0, 2).toUpperCase());
}

function shellNavItem(href, symbol, label, active, extra = '') {
  return `<a class="ni${active ? ' on' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''} title="${escapeHTML(label)}">${icon(symbol, 17)}<span class="lbl">${escapeHTML(label)}</span>${extra}</a>`;
}

function shellSidebar(game, section) {
  const accountName = me.name || (me.email || '').split('@')[0] || 'Administrator';
  const switcher = me.workspaces.length > 1 || me.is_admin ? `<div class="ws-switch"><label class="eyebrow" for="ws-select">Workspace</label><select id="ws-select">${me.workspaces.map(item => `<option value="${item.id}" ${item.id === currentWorkspace ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}</select></div>` : '';
  let gameBlock = '', nav;
  if (game) {
    const variants = variantsOf(game);
    const missing = canManageGames() ? PLATFORM_ORDER.filter(platform => !variants.some(item => item.platform === platform)) : [];
    gameBlock = `<a class="game" href="${gamePath(game, section)}" title="${escapeHTML(game.name)}"><span class="g-ic">${gameMark(game)}</span><span class="gm"><b>${escapeHTML(game.name)}</b><small>${escapeHTML(game.bundle_id)}</small></span></a>
      <div class="platforms${variants.length + missing.length < 2 ? ' one' : ''}" role="group" aria-label="Platform">${variants.map(item => `<a href="${gamePath(item, section)}" class="${item.id === game.id ? 'on' : ''}" ${item.id === game.id ? 'aria-current="page" ' : ''}title="${escapeHTML(item.bundle_id)}">${platformLabel(item.platform)}${item.archived_at ? ' · paused' : ''}</a>`).join('')}${missing.map(platform => `<a class="add" href="/games/new?${new URLSearchParams({name: game.name, bundle_id: game.bundle_id, platform})}" title="Register the ${platformLabel(platform)} version">+ ${platformLabel(platform)}</a>`).join('')}</div>`;
    nav = NAV_GROUPS.map(([label, items, collapsible]) => {
      const holdsActive = items.some(([key]) => key === section);
      const closed = collapsible && closedGroups.has(label) && !holdsActive;
      const head = collapsible
        ? `<button type="button" class="grp-label" data-group="${label}" aria-expanded="${!closed}"><span class="eyebrow">${label}</span>${icon('chevron', 12)}</button>`
        : `<div class="grp-label static"><span class="eyebrow">${label}</span></div>`;
      return `<div class="grp${closed ? ' closed' : ''}" data-grp="${label}">${head}<div class="grp-body"><div>${items.map(([key, symbol, text]) => shellNavItem(gamePath(game, key), symbol, text, key === section)).join('')}</div></div></div>`;
    }).join('');
  } else {
    nav = `<div class="grp"><div class="grp-label static"><span class="eyebrow">Workspace</span></div><div class="grp-body"><div>${shellNavItem('/', 'grid', 'Games', ['/', '/games', '/games/new'].includes(location.pathname))}</div></div></div>`;
  }
  const menu = `<div class="menu" id="acct-menu" hidden role="menu">${shellAccountItems().map(([href, symbol, label]) => `<a href="${href}" role="menuitem">${icon(symbol, 16)}${label}</a>`).join('')}<hr><button type="button" data-action="theme" role="menuitem">${icon('sun', 16)}Light or dark theme</button></div>`;
  return `<aside class="side" id="sidebar" aria-label="Sidebar"><a href="/" class="brand"><span class="mark" aria-hidden="true"><img src="/assets/icons/avn-analytics.svg" alt="" width="28" height="28"></span><span class="brand-t">AVN Analytics</span></a>${switcher}${gameBlock}<nav class="nav" aria-label="${game ? 'Game' : 'Workspace'}"><div class="nav-ind" id="nav-ind"></div>${nav}</nav>
    <div class="acct">${menu}<button type="button" class="acct-btn" id="acct-btn" aria-expanded="false" aria-haspopup="menu"><span class="av">${escapeHTML(accountName.slice(0, 1).toUpperCase())}</span><div><b>${escapeHTML(accountName)}</b><small>${ROLE_LABELS[wsRole()] || wsRole()}${me.source === 'lan' ? ' · local network' : ''}</small></div></button></div></aside>`;
}

function shellTabs(game, section) {
  const tab = (href, symbol, label, on) => `<a class="tab${on ? ' on' : ''}" href="${href}" ${on ? 'aria-current="page"' : ''}>${icon(symbol, 20)}<span>${label}</span></a>`;
  if (game) {
    const labels = Object.fromEntries(NAV_GROUPS.flatMap(([, items]) => items.map(([key, symbol, label]) => [key, [symbol, label]])));
    return PHONE_TABS.map(key => tab(gamePath(game, key), labels[key][0], labels[key][1], key === section)).join('') + `<button type="button" class="tab" data-more aria-haspopup="dialog">${icon('grid', 20)}<span>More</span></button><div class="tab-ind" id="tab-ind"></div>`;
  }
  return tab('/', 'grid', 'Games', ['/', '/games', '/games/new'].includes(location.pathname)) + shellAccountItems().slice(0, 3).map(([href, symbol, label]) => tab(href, symbol, label.replace('Server status', 'Status'), location.pathname === href)).join('') + `<div class="tab-ind" id="tab-ind"></div>`;
}

function shellSheet(game, section) {
  const parts = [];
  if (game) for (const [label, items] of NAV_GROUPS) { const rest = items.filter(([key]) => !PHONE_TABS.includes(key)); if (rest.length) parts.push(`<span class="eyebrow">${label}</span>` + rest.map(([key, symbol, text]) => shellNavItem(gamePath(game, key), symbol, text, key === section)).join('')); }
  parts.push('<span class="eyebrow">Account</span>' + shellAccountItems().map(([href, symbol, label]) => shellNavItem(href, symbol, label, location.pathname === href)).join('') + `<button type="button" class="ni" data-action="theme">${icon('sun', 17)}<span class="lbl">Light or dark theme</span></button>`);
  return `<div class="grab"></div>${parts.join('')}`;
}

// Moves the one highlight behind the active item (it slides because the element stays in the page).
function moveNavIndicator() {
  const indicator = document.querySelector('#nav-ind'), active = document.querySelector('.nav .ni.on');
  if (indicator) {
    if (!active || !active.offsetHeight) { indicator.style.opacity = '0'; }
    else {
      const first = indicator.dataset.placed !== '1';
      if (first) indicator.style.transition = 'none';
      indicator.style.height = `${active.offsetHeight}px`;
      indicator.style.opacity = '1';
      mo.glide(indicator, {transform: `translateY(${active.offsetTop}px)`});
      if (first) { indicator.dataset.placed = '1'; requestAnimationFrame(() => { indicator.style.transition = ''; }); }
    }
  }
  const tabs = document.querySelector('#tab-ind'), tab = document.querySelector('.tabbar .tab.on');
  if (tabs) { if (!tab) tabs.style.opacity = '0'; else { tabs.style.opacity = '1'; mo.glide(tabs, {transform: `translateX(${tab.offsetLeft + tab.offsetWidth / 2 - 14}px)`}); tabs.dataset.placed = '1'; } }
}

function shell(title, content) {
  const game = currentGame, section = currentSection;
  const crumbs = game
    ? `<a href="/">Games</a><span class="sep">/</span><a href="${gamePath(game)}">${escapeHTML(game.name)} · ${platformLabel(game.platform)}</a><span class="sep">/</span><b>${escapeHTML(title)}</b>`
    : `<span>Workspace</span><span class="sep">/</span><b>${escapeHTML(title)}</b>`;
  const key = JSON.stringify([game?.id, game && variantsOf(game).map(item => `${item.id}${item.archived_at ? 'p' : ''}${item.icon_updated_at || ''}`), me.workspaces.map(item => item.id), currentWorkspace, me.can_manage_team, canManageGames(), me.name, wsRole()]);
  const page = `${content}<footer class="footnote"><span>${icon('shield', 13)} Your data stays on your server.</span><span>AVN Analytics</span></footer>`;
  const frame = root.querySelector('.app');
  if (frame && frame.dataset.key === key) {
    // Same sidebar: keep it, so the highlight slides, and only swap the page.
    frame.querySelectorAll('.nav .ni').forEach(item => { const on = item.getAttribute('href') === (game ? gamePath(game, section) : location.pathname) || (!game && item.getAttribute('href') === '/' && ['/', '/games', '/games/new'].includes(location.pathname)); item.classList.toggle('on', on); on ? item.setAttribute('aria-current', 'page') : item.removeAttribute('aria-current'); });
    for (const link of frame.querySelectorAll('.platforms a:not(.add)')) { const target = game && variantsOf(game).find(item => link.getAttribute('href') === gamePath(item, section)); link.classList.toggle('on', !!target && target.id === game.id); }
    frame.querySelector('.crumbs').innerHTML = crumbs;
    frame.querySelector('.m-title b').textContent = title;
    frame.querySelector('#main').innerHTML = page;
    frame.querySelector('.tabbar').innerHTML = shellTabs(game, section);
    frame.querySelector('#sheet').innerHTML = shellSheet(game, section);
  } else {
    root.innerHTML = `<div class="app-root"><div class="app" data-key="${escapeHTML(key)}">${shellSidebar(game, section)}<div class="workspace"><header class="topbar"><div class="crumbs">${crumbs}</div><div class="m-title"><span class="mark" aria-hidden="true"><img src="/assets/icons/avn-analytics.svg" alt="" width="24" height="24"></span><b>${escapeHTML(title)}</b></div>
      <div class="tools topbar-right"><button type="button" class="search-btn" data-cmdk aria-label="Search (Ctrl K)">${icon('search', 15)}<span class="lbl">Search…</span><kbd>Ctrl K</kbd></button><button type="button" class="icon-btn" data-pop="refresh" aria-haspopup="menu" aria-expanded="false" title="Refresh and auto-refresh" aria-label="Refresh and auto-refresh">${icon('refresh', 16)}<span class="auto-tag" id="auto-tag" hidden></span></button><button type="button" data-action="refresh" hidden aria-hidden="true" tabindex="-1"></button><button type="button" class="icon-btn" data-link title="Copy link to this view" aria-label="Copy link to this view">${icon('link', 16)}</button><button type="button" class="icon-btn" data-pop="notes" aria-haspopup="dialog" aria-expanded="false" title="Notifications" aria-label="Notifications">${icon('sparkle', 16)}<span class="bell-n" id="bell-n" hidden>0</span></button><button type="button" class="icon-btn" data-action="theme" title="Switch light/dark theme" aria-label="Switch light/dark theme">${icon(window.avnTheme?.theme() === 'light' ? 'moon' : 'sun', 16)}</button></div></header>
      <main id="main" class="content">${page}</main></div>
      <nav class="tabbar" aria-label="Main">${shellTabs(game, section)}</nav><div class="sheet-bg" id="sheet-bg" hidden></div><div class="sheet" id="sheet" hidden role="dialog" aria-label="More">${shellSheet(game, section)}</div>
      <div class="cmdk-bg" id="cmdk-bg" hidden></div><div class="cmdk" id="cmdk" hidden role="dialog" aria-label="Search"><div class="cmdk-in">${icon('search', 16)}<input id="cmdk-q" placeholder="Jump to a page, game or action…" autocomplete="off" aria-label="Search pages, games and actions"><kbd>Esc</kbd></div><div class="cmdk-list" id="cmdk-list" role="listbox"></div><div class="cmdk-foot">↑ ↓ to move · Enter to open · Esc to close</div></div></div></div>`;
  }
  document.title = `${game ? `${title} · ${game.name}` : title} · AVN Analytics`;
  requestAnimationFrame(moveNavIndicator);
  watchMain(); riseIn(document.querySelector('#main')); updateBell(); markFresh(); setAutoRefresh(autoMinutes, false);
}

/* ─── command palette, account menu, sheet, groups, copy link ─── */
function cmdkItems() {
  const game = currentGame, items = [];
  if (game) for (const [, list] of NAV_GROUPS) for (const [key, symbol, label] of list) items.push(['Pages', symbol, label, () => navigate(gamePath(game, key)), game.name]);
  items.push(['Pages', 'grid', 'All games', () => navigate('/')]);
  for (const [href, symbol, label] of shellAccountItems()) items.push(['Pages', symbol, label, () => navigate(href)]);
  for (const group of gameGroups(overview.games)) items.push(['Games', 'game', group.name, () => navigate(gamePath(group.primary)), group.primary.bundle_id]);
  items.push(['Actions', 'refresh', 'Refresh data', () => document.querySelector('[data-action="refresh"]')?.click()], ['Actions', 'link', 'Copy link to this view', copyViewLink], ['Actions', 'sun', 'Switch light or dark theme', () => document.querySelector('[data-action="theme"]')?.click()]);
  if (document.querySelector('.nb-launcher:not(.locked)')) items.push(['Actions', 'sparkle', 'Ask NutBot', () => document.querySelector('.nb-launcher')?.click()]);
  return items;
}
let cmdkRows = [], cmdkIndex = 0;
function cmdkRender() {
  const query = document.querySelector('#cmdk-q').value.trim().toLowerCase();
  const rank = text => { const t = text.toLowerCase(); if (!query) return 3; if (t.startsWith(query)) return 0; if (t.includes(query)) return 1; let at = 0; for (const letter of query) { at = t.indexOf(letter, at) + 1; if (!at) return 9; } return 2; };
  cmdkRows = cmdkItems().map(item => [rank(item[2]), item]).filter(([score]) => score < 9).sort((a, b) => a[0] - b[0]).map(([, item]) => item).slice(0, 40);
  cmdkIndex = Math.min(cmdkIndex, Math.max(0, cmdkRows.length - 1));
  let last = '';
  document.querySelector('#cmdk-list').innerHTML = cmdkRows.length ? cmdkRows.map(([group, symbol, label, , hint], index) => {
    const head = group !== last ? `<span class="eyebrow cmdk-g">${group}</span>` : ''; last = group;
    return `${head}<button type="button" class="cmdk-i${index === cmdkIndex ? ' on' : ''}" role="option" data-i="${index}">${icon(symbol, 16)}<span>${escapeHTML(label)}</span>${hint ? `<span class="k">${escapeHTML(hint)}</span>` : ''}</button>`;
  }).join('') : '<div class="cmdk-empty">Nothing matches that.</div>';
}
function cmdkOpen() {
  const box = document.querySelector('#cmdk'); if (!box) return;
  document.querySelector('#cmdk-bg').hidden = box.hidden = false; mo.enter(box, 'cmdk'); mo.enter(document.querySelector('#cmdk-bg'), 'fade');
  const input = document.querySelector('#cmdk-q'); input.value = ''; cmdkIndex = 0; cmdkRender(); input.focus();
}
function cmdkClose() { const box = document.querySelector('#cmdk'); if (!box || box.hidden) return; const bg = document.querySelector('#cmdk-bg'); const hide = () => { bg.hidden = box.hidden = true; }; if (mo.on()) { mo.leave(bg, 'fade'); mo.leave(box, 'cmdk').then(hide); } else hide(); }
function cmdkRun(index) { const row = cmdkRows[index]; if (!row) return; cmdkClose(); row[3](); }
async function copyViewLink() { try { await navigator.clipboard.writeText(location.href); toast('Link copied. It opens this same page.'); } catch { toast('Copy failed: your browser blocked clipboard access.'); } }
function sheetToggle(open) {
  const sheet = document.querySelector('#sheet'), bg = document.querySelector('#sheet-bg'); if (!sheet || sheet.hidden === !open) return;
  if (open) { sheet.hidden = bg.hidden = false; mo.enter(sheet, 'sheet'); mo.enter(bg, 'fade'); return; }
  const hide = () => { sheet.hidden = bg.hidden = true; }; if (mo.on()) { mo.leave(bg, 'fade'); mo.leave(sheet, 'sheet').then(hide); } else hide();
}
function accountMenu(open) { const menu = document.querySelector('#acct-menu'), button = document.querySelector('#acct-btn'); if (!menu) return; menu.hidden = !open; button.setAttribute('aria-expanded', String(open)); }

document.addEventListener('click', event => {
  const target = event.target;
  if (target.closest('[data-cmdk]')) { cmdkOpen(); return; }
  if (target.closest('#cmdk-bg')) { cmdkClose(); return; }
  const row = target.closest('.cmdk-i'); if (row) { cmdkRun(Number(row.dataset.i)); return; }
  if (target.closest('[data-link]')) { copyViewLink(); return; }
  if (target.closest('[data-more]')) { sheetToggle(true); return; }
  if (target.closest('#sheet-bg') || target.closest('#sheet a')) sheetToggle(false);
  const group = target.closest('[data-group]');
  if (group) { const holder = group.closest('.grp'), closed = !holder.classList.contains('closed'); holder.classList.toggle('closed', closed); group.setAttribute('aria-expanded', String(!closed)); closed ? closedGroups.add(group.dataset.group) : closedGroups.delete(group.dataset.group); setTimeout(moveNavIndicator, 340); return; }
  if (target.closest('#acct-btn')) { accountMenu(document.querySelector('#acct-menu').hidden); return; }
  if (!target.closest('#acct-menu')) accountMenu(false); else if (target.closest('#acct-menu a')) accountMenu(false);
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); cmdkOpen(); return; }
  const box = document.querySelector('#cmdk');
  if (event.key === 'Escape') { if (box && !box.hidden) cmdkClose(); sheetToggle(false); accountMenu(false); return; }
  if (!box || box.hidden) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); cmdkIndex = (cmdkIndex + (event.key === 'ArrowDown' ? 1 : -1) + cmdkRows.length) % Math.max(1, cmdkRows.length); cmdkRender(); document.querySelector('.cmdk-i.on')?.scrollIntoView({block: 'nearest'}); }
  if (event.key === 'Enter') { event.preventDefault(); cmdkRun(cmdkIndex); }
});
document.addEventListener('input', event => { if (event.target.id === 'cmdk-q') { cmdkIndex = 0; cmdkRender(); } });
window.addEventListener('resize', () => requestAnimationFrame(moveNavIndicator));
