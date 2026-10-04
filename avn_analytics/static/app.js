const root = document.querySelector('#app');
const modal = document.querySelector('#dialog');
let overview;
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
  disk: '<path d="m5 4-3 12v4h20v-4L19 4Z"/><path d="M2 16h20m-5 2h.01"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
  file: '<path d="M14 2H4v20h16V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 4v3"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const number = value => new Intl.NumberFormat().format(value || 0);
const bytes = value => `${(value / 1073741824).toFixed(1)} GB`;
const today = () => new Date().toISOString().slice(0, 10);
const displayDate = value => value ? new Date(value).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}) : 'No events yet';
const gameURL = game => `/v1/games/${encodeURIComponent(game.id)}`;
const brand = `<a href="/" class="brand" aria-label="AVN Analytics home"><span class="brand-icon">a.</span><span><span class="brand-name">avn analytics</span><span class="brand-sub">PRIVATE WORKSPACE</span></span></a>`;

function diagram() {
  return `<div class="welcome-art" aria-hidden="true"><svg viewBox="0 0 340 230" fill="none"><circle cx="185" cy="115" r="82" stroke="#cfdbc0"/><circle cx="185" cy="115" r="57" stroke="#d8e2cc"/><path d="M52 70h48l48 44m-96 59h50l46-48m77-11h68" stroke="#9aac84" stroke-width="1.4" stroke-dasharray="4 5"/><rect x="26" y="43" width="59" height="54" rx="13" fill="#f8faf3" stroke="#c5d2b5"/><rect x="26" y="146" width="59" height="54" rx="13" fill="#f8faf3" stroke="#c5d2b5"/><rect x="139" y="75" width="87" height="81" rx="20" fill="#d3e6ac" stroke="#aabb8d"/><rect x="266" y="87" width="49" height="54" rx="12" fill="#fafcf5" stroke="#c5d2b5"/><path d="M169 99h28v12h-28Zm0 18h28v12h-28Z" stroke="#65804b" stroke-width="2"/><circle cx="175" cy="105" r="1.5" fill="#65804b"/><circle cx="175" cy="123" r="1.5" fill="#65804b"/><path d="M45 65h19l3 14-8-3h-9l-8 3 3-14Zm2 5h7m-3-3v6m9-2h.1M45 167h21v14H45Zm3 17h15m-11-3v3m6-3v3M279 101h15m-15 6h15m-15 6h9m-9 6h12" stroke="#7d9166" stroke-width="1.5" stroke-linecap="round"/><circle cx="241" cy="65" r="12" fill="#eef4e4" stroke="#bfceac"/><path d="m236 65 3 3 6-6" stroke="#7b9659" stroke-width="1.5"/><circle cx="116" cy="181" r="4" fill="#a7c47b"/><circle cx="288" cy="167" r="3" fill="#a7c47b"/></svg></div>`;
}

function toast(message) {
  document.querySelector('#notice').textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { document.querySelector('#notice').textContent = ''; }, 4500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {credentials:'same-origin', ...options,
    headers: {...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}});
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 401 && !path.startsWith('/auth/')) {
      location.assign('/login');
    }
    throw new Error(typeof error.detail === 'string' ? error.detail : 'Please check your details and try again.');
  }
  return response.status === 204 ? null : response.json();
}

function empty(title, description, action = '', type = 'game') {
  return `<div class="empty"><span class="empty-icon">${icon(type, 23)}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p>${action}</div>`;
}

function heading(title, subtitle, action = '') {
  return `<div class="page-heading"><div><h1>${escapeHTML(title)}</h1><p>${escapeHTML(subtitle)}</p></div>${action}</div>`;
}

const registerButton = `<a class="button primary" href="/games/new">${icon('plus', 15)} Register game</a>`;

function metric(title, value, footer, symbol) {
  return `<article class="metric"><div class="metric-top"><span>${title}</span>${icon(symbol,17)}</div><div class="metric-value">${value}</div><p class="metric-foot">${footer}</p></article>`;
}

