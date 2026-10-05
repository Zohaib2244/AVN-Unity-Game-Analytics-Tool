const root = document.querySelector('#app');
const modal = document.querySelector('#dialog');
let overview;
let me = {is_admin: true, can_manage_team: false, workspaces: [], email: '', name: '', source: 'local'};
let currentWorkspace = null;   // the workspace whose games are listed; remembered in this browser
const WS_KEY = 'avn-workspace';
const wsRole = () => me.is_admin ? 'admin' : (me.workspaces.find(item => item.id === currentWorkspace)?.role || 'member');
const canManageGames = () => me.is_admin || wsRole() === 'lead';
const workspaceName = () => me.workspaces.find(item => item.id === currentWorkspace)?.name || '';
const overviewURL = () => `/v1/overview${currentWorkspace ? `?workspace=${encodeURIComponent(currentWorkspace)}` : ''}`;
function chooseWorkspace(id) {
  currentWorkspace = id;
  try { localStorage.setItem(WS_KEY, id); } catch { /* storage unavailable */ }
  cache.clear(); overviewStale = true;
}
async function refreshMe() {
  me = {...await request('/v1/me'), loaded: true}; ensureWorkspace(); cache.clear(); overviewStale = true;
}
function ensureWorkspace(preferred) {
  const ids = me.workspaces.map(item => item.id);
  let saved = null; try { saved = localStorage.getItem(WS_KEY); } catch { /* storage unavailable */ }
  const pick = [preferred, currentWorkspace, saved].find(id => id && ids.includes(id)) || ids[0] || null;
  if (pick !== currentWorkspace) chooseWorkspace(pick);
}
let noticeTimer;
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  game: '<path d="M7 8h10c3 0 4 3 4 7s-2 5-4 2l-1-1H8l-1 1c-2 3-4 2-4-2s1-7 4-7Z"/><path d="M8 10v5m-2.5-2.5h5m5-1h.01m2 2h.01"/>',
  key: '<circle cx="8" cy="9" r="5"/><path d="m12 12 9 9m-5-5 3-3m-1 5 3-3"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/>',
  book: '<path d="M12 6c-3-3-7-3-10-2v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-7-1-10 2Z"/><path d="M12 6v15"/>',
  pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01m4-11h6m-6 11h6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 11 3 3 5-6"/>',
  logout: '<path d="M10 4H4v16h6m5-12 4 4-4 4m-7-4h13"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
  file: '<path d="M14 2H4v20h16V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  funnel: '<path d="M3 4h18l-7 8v6l-4 2v-8Z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.6 2.6 3 5.2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13 7 4 4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 4v3"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const number = value => new Intl.NumberFormat().format(value || 0);
const today = () => new Date().toISOString().slice(0, 10);
const displayDate = value => value ? new Date(value).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}) : 'No events yet';
const addDays = (value, days) => { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const monthStart = value => `${value.slice(0, 8)}01`;
const monthEnd = value => { const date = new Date(`${value}T00:00:00Z`); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };
const shiftMonth = (value, months) => { const date = new Date(`${value}T00:00:00Z`); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)).toISOString().slice(0, 10); };
const prettyDay = value => new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {weekday:'short', day:'numeric', month:'short', year:'numeric', timeZone:'UTC'});

// Date range control: quick presets (Last 7/30/90 days…) plus a flatpickr calendar for any custom From–To days.
const presets = [
  ['today', 'Today', () => [today(), today()]],
  ['yesterday', 'Yesterday', () => [addDays(today(), -1), addDays(today(), -1)]],
  ['7', 'Last 7 days', () => [addDays(today(), -6), today()]],
  ['30', 'Last 30 days', () => [addDays(today(), -29), today()]],
  ['90', 'Last 90 days', () => [addDays(today(), -89), today()]],
  ['month', 'This month', () => [monthStart(today()), today()]],
  ['lastmonth', 'Last month', () => { const first = shiftMonth(today(), -1); return [first, monthEnd(first)]; }],
];

// Compact variant for dashboards: one row with a preset menu, the calendar field and ‹ › steps.
function compactRangeMarkup() {
  return `<div class="range range-compact"><select data-preset-select aria-label="Date range">${presets.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}<option value="custom">Custom days</option></select>
  <button type="button" class="range-nav" data-range-step="-1" aria-label="Previous range">‹</button><input type="text" class="range-input" data-range-picker readonly aria-label="Selected days"><button type="button" class="range-nav" data-range-step="1" aria-label="Next range">›</button>
  <input type="hidden" data-range="from"><input type="hidden" data-range="to"></div>`;
}

function rangeMarkup() {
  return `<div class="range"><div class="range-modes" role="group" aria-label="Quick ranges">${presets.map(([key, label]) => `<button type="button" data-preset="${key}">${label}</button>`).join('')}<button type="button" data-preset="custom">Custom</button></div>
  <div class="range-body"><button type="button" class="range-nav" data-range-step="-1" aria-label="Previous range">‹</button>
  <label>Selected days<input type="text" class="range-input" data-range-picker readonly placeholder="Select from and to days"></label>
  <button type="button" class="range-nav" data-range-step="1" aria-label="Next range">›</button>
  <input type="hidden" data-range="from" name="date"><input type="hidden" data-range="to" name="end_date"></div></div>`;
}

function bindRange(container, onChange, initialPreset = '7', initialRange = null) {
  const state = {preset: initialPreset, from: today(), to: today()};
  const input = container.querySelector('[data-range-picker]');
  const hidden = {from: container.querySelector('[data-range="from"]'), to: container.querySelector('[data-range="to"]')};
  const picker = flatpickr(input, {
    mode: 'range', showMonths: 1, dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y', closeOnSelect: false,
    altInputClass: 'range-input', minDate: '1970-01-01', maxDate: '9998-12-31', locale: {firstDayOfWeek: 1}, allowInput: false,
    // The calendar stays open after the second click (so the range can be adjusted); it closes when you
    // click away or press Esc. The range applies as soon as both days are picked, and again on close.
    onChange: dates => { if (dates.length === 2) commit(dates); },
    onClose: dates => commit(dates),
  });
  function commit(dates) {
      if (dates.length === 0) return;
      const from = picker.formatDate(dates[0], 'Y-m-d'); const to = picker.formatDate(dates[dates.length - 1], 'Y-m-d');
      if (from === state.from && to === state.to) return;
      state.preset = 'custom'; state.from = from; state.to = to; apply(false);
  }
  function apply(updatePicker = true) {
    if (updatePicker) picker.setDate([state.from, state.to], false);
    hidden.from.value = state.from; hidden.to.value = state.to;
    container.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === state.preset)));
    const select = container.querySelector('[data-preset-select]'); if (select) select.value = state.preset;
    onChange({...state});
  }
  container.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.preset === 'custom') { state.preset = 'custom'; apply(false); picker.open(); return; }
    [state.from, state.to] = presets.find(([key]) => key === button.dataset.preset)[2](); state.preset = button.dataset.preset; apply();
  }));
  container.querySelector('[data-preset-select]')?.addEventListener('change', event => {
    if (event.target.value === 'custom') { state.preset = 'custom'; apply(false); picker.open(); return; }
    [state.from, state.to] = presets.find(([key]) => key === event.target.value)[2](); state.preset = event.target.value; apply();
  });
  container.querySelectorAll('[data-range-step]').forEach(button => button.addEventListener('click', () => {
    const direction = Number(button.dataset.rangeStep);
    const span = daysBetween(state.from, state.to) + 1;
    state.from = addDays(state.from, direction * span); state.to = addDays(state.to, direction * span); state.preset = 'custom'; apply();
  }));
  const preset = presets.find(([key]) => key === initialPreset);
  if (preset && initialPreset !== 'custom') [state.from, state.to] = preset[2]();
  else if (initialRange) { state.preset = 'custom'; state.from = initialRange.from; state.to = initialRange.to; }
  else { state.preset = '7'; [state.from, state.to] = presets.find(([key]) => key === '7')[2](); }
  apply();
  return state;
}

async function fetchRange(game, {from, to}, basis = 'server_ts', extra = '') {
  return api(`${gameURL(game)}/health?${new URLSearchParams({period:'custom', date:from, end_date:to, basis})}${extra ? `&${extra}` : ''}`);
}