function shell(title, content) {
  const primary = [['/','grid','Overview'],['/games','game','Games'],['/keys','key','API keys'],['/exports','export','Exports'],['/dictionary','book','Event dictionary']];
  const secondary = [['/status','pulse','Server status'],['/settings','settings','Settings']];
  const nav = links => links.map(([url, symbol, label]) => `<a href="${url}" aria-label="${label}" class="${location.pathname === url || (url === '/games' && location.pathname.startsWith('/games/')) ? 'active' : ''}" ${location.pathname === url ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></a>`).join('');
  root.innerHTML = `<aside class="sidebar">${brand}<p class="nav-label eyebrow">Workspace</p><nav class="nav" aria-label="Workspace">${nav(primary)}</nav><nav class="nav nav-secondary" aria-label="Server">${nav(secondary)}</nav><div class="sidebar-bottom"><a href="/status" class="server-chip"><span class="server-icon">${icon('server',17)}</span><div><strong>Your server</strong><p><span class="dot"></span>Local instance</p></div></a><div class="account"><span class="avatar">AV</span><div><strong>Administrator</strong><p>Personal workspace</p></div><button class="icon-button" data-action="logout" title="Sign out" aria-label="Sign out">${icon('logout',16)}</button></div></div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb">Workspace <span>/</span> <strong>${escapeHTML(title)}</strong></div><div class="topbar-right"><span class="local-badge"><span class="dot"></span>SELF-HOSTED</span><button class="icon-button" data-action="refresh" title="Refresh page" aria-label="Refresh page">${icon('refresh',15)}</button><button class="icon-button" data-action="logout" title="Sign out" aria-label="Sign out">${icon('logout',16)}</button></div></header><main id="main">${content}<footer class="footnote"><span>${icon('shield',13)} Private by design. Stored on your server.</span><span>AVN Analytics <span>·</span> Made for your next idea ${icon('arrow',12)}</span></footer></main></div>`;
  document.title = `${title} · AVN Analytics`;
}

function gameTable(games) {
  if (!games.length) return empty('Your first game starts here', 'Register a game to give its events a home.', '<a href="/games/new" class="button ghost">Register a game '+icon('arrow',14)+'</a>');
  return `<div class="table-wrap"><table><thead><tr><th>GAME</th><th>PLATFORM</th><th>EVENTS</th><th></th></tr></thead><tbody>${games.map(game => `<tr><td><a href="/games/${game.id}" class="row-title"><span class="game-avatar">${escapeHTML(game.name.slice(0,2).toUpperCase())}</span><span>${escapeHTML(game.name)}<p class="small muted">${escapeHTML(game.bundle_id)}</p></span></a></td><td><span class="pill">${escapeHTML(game.platform)}</span></td><td>${number(game.events)}</td><td><a href="/games/${game.id}" aria-label="Open ${escapeHTML(game.name)}">${icon('arrow',16)}</a></td></tr>`).join('')}</tbody></table></div>`;
}

function renderOverview() {
  const games = overview.games;
  shell('Overview', heading('Overview', 'A little clarity for everything you’re building.', registerButton) +
    `<section class="metrics" aria-label="Workspace totals">${metric('Registered games', number(games.length), games.length ? 'Your connected projects' : 'Ready for your first game', 'game')}${metric('Events collected', number(overview.events), 'Safely stored, never double-counted', 'pulse')}${metric('Events today', number(overview.today), 'Received today · UTC', 'export')}${metric('Available storage', bytes(overview.storage.free), 'On your server’s main SSD', 'disk')}</section>
    <section class="welcome"><div class="welcome-copy"><p class="eyebrow">Built for curious creators</p><h2>Your games tell a story.<br>Keep every chapter.</h2><p>Collect the moments that matter. Export your data.<br>Discover what to build next.</p><a class="button lime" href="${games.length ? '/exports' : '/games/new'}">${games.length ? 'Explore your exports' : 'Connect your first game'} ${icon('arrow',14)}</a></div>${diagram()}</section>
    <div class="section-grid"><section class="panel"><div class="panel-header"><h2>Your games <span class="count">${games.length}</span></h2><a href="/games" class="text-link">View all ${icon('arrow',13)}</a></div>${gameTable(games.slice(0,4))}</section><section class="panel"><div class="panel-header"><div><h2>A simple start</h2><p>From your first event to your next idea.</p></div>${icon('pulse',17)}</div><ol class="steps"><li><span class="step-number ${games.length ? 'done' : ''}">${games.length ? icon('check',12) : '01'}</span><div><strong>Register your game</strong><p>A name, a platform, and a place for your events.</p></div></li><li><span class="step-number ${overview.events ? 'done' : ''}">${overview.events ? icon('check',12) : '02'}</span><div><strong>Send your first event</strong><p>Use your game’s API key to start collecting.</p></div></li><li><span class="step-number">03</span><div><strong>Turn data into direction</strong><p>Download an export and explore it with your AI tools.</p></div></li></ol></section></div>`);
}

function renderGames() {
  shell('Games', heading('Your games', 'Each game gets its own keys, events, and space to grow.', registerButton) + `<div class="toolbar"><div class="search">${icon('search',16)}<input id="game-search" type="search" aria-label="Search games" placeholder="Search your games…"></div><span class="filter-note">${overview.games.length} registered ${overview.games.length === 1 ? 'game' : 'games'}</span></div><div id="game-results"></div>`);
  const renderCards = query => {
    const games = overview.games.filter(game => `${game.name} ${game.bundle_id}`.toLowerCase().includes(query.toLowerCase()));
    document.querySelector('#game-results').innerHTML = games.length ? `<div class="game-grid">${games.map(game => `<a class="game-card" href="/games/${game.id}"><div class="game-card-header"><span class="game-avatar">${escapeHTML(game.name.slice(0,2).toUpperCase())}</span><span class="pill">${escapeHTML(game.platform)}</span></div><h3>${escapeHTML(game.name)}</h3><p class="mono">${escapeHTML(game.bundle_id)}</p><div class="game-card-footer"><span>${number(game.events)} events</span><span>${game.last_event ? 'Receiving data' : 'Awaiting events'} ${icon('arrow',12)}</span></div></a>`).join('')}</div>` : `<section class="panel">${empty(query ? 'No games found' : 'Good things begin with a first game', query ? 'Try another name or bundle ID.' : 'Create a game and we’ll generate its first API key.', query ? '' : registerButton)}</section>`;
  };
  renderCards('');
  document.querySelector('#game-search').addEventListener('input', event => renderCards(event.target.value));
}

function renderNewGame() {
  shell('Register game', `<a class="back-link" href="/games">← Back to games</a>` + heading('Make room for your next game.', 'A few details, and you’re ready to start collecting.') + `<div class="form-layout"><form id="register-form" class="panel form-panel"><h2>Game details</h2><p>Give your project a recognizable name.</p><div class="field"><label for="game-name">Game name</label><input id="game-name" name="name" placeholder="e.g. Tiny Adventures" required maxlength="128" autofocus></div><div class="field"><label for="bundle-id">Bundle ID</label><input id="bundle-id" name="bundle_id" placeholder="com.yourstudio.yourgame" pattern="[A-Za-z0-9_\\-]+(\\.[A-Za-z0-9_\\-]+)+" required maxlength="255"><p>The application identifier from your game’s project settings.</p></div><div class="field"><label for="platform">Platform</label><select id="platform" name="platform"><option value="android">Android</option><option value="ios">iOS</option><option value="windows">Windows</option><option value="macos">macOS</option><option value="linux">Linux</option><option value="web">Web</option></select><p>Register each platform separately to keep its events isolated.</p></div><div class="error" role="alert"></div><div class="form-actions"><a href="/games" class="button">Cancel</a><button class="button primary" type="submit">Register game ${icon('arrow',14)}</button></div></form><aside class="aside-card">${icon('game',25)}<h3>A space of its own</h3><p>Every game gets a separate event database and its own collection keys.</p><ul><li>Duplicates are handled automatically</li><li>Keys can be rotated at any time</li><li>Your raw data stays on your server</li></ul><p class="small">After registration, copy your new API key. It’s shown only once.</p></aside></div>`);
  bindForm('#register-form', async (form, values) => {
    const game = await api('/v1/games', {method:'POST', body:JSON.stringify(values)});
    showKey(game.key.api_key, 'Your game is ready.', `/games/${game.id}`);
    form.querySelector('button[type="submit"]').disabled = true;
    form.querySelector('button[type="submit"]').textContent = 'Game registered';
  });
}

function selectedGame() {
  const identifier = new URLSearchParams(location.search).get('game');
  return overview.games.find(game => game.id === identifier) || overview.games[0];
}