function rangeResult(health, {from, to}) {
  const counts = new Map(health.days.map(day => [day.day, day.events]));
  const days = []; for (let day = from; day <= to; day = addDays(day, 1)) days.push({day, events: counts.get(day) || 0});
  const peak = Math.max(1, ...days.map(day => day.events));
  const span = days.length;
  return `<div class="range-total"><strong>${number(health.total)}</strong><span>events · ${prettyDay(from)}${span > 1 ? ` → ${prettyDay(to)}` : ''} · ${span} day${span === 1 ? '' : 's'}</span></div>` +
    (health.total ? `<div class="table-wrap"><table><thead><tr><th>Day</th><th>Events</th><th></th></tr></thead><tbody>${days.map(day => `<tr><td>${day.day}</td><td>${number(day.events)}</td><td class="range-bar"><progress class="progress mini" max="${peak}" value="${day.events}" aria-label="${day.events} events on ${day.day}"></progress></td></tr>`).join('')}</tbody></table></div>` : `<p class="help">No events in this range.</p>`);
}

function mountActivity(container, game, basis = 'server_ts') {
  container.innerHTML = rangeMarkup() + '<div class="range-result" aria-live="polite"></div>';
  const result = container.querySelector('.range-result');
  let latest = 0;
  bindRange(container, async range => {
    const request = ++latest; result.innerHTML = '<p class="help">Counting…</p>';
    try { const health = await fetchRange(game, range, basis); if (request === latest) result.innerHTML = rangeResult(health, range); }
    catch (error) { if (request === latest) result.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  });
}
const platformLabel = platform => ({android:'Android', ios:'iOS'}[platform] || escapeHTML(platform));
const fileSize = value => value >= 1073741824 ? `${(value / 1073741824).toFixed(1)} GB` : value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((value || 0) / 1024))} KB`;
const gameURL = game => `/v1/games/${encodeURIComponent(game.id)}`;
const brand = `<a href="/" class="brand" aria-label="AVN Analytics home"><span class="brand-icon">a.</span><span><span class="brand-name">avn analytics</span><span class="brand-sub"></span></span></a>`;

function diagram() {
  return `<div class="welcome-art" aria-hidden="true"><svg viewBox="0 0 340 230" fill="none"><circle cx="185" cy="115" r="82" stroke="currentColor"/><circle cx="185" cy="115" r="57" stroke="currentColor" opacity=".6"/><path d="M52 70h48l48 44m-96 59h50l46-48m77-11h68" stroke="var(--accent-cyan)" stroke-width="1.4" stroke-dasharray="4 5"/><rect x="26" y="43" width="59" height="54" rx="13" fill="var(--bg-nested)" stroke="var(--border)"/><rect x="26" y="146" width="59" height="54" rx="13" fill="var(--bg-nested)" stroke="var(--border)"/><rect x="139" y="75" width="87" height="81" rx="20" fill="var(--accent-orange)" stroke="var(--border)"/><rect x="266" y="87" width="49" height="54" rx="12" fill="var(--bg-nested)" stroke="var(--border)"/><path d="M169 99h28v12h-28Zm0 18h28v12h-28Z" stroke="var(--badge-text)" stroke-width="2"/><circle cx="175" cy="105" r="1.5" fill="var(--badge-text)"/><circle cx="175" cy="123" r="1.5" fill="var(--badge-text)"/><path d="M45 65h19l3 14-8-3h-9l-8 3 3-14Zm2 5h7m-3-3v6m9-2h.1M45 167h21v14H45Zm3 17h15m-11-3v3m6-3v3M279 101h15m-15 6h15m-15 6h9m-9 6h12" stroke="var(--accent-orange)" stroke-width="1.5" stroke-linecap="round"/><circle cx="241" cy="65" r="12" fill="var(--bg-nested)" stroke="var(--accent-cyan)"/><path d="m236 65 3 3 6-6" stroke="var(--accent-cyan)" stroke-width="1.5"/><circle cx="116" cy="181" r="4" fill="var(--accent-cyan)"/><circle cx="288" cy="167" r="3" fill="var(--accent-cyan)"/></svg></div>`;
}

function toast(message) {
  document.querySelector('#notice').textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { document.querySelector('#notice').textContent = ''; }, 4500);
}

// Short-lived cache for read requests, so revisiting a page (or hovering a link first) skips the network.
// Any write clears it; event counts (/health) are always fetched live.
const cache = new Map();
const CACHE_MS = 30000;
let overviewStale = true;
const cacheable = path => !path.includes('/health') && !path.includes('/export');

async function request(path, options = {}) {
  const response = await fetch(path, {credentials:'same-origin', ...options,
    headers: {...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}});
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Object.assign(new Error(typeof error.detail === 'string' ? error.detail : 'Please check your details and try again.'), {status: response.status});
  }
  return response.status === 204 ? null : response.json();
}

function api(path, options = {}) {
  if (path.includes('/insights/')) return options.method && options.method !== 'GET' ? request(path, options) : cachedRequest(path, options); // read-only queries
  if (options.method && options.method !== 'GET') return request(path, options).finally(() => { cache.clear(); overviewStale = true; });
  return cacheable(path) ? cachedRequest(path, options) : request(path, options);
}

function cachedRequest(path, options) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.promise;
  const promise = request(path, options);
  cache.set(path, {time: Date.now(), promise});
  promise.catch(() => { if (cache.get(path)?.promise === promise) cache.delete(path); });
  return promise;
}

function empty(title, description, action = '', type = 'game') {
  return `<div class="empty"><span class="empty-icon">${icon(type, 23)}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p>${action}</div>`;
}

function heading(title, subtitle, action = '') {
  return `<div class="page-heading"><div><h1>${escapeHTML(title)}</h1><p>${escapeHTML(subtitle)}</p></div>${action}</div>`;
}

const registerButton = () => canManageGames() ? `<a class="button primary" href="/games/new">${icon('plus', 15)} Register game</a>` : '';
const ROLE_LABELS = {admin: 'Admin', lead: 'Team lead', member: 'Member'};

function metric(title, value, footer, symbol) {
  return `<article class="metric"><div class="metric-top"><span>${title}</span>${icon(symbol,17)}</div><div class="metric-value">${value}</div><p class="metric-foot">${footer}</p></article>`;
}

// Game-first navigation: the workspace lists games; inside a game, the sidebar shows that game's
// sections and an Android/iOS switch between its registered variants.
let currentGame = null;
let currentSection = 'overview';
const GAME_SECTIONS = [['overview','grid','Overview'],['funnels','funnel','Funnels'],['players','users','Players'],['exports','export','Exports'],['dictionary','book','Event dictionary'],['keys','key','API keys'],['settings','settings','Game settings']];
const gamePath = (game, section = 'overview') => `/games/${encodeURIComponent(game.id)}${section === 'overview' ? '' : `/${section}`}`;
const sameGame = (a, b) => a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
const PLATFORM_ORDER = ['android', 'ios'];
const byPlatform = (a, b) => (PLATFORM_ORDER.indexOf(a.platform) + 1 || 9) - (PLATFORM_ORDER.indexOf(b.platform) + 1 || 9);
const variantsOf = game => overview.games.filter(item => sameGame(item, game)).sort(byPlatform);
// The game's icon when one was uploaded (for any of its platform versions), otherwise its initials.
const iconURL = game => `${gameURL(game)}/icon?v=${encodeURIComponent(game.icon_updated_at)}`;
const avatar = (name, ...games) => {
  const withIcon = games.flat().find(item => item?.icon_updated_at);
  return `<span class="game-avatar ${withIcon ? 'has-icon' : ''}">${withIcon ? `<img src="${iconURL(withIcon)}" alt="" loading="lazy" width="42" height="42">` : escapeHTML(name.slice(0,2).toUpperCase())}</span>`;
};

// Turns any picked image into a 256×256 PNG (centre-cropped square) before upload, so the server only ever
// stores small PNGs and no image library is needed there.
async function iconFromFile(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Choose an image file (PNG, JPEG, WebP or GIF).');
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('That image couldn’t be read. Try a PNG or JPEG.'); }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = Object.assign(document.createElement('canvas'), {width: 256, height: 256});
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Couldn’t prepare the image.')), 'image/png'));
}
async function uploadIcon(game, file) {
  const blob = await iconFromFile(file);
  for (const item of (overview.games.some(other => other.id === game.id) ? variantsOf(game) : [game])) await request(`${gameURL(item)}/icon`, {method:'PUT', body: blob, headers: {'Content-Type': 'image/png'}});
  cache.clear(); overviewStale = true;
}
async function removeIcon(game) {
  for (const item of variantsOf(game)) if (item.icon_updated_at) await request(`${gameURL(item)}/icon`, {method:'DELETE'});
  cache.clear(); overviewStale = true;
}

function gameGroups(games) {
  const groups = [];
  for (const game of games) {
    const group = groups.find(item => sameGame(item.variants[0], game));
    if (group) group.variants.push(game); else groups.push({variants: [game]});
  }
  return groups.map(group => {
    const variants = group.variants.sort(byPlatform);
    const live = variants.filter(item => !item.archived_at);
    return {name: variants[0].name, variants, primary: [...(live.length ? live : variants)].sort((a, b) => (b.events || 0) - (a.events || 0))[0],
      events: variants.reduce((sum, item) => sum + (item.events || 0), 0), last_event: variants.map(item => item.last_event || '').sort().pop() || null,
      archived: !live.length, created_at: variants.map(item => item.created_at).sort()[0], notes: variants.find(item => item.notes)?.notes || ''};
  });
}

function variantSwitch(game, section) {
  const variants = variantsOf(game);
  const missing = PLATFORM_ORDER.filter(platform => !variants.some(item => item.platform === platform));
  return `<div class="variant-switch" role="group" aria-label="Platform">${variants.map(item => `<a href="${gamePath(item, section)}" aria-pressed="${item.id === game.id}" title="${escapeHTML(item.bundle_id)}">${platformLabel(item.platform)}${item.archived_at ? ' ·  paused' : ''}</a>`).join('')}${(canManageGames() ? missing : []).map(platform => `<a class="variant-add" href="/games/new?${new URLSearchParams({name: game.name, bundle_id: game.bundle_id, platform})}" title="Register the ${platformLabel(platform)} version">+ ${platformLabel(platform)}</a>`).join('')}</div>`;
}

function shell(title, content) {
  const secondary = [...(me.can_manage_team ? [['/workspaces','grid','Workspaces'],['/team','users','Team']] : []), ['/status','pulse','Status'],['/settings','settings','Settings']];
  const link = ([url, symbol, label], active) => `<a href="${url}" aria-label="${label}" class="${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></a>`;
  const game = currentGame;
  const main = game
    ? `<a class="back-to-games" href="/">← All games</a><div class="sidebar-game">${avatar(game.name, variantsOf(game))}<div><strong>${escapeHTML(game.name)}</strong><span>${escapeHTML(game.bundle_id)}</span></div></div>${variantSwitch(game, currentSection)}<p class="nav-label eyebrow">Game</p><nav class="nav" aria-label="Game">${GAME_SECTIONS.map(([section, symbol, label]) => link([gamePath(game, section), symbol, label], section === currentSection)).join('')}</nav>`
    : `<p class="nav-label eyebrow">Menu</p><nav class="nav" aria-label="Menu">${link(['/', 'grid', 'Games'], ['/', '/games', '/games/new'].includes(location.pathname))}</nav>`;
  const crumbs = game ? `<a href="/">Games</a> <span>/</span> <a href="${gamePath(game)}">${escapeHTML(game.name)} · ${platformLabel(game.platform)}</a> <span>/</span> <strong>${escapeHTML(title)}</strong>` : `Workspace <span>/</span> <strong>${escapeHTML(title)}</strong>`;
  const switcher = me.workspaces.length > 1 || me.is_admin ? `<div class="ws-switch"><label for="ws-select">Workspace</label><select id="ws-select" aria-label="Workspace">${me.workspaces.map(item => `<option value="${item.id}" ${item.id === currentWorkspace ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}</select></div>` : '';
  root.innerHTML = `<aside class="sidebar">${brand}${switcher}${main}<nav class="nav nav-secondary" aria-label="Secondary">${secondary.map(item => link(item, location.pathname === item[0])).join('')}</nav><div class="sidebar-bottom"><div class="account"><span class="avatar">${escapeHTML((me.name || me.email || 'A').slice(0,2).toUpperCase())}</span><div><strong>${escapeHTML(me.name || (me.email || '').split('@')[0] || 'Administrator')}</strong><p>${ROLE_LABELS[wsRole()] || wsRole()}${me.source === 'lan' ? ' · local network' : ''}</p></div></div></div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb">${crumbs}</div><div class="topbar-right"><button class="icon-button" data-action="theme" title="Switch light/dark theme" aria-label="Switch light/dark theme">${icon(window.avnTheme?.theme() === 'light' ? 'moon' : 'sun',15)}</button><button class="icon-button" data-action="refresh" title="Refresh data" aria-label="Refresh data">${icon('refresh',15)}</button></div></header><main id="main">${content}<footer class="footnote"><span>${icon('shield',13)} Your data stays on your server.</span><span>AVN Analytics</span></footer></main></div>`;
  document.title = `${game ? `${title} · ${game.name}` : title} · AVN Analytics`;
}