function picker(game) {
  return `<div class="toolbar"><div class="game-select"><label for="selected-game">Game</label><select id="selected-game">${overview.games.map(item => `<option value="${item.id}" ${item.id === game.id ? 'selected' : ''}>${escapeHTML(item.name)} · ${escapeHTML(item.platform)}</option>`).join('')}</select></div></div>`;
}

function bindPicker() {
  document.querySelector('#selected-game')?.addEventListener('change', event => {
    location.assign(`${location.pathname}?game=${encodeURIComponent(event.target.value)}`);
  });
}

function needsGame(title, description) {
  if (overview.games.length) return false;
  shell(title, heading(title, description) + `<section class="panel">${empty('First, give your events a home', 'Register a game to use this part of your workspace.', registerButton)}</section>`);
  return true;
}

function renderGame() {
  const game = overview.games.find(item => item.id === location.pathname.split('/')[2]);
  if (!game) { shell('Game not found', heading('Game not found', 'This game is not in your workspace.') + '<a class="button" href="/games">Back to games</a>'); return; }
  shell(game.name, '<a class="back-link" href="/games">← Back to games</a>' + heading(game.name, `${game.bundle_id} · ${game.platform}`, `<a class="button primary" href="/exports?game=${game.id}">${icon('export',15)} Export data</a>`) + `<section class="metrics">${metric('Events collected',number(game.events),'All committed events','pulse')}${metric('Events today',number(game.today),'Received today · UTC','export')}${metric('Platform',escapeHTML(game.platform),'Registered platform','game')}${metric('Collection',game.last_event ? 'Active' : 'Ready',game.last_event ? 'Events have arrived' : 'Waiting for your first event','server')}</section><div class="section-grid"><section class="panel"><div class="panel-header"><h2>Game information</h2></div><div class="panel-body"><ul class="status-list"><li><span>Game ID</span><code>${game.id}</code></li><li><span>Registered</span><strong>${displayDate(game.created_at)}</strong></li><li><span>Latest event</span><strong>${displayDate(game.last_event)}</strong></li></ul><div class="section-spacing"><a class="button" href="/keys?game=${game.id}">${icon('key',15)} Manage keys</a> <a class="button" href="/dictionary?game=${game.id}">${icon('book',15)} Event dictionary</a></div></div></section><aside class="aside-card">${icon('pulse',25)}<h3>Connect your game</h3><p>Send batches to the collection endpoint with your game’s API key in the <code>X-API-Key</code> header.</p><div class="connection"><code>POST http://127.0.0.1:8100/v1/events</code></div><p class="small section-spacing">This address works on the server. A public address will be available after your Cloudflare Tunnel is connected.</p></aside></div>`);
}

async function renderKeys() {
  if (needsGame('API keys', 'Control how your games connect.')) return;
  const game = selectedGame();
  const keys = await api(`${gameURL(game)}/keys`);
  shell('API keys', heading('API keys', 'A connection for every release. Rotate keys when you need to.', '<button class="button primary" data-action="new-key">'+icon('plus',15)+' Create key</button>') + picker(game) + `<section class="panel"><div class="panel-header"><h2>Collection keys <span class="count">${keys.length}</span></h2><span class="small muted">Full keys are shown only at creation</span></div><div class="table-wrap"><table><thead><tr><th>LABEL</th><th>KEY PREFIX</th><th>CREATED</th><th>STATUS</th><th></th></tr></thead><tbody>${keys.map(key => `<tr><td>${escapeHTML(key.label)}</td><td><code>${escapeHTML(key.prefix)}…</code></td><td class="small muted">${displayDate(key.created_at)}</td><td><span class="pill ${key.revoked_at ? '' : 'good'}">${key.revoked_at ? 'Revoked' : 'Active'}</span></td><td>${key.revoked_at ? '' : `<button class="button danger table-action" data-action="revoke" data-id="${key.id}">Revoke</button>`}</td></tr>`).join('')}</tbody></table></div></section><p class="help section-spacing">These keys identify your game builds. Never use your admin credentials in a game client.</p>`);
  bindPicker();
  document.querySelector('[data-action="new-key"]').addEventListener('click', () => {
    modal.innerHTML = `<h2 id="dialog-title">Create a collection key</h2><p>Give it a label so you can recognize the release or environment.</p><form id="key-form"><label for="key-label">Key label</label><input id="key-label" name="label" placeholder="e.g. Android production" required maxlength="128"><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button type="submit" class="button primary">Create key</button></div></form>`;
    modal.showModal();
    bindForm('#key-form', async (form, values) => {
      const key = await api(`${gameURL(game)}/keys`, {method:'POST', body:JSON.stringify(values)});
      showKey(key.api_key, 'Your new key is ready.', location.href);
    });
  });
  document.querySelectorAll('[data-action="revoke"]').forEach(button => button.addEventListener('click', () => {
    modal.innerHTML = `<h2 id="dialog-title">Revoke this key?</h2><p>Game builds using this key will no longer be able to send events. Existing collected data stays safe.</p><div class="error" role="alert"></div><div class="modal-actions"><button class="button" data-action="close">Keep key</button><button class="button danger" id="confirm-revoke">Revoke key</button></div>`;
    modal.showModal();
    document.querySelector('#confirm-revoke').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try { await api(`${gameURL(game)}/keys/${button.dataset.id}`, {method:'DELETE'}); location.reload(); }
      catch (error) { modal.querySelector('.error').textContent = error.message; document.querySelector('#confirm-revoke').disabled = false; }
    });
  }));
}