function renderHome() {
  const all = gameGroups(overview.games);
  const archivedCount = all.filter(group => group.archived).length;
  shell('Games', heading(me.workspaces.length > 1 || me.is_admin ? `${workspaceName() || 'Your'} games` : 'Your games', 'Pick a game to see its players, funnels, exports and settings.', registerButton()) +
    `<section class="metrics" aria-label="Workspace totals">${metric('Games', number(all.length), `${number(overview.games.length)} platform variant${overview.games.length === 1 ? '' : 's'}`, 'game')}${metric('Events collected', number(overview.events), 'Safely stored, never double-counted', 'pulse')}${metric('Events today', number(overview.today), 'Received today · UTC', 'export')}</section>
    ${all.length ? `<div class="toolbar games-toolbar"><div class="search">${icon('search',16)}<input id="game-search" type="search" aria-label="Search games" placeholder="Search by name, bundle ID or notes…"></div>
    <div class="range-modes" role="group" aria-label="Show">${[['active',`Active (${all.length - archivedCount})`],['archived',`Archived (${archivedCount})`],['all',`All (${all.length})`]].map(([key,label]) => `<button type="button" data-filter="${key}">${label}</button>`).join('')}</div>
    <div class="game-select"><label for="game-sort">Sort</label><select id="game-sort"><option value="recent">Latest activity</option><option value="name">Name A–Z</option><option value="events">Most events</option><option value="newest">Newest first</option></select></div></div>` : ''}<div id="game-results"></div>
    ${overview.events ? '' : `<section class="panel section-spacing"><div class="panel-header"><div><h2>A simple start</h2><p>From your first event to your next idea.</p></div>${icon('pulse',17)}</div><ol class="steps"><li><span class="step-number ${all.length ? 'done' : ''}">${all.length ? icon('check',12) : '01'}</span><div><strong>Register your game</strong><p>A name, a platform, and a place for your events. Add the other platform later.</p></div></li><li><span class="step-number">02</span><div><strong>Send your first event</strong><p>Use your game’s API key to start collecting.</p></div></li><li><span class="step-number">03</span><div><strong>Turn data into direction</strong><p>Open the game for funnels and player journeys, or export the raw events.</p></div></li></ol></section>`}`);
  if (!all.length) { document.querySelector('#game-results').innerHTML = `<section class="panel">${canManageGames() ? empty('Good things begin with a first game', 'Create a game and we’ll generate its first API key.', registerButton()) : empty('No games yet', 'You haven’t been given access to any games. Ask your team lead or the admin.')}</section>`; return; }
  const state = {query: '', filter: archivedCount === all.length ? 'all' : 'active', sort: 'recent'};
  const sorters = {
    newest: (a, b) => b.created_at.localeCompare(a.created_at),
    name: (a, b) => a.name.localeCompare(b.name),
    events: (a, b) => b.events - a.events,
    recent: (a, b) => (b.last_event || '').localeCompare(a.last_event || ''),
  };
  const draw = () => {
    document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)));
    const query = state.query.toLowerCase();
    const groups = all.filter(group => (state.filter === 'all' || (state.filter === 'archived') === group.archived) && `${group.name} ${group.variants.map(item => item.bundle_id).join(' ')} ${group.notes}`.toLowerCase().includes(query)).sort(sorters[state.sort]);
    document.querySelector('#game-results').innerHTML = groups.length ? `<div class="game-grid">${groups.map(group => `<article class="game-card ${group.archived ? 'archived' : ''}"><div class="game-card-header">${avatar(group.name, group.variants)}<span>${group.archived ? '<span class="pill bad">Archived</span>' : ''}</span></div><h3><a class="card-link" href="${gamePath(group.primary)}">${escapeHTML(group.name)}</a></h3><p class="mono">${escapeHTML([...new Set(group.variants.map(item => item.bundle_id))].join(' · '))}</p>${group.notes ? `<p class="game-notes">${escapeHTML(group.notes)}</p>` : ''}<div class="card-variants">${group.variants.map(item => `<a class="pill ${item.archived_at ? 'bad' : ''}" href="${gamePath(item)}" title="Open the ${platformLabel(item.platform)} version">${platformLabel(item.platform)} · ${number(item.events)}</a>`).join('')}${(canManageGames() ? PLATFORM_ORDER.filter(platform => !group.variants.some(item => item.platform === platform)) : []).map(platform => `<a class="pill variant-add" href="/games/new?${new URLSearchParams({name: group.name, bundle_id: group.primary.bundle_id, platform})}">+ ${platformLabel(platform)}</a>`).join('')}</div><div class="game-card-footer"><span>${number(group.events)} events</span><span>${group.archived ? 'Collection paused' : group.last_event ? `Last event ${displayDate(group.last_event)}` : 'Awaiting events'} ${icon('arrow',12)}</span></div></article>`).join('')}</div>` : `<section class="panel">${empty('No games found', 'Try another search or filter.')}</section>`;
  };
  document.querySelector('#game-search').addEventListener('input', event => { state.query = event.target.value; draw(); });
  document.querySelector('#game-sort').addEventListener('change', event => { state.sort = event.target.value; draw(); });
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; draw(); }));
  draw();
}