function renderExports() {
  if (needsGame('Exports', 'Your raw data, ready for a closer look.')) return;
  const game = selectedGame();
  shell('Exports', heading('Take your data further.', 'Create a portable snapshot for your next analysis.') + picker(game) + `<div class="form-layout"><form id="export-form" class="panel form-panel"><h2>Create an export</h2><p>Choose a time period. We’ll package your events and their definitions.</p><div class="field-row"><div class="field"><label for="period">Period</label><select id="period" name="period"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></div><div class="field"><label for="export-date">Date in period</label><input id="export-date" name="date" type="date" value="${today()}" min="1970-01-01" max="9998-12-31" required></div></div><div class="field"><label for="basis">Select events by</label><select id="basis" name="basis"><option value="server_ts">Arrival time — when the server received them</option><option value="client_ts">Game time — when the client says they happened</option></select><p>All periods use UTC. Weeks begin Monday; months follow the calendar. Game time can be affected by device clock settings.</p></div><div class="error" role="alert"></div><div class="form-actions"><button class="button primary" type="submit">${icon('export',15)} Download export</button></div></form><aside class="aside-card">${icon('file',25)}<h3>A small package. The whole story.</h3><p>Your ZIP contains everything an analysis tool needs to get started.</p><div class="file-preview"><div>${icon('file',17)}<span>events.jsonl.gz<small>Your raw, compressed events</small></span></div><div>${icon('book',17)}<span>events.md<small>Event names and what they mean</small></span></div><div>${icon('settings',17)}<span>manifest.json<small>Time range and export details</small></span></div></div><p class="small">Large exports are capped at 256 MiB before compression. Try a shorter period if you hit the limit.</p></aside></div>`);
  bindPicker();
  bindForm('#export-form', async (form, values) => {
    const response = await fetch(`${gameURL(game)}/export?${new URLSearchParams(values)}`, {credentials:'same-origin'});
    if (!response.ok) { const error = await response.json(); throw new Error(error.detail || 'Export failed. Please try again.'); }
    const download = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = download; anchor.download = `${game.bundle_id}-${values.period}-${values.date}.zip`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(download), 60000);
    toast('Your export is ready. Download started.');
  });
}