function renderNewGame() {
  const prefill = new URLSearchParams(location.search);
  shell('Register game', `<a class="back-link" href="/">← Back to games</a>` + heading('Make room for your next game.', 'A few details, and you’re ready to start collecting.') + `<div class="form-layout"><form id="register-form" class="panel form-panel"><h2>Game details</h2><p>Give your project a recognizable name.</p><div class="field"><label for="game-name">Game name</label><input id="game-name" name="name" placeholder="e.g. Tiny Adventures" required maxlength="128" autofocus value="${escapeHTML(prefill.get('name') || '')}"><p>Use the same name for the Android and iOS versions: they appear as one game with a platform switch.</p></div><div class="field"><label for="bundle-id">Bundle ID</label><input id="bundle-id" name="bundle_id" value="${escapeHTML(prefill.get('bundle_id') || '')}" placeholder="com.yourstudio.yourgame" pattern="[A-Za-z0-9_\\-]+(\\.[A-Za-z0-9_\\-]+)+" required maxlength="255"><p>The application identifier from your game’s project settings.</p></div><div class="field"><label for="platform">Platform</label><select id="platform" name="platform"><option value="android">Android</option><option value="ios" ${prefill.get('platform') === 'ios' ? 'selected' : ''}>iOS</option></select><p>Register each platform separately to keep its events isolated. The platform can’t be changed later.</p></div><div class="field"><label for="game-icon">Icon (optional)</label><div class="icon-picker"><span class="game-avatar icon-preview" id="icon-preview">?</span><input id="game-icon" type="file" accept="image/*"></div><p>Shown next to the game everywhere. Any image works; it is cropped to a square. You can change it later in Game settings.</p></div><div class="field"><label for="notes">Notes (optional)</label><textarea id="notes" name="notes" maxlength="2000" placeholder="Store links, release status, anything worth remembering"></textarea></div><div class="error" role="alert"></div><div class="form-actions"><a href="/" class="button">Cancel</a><button class="button primary" type="submit">Register game ${icon('arrow',14)}</button></div></form><aside class="aside-card">${icon('game',25)}<h3>A space of its own</h3><p>Every game gets a separate event database and its own collection keys.</p><ul><li>Duplicates are handled automatically</li><li>Keys can be rotated at any time</li><li>Your raw data stays on your server</li></ul><p class="small">After registration, copy your new API key. It’s shown only once.</p></aside></div>`);
  const iconInput = document.querySelector('#game-icon');
  iconInput.addEventListener('change', async () => {
    const preview = document.querySelector('#icon-preview');
    try { const url = await new Promise((resolve, reject) => { (async () => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(await iconFromFile(iconInput.files[0])); })().catch(reject); }); preview.classList.add('has-icon'); preview.innerHTML = `<img src="${url}" alt="" width="42" height="42">`; }
    catch (error) { iconInput.value = ''; preview.classList.remove('has-icon'); preview.textContent = '?'; toast(error.message); }
  });
  bindForm('#register-form', async (form, values) => {
    delete values.icon; values.workspace_id = currentWorkspace;
    const game = await api('/v1/games', {method:'POST', body:JSON.stringify(values)});
    if (iconInput.files[0]) {
      try { await uploadIcon({...game, platform: values.platform, name: values.name}, iconInput.files[0]); }
      catch (error) { toast(`The game was created, but its icon wasn’t saved: ${error.message}`); }
    }
    showKey(game.key.api_key, 'Your game is ready.', `/games/${game.id}`);
    form.querySelector('button[type="submit"]').disabled = true;
    form.querySelector('button[type="submit"]').textContent = 'Game registered';
  });
}

function selectedGame() {
  if (currentGame) return currentGame;
  const identifier = new URLSearchParams(location.search).get('game');
  return overview.games.find(game => game.id === identifier) || overview.games[0];
}

function picker(game) {
  if (currentGame) return ''; // inside a game, the sidebar's platform switch picks the variant
  return `<div class="toolbar"><div class="game-select"><label for="selected-game">Game</label><select id="selected-game">${overview.games.map(item => `<option value="${item.id}" ${item.id === game.id ? 'selected' : ''}>${escapeHTML(item.name)} · ${platformLabel(item.platform)}${item.archived_at ? ' · archived' : ''}</option>`).join('')}</select></div></div>`;
}

function bindPicker() {
  document.querySelector('#selected-game')?.addEventListener('change', event => {
    navigate(`${location.pathname}?game=${encodeURIComponent(event.target.value)}`);
  });
}

function needsGame(title, description) {
  if (overview.games.length) return false;
  shell(title, heading(title, description) + `<section class="panel">${empty('First, give your events a home', 'Register a game to use this part of your workspace.', registerButton())}</section>`);
  return true;
}

async function renderGameSettings() {
  const id = currentGame.id;
  let game;
  try { game = await api(`/v1/games/${encodeURIComponent(id)}`); }
  catch { shell('Game not found', heading('Game not found', 'This game is not in your workspace.') + '<a class="button" href="/">Back to games</a>'); return; }
  const archived = Boolean(game.archived_at);
  const manage = canManageGames();
  const actions = `<div class="heading-actions">${manage ? `<button class="button" data-game-action="edit">${icon('settings',15)} Edit</button>` : ''}<a class="button primary" href="${gamePath(game, 'exports')}">${icon('export',15)} Export data</a></div>`;
  shell('Game settings', heading('Game settings', `${game.bundle_id} · ${platformLabel(game.platform)}`, actions) +
    (archived ? `<div class="archived-banner">${icon('lock',18)}<div><strong>Archived ${displayDate(game.archived_at)}.</strong> Collection is paused: the server refuses new events, and the Unity SDK keeps them queued on players’ devices until you restore the game.</div>${manage ? '<button class="button" data-game-action="unarchive">Restore game</button>' : ''}</div>` : '') +
    `<section class="metrics">${metric('Events collected',number(game.events),`${number(game.event_names)} distinct event names`,'pulse')}${metric('Events today',number(game.today),'Received today · UTC','export')}${metric('API keys',`${game.keys_active} active`,`${game.keys_total} created in total`,'key')}${metric('Storage',fileSize(game.storage_bytes),'Event database on disk','disk')}</section>
    ${manage ? `<section class="panel section-spacing"><div class="panel-header"><div><h2>Game icon</h2><p>Shown next to the game in the sidebar and on the games page${variantsOf(game).length > 1 ? ' · applies to both platforms' : ''}</p></div></div><div class="panel-body icon-settings">${avatar(game.name, variantsOf(game)).replace('game-avatar', 'game-avatar icon-large')}<div class="icon-actions"><label class="button" for="icon-file">${icon('export',14)} ${game.icon_updated_at ? 'Change icon' : 'Upload icon'}</label><input id="icon-file" type="file" accept="image/*" hidden>${variantsOf(game).some(item => item.icon_updated_at) ? '<button type="button" class="button danger-text" id="icon-remove">Remove</button>' : ''}<p class="small muted">Any image works; it is cropped to a square.</p></div></div></section>` : ''}
    ${manage ? '<section class="panel section-spacing" id="access-panel"><div class="panel-header"><div><h2>Who can see this game</h2><p>Admins and team leads always see every game. Choose which members can open this one.</p></div></div><div class="panel-body" id="access-list"><p class="help">Loading…</p></div></section>' : ''}
    <div class="section-grid section-spacing"><section class="panel"><div class="panel-header"><h2>Game information</h2>${manage ? `<button class="button ghost" data-game-action="edit">Edit ${icon('arrow',12)}</button>` : ''}</div><div class="panel-body"><ul class="status-list">
      <li><span>Name</span><strong>${escapeHTML(game.name)}</strong></li>
      <li><span>Bundle ID</span><code>${escapeHTML(game.bundle_id)}</code></li>
      <li><span>Platform</span><strong>${platformLabel(game.platform)}</strong></li>
      <li><span>Status</span>${archived ? '<span class="pill bad">Archived · collection paused</span>' : `<span class="pill good">${game.last_event ? 'Active' : 'Ready for events'}</span>`}</li>
      <li><span>Game ID</span><span class="copy-row"><code>${game.id}</code><button class="icon-button" data-copy="${game.id}" aria-label="Copy game ID">${icon('copy',14)}</button></span></li>
      <li><span>Registered</span><strong>${displayDate(game.created_at)}</strong></li>
      <li><span>First event</span><strong>${displayDate(game.first_event)}</strong></li>
      <li><span>Latest event</span><strong>${displayDate(game.last_event)}</strong></li>
      <li><span>Event definitions</span><strong>${number(game.definitions)}</strong></li>
      <li class="notes-row"><span>Notes</span>${game.notes ? `<p>${escapeHTML(game.notes)}</p>` : '<span class="muted">No notes yet</span>'}</li>
    </ul><div class="section-spacing"><a class="button" href="${gamePath(game, 'keys')}">${icon('key',15)} Manage keys</a> <a class="button" href="${gamePath(game, 'dictionary')}">${icon('book',15)} Event dictionary</a></div></div></section>
    <aside class="aside-card">${icon('pulse',25)}<h3>Connect your game</h3><p>Send batches to the collection endpoint with one of this game’s API keys in the <code>X-API-Key</code> header.</p><div class="connection"><code>POST ${escapeHTML(overview.ingest_url)}</code></div><p class="small section-spacing">Set <code>AVN_PUBLIC_INGEST_URL</code> on the server to show your public collection address here.</p></aside></div>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>Event activity</h2><p>Pick any days on the calendar · received by the server · UTC</p></div></div><div class="panel-body" id="activity"></div></section>
    ${me.is_admin && me.workspaces.length > 1 ? `<section class="panel section-spacing"><div class="panel-header"><div><h2>Workspace</h2><p>This game is in <strong>${escapeHTML(workspaceName())}</strong>${variantsOf(game).length > 1 ? '; moving it also moves its other platform version' : ''}. Members’ per-game access is cleared when it moves.</p></div></div><div class="panel-body icon-actions"><select id="move-target" aria-label="Move to workspace">${me.workspaces.filter(item => item.id !== currentWorkspace).map(item => `<option value="${item.id}">${escapeHTML(item.name)}</option>`).join('')}</select><button class="button" type="button" id="move-game">Move game…</button></div></section>` : ''}
    ${manage ? `<section class="panel section-spacing danger-zone"><div class="panel-header"><div><h2>Danger zone</h2><p>Changes here affect live data collection.</p></div></div><div class="panel-body">
      <div class="danger-row"><div><strong>${archived ? 'Restore this game' : 'Archive this game'}</strong><p>${archived ? 'Start accepting events again. Queued events on devices will be delivered.' : 'Pause collection without deleting anything. You can restore it at any time.'}</p></div><button class="button" data-game-action="${archived ? 'unarchive' : 'archive'}">${archived ? 'Restore game' : 'Archive game'}</button></div>
      <div class="danger-row"><div><strong>Delete this game</strong><p>Removes the game and all of its API keys. Its event database is moved to the server’s <code>data/deleted</code> folder, not erased.</p></div><button class="button danger" data-game-action="delete">Delete game</button></div>
    </div></section>` : ''}`);
  mountActivity(document.querySelector('#activity'), game);
  if (manage) loadGameAccess(game);
  document.querySelector('#move-game')?.addEventListener('click', () => {
    const target = document.querySelector('#move-target'); const name = target.selectedOptions[0].textContent;
    confirmDialog(`Move ${game.name} to ${name}?`, `${variantsOf(game).length > 1 ? 'Both platform versions move. ' : ''}Events, keys, funnels and the dictionary go with it, and collection keeps working. Members of ${workspaceName()} lose their access to it, and you can grant it again in ${name}.`, 'Move game', async () => {
      await request(`${gameURL(game)}/move`, {method:'POST', body: JSON.stringify({workspace_id: target.value})});
      modal.close(); chooseWorkspace(target.value); toast('Game moved.'); navigate(gamePath(game, 'settings'));
    });
  });
  const refreshAfterIcon = async message => {
    overview = await api(overviewURL()); overviewStale = false;
    currentGame = overview.games.find(item => item.id === game.id) || currentGame;
    await renderGameSettings(); toast(message);
  };
  document.querySelector('#icon-file')?.addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try { await uploadIcon(game, file); await refreshAfterIcon('Icon updated.'); } catch (error) { toast(error.message); }
  });
  document.querySelector('#icon-remove')?.addEventListener('click', async () => {
    try { await removeIcon(game); await refreshAfterIcon('Icon removed.'); } catch (error) { toast(error.message); }
  });
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.dataset.copy); toast('Copied.'); } catch { toast('Select the text and copy it manually.'); }
  }));
  const update = async (changes, message) => { await api(`/v1/games/${game.id}`, {method:'PATCH', body:JSON.stringify(changes)}); toast(message); overview = await api(overviewURL()); overviewStale = false; currentGame = overview.games.find(item => item.id === game.id) || currentGame; await renderGameSettings(); };
  document.querySelectorAll('[data-game-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.gameAction;
    if (action === 'edit') return editGame(game, update);
    if (action === 'archive') return confirmDialog('Archive this game?', `${game.name} will stop accepting events. Nothing is deleted, and devices keep their events queued until you restore it.`, 'Archive game', () => update({archived:true}, 'Game archived. Collection is paused.'));
    if (action === 'unarchive') { try { await update({archived:false}, 'Game restored. Collection has resumed.'); } catch (error) { toast(error.message); } return; }
    if (action === 'delete') return deleteGame(game);
  }));
}

function editGame(game, update) {
  modal.innerHTML = `<form id="edit-form"><h2 id="dialog-title">Edit game</h2><p>Changes apply immediately. Existing events and keys are kept.</p>
    <div class="field"><label for="edit-name">Game name</label><input id="edit-name" name="name" value="${escapeHTML(game.name)}" required maxlength="128"></div>
    <div class="field"><label for="edit-bundle">Bundle ID</label><input id="edit-bundle" name="bundle_id" value="${escapeHTML(game.bundle_id)}" pattern="[A-Za-z0-9_\\-]+(\\.[A-Za-z0-9_\\-]+)+" required maxlength="255"></div>
    <div class="field"><label>Platform</label><input value="${platformLabel(game.platform)}" disabled><p>The platform is fixed so events never mix. Register the other platform as its own game.</p></div>
    <div class="field"><label for="edit-notes">Notes</label><textarea id="edit-notes" name="notes" maxlength="2000" placeholder="Store links, release status, anything worth remembering">${escapeHTML(game.notes || '')}</textarea></div>
    <div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Save changes ${icon('check',14)}</button></div></form>`;
  modal.showModal();
  bindForm('#edit-form', async (form, values) => { await update(values, 'Game updated.'); modal.close(); });
}

function confirmDialog(title, message, label, onConfirm) {
  modal.innerHTML = `<form id="confirm-form"><h2 id="dialog-title">${escapeHTML(title)}</h2><p>${escapeHTML(message)}</p><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">${escapeHTML(label)}</button></div></form>`;
  modal.showModal();
  bindForm('#confirm-form', async () => { await onConfirm(); modal.close(); });
}

function deleteGame(game) {
  modal.innerHTML = `<form id="delete-form"><h2 id="dialog-title">Delete ${escapeHTML(game.name)}?</h2><p>This removes the game and its ${number(game.keys_total)} API key${game.keys_total === 1 ? '' : 's'}. Shipped builds using them will stop sending data. ${number(game.events)} events will be moved to <code>data/deleted</code> on the server, where they can be recovered manually.</p><p>If you only want to pause collection, archive the game instead.</p>
    <div class="field"><label for="delete-confirm">Type <code>${escapeHTML(game.bundle_id)}</code> to confirm</label><input id="delete-confirm" name="confirm" autocomplete="off" required></div>
    <div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button danger" type="submit" disabled>Delete game</button></div></form>`;
  modal.showModal();
  const input = modal.querySelector('#delete-confirm'); const submit = modal.querySelector('[type="submit"]');
  input.addEventListener('input', () => { submit.disabled = input.value !== game.bundle_id; });
  bindForm('#delete-form', async (form, values) => {
    await api(`/v1/games/${game.id}?${new URLSearchParams({confirm: values.confirm})}`, {method:'DELETE'});
    modal.close(); location.assign('/');
  });
}