async function renderDictionary() {
  if (needsGame('Event dictionary', 'Give your events context, so the numbers mean something.')) return;
  const game = selectedGame();
  const definitions = await api(`${gameURL(game)}/dictionary`);
  shell('Event dictionary', heading('Give every event meaning.', 'A shared reference for you and the tools analyzing your data.') + picker(game) + `<div class="form-layout"><section class="panel"><div class="panel-header"><h2>Defined events <span class="count">${Object.keys(definitions).length}</span></h2>${icon('book',17)}</div>${Object.keys(definitions).length ? Object.entries(definitions).map(([name, definition]) => `<article class="dictionary-entry"><h3><code>${escapeHTML(name)}</code></h3><p>${escapeHTML(definition.description)}</p><dl>${Object.entries(definition.params).map(([parameter, meaning]) => `<dt>${escapeHTML(parameter)}</dt><dd>${escapeHTML(meaning)}</dd>`).join('')}</dl><button class="button ghost" data-edit="${escapeHTML(name)}">Edit definition ${icon('arrow',12)}</button></article>`).join('') : empty('Make your events understandable', 'Describe what each event means in your game. Definitions travel with every export.', '', 'book')}</section><form id="dictionary-form" class="panel form-panel"><h2>Add an event definition</h2><p>Use the exact name sent by your game.</p><div class="field"><label for="event-name">Event name</label><input id="event-name" name="name" placeholder="level_complete" pattern="[A-Za-z][A-Za-z0-9_]*" maxlength="80" required></div><div class="field"><label for="description">What does it mean?</label><textarea id="description" name="description" placeholder="The player finished a level successfully." maxlength="4000" required></textarea></div><div class="field"><label for="parameters">Parameters (optional)</label><textarea id="parameters" name="params" placeholder="level: One-based level number&#10;duration: Time spent, in seconds"></textarea><p>One parameter per line: name: description. Saving an existing event replaces its definition.</p></div><div class="error" role="alert"></div><button class="button primary" type="submit">Save definition ${icon('check',14)}</button></form></div>`);
  bindPicker();
  document.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => {
    const definition = definitions[button.dataset.edit];
    document.querySelector('#event-name').value = button.dataset.edit;
    document.querySelector('#description').value = definition.description;
    document.querySelector('#parameters').value = Object.entries(definition.params).map(([name, meaning]) => `${name}: ${meaning}`).join('\n');
    document.querySelector('#event-name').focus();
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
  const health = game ? await api(`${gameURL(game)}/health?period=week&date=${today()}`) : null;
  shell('Server status', heading('A quiet check-in.', 'Make sure your events have a healthy place to land.', '<button class="button" data-action="refresh">'+icon('refresh',14)+' Refresh</button>') + `<div class="status-banner">${icon(overview.healthy ? 'check' : 'disk',25)}<div><h2>${overview.healthy ? 'Your server is ready to collect.' : 'Storage needs attention.'}</h2><p>${overview.healthy ? 'The database is responding and storage is above its safety reserve.' : 'Free up space before collecting more events.'}</p></div></div><div class="section-grid"><section class="panel"><div class="panel-header"><h2>Storage on your main SSD</h2>${icon('disk',17)}</div><div class="panel-body"><p class="eyebrow">Available space</p><p class="storage-number">${bytes(overview.storage.free)}</p><p class="small muted">of ${bytes(overview.storage.total)} total disk capacity</p><progress class="progress" max="${overview.storage.total}" value="${overview.storage.used}" aria-label="Disk space used"></progress><div class="storage-numbers"><span>${bytes(overview.storage.used)} used across the disk</span><span>${bytes(overview.storage.reserve)} reserve</span></div><p class="help section-spacing">Collection pauses below the reserve, giving game clients time to retry. Your data directory can move to a different drive later.</p></div></section><section class="panel"><div class="panel-header"><h2>At a glance</h2>${icon('server',17)}</div><div class="panel-body"><ul class="status-list"><li><span>Admin connection</span><span class="pill good">Connected</span></li><li><span>Active game keys</span><strong>${overview.active_keys}</strong></li><li><span>Registered games</span><strong>${overview.games.length}</strong></li><li><span>Access</span><strong>Local server only</strong></li><li><span>Automatic retention</span><strong>Keep all events</strong></li></ul></div></section></div><section class="panel section-spacing"><div class="panel-header"><div><h2>Event arrivals this week</h2><p>Received by the server · Monday to Sunday · UTC</p></div></div><div class="panel-body">${game ? picker(game) : ''}${health?.days.length ? `<div class="table-wrap"><table><thead><tr><th>DAY</th><th>EVENTS RECEIVED</th></tr></thead><tbody>${health.days.map(day => `<tr><td>${day.day}</td><td>${number(day.events)}</td></tr>`).join('')}</tbody></table></div>` : empty('No arrivals yet', 'When your game starts sending events, daily counts will appear here.', '', 'pulse')}</div></section>`);
  bindPicker();
}

function renderSettings() {
  shell('Settings', heading('Your own little corner of the cloud.', 'A private workspace, running on your own server.') + `<div class="section-grid"><section class="panel"><div class="panel-header"><h2>Workspace</h2>${icon('settings',17)}</div><div class="panel-body"><ul class="status-list"><li><span>Application</span><strong>AVN Analytics</strong></li><li><span>Deployment</span><strong>Self-hosted</strong></li><li><span>Storage</span><strong>Local disk</strong></li><li><span>Event retention</span><strong>Indefinite</strong></li><li><span>Export format</span><strong>JSONL.gz + dictionary</strong></li><li><span>Session duration</span><strong>8 hours</strong></li></ul><p class="help section-spacing">This page describes the current server configuration. Retention changes and drive migrations are server maintenance tasks.</p></div></section><aside class="aside-card">${icon('shield',25)}<h3>Private for now. Ready for later.</h3><p>This management website is available on the server. Internet collection will use a separate endpoint once your domain and Cloudflare Tunnel are ready.</p><p>Your admin password and game keys have separate jobs. Keep the admin password to yourself.</p><button class="button" data-action="logout">${icon('logout',14)} Sign out</button></aside></div>`);
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

function renderAuth(configured) {
  document.title = configured ? 'Sign in · AVN Analytics' : 'Welcome · AVN Analytics';
  root.innerHTML = `<main id="main" class="auth-page"><section class="auth-story"><div>${brand}</div><div><p class="eyebrow">A home for your game data</p><h1>Your data.<br>Your server.<br>Your next idea.</h1><p>Keep the moments that matter, understand your players, and build something better.</p>${diagram()}</div><p class="auth-footer">Self-hosted on your own server. Made for the things you create.</p></section><section class="auth-form-side"><div class="auth-form-wrap"><span class="auth-emblem">${icon(configured ? 'lock' : 'shield',24)}</span><h2>${configured ? 'Welcome back.' : 'Make yourself at home.'}</h2><p>${configured ? 'Sign in to your private analytics workspace.' : 'Create an admin password to open your workspace. This is a one-time setup on your server.'}</p><form id="auth-form"><div class="field"><label for="password">${configured ? 'Admin password' : 'Choose an admin password'}</label><input id="password" name="password" type="password" minlength="12" maxlength="128" autocomplete="${configured ? 'current-password' : 'new-password'}" placeholder="${configured ? 'Enter your password' : 'At least 12 characters'}" required autofocus></div>${configured ? '' : '<div class="field"><label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="One more time" required></div>'}<div class="error" role="alert"></div><button class="button primary" type="submit">${configured ? 'Sign in' : 'Create your workspace'} ${icon('arrow',15)}</button></form><p class="help">${icon('lock',11)} Your data stays on this server.<br>No external account. No subscriptions.</p></div></section></main>`;
  bindForm('#auth-form', async (form, values) => {
    if (!configured && values.password !== values.confirm) throw new Error('The passwords don’t match. Please try again.');
    await api(configured ? '/auth/login' : '/auth/setup', {method:'POST', body:JSON.stringify({password:values.password})});
    location.assign('/');
  });
}

document.addEventListener('click', async event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') { modal.close(); modal.innerHTML = ''; }
  if (action === 'refresh') location.reload();
  if (action === 'logout') {
    try { await api('/auth/logout', {method:'POST'}); location.assign('/login'); }
    catch (error) { toast(error.message); }
  }
});
modal.addEventListener('close', () => { modal.innerHTML = ''; });

async function boot() {
  try {
    const status = await api('/auth/status');
    if (!status.authenticated) { renderAuth(status.configured); return; }
    overview = await api('/v1/overview');
    const pages = {'/':renderOverview, '/login':renderOverview, '/games':renderGames, '/games/new':renderNewGame, '/keys':renderKeys, '/exports':renderExports, '/dictionary':renderDictionary, '/status':renderStatus, '/settings':renderSettings};
    await (pages[location.pathname] || renderGame)();
  } catch (error) {
    root.innerHTML = `<main id="main"><div class="boot"><span class="brand-mark">avn.</span><h1>Couldn’t open your workspace.</h1><p class="muted">${escapeHTML(error.message)}</p><button class="button" data-action="refresh">Try again</button></div></main>`;
  }
}
boot();