async function renderKeys() {
  if (needsGame('API keys', 'Control how your games connect.')) return;
  const game = selectedGame();
  const keys = await api(`${gameURL(game)}/keys`);
  shell('API keys', heading('API keys', 'A connection for every release. Everyone on the team can copy them; admins and leads manage them.', canManageGames() ? '<button class="button primary" data-action="new-key">'+icon('plus',15)+' Create key</button>' : '') + picker(game) + `<section class="panel"><div class="panel-header"><h2>Collection keys <span class="count">${keys.length}</span></h2><span class="small muted">Copy a key any time. Keys made before this update can’t be copied</span></div><div class="table-wrap"><table><thead><tr><th>Label</th><th>Key prefix</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody>${keys.map(key => `<tr><td>${escapeHTML(key.label)}</td><td><code>${escapeHTML(key.prefix)}…</code> ${key.api_key ? `<button type="button" class="icon-button copy-prefix" data-action="copy-key" data-key="${escapeHTML(key.api_key)}" aria-label="Copy full key" title="Copy full key">${icon('copy',14)}</button>` : `<button type="button" class="icon-button copy-prefix" disabled aria-label="Full key unavailable" title="Created before full keys were kept — create a new key to copy it">${icon('copy',14)}</button>`}</td><td class="small muted">${displayDate(key.created_at)}</td><td><span class="pill ${key.revoked_at ? '' : 'good'}">${key.revoked_at ? 'Revoked' : 'Active'}</span></td><td>${canManageGames() ? `<button class="button danger table-action" data-action="delete-key" data-id="${key.id}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section><p class="help section-spacing">These keys identify your game builds. Never use your admin credentials in a game client.</p>`);
  bindPicker();
  document.querySelector('[data-action="new-key"]')?.addEventListener('click', () => {
    modal.innerHTML = `<h2 id="dialog-title">Create a collection key</h2><p>Give it a label so you can recognize the release or environment.</p><form id="key-form"><label for="key-label">Key label</label><input id="key-label" name="label" placeholder="e.g. Android production" required maxlength="128"><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button type="submit" class="button primary">Create key</button></div></form>`;
    modal.showModal();
    bindForm('#key-form', async (form, values) => {
      const key = await api(`${gameURL(game)}/keys`, {method:'POST', body:JSON.stringify(values)});
      showKey(key.api_key, 'Your new key is ready.', location.pathname + location.search);
    });
  });
  document.querySelectorAll('[data-action="delete-key"]').forEach(button => button.addEventListener('click', () => {
    modal.innerHTML = `<h2 id="dialog-title">Delete this key?</h2><p>Game builds using this key will no longer be able to send events. Existing collected data stays safe — events belong to the game, not the key. This can’t be undone.</p><div class="error" role="alert"></div><div class="modal-actions"><button class="button" data-action="close">Keep key</button><button class="button danger" id="confirm-revoke">Delete key</button></div>`;
    modal.showModal();
    document.querySelector('#confirm-revoke').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try { await api(`${gameURL(game)}/keys/${button.dataset.id}`, {method:'DELETE'}); modal.close(); await renderKeys(); toast('Key deleted.'); }
      catch (error) { modal.querySelector('.error').textContent = error.message; document.querySelector('#confirm-revoke').disabled = false; }
    });
  }));
}

function renderExports() {
  const game = selectedGame();
  shell('Exports', heading('Export data', 'Download the raw events as a portable package for your own analysis.') + `<div id="filters"></div><div class="form-layout"><form id="export-form" class="panel form-panel"><h2>Create an export</h2><p>Uses the days and filters above, up to 366 days. We’ll package the matching events and their definitions.</p><p id="export-count" class="export-count" aria-live="polite"></p><div class="field"><label for="basis">Select events by</label><select id="basis" name="basis"><option value="server_ts">Arrival time — when the server received them</option><option value="client_ts">Game time — when the client says they happened</option></select><p>All dates use UTC and both the first and last day are included. Game time can be affected by device clock settings.</p></div><div class="error" role="alert"></div><div class="form-actions"><button class="button primary" type="submit">${icon('export',15)} Download export</button></div></form><aside class="aside-card">${icon('file',25)}<h3>What’s in the ZIP</h3><div class="file-preview"><div>${icon('file',17)}<span>events.parquet<small>Typed columns, best for analysis tools</small></span></div><div>${icon('file',17)}<span>events.jsonl.gz<small>The same events as JSON lines</small></span></div><div>${icon('book',17)}<span>events.md<small>Event names and what they mean</small></span></div><div>${icon('settings',17)}<span>manifest.json<small>Time range, filters and export details</small></span></div><div>${icon('pulse',17)}<span>ANALYSIS.md<small>Guide for AI assistants (Claude, Codex…)</small></span></div></div><p class="small">Large exports are capped at 256 MiB before compression. Try a shorter range if you hit the limit.</p></aside></div>`);
  const exportForm = document.querySelector('#export-form');
  const exportCount = document.querySelector('#export-count');
  let chosen = null; let exportRequest = 0;
  const filterParams = () => { const query = filterQuery(chosen); query.delete('start'); query.delete('end'); return query; };
  const refreshCount = async () => {
    if (!chosen) return;
    const request = ++exportRequest; exportCount.textContent = 'Counting events…';
    try { const health = await fetchRange(game, chosen.range, exportForm.elements.basis.value, filterParams().toString()); if (request === exportRequest) exportCount.textContent = `${number(health.total)} event${health.total === 1 ? '' : 's'} will be exported`; }
    catch (error) { if (request === exportRequest) exportCount.textContent = error.message; }
  };
  mountFilters(document.querySelector('#filters'), game, state => { chosen = state; refreshCount(); });
  exportForm.elements.basis.addEventListener('change', refreshCount);
  bindForm('#export-form', async (form, values) => {
    const query = filterParams();
    query.set('period', 'custom'); query.set('date', chosen.range.from); query.set('end_date', chosen.range.to); query.set('basis', values.basis);
    const response = await fetch(`${gameURL(game)}/export?${query}`, {credentials:'same-origin'});
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(typeof error.detail === 'string' ? error.detail : 'Export failed. Please try again.'); }
    const download = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = download; anchor.download = `${game.bundle_id}-${chosen.range.from}_to_${chosen.range.to}.zip`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(download), 60000);
    toast('Your export is ready. Download started.');
  });
}

async function renderDictionary() {
  if (needsGame('Event dictionary', 'Give your events context, so the numbers mean something.')) return;
  const game = selectedGame();
  const [definitions, found] = await Promise.all([api(`${gameURL(game)}/dictionary`), api(`${gameURL(game)}/dictionary/discovery`)]);
  const drafts = new Map([...document.querySelectorAll('[data-draft]')].filter(field => field.value.trim()).map(field => [field.dataset.draft, field.value]));
  const ago = value => { const seconds = (Date.now() - Date.parse(value)) / 1000; return !(seconds >= 60) ? 'just now' : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : seconds < 86400 ? `${Math.round(seconds / 3600)} h ago` : `${Math.round(seconds / 86400)} d ago`; };
  const activity = name => { const seen = found.activity[name]; return !seen ? '<span class="pill bad">Never received</span>' : found.stale.includes(name) ? `<span class="pill bad">Not seen in ${found.stale_days} days</span>` : `<span class="pill">${number(seen.count)} events · last ${ago(seen.last_seen)}</span>`; };
  const foundCard = (item, index) => `<form class="discovery-card" id="found-${index}"><div class="discovery-head"><h3><code>${escapeHTML(item.name)}</code></h3><span class="pill ${item.defined ? '' : 'good'}">${item.defined ? 'New parameters' : 'New event'}</span><span class="pill">${number(item.count)} events · last ${ago(item.last_seen)}</span></div><div class="field"><label for="found-${index}-description">What does it mean?</label><textarea id="found-${index}-description" name="description" data-draft="${escapeHTML(item.name)}|description" placeholder="The player finished a level successfully." maxlength="4000" required>${escapeHTML(item.description)}</textarea></div>${item.params.length ? `<p class="eyebrow">${item.defined ? 'Parameters without a description' : 'Parameters'} (optional)</p><div class="discovery-params">${item.params.map(param => `<div class="discovery-param"><div><code>${escapeHTML(param.key)}</code><small class="${param.types.length > 1 ? 'warn-text' : ''}">${escapeHTML(param.types.join(' + '))} · e.g. ${escapeHTML(param.examples.join(', '))}</small></div><input name="param:${escapeHTML(param.key)}" data-draft="${escapeHTML(item.name)}|param:${escapeHTML(param.key)}" placeholder="What is it?" maxlength="2000" aria-label="Description of ${escapeHTML(param.key)}"></div>`).join('')}</div>` : ''}<div class="error" role="alert"></div><button class="button primary" type="submit">Save definition ${icon('check',14)}</button></form>`;
  const discovery = found.missing.length ? `<section class="panel section-spacing"><div class="panel-header"><h2>Needs a definition <span class="count">${found.missing.length}</span></h2>${icon('pulse',17)}</div><p class="discovery-intro">Found in the events your game has sent, including editor and development builds. Names and parameters are filled in for you — just say what they mean. Parameters you leave blank stay on this list.</p>${found.missing.map(foundCard).join('')}</section>` : found.events_seen ? `<section class="panel section-spacing"><div class="panel-body discovery-done">${icon('check',17)} Every event your game sends has a description.</div></section>` : '';
  shell('Event dictionary', heading('Give every event meaning.', 'A shared reference for you and the tools analyzing your data.') + picker(game) + discovery + `<div class="form-layout"><section class="panel"><div class="panel-header"><h2>Defined events <span class="count">${Object.keys(definitions).length}</span></h2>${icon('book',17)}</div>${Object.keys(definitions).length ? Object.entries(definitions).map(([name, definition]) => `<article class="dictionary-entry"><h3><code>${escapeHTML(name)}</code> ${activity(name)}</h3><p>${escapeHTML(definition.description)}</p><dl>${Object.entries(definition.params).map(([parameter, meaning]) => `<dt>${escapeHTML(parameter)}</dt><dd>${escapeHTML(meaning)}</dd>`).join('')}</dl><button class="button ghost" data-edit="${escapeHTML(name)}">Edit definition ${icon('arrow',12)}</button> <button class="button ghost danger-text" data-delete-definition="${escapeHTML(name)}">Delete</button></article>`).join('') : empty('Make your events understandable', 'Describe what each event means in your game. Definitions travel with every export.', '', 'book')}</section><form id="dictionary-form" class="panel form-panel"><h2>Add an event definition</h2><p>Use the exact name sent by your game.</p><div class="field"><label for="event-name">Event name</label><input id="event-name" name="name" placeholder="level_complete" pattern="[A-Za-z][A-Za-z0-9_]*" maxlength="80" required></div><div class="field"><label for="description">What does it mean?</label><textarea id="description" name="description" placeholder="The player finished a level successfully." maxlength="4000" required></textarea></div><div class="field"><label for="parameters">Parameters (optional)</label><textarea id="parameters" name="params" placeholder="level: One-based level number&#10;duration: Time spent, in seconds"></textarea><p>One parameter per line: name: description. Saving an existing event replaces its definition.</p></div><div class="error" role="alert"></div><button class="button primary" type="submit">Save definition ${icon('check',14)}</button></form></div>`);
  bindPicker();
  document.querySelectorAll('[data-draft]').forEach(field => { if (drafts.has(field.dataset.draft)) field.value = drafts.get(field.dataset.draft); });
  found.missing.forEach((item, index) => bindForm(`#found-${index}`, async (form, values) => {
    const params = Object.assign(Object.create(null), definitions[item.name]?.params);
    for (const [key, value] of Object.entries(values)) if (key.startsWith('param:') && value.trim()) params[key.slice(6)] = value.trim();
    await api(`${gameURL(game)}/dictionary/${encodeURIComponent(item.name)}`, {method:'PUT', body:JSON.stringify({description:values.description.trim(), params})});
    await renderDictionary(); toast(`${item.name} saved.`);
  }));
  document.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => {
    const definition = definitions[button.dataset.edit];
    document.querySelector('#event-name').value = button.dataset.edit;
    document.querySelector('#description').value = definition.description;
    document.querySelector('#parameters').value = Object.entries(definition.params).map(([name, meaning]) => `${name}: ${meaning}`).join('\n');
    document.querySelector('#event-name').focus();
  }));
  document.querySelectorAll('[data-delete-definition]').forEach(button => button.addEventListener('click', () => {
    const name = button.dataset.deleteDefinition;
    confirmDialog(`Delete the definition of ${name}?`, 'Only the description is removed. Collected events are not affected.', 'Delete definition', async () => {
      await api(`${gameURL(game)}/dictionary/${encodeURIComponent(name)}`, {method:'DELETE'});
      await renderDictionary(); toast('Definition deleted.');
    });
  }));
  bindForm('#dictionary-form', async (form, values) => {
    const params = Object.create(null);
    for (const line of values.params.split('\n').filter(line => line.trim())) {
      const separator = line.indexOf(':');
      if (separator <= 0 || !line.slice(separator + 1).trim()) throw new Error('Write each parameter as name: description.');
      params[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    await api(`${gameURL(game)}/dictionary/${encodeURIComponent(values.name)}`, {method:'PUT', body:JSON.stringify({description:values.description, params})});
    await renderDictionary(); toast('Event definition saved.');
  });
}

async function renderStatus() {
  const game = selectedGame();
  shell('Status', heading('Status', 'Recent event arrivals.', '<button class="button" data-action="refresh">'+icon('refresh',14)+' Refresh</button>') + `<div class="section-grid"><section class="panel"><div class="panel-header"><h2>At a glance</h2>${icon('server',17)}</div><div class="panel-body"><ul class="status-list"><li><span>Active game keys</span><strong>${overview.active_keys}</strong></li><li><span>Registered games</span><strong>${overview.games.length}</strong></li><li><span>Events collected</span><strong>${number(overview.events)}</strong></li></ul></div></section></div><section class="panel section-spacing"><div class="panel-header"><div><h2>Event arrivals</h2><p>Received by the server · choose any days · UTC</p></div></div><div class="panel-body">${game ? picker(game) : ''}${game ? '<div id="arrivals"></div>' : empty('No arrivals yet', 'Register a game and daily counts will appear here.', '', 'pulse')}</div></section>`);
  bindPicker();
  if (game) mountActivity(document.querySelector('#arrivals'), game);
}

function renderSettings() {
  const packs = [["ember", "#1e1a14", "#ff6b2b", "#00b4c8"], ["slate", "#161b22", "#4da3ff", "#00c8a0"], ["moss", "#141c14", "#8fc63c", "#d89a28"], ["plum", "#1c141e", "#e84a8a", "#d8a830"], ["reef", "#102321", "#ff7a59", "#5ad7b7"], ["berry", "#21151a", "#ff4d6d", "#39c6d6"], ["circuit", "#151b19", "#f2c94c", "#2dd4bf"], ["graphite", "#1b1b1b", "#f0623d", "#b4d455"]];
  shell('Settings', heading('Settings', 'Appearance and workspace details.') + `<div class="section-grid"><div><section class="panel"><div class="panel-header"><h2>Appearance</h2>${icon('settings',17)}</div><div class="panel-body"><p class="eyebrow">Theme</p><div class="seg-row range-modes" id="theme-modes">${['dark','light'].map(mode => `<button type="button" data-theme-mode="${mode}" aria-pressed="false">${mode}</button>`).join('')}</div><p class="eyebrow">Palette</p><div class="palette-grid" id="palette-grid">${packs.map(([id]) => `<button type="button" class="palette-btn" data-palette-id="${id}" aria-pressed="false"><span class="palette-swatch" data-swatch="${id}"><i></i><i></i><i></i></span>${id}</button>`).join('')}</div><p class="help section-spacing">Same themes as AVN Hub. Saved in this browser only.</p></div></section><section class="panel section-spacing"><div class="panel-header"><h2>Workspace</h2>${icon('server',17)}</div><div class="panel-body"><ul class="status-list"><li><span>Application</span><strong>AVN Analytics</strong></li><li><span>Export contents</span><strong>Parquet · JSONL.gz · dictionary · AI guide</strong></li><li><span>Collection address</span><code>${escapeHTML(overview.ingest_url)}</code></li></ul><p class="help section-spacing">Storage location and limits are set in the server's .env file.</p></div></section></div><aside class="aside-card">${icon('shield',25)}<h3>Protect this workspace</h3><p>This dashboard has no sign-in of its own. Put it behind your own access control, such as Cloudflare Access, a VPN or a private network, and never expose it directly.</p></aside></div>`);
  const sync = () => {
    document.querySelectorAll('[data-theme-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeMode === window.avnTheme.theme())));
    document.querySelectorAll('[data-palette-id]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.paletteId === 'berry' ? 'raspberry' : button.dataset.paletteId) === window.avnTheme.palette())));
    document.querySelector('[data-action="theme"]').innerHTML = icon(window.avnTheme.theme() === 'light' ? 'moon' : 'sun', 15);
  };
  document.querySelectorAll('[data-theme-mode]').forEach(button => button.addEventListener('click', () => { window.avnTheme.setTheme(button.dataset.themeMode); sync(); }));
  document.querySelectorAll('[data-palette-id]').forEach(button => button.addEventListener('click', () => { window.avnTheme.setPalette(button.dataset.paletteId === 'berry' ? 'raspberry' : button.dataset.paletteId); sync(); }));
  sync();
}

function bindForm(selector, submit) {
  document.querySelector(selector).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const original = button.innerHTML;
    form.querySelector('.error').textContent = '';
    button.disabled = true; button.textContent = 'Working…';
    try { await submit(form, Object.fromEntries(new FormData(form))); }
    catch (error) { form.querySelector('.error').textContent = error.message; }
    finally { if (button.textContent !== 'Game registered') { button.disabled = false; button.innerHTML = original; } }
  });
}

function showKey(key, title, next) {
  modal.innerHTML = `<h2 id="dialog-title">${escapeHTML(title)}</h2><p>Copy this collection key now. For your security, the full key won’t be shown again.</p><code class="key-display">${escapeHTML(key)}</code><p class="small">Keep this with your game’s connection settings. You can generate a replacement key at any time.</p><div class="modal-actions"><button class="button" id="copy-key">${icon('copy',14)} Copy key</button><a class="button primary" href="${escapeHTML(next)}">Done ${icon('check',14)}</a></div>`;
  if (!modal.open) modal.showModal();
  document.querySelector('#copy-key').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(key); toast('Key copied to clipboard.'); }
    catch { toast('Select the key above and copy it manually.'); }
  });
}

document.addEventListener('change', event => {
  if (event.target.id === 'ws-select') { chooseWorkspace(event.target.value); navigate('/'); }
});

document.addEventListener('click', async event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') { modal.close(); modal.innerHTML = ''; }
  if (action === 'refresh') {
    // Fetch everything again and redraw the current page in place, without reloading the site.
    cache.clear(); overviewStale = true;
    document.querySelectorAll('[data-action="refresh"]').forEach(button => button.classList.add('spinning'));
    await go(location.href, false);
    toast('Updated.');
  }
  if (action === 'copy-key') {
    const value = event.target.closest('[data-action]').dataset.key;
    try { await navigator.clipboard.writeText(value); toast('Full key copied.'); } catch { toast('Copy failed — your browser blocked clipboard access.'); }
  }
  if (action === 'theme') { window.avnTheme.setTheme(window.avnTheme.theme() === 'light' ? 'dark' : 'light'); const button = event.target.closest('[data-action="theme"]'); if (button) button.innerHTML = icon(window.avnTheme.theme() === 'light' ? 'moon' : 'sun', 15); }
});
modal.addEventListener('close', () => { modal.innerHTML = ''; });

const routes = {'/':renderHome, '/games':renderHome, '/games/new':renderNewGame, '/team':renderTeam, '/workspaces':renderWorkspaces, '/status':renderStatus, '/settings':renderSettings};
const sections = {overview:renderGameOverview, funnels:renderFunnels, players:renderPlayers, exports:renderExports, dictionary:renderDictionary, keys:renderKeys, settings:renderGameSettings};
const LEGACY = ['/keys', '/exports', '/dictionary', '/funnels', '/players']; // old ?game= pages
const gameRoute = pathname => pathname.match(/^\/games\/([^/]+)(?:\/([a-z]+))?\/?$/);

function renderNotFound() {
  shell('Not found', heading('Page not found', 'This page or game isn’t in your workspace.') + '<a class="button" href="/">Back to games</a>');
}

async function loadOverview() {
  // After a change, wait for fresh totals. Otherwise draw with what we have and refresh quietly for next time.
  if (!overview || overviewStale) { overview = await api(overviewURL()); overviewStale = false; return; }
  const hit = cache.get(overviewURL());
  if (!hit || Date.now() - hit.time >= CACHE_MS) api(overviewURL()).then(data => { overview = data; }, () => {});
}

// The data each page needs, so it can be fetched before the page is drawn (or on link hover).
function prefetch(url) {
  if (!overview) return Promise.resolve();
  const {pathname, searchParams} = new URL(url, location.href);
  const match = gameRoute(pathname);
  if (!match || match[1] === 'new') return Promise.resolve();
  const game = {id: decodeURIComponent(match[1])};
  const path = match[2] === 'keys' ? `${gameURL(game)}/keys` : match[2] === 'dictionary' ? `${gameURL(game)}/dictionary` : match[2] === 'settings' ? gameURL(game) : null;
  return path ? api(path).catch(() => {}) : Promise.resolve();
}

async function renderRoute() {
  try {
    if (!me.loaded) { me = {...await request('/v1/me'), loaded: true}; ensureWorkspace(); }
    await loadOverview();
    currentGame = null; currentSection = 'overview';
    let {pathname} = location;
    if (LEGACY.includes(pathname) && overview.games.length) {
      const query = new URLSearchParams(location.search);
      const game = overview.games.find(item => item.id === query.get('game')) || overview.games[0];
      query.delete('game');
      history.replaceState({}, '', `${gamePath(game, pathname.slice(1))}${query.size ? `?${query}` : ''}`);
      pathname = location.pathname;
    }
    const match = gameRoute(pathname);
    if (routes[pathname] || !match) return await (routes[pathname] || renderNotFound)();
    const wanted = decodeURIComponent(match[1]);
    currentGame = overview.games.find(item => item.id === wanted) || null;
    if (!currentGame && match[1] !== 'new') {  // maybe a game of another workspace the person belongs to
      const found = await request(`/v1/games/${encodeURIComponent(wanted)}`).catch(() => null);
      if (found?.workspace_id && found.workspace_id !== currentWorkspace && me.workspaces.some(item => item.id === found.workspace_id)) {
        chooseWorkspace(found.workspace_id); await loadOverview();
        currentGame = overview.games.find(item => item.id === wanted) || null;
      }
    }
    currentSection = match[2] || 'overview';
    if (!currentGame || !sections[currentSection]) { currentGame = null; return renderNotFound(); }
    await sections[currentSection]();
  } catch (error) {
    const denied = error.status === 401 || error.status === 403;
    root.innerHTML = `<main id="main"><div class="boot"><span class="brand-mark">avn.</span><h1>${denied ? 'You don’t have access yet.' : 'Couldn’t open your workspace.'}</h1><p class="muted">${escapeHTML(error.message)}</p><button class="button" data-action="refresh">Try again</button></div></main>`;
  }
  window.scrollTo(0, 0);
}

// Client-side navigation: highlight the link and show a progress bar at once, fetch the next page's data
// while the current page stays usable, then crossfade to it.
function transition(update) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return update();
  const view = document.startViewTransition(update);
  view.ready.catch(() => {}); view.finished.catch(() => {});
  return view.updateCallbackDone;
}
let navigation = 0;
async function go(url, push) {
  const current = ++navigation;
  if (modal.open) { modal.close(); modal.innerHTML = ''; }
  const target = new URL(url, location.href).pathname;
  document.querySelectorAll('.nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === target));
  const loading = setTimeout(() => document.documentElement.classList.add('is-loading'), 80);
  if (!overview || overviewStale) await loadOverview().catch(() => {});
  await prefetch(url);
  clearTimeout(loading);
  document.documentElement.classList.remove('is-loading');
  if (current !== navigation) return;
  if (push) history.pushState({}, '', url);
  return transition(renderRoute);
}
const navigate = url => go(url, true);

const internal = link => {
  if (!link || link.target || link.hasAttribute('download')) return null;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/assets/')) return null;
  if (!routes[url.pathname] && !LEGACY.includes(url.pathname) && !gameRoute(url.pathname)) return null;
  return url;
};
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = internal(event.target.closest('a[href]'));
  if (!url) return;
  event.preventDefault();
  if (url.href !== location.href) navigate(url.pathname + url.search); else go(location.href, false);
});
// Start fetching as soon as the pointer heads for a link; by the click the data is usually here.
for (const type of ['pointerover', 'focusin', 'touchstart']) {
  document.addEventListener(type, event => {
    const url = internal(event.target.closest?.('a[href]'));
    if (url && url.href !== location.href) prefetch(url.href);
  }, {passive: true});
}
window.addEventListener('popstate', () => go(location.href, false));
renderRoute();
