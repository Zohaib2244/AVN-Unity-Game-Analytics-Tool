// Game dashboards: overview, funnels and player journeys, computed live on the server from the game's
// events (game time, shown in local time by default). Loaded before app.js; uses its helpers (api, shell, heading, metric,
// rangeMarkup, bindRange…) at call time.

const MAX_STEPS = 100;
const TEST_ENVIRONMENTS = ['editor', 'development', 'test', 'debug'];
const DIMENSION_LABELS = {environment: 'Environment', app_version: 'App version', build: 'Build', country: 'Country', platform: 'Device platform'};
const FILTER_KEYS = {environment: 'env', app_version: 'version', build: 'build', country: 'country', platform: 'platform'};
const OPERATORS = [['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['exists', 'any value']];

/* ─── Countries: show names, not two-letter codes ─── */

const COUNTRY_SPECIAL = {XX: 'Unknown country', T1: 'Tor network', unknown: 'Unknown country'};
const COUNTRY_NAMES = (() => { try { return new Intl.DisplayNames(['en'], {type: 'region'}); } catch { return null; } })();
function countryName(code) {
  if (!code) return '';
  if (COUNTRY_SPECIAL[code]) return COUNTRY_SPECIAL[code];
  try { return COUNTRY_NAMES?.of(String(code).toUpperCase()) || code; } catch { return code; }
}
// "Romania (RO)" for menus and tables where there is room; a hover tag where there isn't.
const countryText = code => code && countryName(code) !== code ? `${countryName(code)} (${code})` : (code || '—');
const countryTag = code => code ? `<abbr class="cc" title="${escapeHTML(countryName(code))}">${escapeHTML(code)}</abbr>` : '—';
// Display text for a value of a filter dimension (only countries need translating).
const dimensionText = (dimension, value) => dimension === 'country' ? countryText(value) : value;

function duration(seconds) {
  if (seconds == null) return '—';
  const value = Math.round(seconds);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, '0')}s`;
  if (value < 86400) return `${Math.floor(value / 3600)}h ${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}m`;
  return `${Math.floor(value / 86400)}d ${Math.floor(value % 86400 / 3600)}h`;
}
const timeZoneOptions = timezone => timezone === 'utc' ? {timeZone: 'UTC'} : {};
const clock = (value, timezone = 'local') => new Date(value).toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23', ...timeZoneOptions(timezone)});
const analysisDate = (value, timezone = 'local') => value ? new Date(value).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short', ...timeZoneOptions(timezone)}) : 'No events yet';
const percent = value => `${Number(value).toLocaleString(undefined, {maximumFractionDigits: 1})}%`;
const operatorLabel = op => OPERATORS.find(([key]) => key === op)?.[1] || '=';
const stepLabel = step => step.label ? escapeHTML(step.label) : `${escapeHTML(step.event)}${step.param ? ` · ${escapeHTML(step.param)}${step.op === 'exists' || (step.value ?? '') === '' ? '' : ` ${operatorLabel(step.op)} ${escapeHTML(step.value)}`}` : ''}`;
// Quick highlights for the things studied most: [key, label, event-name pattern, fallback keyword, color].
const HIGHLIGHT_PRESETS = [['levels', 'Levels', /^level/i, 'level', 'cyan'], ['screens', 'Screens', /^screen/i, 'screen', 'violet'], ['ads', 'Ads', /^ads?(_|$)/i, 'ad_', 'gold']];
// Long decimals (6.9673786) read as 2 decimals; the exact value stays in the tooltip. Strings, IDs and integers are untouched.
const chipValue = value => typeof value === 'number' && !Number.isInteger(value) ? String(Number(value.toFixed(2))) : typeof value === 'object' ? JSON.stringify(value) : value;
const sessionStartSummary = params => {
  const pick = key => params[Object.keys(params).find(name => name.toLowerCase() === key)];
  const system = String(pick('os_version') ?? '').split(' / ')[0].split(' (')[0];
  return [pick('session_number') != null ? `Session ${pick('session_number')}` : '', pick('device_model'), system, pick('environment')].filter(Boolean).join(' · ') || 'Session details';
};
const paramChips = params => Object.entries(params).map(([key, value]) => `<span class="chip"><b>${escapeHTML(key)}</b> ${escapeHTML(typeof value === 'object' ? JSON.stringify(value) : value)}</span>`).join('');
const shortId = id => id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
const setWidths = container => container.querySelectorAll('[data-width]').forEach(bar => { bar.style.width = `${bar.dataset.width}%`; }); // CSP: no inline style attributes
function storeGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function storeSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }
const disclosureBindings = new WeakMap();
function mountDisclosures(container, storageKey) {
  disclosureBindings.get(container)?.abort();
  const controller = new AbortController();
  disclosureBindings.set(container, controller);
  const remember = () => {
    const saved = storeGet(storageKey) || {};
    container.querySelectorAll('details[data-disclosure]').forEach(section => {saved[section.dataset.disclosure] = section.open;});
    storeSet(storageKey, saved);
  };
  const refresh = () => {
    const saved = storeGet(storageKey) || {};
    container.querySelectorAll('details[data-disclosure]').forEach(section => {
      if (Object.hasOwn(saved, section.dataset.disclosure)) section.open = saved[section.dataset.disclosure];
    });
  };
  container.addEventListener('toggle', event => {
    const section = event.target;
    if (!section.matches('details[data-disclosure]')) return;
    const saved = storeGet(storageKey) || {};
    if (saved[section.dataset.disclosure] !== section.open) storeSet(storageKey, {...saved, [section.dataset.disclosure]: section.open});
  }, {capture: true, signal: controller.signal});
  refresh();
  return {remember, refresh};
}
function downloadCSV(name, rows) {
  const csv = rows.map(row => row.map(cell => /[",\n]/.test(String(cell ?? '')) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell ?? '')).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
  const anchor = Object.assign(document.createElement('a'), {href: url, download: name});
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ─── Collapsible panels (state remembered per game) ─── */

// Adds a chevron to the panel's header that folds the panel down to just that header, with a one-line
// note beside it while folded. Returns {setNote, set}.
function collapsible(section, game, name) {
  const header = section.querySelector(':scope > .panel-header');
  if (!header) return {setNote() {}, set() {}};
  const key = `avn-collapsed-${game.id}`;
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'icon-button collapse-toggle';
  toggle.innerHTML = icon('chevron', 16);
  const note = document.createElement('span'); note.className = 'collapse-note muted';
  header.prepend(toggle); header.append(note);
  const set = (collapsed, remember = true) => {
    section.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = toggle.ariaLabel = collapsed ? 'Expand' : 'Collapse';
    if (remember) storeSet(key, {...(storeGet(key) || {}), [name]: collapsed});
  };
  toggle.addEventListener('click', () => set(!section.classList.contains('collapsed')));
  set(Boolean((storeGet(key) || {})[name]), false);
  return {setNote: text => { note.textContent = text || ''; }, set, section};
}

/* ─── Filters: days + environment, version, build, country, platform. Remembered per game. ─── */

function filterState(game) {
  const saved = storeGet(`avn-filters-${game.id}`) || {};
  return {range: saved.range || null, timezone: saved.timezone === 'utc' ? 'utc' : 'local', hideTest: saved.hideTest ?? true, environment: saved.environment || [], app_version: saved.app_version || [], build: saved.build || [], country: saved.country || [], platform: saved.platform || [],
    // Dashboards open on the newest published build by default; 'custom' (picked builds) and 'all' are remembered.
    versionMode: ['latest', 'custom', 'all'].includes(saved.versionMode) ? saved.versionMode : saved.app_version?.length ? 'custom' : 'latest'};
}
function saveFilters(game, state) { storeSet(`avn-filters-${game.id}`, state); }
const timezoneOffset = state => state.timezone === 'utc' ? 0 : localTimezoneOffset();
function filterQuery(state) {
  const query = new URLSearchParams({start: state.range.from, end: state.range.to, tz_offset: timezoneOffset(state)});
  if (state.hideTest && !state.environment.length) TEST_ENVIRONMENTS.forEach(value => query.append('not_env', value));
  for (const [dimension, key] of Object.entries(FILTER_KEYS)) state[dimension].forEach(value => query.append(key, value));
  return query;
}
function filterBody(state) {
  return {start: state.range.from, end: state.range.to, timezone_offset_minutes: timezoneOffset(state), filters: {
    environments: state.environment, exclude_environments: state.hideTest && !state.environment.length ? TEST_ENVIRONMENTS : [],
    app_versions: state.app_version, builds: state.build, countries: state.country, platforms: state.platform}};
}
const activeFilters = state => Object.keys(FILTER_KEYS).reduce((sum, dimension) => sum + state[dimension].length, 0);

// The filter bar at the top of every game dashboard: days, one "Filters" menu, and chips for what's
// active. onChange(state) runs now and after each change.
function mountFilters(container, game, onChange) {
  const state = filterState(game);
  let facets = {};
  container.innerHTML = `<div class="filter-bar"><div id="filter-range"></div><div class="segmented timezone-toggle" role="group" aria-label="Time zone"><button type="button" data-timezone="local">Local</button><button type="button" data-timezone="utc">UTC</button></div><div class="segmented density-toggle" role="group" aria-label="Row density"><button type="button" data-density="roomy">Roomy</button><button type="button" data-density="compact">Compact</button></div><button type="button" class="btn filters-open" data-filters-open aria-haspopup="dialog" aria-expanded="false">${icon('funnel',14)} Filters <span class="count" id="filter-count" hidden></span></button></div><div class="filter-chips" id="filter-chips"></div><div class="analysis-context" aria-live="polite"></div>`;
  // The multi-select list: the common default on top, then one group per category, checkbox left and player count right.
  const filterPopHTML = () => `<div data-filter-pop><div class="pop-scroll"><label class="opt"><input type="checkbox" class="cb-in" id="hide-test" ${state.hideTest ? 'checked' : ''} ${state.environment.length ? 'disabled' : ''}><span class="ot">Hide editor &amp; development data</span></label>${Object.keys(FILTER_KEYS).map(dimension => {
    const values = [...new Set([...(facets[dimension] || []).map(item => item.value), ...state[dimension]])];
    const counts = Object.fromEntries((facets[dimension] || []).map(item => [item.value, item.players]));
    const latestRow = dimension === 'app_version' ? `<label class="opt"><input type="checkbox" class="cb-in" id="latest-build" ${state.versionMode === 'latest' ? 'checked' : ''} ${facets.latest_app_version ? '' : 'disabled'}><span class="ot">Latest published build</span><span class="oc">${escapeHTML(facets.latest_app_version || '—')}</span></label>` : '';
    return `<div class="pop-grp"><span class="eyebrow">${DIMENSION_LABELS[dimension]}</span></div>${latestRow}${values.length ? values.map(value => `<label class="opt"><input type="checkbox" class="cb-in" data-dimension="${dimension}" value="${escapeHTML(value)}" ${state[dimension].includes(value) ? 'checked' : ''}><span class="ot">${escapeHTML(dimensionText(dimension, value))}</span><span class="oc" title="Players">${number(counts[value] || 0)}</span></label>`).join('') : '<p class="help pop-none">None in these days</p>'}`;
  }).join('')}</div><div class="pop-foot"><button type="button" class="btn sm ghost" data-filters-clear>Clear</button><button type="button" class="btn sm primary" data-filters-done>Done</button></div></div>`;
  const applyLatest = () => { state.app_version = facets.latest_app_version ? [facets.latest_app_version] : []; };
  const loadFacets = async range => { facets = await api(`${gameURL(game)}/insights/facets?${new URLSearchParams({start: range.from, end: range.to, tz_offset: timezoneOffset(state)})}`); };
  const changed = () => { saveFilters(game, state); draw(); onChange(state); };
  const draw = () => {
    const pop = document.querySelector('#pop');
    if (pop && !pop.hidden && pop.querySelector('[data-filter-pop]')) { const scroll = pop.querySelector('.pop-scroll').scrollTop; pop.innerHTML = filterPopHTML(); pop.querySelector('.pop-scroll').scrollTop = scroll; }
    const active = activeFilters(state);
    const count = container.querySelector('#filter-count');
    count.hidden = !active; count.textContent = active;
    container.querySelectorAll('[data-timezone]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.timezone === state.timezone)));
    container.querySelectorAll('button[data-density]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.density === window.avnTheme.density())));
    const chips = Object.keys(FILTER_KEYS).flatMap(dimension => state[dimension].map(value => `<button type="button" class="filter-chip" data-remove-dimension="${dimension}" data-remove-value="${escapeHTML(value)}" title="Remove this filter">${DIMENSION_LABELS[dimension]}: ${escapeHTML(dimensionText(dimension, value))}${dimension === 'app_version' && state.versionMode === 'latest' ? ' (latest)' : ''} ${icon('close',11)}</button>`));
    container.querySelector('#filter-chips').innerHTML = chips.join('') + (state.hideTest && !state.environment.length ? '<span class="filter-note">Editor & development data hidden</span>' : '') + (chips.length > 1 ? '<button type="button" class="filter-clear" data-clear>Clear all</button>' : '');
  };
  window.__filterPopChange && document.removeEventListener('change', window.__filterPopChange);
  window.__filterPopChange = event => {
    if (!container.isConnected || !event.target.closest?.('#pop [data-filter-pop]')) return;
    if (event.target.id === 'hide-test') { state.hideTest = event.target.checked; changed(); return; }
    if (event.target.id === 'latest-build') { if (event.target.checked) { state.versionMode = 'latest'; applyLatest(); } else { state.versionMode = 'all'; state.app_version = []; } changed(); return; }
    const dimension = event.target.dataset.dimension; if (!dimension) return;
    state[dimension] = [...document.querySelectorAll(`#pop input[data-dimension="${dimension}"]:checked`)].map(input => input.value);
    if (dimension === 'app_version') state.versionMode = state.app_version.length ? 'custom' : 'all';
    changed();
  };
  document.addEventListener('change', window.__filterPopChange);
  window.__filterPopClick && document.removeEventListener('click', window.__filterPopClick);
  window.__filterPopClick = event => {
    if (!container.isConnected) return;
    if (event.target.closest('#pop [data-filters-done]')) { closePop(); return; }
    if (event.target.closest('#pop [data-filters-clear]')) { for (const dimension of Object.keys(FILTER_KEYS)) state[dimension] = []; state.versionMode = 'all'; changed(); }
  };
  document.addEventListener('click', window.__filterPopClick);
  container.addEventListener('click', event => {
    const density = event.target.closest('button[data-density]');
    if (density) { window.avnTheme.setDensity(density.dataset.density); document.querySelectorAll('button[data-density]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.density === window.avnTheme.density()))); return; }
    const timezone = event.target.closest('[data-timezone]');
    if (timezone && timezone.dataset.timezone !== state.timezone) { state.timezone = timezone.dataset.timezone; changed(); return; }
    if (event.target.closest('[data-include-test]')) { state.hideTest = false; changed(); return; }
    const opener = event.target.closest('[data-filters-open]');
    if (opener) { openPop(opener, filterPopHTML(), {width: 320, label: 'Filters'}); return; }
    const chip = event.target.closest('[data-remove-dimension]');
    if (chip) {
      const dimension = chip.dataset.removeDimension, value = chip.dataset.removeValue;
      const modeBefore = state.versionMode;
      state[dimension] = state[dimension].filter(item => item !== value);
      if (dimension === 'app_version') state.versionMode = state.app_version.length ? 'custom' : 'all';
      changed();
      toast(`Removed filter: ${DIMENSION_LABELS[dimension]} ${dimensionText(dimension, value)}`, {label: 'Undo', run: () => { if (!state[dimension].includes(value)) state[dimension] = [...state[dimension], value]; if (dimension === 'app_version') state.versionMode = modeBefore; changed(); }}, 'info');
    }
    if (event.target.closest('[data-clear]')) { const before = Object.fromEntries(Object.keys(FILTER_KEYS).map(dimension => [dimension, [...state[dimension]]])); const modeBefore = state.versionMode; for (const dimension of Object.keys(FILTER_KEYS)) state[dimension] = []; state.versionMode = 'all'; changed(); toast('Cleared all filters', {label: 'Undo', run: () => { Object.assign(state, before); state.versionMode = modeBefore; changed(); }}, 'info'); }
  });
  const rangeBox = container.querySelector('#filter-range');
  rangeBox.innerHTML = compactRangeMarkup();
  bindRange(rangeBox, async range => {
    state.range = {from: range.from, to: range.to, preset: range.preset};
    // On the default (latest build) the newest build is looked up first, so the page opens on it without a second load.
    const wantLatest = state.versionMode === 'latest';
    if (wantLatest) { try { await loadFacets(range); applyLatest(); } catch { /* every build shows if the lookup fails */ } }
    saveFilters(game, state);
    draw(); onChange(state);
    if (!wantLatest) { try { await loadFacets(range); draw(); } catch { /* the menu keeps the chosen values */ } }
  }, state.range?.preset || '30', state.range);
  const setContext = (context = {}) => {
    const parts = [`${prettyDay(state.range.from)}${state.range.from === state.range.to ? '' : ` → ${prettyDay(state.range.to)}`}`, state.timezone === 'utc' ? 'UTC' : 'Local time', 'player ID = user_id, otherwise device_id'];
    if (context.anonymous_events) parts.push(`${number(context.anonymous_events)} event${context.anonymous_events === 1 ? '' : 's'} without a player ID`);
    if (context.excluded_events) parts.push(`${number(context.excluded_events)} event${context.excluded_events === 1 ? '' : 's'} outside active filters`);
    const warning = context.low_sample ? `<span class="sample-warning">Small sample: ${number(context.players || 0)} of ${number(context.minimum_players)} players</span>` : '';
    const includeTest = context.excluded_events && state.hideTest && !state.environment.length ? `<button type="button" class="filter-clear" data-include-test>Include editor & development data</button>` : '';
    container.querySelector('.analysis-context').innerHTML = `<span>${parts.map(escapeHTML).join(' · ')}</span><span>${warning}${includeTest}</span>`;
  };
  setContext();
  return {state, setContext, toggle(dimension, value) { const list = state[dimension]; state[dimension] = list.includes(value) ? list.filter(item => item !== value) : [...list, value]; changed(); }};
}

// Clicking anywhere outside a filter menu closes it.
document.addEventListener('click', event => { if (!event.target.closest('.filter-menu')) document.querySelectorAll('.filter-menu[open]').forEach(menu => { menu.open = false; }); });

/* ─── Game overview ─── */

function dailyChart(days, range, measure) {
  const all = []; for (let day = range.from; day <= range.to; day = addDays(day, 1)) all.push(day);
  const values = Object.fromEntries(days.map(day => [day.day, day[measure]]));
  const series = all.map(day => ({day, value: values[day] || 0}));
  const peak = Math.max(1, ...series.map(item => item.value));
  const width = 800, height = 170, left = 40, bottom = 22, top = 8, plot = width - left - 4;
  const step = plot / series.length, bar = Math.max(1, Math.min(28, step - 2));
  const y = value => top + (height - top - bottom) * (1 - value / peak);
  const ticks = [0, Math.round(peak / 2), peak].filter((value, index, list) => list.indexOf(value) === index);
  const labelEvery = Math.ceil(series.length / 8);
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${measure} per day">
    ${ticks.map(value => `<line class="chart-grid" x1="${left}" x2="${width}" y1="${y(value)}" y2="${y(value)}"/><text class="chart-axis" x="${left - 6}" y="${y(value) + 4}" text-anchor="end">${number(value)}</text>`).join('')}
    ${series.map((item, index) => { const x = left + index * step + (step - bar) / 2; const h = Math.max(item.value ? 2 : 0, height - bottom - y(item.value)); return `<rect class="chart-bar" x="${x}" y="${height - bottom - h}" width="${bar}" height="${h}" rx="${Math.min(4, bar / 2)}"/>`; }).join('')}
    ${series.map((item, index) => index % labelEvery === 0 ? `<text class="chart-axis" x="${left + index * step + step / 2}" y="${height - 6}" text-anchor="middle">${item.day.slice(5)}</text>` : '').join('')}
    ${series.map((item, index) => `<rect class="chart-hit" x="${left + index * step}" y="0" width="${step}" height="${height - bottom}" data-day="${item.day}" data-value="${item.value}"/>`).join('')}
  </svg><div class="chart-tip" hidden></div>`;
}

function bindChartTips(container, measureLabel) {
  const tip = container.querySelector('.chart-tip'); if (!tip) return;
  container.querySelectorAll('.chart-hit').forEach(hit => {
    hit.addEventListener('pointerenter', () => {
      container.querySelectorAll('.chart-hit.on').forEach(other => other.classList.remove('on'));
      hit.classList.add('on');
      tip.innerHTML = `<strong>${prettyDay(hit.dataset.day)}</strong><span>${number(hit.dataset.value)} ${measureLabel}</span>`;
      tip.hidden = false;
      const box = container.getBoundingClientRect(), mark = hit.getBoundingClientRect();
      tip.style.left = `${Math.min(box.width - tip.offsetWidth, Math.max(0, mark.left - box.left + mark.width / 2 - tip.offsetWidth / 2))}px`;
    });
  });
  container.querySelector('svg')?.addEventListener('pointerleave', () => { tip.hidden = true; container.querySelectorAll('.chart-hit.on').forEach(hit => hit.classList.remove('on')); });
}

const shortDay = value => new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {day: 'numeric', month: 'short', timeZone: 'UTC'});

const activeUsers = active => {
  const change = active.dau - active.dau_previous;
  const trend = `${change > 0 ? '+' : ''}${number(change)} vs ${shortDay(addDays(active.last_day, -1))}`;
  const tip = text => `title="${escapeHTML(text)}"`;
  return `<section class="panel active-users"><div class="panel-header"><h2>Daily active users</h2><span class="help">DAU, WAU and MAU count back from ${prettyDay(active.last_day)}, the last day of this range${active.last_day === new Date().toISOString().slice(0, 10) ? ' (today, still in progress)' : ''}</span></div><div class="panel-body">${stats([
    [`<span ${tip('Distinct players with at least one event on that day')}>DAU</span>`, number(active.dau), trend],
    [`<span ${tip('Average distinct players per day across the selected days, empty days count as 0')}>Average DAU</span>`, number(active.avg_dau), `last 7 days ${number(active.avg_dau_7)}`],
    [`<span ${tip('The day in the range with the most distinct players')}>Peak DAU</span>`, number(active.peak_dau?.players || 0), active.peak_dau ? shortDay(active.peak_dau.day) : ''],
    [`<span ${tip('Distinct players in the 7 days up to and including that day')}>WAU</span>`, number(active.wau), '7 days'],
    [`<span ${tip('Distinct players in the 30 days up to and including that day')}>MAU</span>`, number(active.mau), '30 days'],
    [`<span ${tip('Average DAU over the last 30 days divided by MAU: how much of the monthly audience plays on a typical day')}>Stickiness</span>`, active.stickiness === null ? '—' : `${active.stickiness}%`, 'avg DAU ÷ MAU']])}</div></section>`;
};
// A row of headline numbers without card chrome.
const stats = items => `<div class="stat-strip">${items.map(([label, value, note]) => `<div class="stat"><span class="stat-label">${label}</span><strong class="stat-value">${value}</strong>${note ? `<span class="stat-note">${note}</span>` : ''}</div>`).join('')}</div>`;

function breakdownTable(dimension, rows, total, chosen) {
  const peak = Math.max(1, ...rows.map(row => row.players));
  return rows.length ? `<table class="breakdown"><thead><tr><th>${DIMENSION_LABELS[dimension]}</th><th><span class="sr-only">Share bar</span></th><th class="num">Players</th><th class="num">Share</th></tr></thead><tbody>${rows.map(row => `<tr class="${chosen.includes(row.value) ? 'chosen' : ''}"><td><button type="button" class="link-button" data-filter-dimension="${dimension}" data-filter-value="${escapeHTML(row.value)}" title="${chosen.includes(row.value) ? 'Remove this filter' : 'Show only this'}">${escapeHTML(dimensionText(dimension, row.value))}</button></td><td class="breakdown-bar"><span data-width="${Math.max(2, 100 * row.players / peak)}"></span></td><td class="num">${number(row.players)}</td><td class="num muted">${total ? percent(100 * row.players / total) : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="help panel-body">No data.</p>';
}

async function renderGameOverview() {
  const game = currentGame;
  const archived = game.archived_at ? `<div class="archived-banner">${icon('lock',18)}<div><strong>Archived.</strong> Collection is paused for this platform.</div><a class="button" href="${gamePath(game, 'settings')}">Game settings</a></div>` : '';
  shell('Overview', heading(game.name, `${platformLabel(game.platform)} · ${game.bundle_id}`, `<a class="button primary" href="${gamePath(game, 'exports')}">${icon('export',15)} Export data</a>`) + archived +
    `<div id="mapping-notice"></div><div id="filters"></div><div id="setup"></div><div id="anomalies"></div><div id="totals"></div>
    <div class="split"><section class="panel"><div class="panel-header"><div><h2>Activity per day</h2></div><div class="quiet-actions">${freshStamp()}<div class="segmented" role="group" aria-label="Measure">${[['players','Players (DAU)'],['sessions','Sessions'],['events','Events']].map(([key, label]) => `<button type="button" data-measure="${key}" aria-pressed="${key === 'players'}">${label}</button>`).join('')}</div></div></div><div class="panel-body chart-wrap" id="daily">${skeleton('chart')}</div></section>
    <section class="panel"><div class="panel-header"><h2>Needs a look</h2></div><div id="look"></div></section></div>
    <div id="tiles"></div><div id="active"></div>
    <div class="section-grid overview-grid section-spacing"><section class="panel"><div class="panel-header"><h2>Who’s playing</h2><div class="segmented" aria-label="Break down by">${Object.entries(DIMENSION_LABELS).map(([key, label], index) => `<button type="button" data-dimension-tab="${key}" aria-pressed="${index === 0}">${label.replace('Device platform', 'Platform').replace('App version', 'Version')}</button>`).join('')}</div></div><div id="breakdowns"></div></section>
    <section class="panel"><div class="panel-header"><h2>Top events</h2><div class="quiet-actions"><span class="help" id="events-total"></span><a class="text-link" href="${gamePath(game, 'dictionary')}">Dictionary ${icon('arrow',13)}</a></div></div><div id="top-events"></div></section></div>`);
  // mappingNotice() lives in events.js, which is loaded after this file and ready by the time it runs.
  const notice = document.querySelector('#mapping-notice');
  api(`${gameURL(game)}/mappings/status`).then(status => { if (notice.isConnected) notice.innerHTML = mappingNotice(game, status); }).catch(() => { /* no notice is better than a wrong one */ });
  notice.addEventListener('click', event => {
    const dismiss = event.target.closest('[data-dismiss-mapping-notice]'); if (!dismiss) return;
    storeSet(`avn-mapping-dismissed-${game.id}`, dismiss.dataset.dismissMappingNotice); notice.innerHTML = '';
  });
  let summary = null; let measure = 'players'; let dimension = 'environment'; let latest = 0;
  // Setup checklist: each step is Verified only by a check against real data, never by hand.
  const setupKey = `avn-setup-open-${game.id}`;
  // Setup is a quiet nudge: closed by default, and it can be dismissed for good.
  const dismissKey = `avn-setup-dismissed-${game.id}`;
  let setupOpen = storeGet(setupKey) === true;
  let facts = null;
  const loadFacts = async () => {
    const [funnels, dictionary, team] = await Promise.allSettled([request(`${gameURL(game)}/insights/funnels`), request(`${gameURL(game)}/dictionary`), me.can_manage_team ? request('/v1/team') : Promise.resolve(null)]);
    facts = {funnels: funnels.status === 'fulfilled' ? funnels.value : null, dictionary: dictionary.status === 'fulfilled' ? dictionary.value : null, team: team.status === 'fulfilled' ? team.value : null};
    return facts;
  };
  const setupSteps = data => {
    const described = facts?.dictionary ? Object.values(facts.dictionary).filter(item => (item?.description || '').trim()).length : 0;
    const shown = (data.top_events || []).slice(0, 10);
    const undescribed = shown.filter(row => !(facts?.dictionary?.[row.name]?.description || '').trim()).length;
    const versions = (data.breakdowns?.app_version || []).length;
    const steps = [
      {id: 'sdk', title: 'Add the SDK to your game', note: data.events || game.events ? `${number(game.events || data.events)} events received` : 'Waiting for the first event', state: game.events || data.events ? 'ok' : 'wait', href: gamePath(game, 'event-setup'), action: 'Event setup'},
      {id: 'key', title: 'Use an API key', note: game.events ? 'Events are arriving with a key' : 'Create one and put it in the game', state: game.events ? 'ok' : 'todo', href: gamePath(game, 'keys'), action: 'API keys'},
      {id: 'dictionary', title: 'Describe your events', note: facts?.dictionary ? `${number(described)} described${shown.length ? ` · ${undescribed ? `${undescribed} of the top ${shown.length} still without` : 'every top event has one'}` : ''}` : 'Checking…', state: !facts?.dictionary ? 'wait' : shown.length && !undescribed ? 'ok' : described ? 'done' : 'todo', href: gamePath(game, 'dictionary'), action: 'Dictionary'},
      {id: 'funnel', title: 'Save your first funnel', note: facts?.funnels ? (facts.funnels.length ? `${facts.funnels.length} saved` : 'Funnels show where players stop') : 'Checking…', state: !facts?.funnels ? 'wait' : facts.funnels.length ? 'ok' : 'todo', href: gamePath(game, 'funnels'), action: 'Funnels'},
      {id: 'release', title: 'See a new release', note: versions > 1 ? `${versions} versions seen` : 'Compare releases once a second version sends events', state: versions > 1 ? 'ok' : 'todo', href: gamePath(game, 'levels'), action: 'Levels'},
      ...(me.can_manage_team ? [{id: 'team', title: 'Invite your team', note: facts?.team ? (facts.team.length > 1 ? `${facts.team.length} people` : 'Only you so far') : 'Checking…', state: !facts?.team ? 'wait' : facts.team.length > 1 ? 'ok' : 'todo', href: '/team', action: 'Team'}] : []),
    ];
    return steps;
  };
  let summaryForSetup = null;
  const drawSetup = data => {
    summaryForSetup = data;
    const box = document.querySelector('#setup'); if (!box || !facts) return;
    const steps = setupSteps(data), verified = steps.filter(step => step.state === 'ok').length;
    if (verified === steps.length || storeGet(dismissKey) === true) { box.innerHTML = ''; return; }
    quietNote(`${steps.length - verified} setup step${steps.length - verified === 1 ? '' : 's'} left for ${game.name}`, 'Open the Overview to review them. You can ignore this.', `setup-${game.id}`);
    const tags = {ok: '<span class="tag ok">Verified</span>', done: '<span class="tag done">Done · to confirm</span>', wait: '<span class="tag info">Waiting</span>', todo: '<span class="tag plain">To do</span>'};
    box.innerHTML = `<section class="panel setup${setupOpen ? '' : ' closed'}"><div class="panel-header"><div><h2>Set up ${escapeHTML(game.name)}</h2><p>${verified} of ${steps.length} verified</p></div><div class="quiet-actions"><span class="sbar" aria-hidden="true">${steps.map(step => `<i class="${step.state}"></i>`).join('')}</span><button type="button" class="btn sm ghost" data-setup-toggle aria-expanded="${setupOpen}">${setupOpen ? 'Hide steps' : 'Show steps'}</button><button type="button" class="btn sm ghost" data-setup-dismiss aria-label="Dismiss setup suggestions" title="Dismiss">${icon('close', 14)}</button></div></div><div class="collapse${setupOpen ? '' : ' shut'}"><div>${steps.map(step => `<div class="srow"><span class="sic ${step.state}" aria-hidden="true">${step.state === 'ok' || step.state === 'done' ? icon('check', 13) : ''}</span><span><b>${step.title}</b><span class="s">${escapeHTML(step.note)}</span></span><span class="ra">${tags[step.state]}<a class="btn sm" href="${step.href}">${step.action}</a></span></div>`).join('')}</div></div></section>`;
  };
  document.querySelector('#setup').addEventListener('click', event => {
    if (event.target.closest('[data-setup-dismiss]')) { storeSet(dismissKey, true); document.querySelector('#setup').innerHTML = ''; toast('Setup suggestions hidden for this game', {label: 'Undo', run: () => { storeSet(dismissKey, false); drawSetup(summaryForSetup); }}, 'info'); return; }
    if (!event.target.closest('[data-setup-toggle]')) return;
    setupOpen = !setupOpen; document.querySelector('#setup .setup')?.classList.toggle('closed', !setupOpen); storeSet(setupKey, setupOpen);
    const toggle = document.querySelector('[data-setup-toggle]'); toggle.textContent = setupOpen ? 'Hide steps' : 'Show steps'; toggle.setAttribute('aria-expanded', String(setupOpen));
    document.querySelector('#setup .collapse').classList.toggle('shut', !setupOpen);
  });
  // Sections at a glance: one tile per area with its own headline, each opening that page.
  const drawTiles = data => {
    const tile = (section, symbol, title, value, note) => `<a class="tile" href="${gamePath(game, section)}"><span class="th">${icon(symbol, 16)}${title}</span><span class="tv">${value}</span><span class="ts2">${escapeHTML(note)}</span><span class="go">Open ${title.toLowerCase()} ${icon('arrow', 13)}</span></a>`;
    const top = (data.top_events || [])[0];
    const described = facts?.dictionary ? Object.values(facts.dictionary).filter(item => (item?.description || '').trim()).length : null;
    document.querySelector('#tiles').innerHTML = `<div class="strip-h"><span class="eyebrow">Sections at a glance</span></div><div class="tiles">${[
      tile('funnels', 'funnel', 'Funnels', facts?.funnels ? number(facts.funnels.length) : '—', facts?.funnels?.length ? `saved funnel${facts.funnels.length === 1 ? '' : 's'}` : 'Where players stop, step by step'),
      tile('levels', 'game', 'Levels', '→', 'Where players stop, level by level'),
      tile('players', 'users', 'Players', number(data.players), `${number(data.new_players)} new in this range`),
      tile('dictionary', 'book', 'Event dictionary', top ? escapeHTML(top.name) : '—', top ? `most sent · ${number(top.events)} events${described != null ? ` · ${number(described)} described` : ''}` : 'Describe what your events mean'),
    ].join('')}</div>`;
  };
  const drawDaily = () => {
    const box = document.querySelector('#daily');
    box.innerHTML = summary.events ? dailyChart(summary.days, filters.state.range, measure) : '<p class="help">No events with these filters and days.</p>';
    bindChartTips(box, measure);
  };
  const drawBreakdown = () => {
    const box = document.querySelector('#breakdowns');
    box.innerHTML = breakdownTable(dimension, summary.breakdowns[dimension], summary.players, filters.state[dimension]);
    setWidths(box);
  };
  document.querySelectorAll('[data-measure]').forEach(button => button.addEventListener('click', () => {
    measure = button.dataset.measure;
    document.querySelectorAll('[data-measure]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    if (summary) drawDaily();
  }));
  document.querySelectorAll('[data-dimension-tab]').forEach(button => button.addEventListener('click', () => {
    dimension = button.dataset.dimensionTab;
    document.querySelectorAll('[data-dimension-tab]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    if (summary) drawBreakdown();
  }));
  document.querySelector('#breakdowns').addEventListener('click', event => {
    const button = event.target.closest('[data-filter-dimension]');
    if (button) filters.toggle(button.dataset.filterDimension, button.dataset.filterValue);
  });
  const filters = mountFilters(document.querySelector('#filters'), game, async state => {
    const ticket = ++latest;
    const summaryPath = `${gameURL(game)}/insights/summary?${filterQuery(state)}`;
    const finishLoading = [
      ['totals', skeleton('stats')], ['daily', skeleton('chart')],
      ['breakdowns', skeleton('table', 5, 3)], ['top-events', skeleton('table', 5, 3)],
    ].map(([id, placeholder]) => beginLoading(document.querySelector(`#${id}`), placeholder, id === 'totals' ? {path: summaryPath} : {note: false}));
    // Coming back to a page seen a few minutes ago draws it at once, then updates it if anything changed.
    let shownOld = false;
    const showSummary = (data, old) => {
      if (ticket !== latest || !notice.isConnected) return;
      if (old) shownOld = true;
      summary = data;
      filters.setContext({...data.context, players: data.players});
      const active = data.active || {};
      const dauChange = (active.dau || 0) - (active.dau_previous || 0);
      const kpi = (label, value, note) => `<div class="kpi"><div class="eyebrow">${label}</div><div class="k-v">${value}</div><div class="k-c">${note}</div></div>`;
      document.querySelector('#totals').innerHTML = `<div class="kpis">${[
        kpi('Players', number(data.players), `${number(data.new_players)} new · unique player IDs`),
        kpi('Sessions', number(data.sessions), data.players ? `${(data.sessions / data.players).toFixed(1)} per player` : 'with a player ID'),
        kpi('Daily active', number(active.dau || 0), data.events ? `<span class="d ${dauChange < 0 ? 'down' : 'up'}">${dauChange > 0 ? '+' : ''}${number(dauChange)}</span> vs ${shortDay(addDays(active.last_day, -1))}` : 'no events yet'),
        kpi('Stickiness', active.stickiness == null ? '—' : `${active.stickiness}<small>%</small>`, 'avg DAU ÷ MAU'),
      ].join('')}</div>`;
      const context = data.context || {};
      const looks = [
        context.low_sample && ['warn', 'Sample', 'Small sample', `${number(data.players || 0)} of ${number(context.minimum_players)} players`],
        context.anonymous_events && ['warn', 'Data', `${number(context.anonymous_events)} event${context.anonymous_events === 1 ? '' : 's'} without a player ID`, 'They do not count toward players.'],
      ].filter(Boolean);
      document.querySelector('#look').innerHTML = looks.length ? looks.map(([kind, tag, title, note]) => `<div class="look"><span class="tag ${kind}">${tag}</span><div><b>${title}</b><span class="s">${note}</span></div></div>`).join('') : `<div class="empty-scene">${doraScene()}<p>Nothing needs a look in this range. Dora is asleep on the monitor.</p></div>`;
      document.querySelector('#events-total').textContent = `${number(data.events)} events`;
      markFresh(); drawTiles(data); (facts ? Promise.resolve(facts) : loadFacts()).then(() => { if (notice.isConnected) { drawSetup(data); drawTiles(data); } });
      document.querySelector('#anomalies').innerHTML = data.anomalies.length ? `<div class="strip-h"><span class="eyebrow">What changed · vs the preceding ${daysBetween(state.range.from, state.range.to) + 1}-day period</span></div><div class="insights">${data.anomalies.map(item => `<div class="insight"><span class="tag plain dot">${item.direction === 'down' ? 'Down' : 'Up'}</span><b>${escapeHTML(item.label)} ${item.change_percent > 0 ? '+' : ''}${percent(item.change_percent)}</b><span class="s">${number(item.previous)} → ${number(item.current)}</span></div>`).join('')}</div>` : '';
      document.querySelector('#active').innerHTML = data.events ? activeUsers(data.active) : '';
      drawDaily(); drawBreakdown();
      document.querySelector('#top-events').innerHTML = data.top_events.length ? `<table class="compact-table"><thead><tr><th>Event</th><th class="num">Events</th><th class="num">Players</th></tr></thead><tbody>${data.top_events.slice(0, 10).map(row => `<tr><td class="mono">${escapeHTML(row.name)}</td><td class="num">${number(row.events)}</td><td class="num">${number(row.players)}</td></tr>`).join('')}</tbody></table>` : '<p class="help panel-body">No events.</p>';
    };
    try { await apiShowing(summaryPath, showSummary); }
    catch (error) { if (ticket === latest && notice.isConnected) {
      if (shownOld) { toastError(error); return; }
      for (const id of ['totals', 'breakdowns', 'top-events']) document.querySelector(`#${id}`).innerHTML = '';
      summary = null;
      document.querySelector('#anomalies').innerHTML = '';
      document.querySelector('#look').innerHTML = '';
      document.querySelector('#active').innerHTML = '';
      document.querySelector('#daily').innerHTML = loadError(error);
    } } finally { finishLoading.forEach(finish => finish()); }
  });
}

/* ─── Funnels ─── */

const blankStep = event => ({event: event || '', param: '', op: 'eq', value: '', label: ''});

async function renderFunnels() {
  const game = currentGame;
  shell('Funnels', heading('Funnels', 'How many players get through each step, and where they stop.', '<button class="button small-button" type="button" id="collapse-all">Collapse all</button>') +
    `<div id="filters"></div>
    <section class="panel section-spacing"><div class="panel-header funnel-header"><div class="saved-row"><select id="saved-funnel" aria-label="Saved funnels"></select></div><div class="quiet-actions"><button class="button small-button" type="button" id="save-funnel">Save</button><button class="button small-button" type="button" id="save-as">Save as…</button><button class="button small-button danger-text" type="button" id="delete-funnel">Delete</button></div></div>
      <div class="panel-body"><div id="funnel-steps"></div>
        <div class="funnel-actions"><div class="quiet-actions"><button class="button small-button" type="button" id="add-step">${icon('plus',14)} Add step</button><button class="button small-button" type="button" id="quick-levels">${icon('plus',14)} Level steps…</button><button class="button ghost small-button" type="button" id="clear-steps">Clear</button></div><button class="button primary" type="button" id="run-funnel">Run funnel</button></div>
        <div class="funnel-more"><span class="eyebrow">Options</span><div class="funnel-options option-chips"><label class="inline-field">Count<select id="funnel-scope"><option value="player">Per player, across sessions</option><option value="session">Within one session</option></select></label><label class="inline-field">Finish within<select id="funnel-window"><option value="">Any time</option><option value="0.25">15 minutes</option><option value="1">1 hour</option><option value="24">1 day</option><option value="168">7 days</option><option value="720">30 days</option></select></label><label class="inline-field">Break down by<select id="funnel-breakdown"><option value="">Nothing</option>${Object.entries(DIMENSION_LABELS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label></div></div></div></section>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>Result</h2><p id="funnel-note">Add at least two steps.</p></div><button class="button small-button" type="button" id="funnel-csv" hidden>${icon('export',14)} CSV</button></div><div id="funnel-summary"></div><div class="panel-body" id="funnel-result"><p class="help">No result yet.</p></div></section>
    <section class="panel section-spacing" id="journeys-panel"></section>
    <section class="panel section-spacing" id="breakdown-panel" hidden><div class="panel-header"><div><h2 id="breakdown-title">Breakdown</h2><p>Players reaching each step, per segment · a player’s segment comes from their step 1 event</p></div></div><div id="breakdown-result"></div></section>`);
  const panels = {};
  const sections = document.querySelectorAll('main .panel.section-spacing');
  panels.editor = collapsible(sections[0], game, 'editor');
  panels.result = collapsible(sections[1], game, 'result');
  panels.breakdown = collapsible(document.querySelector('#breakdown-panel'), game, 'breakdown');
  document.querySelector('#collapse-all').addEventListener('click', event => {
    const all = Object.values(panels);
    const collapse = all.some(panel => !panel.section.classList.contains('collapsed'));
    all.forEach(panel => panel.set(collapse)); event.target.textContent = collapse ? 'Expand all' : 'Collapse all';
  });
  const draftKey = `avn-funnel-draft-${game.id}`;
  let saved = [];
  let current = storeGet(draftKey) || {id: null, name: '', steps: [], scope: 'player', window_hours: null};
  current.steps = (current.steps || []).map(step => ({...blankStep(), ...step}));
  let catalog = {events: []};
  let lastResult = null;
  const byName = name => catalog.events.find(item => item.name === name);
  const stepsBox = document.querySelector('#funnel-steps');
  const result = document.querySelector('#funnel-result');
  const persist = () => storeSet(draftKey, current);

  const drawSaved = () => {
    document.querySelector('#saved-funnel').innerHTML = `<option value="">${current.id ? 'New funnel' : current.name ? `${escapeHTML(current.name)} (unsaved)` : 'New funnel (unsaved)'}</option>${saved.map(item => `<option value="${item.id}" ${item.id === current.id ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}`;
    document.querySelector('#delete-funnel').hidden = !current.id;
    document.querySelector('#save-funnel').textContent = current.id ? 'Save' : 'Save…';
  };
  const drawOptions = () => {
    document.querySelector('#funnel-scope').value = current.scope || 'player';
    document.querySelector('#funnel-window').value = current.window_hours ? String(current.window_hours) : '';
    const parts = [document.querySelector('#funnel-scope').selectedOptions[0].textContent];
    if (current.window_hours) parts.push(`within ${document.querySelector('#funnel-window').selectedOptions[0].textContent}`);
    const breakdown = document.querySelector('#funnel-breakdown').value;
    if (breakdown) parts.push(`by ${DIMENSION_LABELS[breakdown].toLowerCase()}`);
    // Options that differ from the default are highlighted, so nothing hidden changes the numbers.
    for (const [id, changed] of [['funnel-scope', current.scope === 'session'], ['funnel-window', !!current.window_hours], ['funnel-breakdown', !!breakdown]]) document.querySelector(`#${id}`).closest('label').classList.toggle('changed', changed);
  };
  const drawSteps = () => {
    document.querySelector('#add-step').disabled = current.steps.length >= MAX_STEPS;
    if (!current.steps.length) { stepsBox.innerHTML = '<p class="help">No steps yet. Add one, or use “Level steps…” to add Started/Completed steps for a range of levels.</p>'; return; }
    const names = catalog.events.map(item => item.name);
    stepsBox.innerHTML = current.steps.map((step, index) => {
      const event = byName(step.event);
      const eventNames = step.event && !names.includes(step.event) ? [step.event, ...names] : names;
      const params = (event?.params || []).map(param => param.key);
      if (step.param && !params.includes(step.param)) params.unshift(step.param);
      const values = event?.params.find(param => param.key === step.param)?.values || [];
      const needsValue = step.param && step.op !== 'exists';
      return `<div class="funnel-step" data-index="${index}"><span class="step-number">${String(index + 1).padStart(2, '0')}</span>
        <select data-field="event" aria-label="Step ${index + 1} event">${eventNames.map(name => `<option ${name === step.event ? 'selected' : ''}>${escapeHTML(name)}</option>`).join('')}${eventNames.length ? '' : '<option value="">No events in these days</option>'}</select>
        <select data-field="param" aria-label="Step ${index + 1} parameter"><option value="">Any parameters</option>${params.map(key => `<option value="${escapeHTML(key)}" ${key === step.param ? 'selected' : ''}>${escapeHTML(key)}</option>`).join('')}</select>
        <select data-field="op" aria-label="Step ${index + 1} condition" ${step.param ? '' : 'disabled'}>${OPERATORS.map(([key, label]) => `<option value="${key}" ${key === (step.op || 'eq') ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <input data-field="value" aria-label="Step ${index + 1} value" placeholder="${needsValue ? 'any value' : '—'}" ${needsValue ? '' : 'disabled'} value="${escapeHTML(step.value || '')}" list="step-values-${index}"><datalist id="step-values-${index}">${values.map(value => `<option value="${escapeHTML(value)}">`).join('')}</datalist>
        <span class="step-tools"><button type="button" class="icon-button" data-name aria-label="Name this step" title="Name this step">${icon('edit',13)}</button><button type="button" class="icon-button" data-move="-1" aria-label="Move step up" ${index ? '' : 'disabled'}>↑</button><button type="button" class="icon-button" data-move="1" aria-label="Move step down" ${index < current.steps.length - 1 ? '' : 'disabled'}>↓</button><button type="button" class="icon-button" data-remove aria-label="Remove step">${icon('close',13)}</button></span>
        ${step.label || step.naming ? `<input class="step-name" data-field="label" aria-label="Step ${index + 1} name" placeholder="Step name, e.g. Level 1 start" maxlength="80" value="${escapeHTML(step.label || '')}">` : ''}</div>`;
    }).join('');
  };
  const editorNote = () => {
    const steps = current.steps.filter(step => step.event);
    const name = step => step.label || `${step.event}${step.param ? ` · ${step.param}${step.value ? `=${step.value}` : ''}` : ''}`;
    panels.editor.setNote(steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}: ${name(steps[0])} → ${name(steps[steps.length - 1])}` : 'no steps yet');
  };
  const changed = (redraw = true) => { persist(); drawSaved(); editorNote(); if (redraw) drawSteps(); };

  stepsBox.addEventListener('change', event => {
    const row = event.target.closest('.funnel-step[data-index]'); if (!row) return;
    const step = current.steps[Number(row.dataset.index)]; const field = event.target.dataset.field;
    step[field] = event.target.value;
    if (field === 'event') Object.assign(step, {param: '', op: 'eq', value: ''});
    if (field === 'param') Object.assign(step, {op: 'eq', value: ''});
    if (field === 'op' && step.op === 'exists') step.value = '';
    changed(['event', 'param', 'op'].includes(field));
  });
  stepsBox.addEventListener('input', event => {
    const field = event.target.dataset.field;
    if (field !== 'value' && field !== 'label') return;
    current.steps[Number(event.target.closest('.funnel-step').dataset.index)][field] = event.target.value; persist();
  });
  stepsBox.addEventListener('click', event => {
    const row = event.target.closest('.funnel-step[data-index]'); if (!row) return;
    const index = Number(row.dataset.index);
    const move = event.target.closest('[data-move]');
    if (move) { const to = index + Number(move.dataset.move); [current.steps[index], current.steps[to]] = [current.steps[to], current.steps[index]]; changed(); }
    if (event.target.closest('[data-name]')) { current.steps[index].naming = true; drawSteps(); stepsBox.querySelector(`[data-index="${index}"] .step-name`)?.focus(); }
    if (event.target.closest('[data-remove]')) { current.steps.splice(index, 1); changed(); }
  });
  document.querySelector('#add-step').addEventListener('click', () => { current.steps.push(blankStep(current.steps[current.steps.length - 1]?.event || catalog.events[0]?.name)); changed(); });
  document.querySelector('#clear-steps').addEventListener('click', () => { current.steps = []; changed(); run(); });
  document.querySelector('#funnel-scope').addEventListener('change', event => { current.scope = event.target.value; persist(); drawOptions(); run(); });
  document.querySelector('#funnel-window').addEventListener('change', event => { current.window_hours = event.target.value ? Number(event.target.value) : null; persist(); drawOptions(); run(); });
  document.querySelector('#funnel-breakdown').addEventListener('change', () => { drawOptions(); run(); });
  document.querySelector('#run-funnel').addEventListener('click', () => run());

  document.querySelector('#quick-levels').addEventListener('click', () => {
    modal.innerHTML = `<form id="levels-form"><h2 id="dialog-title">Add level steps</h2><p>Adds one step per level and key, in order. For example keys <code>Started, Completed</code> for levels 1–5 make 10 steps.</p>
      <div class="field"><label for="series-event">Event</label><select id="series-event" name="event">${catalog.events.map(item => `<option>${escapeHTML(item.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="series-keys">Parameter keys, in order</label><input id="series-keys" name="keys" placeholder="Started, Completed" required></div>
      <div class="field-row"><div class="field"><label for="series-from">From level</label><input id="series-from" name="from" type="number" min="0" value="1" required></div><div class="field"><label for="series-to">To level</label><input id="series-to" name="to" type="number" min="0" value="5" required></div></div>
      <label class="check-row"><input type="checkbox" name="replace" checked> Replace the current steps</label>
      <div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Add steps</button></div></form>`;
    modal.showModal();
    const keyInput = modal.querySelector('#series-keys');
    const suggest = () => { const params = byName(modal.querySelector('#series-event').value)?.params.map(param => param.key) || []; keyInput.placeholder = params.slice(0, 3).join(', ') || 'Started, Completed'; };
    modal.querySelector('#series-event').addEventListener('change', suggest); suggest();
    bindForm('#levels-form', async (form, values) => {
      const keys = values.keys.split(',').map(key => key.trim()).filter(Boolean);
      const from = Number(values.from), to = Number(values.to);
      if (!keys.length) throw new Error('Enter at least one key.');
      if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) throw new Error('Use whole numbers, with “to” at least “from”.');
      const added = [];
      for (let level = from; level <= to; level++) for (const key of keys) added.push({...blankStep(values.event), param: key, value: String(level), label: `${key} ${level}`});
      const base = values.replace ? [] : current.steps;
      if (base.length + added.length > MAX_STEPS) throw new Error(`That makes ${base.length + added.length} steps. A funnel can have up to ${MAX_STEPS}.`);
      current.steps = [...base, ...added]; changed(); modal.close(); run();
    });
  });

  const definition = () => ({name: current.name, steps: current.steps.filter(step => step.event).map(({event, param, op, value, label}) => ({event, param: param || '', op: param ? (op || 'eq') : 'eq', value: param && op !== 'exists' ? (value || '') : '', label: label || ''})), scope: current.scope || 'player', window_hours: current.window_hours || null});
  const loadSaved = async () => { saved = await request(`${gameURL(game)}/insights/funnels`); drawSaved(); };
  const saveAs = () => {
    modal.innerHTML = `<form id="name-form"><h2 id="dialog-title">Save funnel</h2><p>Saved funnels are stored on the server, so they’re there on every device you use.</p><div class="field"><label for="funnel-name">Name</label><input id="funnel-name" name="name" required maxlength="80" value="${escapeHTML(current.name || '')}" placeholder="e.g. Levels 1–5"></div><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Save</button></div></form>`;
    modal.showModal();
    bindForm('#name-form', async (form, values) => {
      const body = {...definition(), name: values.name};
      if (body.steps.length < 2) throw new Error('A funnel needs at least two steps.');
      const created = await request(`${gameURL(game)}/insights/funnels`, {method:'POST', body: JSON.stringify(body)});
      current = {...current, id: created.id, name: created.name}; persist(); await loadSaved(); modal.close(); toast('Funnel saved.');
    });
  };
  document.querySelector('#save-as').addEventListener('click', saveAs);
  document.querySelector('#save-funnel').addEventListener('click', async () => {
    if (!current.id) return saveAs();
    const body = definition();
    if (body.steps.length < 2) { toast('A funnel needs at least two steps.'); return; }
    try { await request(`${gameURL(game)}/insights/funnels/${current.id}`, {method:'PUT', body: JSON.stringify(body)}); await loadSaved(); toast('Funnel saved.'); }
    catch (error) { toastError(error); }
  });
  document.querySelector('#delete-funnel').addEventListener('click', () => confirmDialog(`Delete “${current.name}”?`, 'Only the saved steps are removed. No event data is affected.', 'Delete funnel', async () => {
    await request(`${gameURL(game)}/insights/funnels/${current.id}`, {method:'DELETE'});
    current = {...current, id: null, name: ''}; persist(); await loadSaved(); toast('Funnel deleted.');
  }));
  document.querySelector('#saved-funnel').addEventListener('change', event => {
    const chosen = saved.find(item => item.id === event.target.value);
    current = chosen ? {id: chosen.id, name: chosen.name, steps: chosen.steps.map(step => ({...blankStep(), ...step})), scope: chosen.scope, window_hours: chosen.window_hours} : {...current, id: null, name: ''};
    persist(); drawOptions(); changed(); run();
  });

  let latest = 0;
  async function run() {
    const body = definition();
    document.querySelector('#breakdown-panel').hidden = true;
    if (body.steps.length < 2) { result.innerHTML = '<p class="help">Add at least two steps.</p>'; document.querySelector('#funnel-summary').innerHTML = ''; document.querySelector('#funnel-csv').hidden = true; return; }
    const ticket = ++latest;
    result.innerHTML = skeleton('table', 5, 4);
    const breakdown = document.querySelector('#funnel-breakdown').value;
    try {
      const data = await api(`${gameURL(game)}/insights/funnel`, {method:'POST', body: JSON.stringify({...filterBody(filters.state), steps: body.steps, scope: body.scope, ...(body.window_hours ? {window_hours: body.window_hours} : {}), ...(breakdown ? {breakdown} : {})})});
      if (ticket === latest) {
        lastResult = data; filters.setContext({...data.context, players: data.steps[0]?.players || 0}); drawResult(data);
        if (storeGet(`avn-pending-journeys-${game.id}`)) { storeSet(`avn-pending-journeys-${game.id}`, null); journeys.run(); } else journeys.refresh();
      }
    } catch (error) { if (ticket === latest) result.innerHTML = loadError(error, 'data-retry-funnel'); }
  }
  result.addEventListener('click', event => { if (event.target.closest('[data-retry-funnel]')) run(); });
  const timing = times => times ? `<span title="${number(times.count)} players · average ${duration(times.average)} · fastest ${duration(times.min)} · slowest ${duration(times.max)}">median ${duration(times.median)} · 90% within ${duration(times.p90)}</span>` : '';
  const drawResult = data => {
    const rows = data.steps; const first = rows[0].players; const last = rows[rows.length - 1];
    document.querySelector('#funnel-note').textContent = first ? `${current.scope === 'session' ? 'Each player’s best single session' : 'Each player, across all their sessions'}${current.window_hours ? ` · finished within ${document.querySelector('#funnel-window').selectedOptions[0].textContent}` : ''} · hover times for averages` : 'Nobody did the first step with these filters and days.';
    document.querySelector('#funnel-csv').hidden = false;
    panels.result.setNote(first ? `${number(first)} started · ${number(last.players)} completed · ${percent(last.of_first)}` : 'nobody did step 1');
    const kpi = ([label, value, note]) => `<div class="kpi"><div class="eyebrow">${label}</div><div class="k-v">${value}</div><div class="k-c">${note}</div></div>`;
    document.querySelector('#funnel-summary').innerHTML = first ? `<div class="panel-body funnel-stats"><p class="funnel-headline"><strong>${percent(last.of_first)}</strong> of players who did “${stepLabel(rows[0])}” went on to “${stepLabel(last)}”.</p><div class="kpis">${[['Started', number(first), 'did step 1'], ['Completed', number(last.players), 'reached the last step'], ['Conversion', percent(last.of_first), 'first → last step'], ['Time to complete', data.time_to_complete ? duration(data.time_to_complete.median) : '—', data.time_to_complete ? `median · 90% within ${duration(data.time_to_complete.p90)}` : 'nobody finished']].map(kpi).join('')}</div></div>` : '';
    let worst = null;
    rows.forEach((row, index) => { if (index && rows[index - 1].players && row.of_previous < 100 && (!worst || row.of_previous < worst.rate)) worst = {index, rate: row.of_previous}; });
    result.classList.toggle('many', rows.length > 15);
    result.innerHTML = `<ol class="funnel">${rows.map((row, index) => {
      const isWorst = worst && worst.index === index;
      const gap = index ? `<li class="funnel-gap ${isWorst ? 'worst' : ''}"><span>${percent(row.of_previous)} continued · <span class="lost">${percent(Math.round((100 - row.of_previous) * 10) / 10)} lost</span>${isWorst ? ' <strong class="gap-flag">Biggest drop</strong>' : ''}</span>${timing(row.time_from_previous)}</li>` : '';
      const lost = row.dropped ? `<details class="dropped"><summary>${number(row.dropped)} stopped here · see who</summary><div class="dropped-list">${row.dropped_sample.map(item => `<a href="${gamePath(game, 'players')}?${new URLSearchParams({player: item.player})}"><span class="mono">${escapeHTML(shortId(item.player))}</span><span class="small muted">last step ${displayDate(item.last_seen)}</span></a>`).join('')}${row.dropped > row.dropped_sample.length ? `<p class="small muted">Showing the ${row.dropped_sample.length} most recent of ${number(row.dropped)}.</p>` : ''}</div></details>` : '';
      return gap + `<li class="funnel-row"><div class="funnel-label"><span class="step-number">${String(index + 1).padStart(2, '0')}</span><span>${stepLabel(row)}</span></div><div class="funnel-bar" title="${number(row.players)} players · ${percent(row.of_first)} of step 1"><span data-width="${first ? Math.max(row.of_first, row.players ? 1 : 0) : 0}"></span></div><div class="funnel-numbers"><strong>${number(row.players)}</strong><span>${percent(row.of_first)}</span></div>${lost}</li>`;
    }).join('')}</ol>`;
    setWidths(result);
    const panel = document.querySelector('#breakdown-panel');
    panel.hidden = !data.breakdown;
    if (data.breakdown) {
      document.querySelector('#breakdown-title').textContent = `By ${DIMENSION_LABELS[data.breakdown].toLowerCase()}`;
      document.querySelector('#breakdown-result').innerHTML = data.segments.length ? `<div class="table-wrap"><table><thead><tr><th>${DIMENSION_LABELS[data.breakdown]}</th>${rows.map((row, index) => `<th class="num" title="${escapeHTML(row.label || row.event)}">${String(index + 1).padStart(2, '0')}</th>`).join('')}<th class="num">Conversion</th></tr></thead><tbody>${data.segments.map(segment => `<tr><td>${escapeHTML(dimensionText(data.breakdown, segment.value))}</td>${segment.players.map(count => `<td class="num">${number(count)}</td>`).join('')}<td class="num"><strong>${segment.players[0] ? percent(100 * segment.players[segment.players.length - 1] / segment.players[0]) : '—'}</strong></td></tr>`).join('')}</tbody></table></div>${data.segments_total > data.segments.length ? `<p class="help panel-body">Showing the ${data.segments.length} largest of ${data.segments_total} segments.</p>` : ''}` : '<p class="help panel-body">No segments.</p>';
    }
  };
  document.querySelector('#funnel-csv').addEventListener('click', () => {
    if (!lastResult) return;
    const rows = [['step', 'name', 'event', 'parameter', 'condition', 'value', 'players', 'percent_of_step_1', 'percent_of_previous', 'stopped_here', 'median_seconds_from_previous', 'p90_seconds_from_previous']];
    lastResult.steps.forEach((row, index) => rows.push([index + 1, row.label, row.event, row.param, row.param ? row.op : '', row.value, row.players, row.of_first, row.of_previous, row.dropped, row.time_from_previous?.median ?? '', row.time_from_previous?.p90 ?? '']));
    downloadCSV(`${game.name}-${platformLabel(game.platform)}-funnel-${filters.state.range.from}_${filters.state.range.to}.csv`, rows);
  });

  const journeys = mountJourneys(document.querySelector('#journeys-panel'), game, {
    steps: () => current.steps.filter(step => step.event),
    catalog: () => catalog,
    query: () => ({...filterBody(filters.state), ...(({steps, scope, window_hours}) => ({steps, scope, ...(window_hours ? {window_hours} : {})}))(definition())}),
  });
  panels.journeys = collapsible(document.querySelector('#journeys-panel'), game, 'journeys');
  drawOptions(); drawSaved(); drawSteps(); editorNote();
  loadSaved().catch(() => {});
  const filters = mountFilters(document.querySelector('#filters'), game, async state => {
    try { catalog = await api(`${gameURL(game)}/insights/catalog?${filterQuery(state)}`); }
    catch (error) { toastError(error); catalog = {events: []}; }
    if (!current.steps.length && catalog.events.length) current.steps = [blankStep(catalog.events[0].name), blankStep(catalog.events[0].name)];
    drawSteps();
    journeys.redraw();
    run();
  });
}

/* ─── Journeys: what players did between two funnel steps, in plain words ─── */

const JOURNEY_OUTCOMES = {reached: ['Reached the end', 'good'], stopped: ['Stopped', 'bad'], continued: ['Kept going', '']};
const START_EXIT = '__start__';

function mountJourneys(container, game, hooks) {
  const key = `avn-journeys-${game.id}`;
  const saved = storeGet(key) || {};
  const state = {from: 1, to: null, ignore: [], span: 'session', view: 'journeys', ...saved};
  state.ignore = (Array.isArray(state.ignore) ? state.ignore : []).filter(name => typeof name === 'string');
  let outcomeFilter = 'all'; let shown = 12; let lastData = null; let active = false; let latest = 0; let lastBody = null;
  container.innerHTML = `<div class="panel-header"><div><h2>Journeys</h2><p>What players did between two steps, in plain words · click a journey to see who took it</p></div><button class="button primary" type="button" id="journeys-run">${icon('funnel',14)} Show journeys</button></div>
    <div class="panel-body"><div class="routes-controls">
      <label class="inline-field">From<select id="journeys-from"></select></label>
      <label class="inline-field">To<select id="journeys-to"></select></label>
      <label class="inline-field">Look at<select id="journeys-span"><option value="session">The session they started in</option><option value="all">All their sessions</option></select></label>
      <label class="inline-field">Hide<select id="journeys-ignore-add"></select></label><span id="journeys-ignore" class="chip-row"></span>
    </div>
    <div id="journeys-summary"></div>
    <p class="help" id="journeys-intro">Pick where to start and end, then “Show journeys”. The steps come from your funnel above. Events are named from your event dictionary; fill in “How it reads in player stories” there to rename them in journeys.</p>
    <div id="journeys-views" hidden>
      <div class="range-modes route-tabs" role="group" aria-label="How to view journeys"><button type="button" data-view="journeys">Journeys</button><button type="button" data-view="exits">Where players stop</button></div>
      <div id="journeys-view-journeys"></div><div id="journeys-view-exits" hidden></div>
    </div></div>
    <div id="journeys-players-wrap" hidden><div class="panel-header"><div><h2 id="journeys-players-title">Players</h2><p id="journeys-players-note"></p></div><button class="button small-button" type="button" id="journeys-players-csv">${icon('export',14)} CSV</button></div><div id="journeys-players" class="panel-body"></div></div>`;
  const $ = selector => container.querySelector(selector);
  const persist = () => storeSet(key, {from: state.from, to: state.to, ignore: state.ignore, span: state.span, view: state.view});
  const stepName = (step, index) => `${index + 1}. ${step.label || step.event}${step.param ? ` · ${step.param}${step.value ? `=${step.value}` : ''}` : ''}`;
  const plain = (step, index) => stepName(step, index).replace(/^\d+\.\s*/, '');
  const startName = () => plain(hooks.steps()[state.from - 1], state.from - 1);
  const endName = () => plain(hooks.steps()[(state.to || hooks.steps().length) - 1], (state.to || hooks.steps().length) - 1);

  const drawControls = () => {
    const steps = hooks.steps();
    state.from = Math.min(Math.max(1, state.from), Math.max(1, steps.length - 1));
    state.to = Math.min(Math.max(state.to || steps.length, state.from + 1), Math.max(steps.length, 2));
    $('#journeys-from').innerHTML = steps.map((step, index) => `<option value="${index + 1}" ${index + 1 === state.from ? 'selected' : ''}>${escapeHTML(stepName(step, index))}</option>`).join('');
    $('#journeys-to').innerHTML = steps.map((step, index) => `<option value="${index + 1}" ${index + 1 === state.to ? 'selected' : ''} ${index + 1 <= state.from ? 'disabled' : ''}>${escapeHTML(stepName(step, index))}</option>`).join('');
    $('#journeys-span').value = state.span;
    const events = hooks.catalog().events;
    $('#journeys-ignore-add').innerHTML = `<option value="">an event…</option>${events.filter(event => !state.ignore.includes(event.name)).map(event => `<option>${escapeHTML(event.name)}</option>`).join('')}`;
    $('#journeys-ignore').innerHTML = state.ignore.map(name => `<span class="chip">${escapeHTML(name)} <button type="button" class="chip-x" data-unignore="${escapeHTML(name)}" aria-label="Show ${escapeHTML(name)} again">×</button></span>`).join('');
  };
  const changed = () => { persist(); drawControls(); if (active) run(); };
  $('#journeys-from').addEventListener('change', event => { state.from = Number(event.target.value); changed(); });
  $('#journeys-to').addEventListener('change', event => { state.to = Number(event.target.value); changed(); });
  $('#journeys-span').addEventListener('change', event => { state.span = event.target.value; changed(); });
  $('#journeys-ignore-add').addEventListener('change', event => { if (event.target.value) { state.ignore.push(event.target.value); changed(); } });

  const outcome = status => { const [label, tone] = JOURNEY_OUTCOMES[status]; return `<span class="pill ${tone}">${label}</span>`; };
  const chain = item => `<span class="route-step start" title="Start">${escapeHTML(startName())}</span>${item.steps.map((text, index) => `<span class="route-arrow">→</span><span class="route-step" title="Step ${index + 1}"><i>${index + 1}</i>${escapeHTML(text)}</span>`).join('')}<span class="route-arrow">→</span>${{reached: `<span class="route-step end good">Reached: ${escapeHTML(endName())}</span>`, stopped: '<span class="route-step end bad">Stopped here</span>', continued: '<span class="route-step end">… and kept going</span>'}[item.status]}`;
  const exitText = label => label === START_EXIT ? `Left right after “${startName()}”` : label;

  const drawJourneys = () => {
    const data = lastData; const counts = {all: data.journeys.length};
    data.journeys.forEach(item => { counts[item.status] = (counts[item.status] || 0) + 1; });
    const items = data.journeys.filter(item => outcomeFilter === 'all' || item.status === outcomeFilter);
    const peak = Math.max(1, ...data.journeys.map(item => item.percent));
    $('#journeys-view-journeys').innerHTML = `<div class="route-filters" role="group" aria-label="Filter journeys by outcome">${[['all', 'All journeys'], ['reached', 'Reached the end'], ['stopped', 'Stopped'], ['continued', 'Kept going']].map(([name, label]) => `<button type="button" data-outcome="${name}" aria-pressed="${outcomeFilter === name}" ${counts[name] ? '' : 'disabled'}>${label} <span class="count">${counts[name] || 0}</span></button>`).join('')}</div>
      <ol class="route-cards">${items.slice(0, shown).map((item, index) => `<li class="route-card tone-${item.status}"><div class="route-card-head"><span class="route-rank">#${index + 1}</span>${outcome(item.status)}<span class="route-count"><strong>${number(item.players)}</strong> player${item.players === 1 ? '' : 's'} · ${percent(item.percent)}</span><progress class="progress mini route-share" max="${peak}" value="${item.percent}" aria-label="${percent(item.percent)} of players"></progress><button type="button" class="button small-button" data-journey="${data.journeys.indexOf(item)}">See players</button></div><div class="route-chain">${chain(item)}</div></li>`).join('') || '<li class="help">No journeys with this outcome.</li>'}</ol>
      ${items.length > shown ? `<div class="route-more"><button type="button" class="button" data-more>Show ${Math.min(12, items.length - shown)} more (${number(items.length - shown)} left)</button></div>` : ''}
      ${data.distinct > data.journeys.length ? `<p class="help">Showing the ${data.journeys.length} most common of ${number(data.distinct)} different journeys. Hide noisy events above to merge similar ones.</p>` : ''}`;
  };
  const drawExits = () => {
    const data = lastData;
    $('#journeys-view-exits').innerHTML = data.stopped ? `<p class="help">The last thing ${number(data.stopped)} player${data.stopped === 1 ? '' : 's'} did before they stopped, between “${escapeHTML(startName())}” and “${escapeHTML(endName())}”. Click one to see who they were.</p>
      <ol class="exit-list">${data.exits.map((item, index) => `<li class="exit-row"><span class="route-rank">#${index + 1}</span><span class="exit-label"><span class="route-step ${item.label === START_EXIT ? 'start' : ''}">${escapeHTML(exitText(item.label))}</span></span><progress class="progress mini exit-bar" max="100" value="${item.percent_of_stopped}" aria-label="${percent(item.percent_of_stopped)} of those who stopped"></progress><span class="exit-numbers"><strong>${number(item.players)}</strong> player${item.players === 1 ? '' : 's'}<br><span class="small muted">${percent(item.percent)} of all · ${percent(item.percent_of_stopped)} of stoppers</span></span><button type="button" class="button small-button" data-exit="${index}">See players</button></li>`).join('')}</ol>` : '<p class="help">Nobody stopped between these steps: everyone either reached the end or was still playing.</p>';
  };
  const drawViews = () => {
    $('#journeys-views').querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
    ['journeys', 'exits'].forEach(name => { $(`#journeys-view-${name}`).hidden = name !== state.view; });
    if (state.view === 'journeys') drawJourneys(); else drawExits();
  };
  container.addEventListener('click', event => {
    const unignore = event.target.closest('[data-unignore]'); if (unignore) { state.ignore = state.ignore.filter(name => name !== unignore.dataset.unignore); changed(); return; }
    const tab = event.target.closest('[data-view]'); if (tab && lastData) { state.view = tab.dataset.view; persist(); drawViews(); return; }
    const filter = event.target.closest('[data-outcome]'); if (filter && lastData) { outcomeFilter = filter.dataset.outcome; shown = 12; drawJourneys(); return; }
    if (event.target.closest('[data-more]') && lastData) { shown += 12; drawJourneys(); return; }
    const journey = event.target.closest('[data-journey]');
    if (journey && lastData) { const item = lastData.journeys[Number(journey.dataset.journey)]; showPlayers({steps: item.steps, status: item.status}, `Players on this journey: ${item.steps.join(' → ') || 'straight to the end'}`); return; }
    const exit = event.target.closest('[data-exit]');
    if (exit && lastData) { const item = lastData.exits[Number(exit.dataset.exit)]; showPlayers({exit: item.label}, `Players who ${exitText(item.label).replace(/^Left/, 'left')}`); }
  });

  async function showPlayers(target, title) {
    const wrap = $('#journeys-players-wrap'); wrap.hidden = false;
    $('#journeys-players-title').textContent = title; $('#journeys-players-note').textContent = ''; $('#journeys-players').innerHTML = skeleton('table', 5, 4);
    wrap.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    try {
      const data = await api(`${gameURL(game)}/insights/journeys/players`, {method: 'POST', body: JSON.stringify({...lastBody, target})});
      $('#journeys-players-note').textContent = `${number(data.total)} player${data.total === 1 ? '' : 's'}${data.total > data.players.length ? ` · showing the latest ${number(data.players.length)}` : ''} · open one to read their events`;
      $('#journeys-players').innerHTML = data.players.length ? `<div class="table-wrap"><table><thead><tr><th>Player</th><th>Outcome</th><th>What they did</th><th>Last event</th></tr></thead><tbody>${data.players.map(item => `<tr><td><a class="mono" href="${gamePath(game, 'players')}?${new URLSearchParams({player: item.player})}">${escapeHTML(shortId(item.player))}</a></td><td>${outcome(item.status)}</td><td class="route-cell">${escapeHTML(item.line || '—')}</td><td class="small muted">${displayDate(item.last_seen)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Nobody.</p>';
      $('#journeys-players-csv').onclick = () => downloadCSV(`${game.name}-journey-players.csv`, [['player', 'outcome', 'what_they_did', 'last_event'], ...data.players.map(item => [item.player, item.status, item.line, item.last_seen])]);
    } catch (error) { $('#journeys-players').innerHTML = loadError(error); }
  }

  async function run() {
    active = true;
    const ticket = ++latest;
    const steps = hooks.steps();
    const intro = $('#journeys-intro');
    if (steps.length < 2) { $('#journeys-views').hidden = true; intro.hidden = false; intro.textContent = 'Add at least two steps to your funnel first.'; return; }
    intro.hidden = false; intro.innerHTML = skeleton('table', 5, 3); $('#journeys-players-wrap').hidden = true;
    try {
      lastBody = {...hooks.query(), route_from: state.from, route_to: state.to, ignore: state.ignore, span: state.span};
      const data = await api(`${gameURL(game)}/insights/journeys`, {method: 'POST', body: JSON.stringify(lastBody)});
      if (ticket !== latest) return;
      $('#journeys-summary').innerHTML = data.started ? stats([['Started', number(data.started), `did “${escapeHTML(startName())}”`], ['Reached the end', number(data.reached), percent(100 * data.reached / data.started)], ['Stopped', number(data.stopped), percent(100 * data.stopped / data.started)], ['Kept going', number(data.continued), ''], ['Different journeys', number(data.distinct), '']]) : '';
      if (!data.started) { $('#journeys-views').hidden = true; intro.hidden = false; intro.textContent = 'Nobody did the start step with these days and filters.'; return; }
      lastData = data; outcomeFilter = 'all'; shown = 12;
      intro.hidden = true; $('#journeys-views').hidden = false; drawViews();
    } catch (error) { if (ticket === latest) { $('#journeys-views').hidden = true; intro.hidden = false; intro.innerHTML = loadError(error, 'data-retry-journeys'); } }
  }
  $('#journeys-run').addEventListener('click', run);
  $('#journeys-intro').addEventListener('click', event => { if (event.target.closest('[data-retry-journeys]')) run(); });
  drawControls();
  return {run, redraw: drawControls, refresh() { drawControls(); if (active) run(); }};
}

/* ─── Players and journeys ─── */

/* ─── Event rules: a reusable editor for "an event, optionally with a parameter test" ───
   Used on the Players page for "only players who…" conditions and for custom columns / sort keys,
   and shaped so any other page can reuse it (funnel-like steps, segments, cohorts…).

   mountRuleList({container, rules, catalog, blank, before, after, onChange, addLabel, empty})
     rules    the array the editor edits in place (each rule: {event, param, op, value, …})
     catalog  {events: [{name, params: [{key, values}]}]} from /insights/catalog
     before/  (rule, index) => html, inserted before / after the event fields; their controls carry
     after    data-rule-field="name" and are read back into the rule (numbers for type=number)
*/
function ruleOptions(items, chosen, blank) {
  const list = items.includes(chosen) || !chosen ? items : [chosen, ...items];
  return (blank === undefined ? '' : `<option value="">${escapeHTML(blank)}</option>`) + list.map(item => `<option value="${escapeHTML(item)}" ${item === chosen ? 'selected' : ''}>${escapeHTML(item)}</option>`).join('');
}
function ruleFields(rule, index, catalog) {
  const event = catalog.events.find(item => item.name === rule.event);
  const params = (event?.params || []).map(param => param.key);
  const values = event?.params.find(param => param.key === rule.param)?.values || [];
  const needsValue = rule.param && rule.op !== 'exists';
  return `<select class="rule-event" data-rule-field="event" aria-label="Event">${ruleOptions(catalog.events.map(item => item.name), rule.event, rule.event ? undefined : 'Pick an event…')}</select>
    <select class="rule-param" data-rule-field="param" aria-label="Only when this parameter…">${ruleOptions(params, rule.param, '+ only when a parameter…')}</select>
    ${rule.param ? `<select class="rule-op" data-rule-field="op" aria-label="Condition">${OPERATORS.map(([key, label]) => `<option value="${key}" ${key === (rule.op || 'eq') ? 'selected' : ''}>${label}</option>`).join('')}</select>${needsValue ? `<input class="rule-value" data-rule-field="value" aria-label="Value" placeholder="value" value="${escapeHTML(rule.value || '')}" list="rule-values-${index}"><datalist id="rule-values-${index}">${values.slice(0, 40).map(value => `<option value="${escapeHTML(value)}">`).join('')}</datalist>` : ''}` : ''}`;
}
function mountRuleList({container, rules, catalog, blank, before = () => '', after = () => '', onChange, addLabel = 'Add', empty = ''}) {
  const draw = () => {
    container.innerHTML = `${rules.length ? rules.map((rule, index) => `<div class="rule-row" data-rule="${index}">${before(rule, index)}${ruleFields(rule, index, catalog())}${after(rule, index, catalog())}<button type="button" class="icon-button rule-remove" data-rule-remove aria-label="Remove this rule" title="Remove">${icon('close', 14)}</button></div>`).join('') : `<p class="help">${empty}</p>`}<button type="button" class="button small-button" data-rule-add>${icon('plus', 13)} ${escapeHTML(addLabel)}</button>`;
  };
  container.addEventListener('change', event => {
    const row = event.target.closest('[data-rule]'); const field = event.target.dataset.ruleField;
    if (!row || !field) return;
    const rule = rules[Number(row.dataset.rule)];
    rule[field] = event.target.type === 'number' ? Number(event.target.value) || 1 : event.target.value;
    if (field === 'event') Object.assign(rule, {param: '', op: 'eq', value: '', of: ''});
    if (field === 'param') Object.assign(rule, {op: 'exists', value: ''});
    if (field === 'op' && rule.op === 'exists') rule.value = '';
    onChange(rules, ['event', 'param', 'op', 'agg', 'does'].includes(field)); 
  });
  container.addEventListener('click', event => {
    const row = event.target.closest('[data-rule]');
    if (event.target.closest('[data-rule-remove]') && row) { rules.splice(Number(row.dataset.rule), 1); onChange(rules, true); }
    if (event.target.closest('[data-rule-add]')) { rules.push(blank(catalog())); onChange(rules, true); }
  });
  draw();
  return {redraw: draw};
}

/* ─── Players: sortable list with custom event-based columns and "only players who…" rules ─── */

const AGG_LABELS = {count: 'How many times', max: 'Highest value', min: 'Lowest value', sum: 'Total of', first: 'First time', last: 'Last time'};
const ruleSubject = rule => `${rule.event}${rule.param ? ` · ${rule.param}${rule.op === 'exists' ? '' : ` ${operatorLabel(rule.op)} ${rule.value}`}` : ''}`;
function metricLabel(metric) {
  if (metric.label) return metric.label;
  if (['max', 'min', 'sum'].includes(metric.agg)) return `${{max: 'Highest', min: 'Lowest', sum: 'Total'}[metric.agg]} ${metric.of || metric.param || '?'} · ${metric.event}`;
  return `${{count: 'Times', first: 'First time', last: 'Last time'}[metric.agg]}: ${ruleSubject(metric)}`;
}
const metricValue = (metric, value, timezone = 'local') => value == null ? '—' : ['first', 'last'].includes(metric.agg) ? analysisDate(value, timezone) : number(value);
const usableRules = list => list.filter(rule => rule.event).map(({event, param, op, value, ...rest}) => ({event, param: param || '', op: param ? (op || 'eq') : 'eq', value: param && op !== 'exists' ? (value || '') : '', ...Object.fromEntries(Object.entries(rest).filter(([key]) => !key.startsWith('_')))}));
const BASE_SORTS = [['last_seen', 'Last active'], ['first_seen', 'First seen'], ['events', 'Events'], ['sessions', 'Sessions'], ['session_length', 'Session length'], ['playtime', 'Total playtime'], ['version', 'App version']];

async function renderPlayers() {
  const game = currentGame;
  const player = new URLSearchParams(location.search).get('player');
  if (player) return renderJourney(game, player);
  const viewKey = `avn-players-view-${game.id}`;
  const view = {sort: 'last_seen', order: 'desc', conditions: [], metrics: [], ...(storeGet(viewKey) || {})};
  let catalog = {events: []};
  shell('Players', heading('Players', 'A player uses user_id when available, otherwise device_id. Open one to read their events, sort the list, or add event-based columns.') +
    `<div id="filters"></div><div id="rule-bar"></div>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>Players <span class="count" id="player-count">0</span></h2></div><div class="quiet-actions">${freshStamp()}<div class="search">${icon('search',16)}<input id="player-search" type="search" aria-label="Search players" placeholder="Search by user or install ID…"></div></div></div>
      <div class="players-toolbar"><label class="inline-field">Sort by<select id="player-sort"></select></label><button type="button" class="button small-button" id="player-order"></button>
        <button type="button" class="button small-button rules-toggle" id="rules-toggle" aria-haspopup="dialog">${icon('funnel', 14)} Event rules <span class="count" id="rules-count" hidden></span></button>
      <div id="player-list">${skeleton('table', 8, 7)}</div></section><div id="rules-holder" hidden><div class="player-rules" id="player-rules">
          <section class="rule-section" id="conditions-section"><button type="button" class="rule-section-toggle" aria-expanded="true"><span class="rule-chevron">${icon('chevron', 15)}</span><span class="rule-section-title">Only show players who…</span><span class="count" id="conditions-count" hidden></span><span class="rule-section-note small muted" id="conditions-note"></span></button><div class="rule-section-body"><p class="help">Every rule here must be true. For example: <em>Did</em> <code>POWERUP_CONSUMED</code> at least 3 times, or <em>Never did</em> <code>SETTINGS_OPENED</code>.</p><div id="condition-list"></div></div></section>
          <section class="rule-section" id="metrics-section"><button type="button" class="rule-section-toggle" aria-expanded="true"><span class="rule-chevron">${icon('chevron', 15)}</span><span class="rule-section-title">Add a column (and sort by it)</span><span class="count" id="metrics-count" hidden></span><span class="rule-section-note small muted" id="metrics-note"></span></button><div class="rule-section-body"><p class="help">Pick what to work out for each player, from an event: how many times, the highest, lowest or total of one of its parameters, or when it first or last happened.</p><div id="metric-list"></div></div></section></div></div></div>`);
  const list = document.querySelector('#player-list');
  let offset = 0; let search = ''; let latest = 0; let chosen = null; let lastMetrics = [];
  const persist = () => storeSet(viewKey, view);
  const holder = document.querySelector('#rules-holder');
  // The rule editor opens in the inspector drawer, never inline; closing hands its lists back to the holder.
  const openRules = () => openDrawer(() => `${drawerHead('Player rules', 'Who to show, and extra columns')}<div class="db" id="rules-drawer-body"></div>`, {bind: drawer => drawer.querySelector('#rules-drawer-body').append(...holder.children), onClose: () => { holder.append(...document.querySelectorAll('#rules-drawer-body > *')); drawRuleBar(); }});
  document.querySelector('#rules-toggle').addEventListener('click', openRules);
  view.fold = view.fold || {};
  const foldSection = (id, name) => {
    const section = document.querySelector(id); const button = section.querySelector('.rule-section-toggle');
    const apply = () => { section.classList.toggle('collapsed', Boolean(view.fold[name])); button.setAttribute('aria-expanded', String(!view.fold[name])); };
    button.addEventListener('click', () => { view.fold[name] = !view.fold[name]; persist(); apply(); });
    apply();
  };
  foldSection('#conditions-section', 'conditions'); foldSection('#metrics-section', 'metrics');
  let lastTotal = null;
  const ruleSentence = rule => `<span class="sent"><span class="tok verb${rule.does === 'didnt' ? ' not' : ''}">${rule.does === 'didnt' ? 'didn’t do' : 'did'}</span><span class="tok">${escapeHTML(rule.event)}</span>${rule.param ? `<span>where</span><span class="tok">${escapeHTML(rule.param)}</span><span class="tok op">${escapeHTML(operatorLabel(rule.op))}</span>${rule.op === 'exists' ? '' : `<span class="tok val">${escapeHTML(rule.value)}</span>`}` : ''}${rule.does !== 'didnt' && (rule.min_times || 1) > 1 ? `<span>at least</span><span class="tok val">${rule.min_times}×</span>` : ''}</span>`;
  // The rule bar sits above the data and is never folded away: every rule that changes the list is on screen.
  function drawRuleBar() {
    const bar = document.querySelector('#rule-bar'); if (!bar) return;
    const used = view.conditions.map((rule, index) => [rule, index]).filter(([rule]) => rule.event);
    const metrics = view.metrics.map((rule, index) => [rule, index]).filter(([rule]) => rule.event);
    const count = lastTotal == null ? '' : `<span class="rb-count"><b>${number(lastTotal)}</b> player${lastTotal === 1 ? '' : 's'}</span>`;
    const extra = metrics.length ? `<div class="rb-cols"><span class="eyebrow">Extra columns</span>${metrics.map(([metric, index]) => `<span class="chip">${escapeHTML(metricLabel(metric))}<button type="button" data-metric-del="${index}" aria-label="Remove column ${escapeHTML(metricLabel(metric))}">×</button></span>`).join('')}</div>` : '';
    bar.innerHTML = used.length
      ? `<section class="rulebar" aria-label="Player rules"><div class="rb-h"><span class="rb-ic">${icon('funnel', 15)}</span><b class="ttl">Showing players who</b>${count}<button type="button" class="btn sm ghost" data-rules-clear>Clear rules</button></div><div class="rb-list">${used.map(([rule, index], position) => `${position ? '<div class="rjoin"><span class="join static">AND</span><span class="dim">players match every rule</span></div>' : ''}<div class="rrow">${ruleSentence(rule)}<span class="ra"><button type="button" class="icon-btn" data-rule-edit aria-label="Edit rule">${icon('edit', 15)}</button><button type="button" class="icon-btn" data-rule-del="${index}" aria-label="Remove rule">${icon('close', 15)}</button></span></div>`).join('')}<button type="button" class="rb-add" data-rule-edit>+ Add rule</button>${extra}</div></section>`
      : `<section class="rulebar" aria-label="Player rules"><div class="rb-empty"><span class="rb-ic">${icon('funnel', 15)}</span><b>${lastTotal == null ? 'All players' : `All ${number(lastTotal)} player${lastTotal === 1 ? '' : 's'}`}</b><span class="muted">No rules. Narrow the list by what people did.</span>${extra}<button type="button" class="btn sm rb-open" data-rule-edit>+ Add rule</button></div></section>`;
  }
  document.querySelector('#rule-bar').addEventListener('click', event => {
    if (event.target.closest('[data-rule-edit]')) { openRules(); return; }
    const del = event.target.closest('[data-rule-del]');
    if (del) { const index = Number(del.dataset.ruleDel); const [removed] = view.conditions.splice(index, 1); conditionList.redraw(); persist(); drawControls(); offset = 0; load(); toast('Rule removed', {label: 'Undo', run: () => { view.conditions.splice(index, 0, removed); conditionList.redraw(); persist(); drawControls(); offset = 0; load(); }}, 'info'); return; }
    const column = event.target.closest('[data-metric-del]');
    if (column) { const index = Number(column.dataset.metricDel); const [removed] = view.metrics.splice(index, 1); metricList.redraw(); persist(); drawControls(); offset = 0; load(); toast('Column removed', {label: 'Undo', run: () => { view.metrics.splice(index, 0, removed); metricList.redraw(); persist(); drawControls(); offset = 0; load(); }}, 'info'); return; }
    if (event.target.closest('[data-rules-clear]')) { const before = view.conditions.splice(0); conditionList.redraw(); persist(); drawControls(); offset = 0; load(); toast('Rules cleared', {label: 'Undo', run: () => { view.conditions.push(...before); conditionList.redraw(); persist(); drawControls(); offset = 0; load(); }}, 'info'); }
  });
  let pageRows = [];
  const rulesBody = () => ({conditions: usableRules(view.conditions).map(rule => ({...rule, does: rule.does || 'did', min_times: rule.min_times || 1})), metrics: usableRules(view.metrics).map(rule => ({...rule, agg: rule.agg || 'count'}))});

  const drawControls = () => {
    const metrics = rulesBody().metrics;
    const options = [...BASE_SORTS, ...metrics.map((metric, position) => [`metric${position}`, metricLabel(metric)])];
    if (!options.some(([key]) => key === view.sort)) view.sort = 'last_seen';
    document.querySelector('#player-sort').innerHTML = options.map(([key, label]) => `<option value="${key}" ${key === view.sort ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('');
    const timeSort = ['last_seen', 'first_seen', 'version'].includes(view.sort) || metrics[Number(view.sort.replace('metric', ''))]?.agg?.match(/first|last/);
    const orderLabel = ['session_length', 'playtime'].includes(view.sort)
      ? (view.order === 'desc' ? 'Longest first' : 'Shortest first')
      : (view.order === 'desc' ? (timeSort ? 'Newest first' : 'Highest first') : (timeSort ? 'Oldest first' : 'Lowest first'));
    document.querySelector('#player-order').innerHTML = `${view.order === 'desc' ? '↓' : '↑'} ${orderLabel}`;
    const conditions = rulesBody().conditions;
    const active = conditions.length + metrics.length;
    const count = document.querySelector('#rules-count'); count.hidden = !active; count.textContent = active;
    const part = (name, count, texts) => { const badge = document.querySelector(`#${name}-count`); badge.hidden = !count; badge.textContent = count; document.querySelector(`#${name}-note`).textContent = texts.join(' · '); };
    part('conditions', conditions.length, conditions.map(rule => `${rule.does === 'didnt' ? 'never' : 'did'} ${rule.event}${rule.param ? ` (${rule.param})` : ''}`));
    part('metrics', metrics.length, metrics.map(metricLabel));
    drawRuleBar();
  };
  const conditionList = mountRuleList({
    container: document.querySelector('#condition-list'), rules: view.conditions, catalog: () => catalog, addLabel: 'Add a condition', empty: 'No conditions yet.',
    blank: current => ({event: current.events[0]?.name || '', param: '', op: 'eq', value: '', does: 'did', min_times: 1}),
    before: rule => `<select class="rule-verb" data-rule-field="does" aria-label="Did or never did"><option value="did" ${rule.does !== 'didnt' ? 'selected' : ''}>Did</option><option value="didnt" ${rule.does === 'didnt' ? 'selected' : ''}>Never did</option></select>`,
    after: rule => rule.does === 'didnt' ? '' : `<span class="rule-times">at least <input type="number" min="1" max="100000" data-rule-field="min_times" aria-label="At least this many times" value="${rule.min_times || 1}"> time${(rule.min_times || 1) === 1 ? '' : 's'}</span>`,
    onChange: (rules, redraw) => { persist(); if (redraw) conditionList.redraw(); drawControls(); offset = 0; load(); },
  });
  const metricList = mountRuleList({
    container: document.querySelector('#metric-list'), rules: view.metrics, catalog: () => catalog, addLabel: 'Add a column', empty: 'No extra columns yet.',
    blank: current => ({event: current.events[0]?.name || '', param: '', op: 'eq', value: '', agg: 'count', of: ''}),
    before: rule => `<select class="rule-verb" data-rule-field="agg" aria-label="What to show">${Object.entries(AGG_LABELS).map(([key, label]) => `<option value="${key}" ${key === (rule.agg || 'count') ? 'selected' : ''}>${label}</option>`).join('')}</select>`,
    after: (rule, index, current) => ['max', 'min', 'sum'].includes(rule.agg) ? `<label class="rule-times">of this parameter <select class="rule-param" data-rule-field="of" aria-label="Which parameter">${ruleOptions((current.events.find(item => item.name === rule.event)?.params || []).map(param => param.key), rule.of || rule.param, 'pick…')}</select></label>` : '',
    onChange: (rules, redraw) => {
      rules.forEach(rule => { if (['max', 'min', 'sum'].includes(rule.agg) && !rule.of) rule.of = catalog.events.find(item => item.name === rule.event)?.params[0]?.key || ''; });
      persist(); if (redraw) metricList.redraw(); drawControls(); offset = 0; load();
    },
  });

  const load = async () => {
    if (!chosen) return;
    const ticket = ++latest;
    const body = rulesBody();
    lastMetrics = body.metrics;
    drawControls();
    const finishLoading = beginLoading(list, skeleton('table', 8, 7), {path: `${gameURL(game)}/insights/players`});
    const playersPath = `${gameURL(game)}/insights/players?${filterQuery(chosen)}&${new URLSearchParams({search, offset, sort: view.sort, order: view.order, ...(body.conditions.length || body.metrics.length ? {rules: JSON.stringify(body)} : {})})}`;
    // Coming back to a list seen a few minutes ago draws it at once, then updates it if anything changed.
    let shownOld = false;
    const showPlayers = (data, old) => {
      if (ticket !== latest) return;
      if (old) shownOld = true;
      filtersControl?.setContext(data.context || {});
      pageRows = data.players;
      document.querySelector('#player-count').textContent = number(data.total); lastTotal = data.total; markFresh(); drawRuleBar();
      if (!data.players.length) { list.innerHTML = empty(search || body.conditions.length ? 'No matching players' : 'No players', search || body.conditions.length ? 'Try another ID, or loosen the event rules.' : 'Pick other days or filters, or check that your game is sending events.', '', 'users'); return; }
      const link = row => `${gamePath(game, 'players')}?${new URLSearchParams({player: row.player})}`;
      const head = (key, label, extra = '') => `<th class="${extra} sortable ${view.sort === key ? 'sorted' : ''}" data-sort="${key}" aria-sort="${view.sort === key ? (view.order === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button">${escapeHTML(label)}<span class="sort-arrow">${view.sort === key ? (view.order === 'asc' ? '▲' : '▼') : ''}</span></button></th>`;
      list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Player</th>${head('events', 'Events', 'num')}${head('sessions', 'Sessions', 'num')}${head('session_length', 'Avg session', 'num')}${head('playtime', 'Total playtime', 'num')}${head('last_seen', 'Last active')}${body.metrics.map((metric, position) => head(`metric${position}`, metricLabel(metric), 'num metric')).join('')}${head('version', 'Version')}<th>Env</th><th>Country</th></tr></thead><tbody>${data.players.map(row => `<tr><td><a class="row-title" href="${link(row)}"><span class="mono">${escapeHTML(shortId(row.player))}</span></a><p class="small muted">${row.has_user_id ? 'User ID' : 'Install ID'} · ${platformLabel(row.platform || '—')}</p></td><td class="num">${number(row.events)}</td><td class="num">${number(row.sessions)}</td><td class="num">${duration(row.avg_session_seconds)}</td><td class="num">${duration(row.total_play_seconds)}</td><td class="small muted">${analysisDate(row.last_seen, chosen.timezone)}</td>${body.metrics.map((metric, position) => `<td class="num metric">${metricValue(metric, row.metrics[position], chosen.timezone)}</td>`).join('')}<td class="small">${escapeHTML(row.app_version || '—')}</td><td><span class="pill ${TEST_ENVIRONMENTS.includes(row.environment) ? '' : 'good'}">${escapeHTML(row.environment || '—')}</span></td><td class="small">${countryTag(row.country)}</td></tr>`).join('')}</tbody></table></div>
        <div class="pager"><span class="small muted">${number(offset + 1)}–${number(offset + data.players.length)} of ${number(data.total)}</span><span><button class="button" data-page="-1" ${offset ? '' : 'disabled'}>Previous</button> <button class="button" data-page="1" ${offset + data.players.length < data.total ? '' : 'disabled'}>Next</button></span></div>`;
    };
    try { await apiShowing(playersPath, showPlayers); }
    catch (error) { if (ticket === latest) { if (shownOld) toastError(error); else list.innerHTML = loadError(error); } }
    finally { finishLoading(); }
  };
  list.addEventListener('click', event => {
    // A player opens in the inspector drawer so the list keeps its place; Previous / Next walk this page of players.
    const link = event.target.closest('a[href*="player="]');
    if (link && event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
      const id = new URL(link.href, location.href).searchParams.get('player'); const index = pageRows.findIndex(row => row.player === id);
      if (index >= 0) { event.preventDefault(); renderJourney(game, id, {overlay: true, trigger: link, filters: chosen, browse: {index, total: pageRows.length, load: async position => pageRows[position]}}); return; }
    }
    const page = event.target.closest('[data-page]'); if (page) { offset = Math.max(0, offset + 50 * Number(page.dataset.page)); load(); return; }
    const header = event.target.closest('[data-sort]');
    if (header) { const key = header.dataset.sort; if (view.sort === key) view.order = view.order === 'desc' ? 'asc' : 'desc'; else { view.sort = key; view.order = 'desc'; } persist(); offset = 0; load(); }
  });
  document.querySelector('#player-sort').addEventListener('change', event => { view.sort = event.target.value; persist(); offset = 0; load(); });
  document.querySelector('#player-order').addEventListener('click', () => { view.order = view.order === 'desc' ? 'asc' : 'desc'; persist(); offset = 0; load(); });
  let typing;
  document.querySelector('#player-search').addEventListener('input', event => { clearTimeout(typing); typing = setTimeout(() => { search = event.target.value.trim(); offset = 0; load(); }, 250); });
  let filtersControl;
  filtersControl = mountFilters(document.querySelector('#filters'), game, async state => {
    chosen = state; offset = 0;
    try { catalog = await api(`${gameURL(game)}/insights/catalog?${filterQuery(state)}`); if (!list.isConnected) return; conditionList.redraw(); metricList.redraw(); } catch { catalog = {events: []}; }
    if (list.isConnected) load();
  });
}

/* ─── One player: every raw event (default) or their device info ─── */

function playerOperatingSystem(raw, platform) {
  const value = String(raw || '').trim();
  let match = value.match(/^Android(?: OS)?\s+([^ /]+)(?:\s*\/\s*API-(\d+))?(?:\s*\((.*)\))?$/i);
  if (match) return {name: 'Android', version: [match[1], match[2] && `API ${match[2]}`].filter(Boolean).join(' · '), build: match[3] || ''};
  match = value.match(/^(?:iPhone OS|iOS)\s+([^\s(]+)(?:\s*\((.*)\))?$/i);
  if (match) return {name: 'iOS', version: match[1], build: match[2] || ''};
  match = value.match(/^Mac OS X\s+([^\s(]+)(?:\s*\((.*)\))?$/i);
  if (match) return {name: 'macOS', version: match[1], build: match[2] || ''};
  return {name: platformLabel(platform || '') || '—', version: value, build: ''};
}

const playerTimezone = value => {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return value || '';
  const sign = minutes < 0 ? '−' : '+';
  return `UTC${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
};
const propertyLabel = key => key.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

function deviceCatalog(details) {
  if (!details) return '';
  if (details.loading) return '<div class="device-catalog loading">Looking up this model on Wikipedia…</div>';
  const labels = {manufacturer: 'Manufacturer', type: 'Device type', released: 'Released', os: 'Original OS', chipset: 'Chipset', cpu: 'CPU', gpu: 'GPU', ram: 'RAM options', storage: 'Storage options', expandable_storage: 'Expandable storage', display: 'Display', battery: 'Battery', dimensions: 'Dimensions', weight: 'Weight', network: 'Network'};
  const rows = Object.entries(labels).filter(([key]) => details.specs?.[key]).map(([key, label]) => `<div><dt>${label}</dt><dd>${escapeHTML(details.specs[key])}</dd></div>`).join('');
  return `<section class="device-catalog"><div class="device-catalog-head"><div><h3>${escapeHTML(details.matched_device || details.requested_model)}</h3><p>${escapeHTML(details.note || '')}</p></div><a class="text-link" href="${escapeHTML(details.source_url)}" target="_blank" rel="noopener noreferrer">Wikipedia source ${icon('arrow', 12)}</a></div><dl>${rows}</dl></section>`;
}

function playerInformation(data, timezone, fetchedDevice = null) {
  const info = data.info || {};
  const profile = info.properties || {};
  const os = playerOperatingSystem(profile.os_version, info.platform);
  const screen = profile.screen_width != null && profile.screen_height != null ? `${profile.screen_width} × ${profile.screen_height}` : '';
  const row = (label, value, mono = false) => value == null || value === '' ? '' : `<div><dt>${escapeHTML(label)}</dt><dd class="${mono ? 'mono' : ''}">${escapeHTML(value)}</dd></div>`;
  const group = (title, rows) => {
    const content = rows.filter(Boolean).join('');
    return content ? `<section><h3>${title}</h3><dl>${content}</dl></section>` : '';
  };
  const identity = group('Identity', [
    row('User ID', info.user_id, true),
    row('Install ID', info.device_id, true),
  ]);
  const device = group('Device', [
    row('Model', profile.device_model),
    row('Type', profile.device_type),
    row('Operating system', os.name),
    row('OS version', os.version),
    row('OS build', os.build, true),
    row('Screen', screen),
  ]);
  const context = group('App & location', [
    row('Location', info.country ? countryText(info.country) : ''),
    row('Language', profile.language),
    row('Player time zone', playerTimezone(profile.timezone_offset_minutes)),
    row('Platform', platformLabel(info.platform || '')),
    row('App version', info.app_version),
    row('Build', info.build),
    row('Environment', info.environment),
    row('Latest session', profile.session_number),
  ]);
  const known = new Set(['seq', 'environment', 'session_number', 'device_model', 'device_type', 'os_version', 'language', 'timezone_offset_minutes', 'screen_width', 'screen_height']);
  const other = group('Other collected properties', Object.entries(profile).filter(([key]) => !known.has(key)).map(([key, value]) => row(propertyLabel(key), value)));
  const updated = info.updated_at ? `Latest information · ${analysisDate(info.updated_at, timezone)}` : 'No profile information collected';
  const lookup = profile.device_model ? `<button type="button" class="button small-button" id="fetch-device-info">${icon('search', 14)} Fetch device info</button>` : '';
  return `<section class="panel player-information"><div class="panel-header"><div><h2>Player information</h2><p>${escapeHTML(updated)} · location is IP-derived country${profile.device_model ? ' · lookup sends the device model to Wikipedia only when pressed' : ''}</p></div>${lookup}</div><div class="player-information-grid">${identity}${device}${context}${other}</div><div id="device-specs-result">${deviceCatalog(fetchedDevice)}</div></section>`;
}

async function renderJourney(game, player, options = {}) {
  const container = options.pane || (options.overlay ? drawerEls().drawer : document);
  const embedded = Boolean(options.overlay || options.pane);  // not a page of its own
  const returnScroll = {left: window.scrollX, top: window.scrollY, behavior: 'instant'};
  const content = `<a class="back-link" href="${gamePath(game, 'players')}">← Back to players</a>` + heading('Player', player) +
    `<div class="filter-bar"><div id="story-range"></div><div class="segmented timezone-toggle" role="group" aria-label="Player event time zone"><button type="button" data-story-timezone="local">Local</button><button type="button" data-story-timezone="utc">UTC</button></div></div><div class="analysis-context" id="story-context"></div><div id="story-metrics"></div>
    <div class="range-modes route-tabs" role="group" aria-label="View"><button type="button" data-story-view="raw">Raw events</button><button type="button" data-story-view="analysis">Event Analysis</button><button type="button" data-story-view="info">Player info</button></div>
    <div id="story-body"></div>`;
  if (options.pane) {
    const pane = options.pane;
    pane.querySelector('[data-range-picker]')?._flatpickr?.destroy();
    pane.innerHTML = '<div class="player-pane-head"><h2 id="pane-title">Player timeline</h2><button type="button" class="button small-button" data-close-player aria-label="Close player timeline">Close ×</button></div>' + content;
    pane.querySelector('.back-link').remove();
    pane.querySelector('[data-close-player]').addEventListener('click', () => options.onClose?.());
    if (options.browse) {
      const controls = document.createElement('div');
      controls.className = 'player-browse';
      controls.innerHTML = '<button type="button" class="button small-button" data-player-previous>← Previous</button><span data-player-position aria-live="polite"></span><button type="button" class="button small-button" data-player-next>Next →</button>';
      pane.querySelector('.player-pane-head').insertBefore(controls, pane.querySelector('[data-close-player]'));
    }
  } else if (options.overlay) {
    // The inspector drawer: the list keeps its place behind it, and closing returns focus to the row.
    const drawer = drawerEls().drawer;
    const rangePicker = () => drawer.querySelector('[data-range-picker]')?._flatpickr;
    openDrawer(() => `<div class="dh"><div class="sp1"><h2 id="drawer-title">Player details</h2><span class="sub">${escapeHTML(shortId(player))}</span></div><span class="player-browse-slot"></span><button type="button" class="icon-btn" data-close-player aria-label="Close player details">${icon('close', 16)}</button></div><div class="db">${content}</div>`, {onClose: () => {
      latest++; rangePicker()?.destroy();
      if (options.trigger?.isConnected) { options.trigger.focus({preventScroll: true}); window.scrollTo(returnScroll); }
    }});
    drawer.classList.add('player-drawer');
    drawer.querySelector('.back-link').remove();
    drawer.querySelector('[data-close-player]').addEventListener('click', closeDrawer);
    if (options.browse) {
      const controls = document.createElement('div');
      controls.className = 'player-browse';
      controls.innerHTML = '<button type="button" class="btn sm" data-player-previous>‹ Previous</button><span data-player-position aria-live="polite"></span><button type="button" class="btn sm" data-player-next>Next ›</button>';
      drawer.querySelector('.player-browse-slot').replaceWith(controls);
    }
  } else {
    shell('Player', content);
  }
  const preferredView = embedded ? storeGet(`avn-story-view-${game.id}`) : new URLSearchParams(location.search).get('view') || storeGet(`avn-story-view-${game.id}`);
  let view = ['info', 'analysis'].includes(preferredView) ? preferredView : 'raw';
  let timelineController = null;
  const saved = options.filters || filterState(game);
  let latest = 0;
  let range = null; let timezone = saved.timezone; let fetchedDevice = null;
  const body = container.querySelector('#story-body');
  const isOpen = () => options.pane ? body.isConnected : !drawerEls().drawer.hidden && body.isConnected;
  let playerIndex = options.browse?.index ?? 0;
  let browsing = false;
  // Opened from a level: the timeline starts at the player's last event on it.
  let focus = options.focus || null;
  const syncBrowse = () => {
    if (!options.browse || !body.isConnected) return;
    container.querySelector('[data-player-previous]').disabled = browsing || playerIndex === 0;
    container.querySelector('[data-player-next]').disabled = browsing || playerIndex >= options.browse.total - 1;
    container.querySelector('[data-player-position]').textContent = browsing ? 'Loading player…' : `${number(playerIndex + 1)} of ${number(options.browse.total)}`;
  };
  const changePlayer = async direction => {
    if (browsing || !options.browse) return;
    const index = playerIndex + direction;
    if (index < 0 || index >= options.browse.total) return;
    browsing = true; syncBrowse();
    const ticket = ++latest;
    try {
      const next = await options.browse.load(index);
      if (ticket !== latest || !body.isConnected || !isOpen()) return;
      if (!next) throw new Error('This player list changed. Close and reopen the group to refresh it.');
      player = next.player; playerIndex = index; fetchedDevice = null;
      focus = options.browse.focus ? options.browse.focus(next) : null;
      container.querySelector('.page-heading p').textContent = player;
      container.querySelector('#story-metrics').innerHTML = '';
      options.onPlayer?.(player);
      draw();
      (options.pane || container.querySelector('.db') || container).scrollTop = 0;
    } catch (error) { if (body.isConnected && isOpen()) toastError(error); }
    finally { browsing = false; syncBrowse(); }
  };
  container.querySelector('[data-player-previous]')?.addEventListener('click', () => changePlayer(-1));
  container.querySelector('[data-player-next]')?.addEventListener('click', () => changePlayer(1));
  syncBrowse();
  const tabs = () => container.querySelectorAll('[data-story-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.storyView === view)));
  const rememberView = next => {
    view = next; storeSet(`avn-story-view-${game.id}`, view); tabs();
    if (!embedded) { const url = new URL(location.href); view === 'raw' ? url.searchParams.delete('view') : url.searchParams.set('view', view); history.replaceState(null, '', url); }
  };
  container.addEventListener('click', event => { if (event.target.closest('[data-retry-story]')) { cache.clear(); draw(); } });
  const draw = async () => {
    const ticket = ++latest;
    timelineController = null;
    tabs();
    container.querySelectorAll('[data-story-timezone]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.storyTimezone === timezone)));
    container.querySelector('#story-context').textContent = `${timezone === 'utc' ? 'UTC' : 'Local time'} · player ID = user_id, otherwise device_id`;
    container.querySelector('#story-metrics').innerHTML = skeleton('stats');
    body.innerHTML = skeleton('table', 5, 2);
    const rawPromise = view === 'info' ? null : renderRawEvents(game, player, range, timezone, container, focus, {view, onView: rememberView, onReady: controller => {if (ticket === latest) timelineController = controller;}}).catch(error => {
      if (ticket === latest && body.isConnected) body.innerHTML = loadError(error, 'data-retry-story');
    });
    try {
      const data = await api(`${gameURL(game)}/insights/story?${new URLSearchParams({start: range.from, end: range.to, player, tz_offset: timezone === 'utc' ? 0 : localTimezoneOffset()})}`);
      if (ticket !== latest || !body.isConnected) return;
      container.querySelector('#story-metrics').innerHTML = stats([['Sessions', number(data.sessions), data.first_seen ? `${analysisDate(data.first_seen, timezone)} → ${analysisDate(data.last_seen, timezone)}` : ''], ['Events', number(data.events), ''], ['Play time', duration(data.total_play_seconds), data.average_session_seconds != null ? `${duration(data.average_session_seconds)} average session` : ''], ['Highest level', data.highest_level != null ? number(data.highest_level) : '—', '']]);
      if (view === 'info') {
        body.innerHTML = playerInformation(data, timezone, fetchedDevice);
        const fetchButton = body.querySelector('#fetch-device-info');
        fetchButton?.addEventListener('click', async () => {
          const requestedPlayer = player;
          fetchButton.disabled = true; fetchButton.textContent = 'Fetching…';
          const result = body.querySelector('#device-specs-result');
          result.innerHTML = deviceCatalog({loading: true});
          try {
            const device = await api(`${gameURL(game)}/insights/device-specs?${new URLSearchParams({player: requestedPlayer})}`);
            if (player !== requestedPlayer || !result.isConnected) return;
            fetchedDevice = device;
            result.innerHTML = deviceCatalog(fetchedDevice);
            fetchButton.textContent = 'Device info fetched';
          } catch (error) {
            result.innerHTML = deviceCatalog(fetchedDevice);
            toastError(error);
            fetchButton.disabled = false; fetchButton.textContent = 'Try device lookup again';
          }
        });
        return;
      }
      if (rawPromise) await rawPromise;
    } catch (error) { if (ticket === latest && body.isConnected) { container.querySelector('#story-metrics').innerHTML = loadError(error, 'data-retry-story'); if (!rawPromise) body.innerHTML = '';  } }
  };
  container.querySelector('[aria-label="View"]').addEventListener('click', event => {
    const tab = event.target.closest('[data-story-view]');
    if (tab && range) {
      const reuseTimeline = timelineController && tab.dataset.storyView !== 'info' && view !== 'info';
      rememberView(tab.dataset.storyView);
      if (reuseTimeline) {timelineController.setView(view); return;}
      // Cross-fade between views where the browser can.
      document.startViewTransition ? document.startViewTransition(() => draw()) : draw();
    }
  });
  container.querySelector('[aria-label="Player event time zone"]').addEventListener('click', event => {
    const button = event.target.closest('[data-story-timezone]');
    if (!button || button.dataset.storyTimezone === timezone) return;
    timezone = button.dataset.storyTimezone;
    if (!embedded) saveFilters(game, {...filterState(game), timezone});
    if (range) draw();
  });
  const rangeBox = container.querySelector('#story-range');
  rangeBox.innerHTML = compactRangeMarkup();
  bindRange(rangeBox, next => { range = next; draw(); }, saved.range?.preset || '30', saved.range);
}

// The sessions of a timeline, in order; a session is a run of events with the same session_id.
function timelineSessions(events) {
  const sessions = [];
  events.forEach((event, index) => {
    const previous = events[index - 1];
    const gap = previous ? (Date.parse(event.client_ts) - Date.parse(previous.client_ts)) / 1000 : null;
    if (!sessions.length || sessions[sessions.length - 1].id !== event.session_id) sessions.push({id: event.session_id, items: []});
    sessions[sessions.length - 1].items.push({...event, gap, index, session: sessions.length - 1});
  });
  return sessions;
}

// One button per session, to read a single session; "All sessions" shows the whole timeline.
function sessionPickerHTML(sessions, chosen, timezone, focus) {
  if (sessions.length < 2) return '';
  const levels = session => {
    const numbers = session.items.map(item => item.level).filter(level => level != null);
    if (!numbers.length) return 'no levels';
    const low = Math.min(...numbers); const high = Math.max(...numbers);
    return low === high ? `level ${low}` : `levels ${low}–${high}`;
  };
  const chips = sessions.map((session, index) => {
    const first = session.items[0].client_ts; const last = session.items[session.items.length - 1].client_ts;
    const quit = focus && session.items.some(item => item.event_id === focus.event);
    return `<button type="button" class="session-chip" data-session-pick="${index}" aria-pressed="${chosen === String(index)}"><strong>Session ${index + 1}${quit ? ` <span class="pill">${escapeHTML(focus.label)}</span>` : ''}</strong><span>${analysisDate(first, timezone)} · ${duration((Date.parse(last) - Date.parse(first)) / 1000)} · ${levels(session)}</span></button>`;
  }).join('');
  return `<label class="compact-session-picker">Session<select data-session-select><option value="all" ${chosen === 'all' ? 'selected' : ''}>All ${number(sessions.length)} sessions</option>${sessions.map((session, index) => `<option value="${index}" ${chosen === String(index) ? 'selected' : ''}>Session ${index + 1} · ${analysisDate(session.items[0].client_ts, timezone)}</option>`).join('')}</select></label><span class="session-picker-label" id="session-picker-label">Sessions</span><div class="session-chips" role="group" aria-labelledby="session-picker-label"><button type="button" class="session-chip" data-session-pick="all" aria-pressed="${chosen === 'all'}"><strong>All sessions</strong><span>${number(sessions.length)} sessions</span></button>${chips}</div>`;
}

async function renderRawEvents(game, player, range, timezone, container = document, focus = null, options = {}) {
  const saved = storeGet(`avn-highlights-${game.id}`) || {};
  const highlights = saved.rules || [];
  let mode = saved.mode || 'highlight';
  let painted = false; // the entrance animation plays once; later redraws (toggles, edits) must not blink
  let freshRule = -1; // a rule you just added opens for editing; the rest stay folded
  let events = []; let current = -1; let complete = false; let loadFailure = '';
  let sessions = []; let shownSession = 'all'; let focusIndex = -1;
  let analysisView = options.view === 'analysis'; let library = null;
  const visible = index => shownSession === 'all' || events[index]?.session === Number(shownSession);
  const persist = () => storeSet(`avn-highlights-${game.id}`, {rules: highlights, mode});
  // Parameters you never read (random IDs, counters) can be hidden; keys are matched case-insensitively.
  const paramState = {hidden: ['seq', 'attempt_id'], showAll: false, group: false, ...(storeGet(`avn-timeline-params-${game.id}`) || {})};
  const hiddenParams = new Set(paramState.hidden);
  const saveParams = () => storeSet(`avn-timeline-params-${game.id}`, {hidden: [...hiddenParams], showAll: paramState.showAll, group: paramState.group});
  container.querySelector('#story-body').innerHTML = `<section class="panel raw-timeline"><div class="panel-header"><div><h2 id="player-events-title">Timeline</h2><p id="player-events-description">Every event, grouped by session · times in ${timezone === 'utc' ? 'UTC' : 'your local time'} · the gap is the time since the previous event</p></div>
    <div class="segmented" role="group" aria-label="Timeline mode"><button type="button" data-timeline-mode="highlight">Highlight timeline</button><button type="button" data-timeline-mode="filter">Filter timeline</button></div></div>
    <p class="timeline-focus-note panel-body" id="timeline-focus" role="status" hidden></p>
    <div class="session-picker panel-body" id="session-picker" hidden></div>
    <div class="param-bar panel-body" id="timeline-parameters"><div class="segmented" role="group" aria-label="Parameters shown"><button type="button" data-param-view="clean">Hide noise</button><button type="button" data-param-view="all">Show all</button></div><details class="param-chooser" data-disclosure="param-chooser"><summary>Choose parameters <span class="small muted" id="param-summary"></span></summary><div class="param-list" id="param-list"></div></details><label class="check-row" for="group-repeats"><input type="checkbox" id="group-repeats"> Group repeated events</label></div>
    <div class="highlight-actions panel-body" id="highlight-actions"><div class="highlight-add-row"><button type="button" class="button small-button" id="highlight-add">+ Highlight</button><span class="small muted">Quick:</span>${HIGHLIGHT_PRESETS.map(([key, label]) => `<button type="button" class="button small-button" data-highlight-preset="${key}">+ ${label}</button>`).join('')}</div></div>
    <div class="highlight-summary panel-body" id="highlight-summary" hidden></div>
    <details class="panel-body highlight-setup" id="timeline-highlights" data-disclosure="highlight-setup"><summary>Highlight rules <span class="small muted" id="highlight-rule-summary"></span></summary><div class="highlight-setup-body"><p class="help">1. Choose an event. 2. Add parameters if you want a specific type or action. 3. Save the rule to reuse it. For example: AD_ANALYSIS with AD_TYPE = interstitial and STAGE = shown. Use the parameter names and values your game actually sends.</p><div class="highlight-library" id="highlight-library"></div><div id="highlight-rules"></div></div></details>
    <div class="highlight-navigation" hidden><label for="highlight-selection">Navigate</label><div class="highlight-navigation-controls"><select id="highlight-selection"><option value="all">All highlights</option></select><div class="highlight-navigation-buttons" role="group" aria-label="Navigate matching events"><button type="button" class="button" id="highlight-previous" title="Shortcut: K">← Previous</button><button type="button" class="button" id="highlight-next" title="Shortcut: J">Next →</button></div><span id="highlight-position" role="status" aria-live="polite"></span><span class="small muted">Keys: J next · K previous</span></div></div>
    <div class="toolbar" id="timeline-search"><div class="search">${icon('search',16)}<input id="journey-filter" type="search" aria-label="Filter events" placeholder="Filter by event or parameter…"></div></div>
    <p class="help panel-body" id="timeline-load" role="status"></p><div class="panel-body" id="event-analysis" hidden></div><div class="panel-body" id="journey">${skeleton('table', 6, 3)}</div></section>`;
  const root = container.querySelector('#story-body');
  const disclosures = mountDisclosures(root, `avn-raw-disclosures-${game.id}-${player}`);
  const box = root.querySelector('#journey'); const search = root.querySelector('#journey-filter');
  const rulesBox = root.querySelector('#highlight-rules'); const selection = root.querySelector('#highlight-selection');
  let catalog = {events: []};
  const matches = highlightMatches;
  const selectedMatches = () => highlightMatchIndices(events, highlights, selection.value).filter(visible);
  const updateNavigation = () => {
    const indices = selectedMatches(); const position = indices.indexOf(current);
    root.querySelector('#highlight-position').textContent = `${position < 0 ? '0' : number(position + 1)} / ${number(indices.length)} matching events${complete ? '' : ' · loading timeline…'}`;
    root.querySelector('#highlight-previous').disabled = !indices.length || mode !== 'highlight';
    root.querySelector('#highlight-next').disabled = !indices.length || mode !== 'highlight';
  };
  // How much of the timeline each highlight covers, and where along it the matches fall.
  let summaryPainted = false;
  const drawSummary = () => {
    const active = highlights.map((rule, index) => ({rule, index})).filter(({rule}) => rule.enabled !== false && !conditionError(rule.conditions));
    const scoped = events.flatMap((event, index) => visible(index) ? [{event, index}] : []);
    const summary = root.querySelector('#highlight-summary');
    summary.hidden = analysisView || mode !== 'highlight' || !active.length || !scoped.length;
    if (summary.hidden) return;
    summary.classList.toggle('settled', summaryPainted); summaryPainted = true;
    const sessionIds = new Set(scoped.map(({event}) => event.session_id));
    const cards = active.map(({rule, index}) => {
      const hits = scoped.map(({event}) => event).filter(event => matches(event, rule));
      const inSessions = new Set(hits.map(event => event.session_id)).size;
      const share = 100 * hits.length / scoped.length;
      return `<div class="highlight-card highlight-${rule.color}"><div class="highlight-card-head"><span class="highlight-dot" aria-hidden="true"></span><span class="highlight-card-name">${escapeHTML(rule.label || `Highlight ${index + 1}`)}</span><strong>${number(hits.length)}</strong></div><div class="highlight-bar" aria-hidden="true"><i data-width="${Math.max(share, hits.length ? 1.5 : 0)}"></i></div><span class="small muted">${percent(share)} of ${number(scoped.length)} events · in ${number(inSessions)} of ${number(sessionIds.size)} session${sessionIds.size === 1 ? '' : 's'}</span></div>`;
    }).join('');
    const ticks = scoped.flatMap(({event, index}, position) => {
      const rule = active.find(({rule}) => matches(event, rule))?.rule;
      return rule ? [`<button type="button" class="highlight-tick highlight-${rule.color}" data-left="${scoped.length > 1 ? 100 * position / (scoped.length - 1) : 0}" data-timeline-jump="${index}" aria-label="Go to ${escapeHTML(event.name)}, event ${index + 1}" title="${escapeHTML(event.name)} · event ${index + 1}"></button>`] : [];
    }).slice(0, 3000).join('');
    summary.innerHTML = `<div class="highlight-cards">${cards}</div><div class="highlight-map" role="group" aria-label="Where highlights fall in this player's timeline"><span class="small muted">Start</span><div class="highlight-track">${ticks}</div><span class="small muted">Latest</span></div>`;
    setWidths(summary);
    summary.querySelectorAll('[data-left]').forEach(tick => { tick.style.left = `${tick.dataset.left}%`; }); // CSP: no inline style attributes
  };
  const jumpTo = index => {
    if (!visible(index)) { shownSession = String(events[index].session); draw(); }
    current = index;
    box.querySelector('.timeline-current')?.classList.remove('timeline-current');
    const target = box.querySelector(`[data-timeline-index="${current}"]`);
    if (target) target.closest('.journey-session').open = true;
    disclosures.remember();
    target?.classList.add('timeline-current', 'jump-pulse'); setTimeout(() => target?.classList.remove('jump-pulse'), 800);
    target?.focus({preventScroll: true});
    // Centre it in its own scroll area; in the level page's pane only the pane moves, not the page.
    const pane = root.closest?.('.player-pane');
    if (target && pane) { const at = target.getBoundingClientRect(); const area = pane.getBoundingClientRect(); pane.scrollTop += at.top - area.top - (pane.clientHeight - at.height) / 2; }
    else target?.scrollIntoView({block: 'center', behavior: 'instant'});
    updateNavigation();
  };
  const analysis = mountPlayerEventAnalysis(root.querySelector('#event-analysis'), {timezone,
    onJump: index => {
      analysisView = false; mode = 'highlight';
      focus = {event: events[index].event_id, label: 'Selected from Event Analysis'}; focusIndex = index;
      options.onView?.('raw'); persist(); draw(); jumpTo(index);
    },
    onHighlight: rule => {
      if (highlights.length >= 20) {toast('Use at most 20 highlights.'); return;}
      highlights.push(rule); freshRule = highlights.length - 1;
      analysisView = false; mode = 'highlight'; options.onView?.('raw');
      persist(); drawRules(); draw(); root.querySelector('#timeline-highlights').open = true;
    },
  });
  const rowFor = (item, run = null) => {
          const hits = mode === 'highlight' ? highlights.flatMap((rule, index) => matches(item, rule) ? [{...rule, index}] : []) : [];
          const lit = new Set(hits.flatMap(rule => matchingConditionParams(item, rule.conditions)));
          const quiet = [];
          const chips = Object.entries(item.params).map(([key, value]) => {
            if (!paramState.showAll && hiddenParams.has(key.toLowerCase()) && !lit.has(key)) { quiet.push(key); return ''; }
            const hit = hits.find(rule => matchingConditionParams(item, rule.conditions).includes(key));
            const off = hiddenParams.has(key.toLowerCase());
            return `<span class="chip ${hit ? `highlight-ink highlight-${hit.color}` : ''} ${off ? 'chip-off' : ''}"><button type="button" class="chip-key" data-hide-param="${escapeHTML(key)}" title="${off ? `Show ${escapeHTML(key)} again in clean view` : `Hide ${escapeHTML(key)} in every event`}">${escapeHTML(key)}</button> <span title="${escapeHTML(typeof value === 'object' ? JSON.stringify(value) : value)}">${escapeHTML(chipValue(value))}</span></span>`;
          }).join('') + (quiet.length ? `<button type="button" class="chip chip-more" data-param-view="all" title="Hidden: ${escapeHTML(quiet.join(', '))}. Click to show all parameters.">+${quiet.length}</button>` : '');
          const params = item.name === 'session_start' && Object.keys(item.params).length ? `<details class="chip-collapse" ${lit.size ? 'open' : ''}><summary>${escapeHTML(sessionStartSummary(item.params))}</summary>${chips}</details>` : chips;
          const last = run?.[run.length - 1];
          const span = last ? `<span class="small muted">${clock(item.client_ts, timezone)}–${clock(last.client_ts, timezone)} · ${duration((Date.parse(last.client_ts) - Date.parse(item.client_ts)) / 1000)}</span>` : '';
          const focused = item.index === focusIndex;
          return `<li data-timeline-index="${item.index}" tabindex="-1" class="${run ? 'timeline-run' : ''} ${hits.length ? `timeline-match highlight-${hits[0].color}` : ''} ${focused ? 'timeline-focus' : ''} ${current === item.index && mode === 'highlight' ? 'timeline-current' : ''}"><time datetime="${escapeHTML(item.client_ts)}">${clock(item.client_ts, timezone)}</time><span class="journey-gap ${item.gap > 60 ? 'long' : ''}">${item.gap == null ? '' : `+${duration(item.gap)}`}</span><span class="journey-name">${escapeHTML(item.name)}${run ? `<span class="chip chip-count" title="${run.length} identical events in a row">×${run.length}</span>` : ''}${focused ? `<span class="highlight-tag focus-tag">${escapeHTML(focus.label)}</span>` : ''}${hits.map(rule => `<span class="highlight-tag highlight-${rule.color}">${escapeHTML(rule.label || `Highlight ${rule.index + 1}`)}</span>`).join('')}</span><span class="journey-params">${params}${span}</span></li>`;
  };
  // Runs of 3+ identical, un-highlighted events fold into one "×N" row (opt-in; highlighted events always stay visible so navigation works).
  const runKey = item => {
    if (item.index === focusIndex || (mode === 'highlight' && highlights.some(rule => matches(item, rule)))) return null;
    const shown = Object.entries(item.params).filter(([key]) => paramState.showAll || !hiddenParams.has(key.toLowerCase()));
    return `${item.name}|${JSON.stringify(shown)}`;
  };
  const rowsFor = items => {
    const rows = [];
    for (let start = 0; start < items.length;) {
      const key = paramState.group ? runKey(items[start]) : null;
      let end = start + 1;
      if (key) while (end < items.length && runKey(items[end]) === key) end++;
      if (end - start >= 3) rows.push(rowFor(items[start], items.slice(start, end)));
      else for (let index = start; index < end; index++) rows.push(rowFor(items[index]));
      start = end;
    }
    return rows.join('');
  };
  const draw = () => {
    if (!box.isConnected) return;
    disclosures.remember();
    root.querySelector('#player-events-title').textContent = analysisView ? 'Event Analysis' : 'Timeline';
    root.querySelector('#player-events-description').textContent = analysisView ? 'What this player called, and how often · counts follow the session selected below' : `Every event, grouped by session · times in ${timezone === 'utc' ? 'UTC' : 'your local time'} · the gap is the time since the previous event`;
    root.querySelector('[aria-label="Timeline mode"]').hidden = analysisView;
    root.querySelector('#timeline-parameters').hidden = analysisView;
    root.querySelector('#event-analysis').hidden = !analysisView;
    box.hidden = analysisView;
    root.querySelector('#highlight-actions').hidden = analysisView || mode !== 'highlight';
    root.querySelector('#group-repeats').checked = Boolean(paramState.group);
    root.querySelector('#timeline-highlights').hidden = analysisView || mode !== 'highlight';
    root.querySelector('.highlight-navigation').hidden = analysisView || mode !== 'highlight' || !highlights.some(rule => rule.enabled !== false && !conditionError(rule.conditions));
    root.querySelector('#timeline-search').hidden = analysisView || mode !== 'filter';
    root.querySelector('#timeline-load').hidden = analysisView;
    root.querySelectorAll('[data-param-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paramView === (paramState.showAll ? 'all' : 'clean'))));
    root.querySelectorAll('[data-timeline-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.timelineMode === mode)));
    root.querySelector('#timeline-load').textContent = loadFailure || `${number(events.length)} events ${complete ? 'in the full selected date range' : 'loaded · loading the rest of the timeline…'}`;
    root.querySelector('#timeline-load').classList.toggle('error', Boolean(loadFailure));
    highlights.forEach((rule, index) => {
      const count = rulesBox.querySelector(`[data-highlight-count="${index}"]`);
      const valid = !conditionError(rule.conditions);
      const matching = valid ? events.filter((event, index) => visible(index) && eventMatchesCondition(event, rule.conditions)).length : 0;
      if (count) count.textContent = `${rule.enabled === false ? 'Off · ' : ''}${number(matching)} matches${complete ? '' : ' so far'}`;
      const error = rulesBox.querySelector(`[data-highlight-error="${index}"]`);
      if (error) error.textContent = conditionError(rule.conditions);
      const preview = rulesBox.querySelector(`[data-highlight-preview="${index}"]`);
      if (preview) preview.textContent = `Highlights when ${describeHighlight(rule.conditions)}.`;
    });
    const query = mode === 'filter' ? search.value.trim().toLowerCase() : '';
    const picker = root.querySelector('#session-picker');
    picker.innerHTML = sessionPickerHTML(sessions, shownSession, timezone, focus);
    picker.hidden = sessions.length < 2;
    const focusNote = root.querySelector('#timeline-focus');
    focusNote.hidden = analysisView || !focus;
    if (focus) focusNote.innerHTML = focusIndex >= 0 ? `<span>${escapeHTML(focus.label)} is marked in the timeline.</span><button type="button" class="button small-button" data-timeline-jump="${focusIndex}">Go to it</button>` : `<span>${complete ? `${escapeHTML(focus.label)} is not in these dates.` : `Finding ${escapeHTML(focus.label.toLowerCase())}…`}</span>`;
    if (analysisView) {analysis.update(events, shownSession, complete, loadFailure); root.querySelector('#highlight-summary').hidden = true; disclosures.refresh(); return;}
    let shownSessions = 0;
    box.innerHTML = sessions.map((session, index) => {
      if (shownSession !== 'all' && index !== Number(shownSession)) return '';
      const items = session.items.filter(item => !query || `${item.name} ${JSON.stringify(item.params)}`.toLowerCase().includes(query));
      if (!items.length) return '';
      const start = session.items[0].client_ts; const end = session.items[session.items.length - 1].client_ts;
      const gap = session.items[0].gap;
      const divider = shownSessions++ ? `<div class="session-break" role="separator" aria-label="Session break before session ${index + 1}"><span aria-hidden="true">Session break</span></div>` : '';
      const sessionGap = gap == null ? '' : `<span class="session-gap">${duration(gap)} after previous session</span>`;
      return `${divider}<details class="journey-session" data-disclosure="session-${escapeHTML(session.id)}-${index}" open><summary class="journey-session-head"><strong>Session ${index + 1}</strong><span>${analysisDate(start, timezone)} · ${duration((Date.parse(end) - Date.parse(start)) / 1000)} · ${number(session.items.length)} events</span>${sessionGap}</summary>
        <ol class="journey-events">${rowsFor(items)}</ol></details>`;
    }).join('') || `<p class="help">${events.length ? 'No events match the filter.' : complete ? 'No events from this player in these days.' : 'Loading events…'}</p>`;
    if (events.length) { if (painted) box.classList.toggle('settled', true); painted = true; }
    disclosures.refresh(); updateNavigation(); drawSummary();
  };
  const drawParams = () => {
    const counts = new Map();
    events.forEach(event => Object.keys(event.params).forEach(key => counts.set(key.toLowerCase(), {key, count: (counts.get(key.toLowerCase())?.count || 0) + 1})));
    const keys = [...new Set([...counts.keys(), ...hiddenParams])].sort();
    root.querySelector('#param-summary').textContent = `${number(hiddenParams.size)} hidden`;
    root.querySelector('#param-list').innerHTML = `<p class="help">Untick parameters you never read. Clicking a parameter name in the timeline hides it too. Remembered for this game in this browser; a parameter used by a highlight stays visible.</p><div class="param-grid">${keys.map(key => `<label class="check-row"><input type="checkbox" data-param-toggle="${escapeHTML(key)}" ${hiddenParams.has(key) ? '' : 'checked'}> <code>${escapeHTML(counts.get(key)?.key || key)}</code> <span class="small muted">${number(counts.get(key)?.count || 0)}</span></label>`).join('')}</div><button type="button" class="button small-button" data-param-reset>Reset to default</button>`;
  };
  const drawRules = () => {
    if (!rulesBox.isConnected) return;
    disclosures.remember();
    const selected = selection.value;
    selection.innerHTML = '<option value="all">All highlights</option>' + highlights.map((rule, index) => `<option value="${index}">${escapeHTML(rule.label || `Highlight ${index + 1}`)}</option>`).join('');
    selection.value = [...selection.options].some(option => option.value === selected) ? selected : 'all';
    rulesBox.innerHTML = highlights.map((rule, index) => `<details class="highlight-rule highlight-${rule.color}" data-highlight="${index}" data-disclosure="highlight-${index}" ${index === freshRule ? 'open' : ''}><summary><span class="highlight-dot" aria-hidden="true"></span> ${escapeHTML(rule.label || `Highlight ${index + 1}`)} <span class="small muted" data-highlight-count="${index}"></span></summary><div class="highlight-settings"><label>Name<input data-highlight-field="label" value="${escapeHTML(rule.label)}" maxlength="80"></label><label>Color<select data-highlight-field="color">${HIGHLIGHT_COLORS.map(([key, label]) => `<option value="${key}" ${key === rule.color ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="check-row"><input type="checkbox" data-highlight-field="enabled" ${rule.enabled !== false ? 'checked' : ''}> Enabled</label><button type="button" class="button small-button" data-highlight-save>${rule.savedId ? 'Update saved rule' : 'Save rule'}</button>${rule.savedId ? '<button type="button" class="button small-button" data-highlight-copy>Save as new rule</button>' : ''}<button type="button" class="button small-button" data-highlight-remove>Remove from timeline</button></div><p class="highlight-rule-preview help" data-highlight-preview="${index}"></p><div data-highlight-editor></div><p class="error" data-highlight-error="${index}" role="alert"></p></details>`).join('');
    rulesBox.querySelectorAll('[data-highlight-editor]').forEach((editor, index) => mountHighlightEditor({container: editor, tree: highlights[index].conditions, catalog: () => catalog, onChange: () => {current = -1; persist(); draw();}}));
    root.querySelector('#highlight-add').disabled = highlights.length >= 20;
    root.querySelector('#highlight-rule-summary').textContent = `${number(highlights.length)} highlights`;
    disclosures.refresh();
  };
  root.addEventListener('click', event => {
    const toggle = event.target.closest('[data-timeline-mode]');
    if (toggle) {mode = toggle.dataset.timelineMode; persist(); draw();}
    const pick = event.target.closest('[data-session-pick]');
    if (pick) { shownSession = pick.dataset.sessionPick; if (!visible(current)) current = -1; draw(); }
    const tick = event.target.closest('[data-timeline-jump]');
    if (tick) jumpTo(Number(tick.dataset.timelineJump));
    const view = event.target.closest('[data-param-view]');
    if (view) { paramState.showAll = view.dataset.paramView === 'all'; saveParams(); draw(); }
    const hide = event.target.closest('[data-hide-param]');
    if (hide) { const key = hide.dataset.hideParam.toLowerCase();
      if (hiddenParams.has(key)) hiddenParams.delete(key);
      else {
        hiddenParams.add(key); paramState.showAll = false;
        toast(`Hid ${hide.dataset.hideParam} in every event.`, {label: 'Undo', run: () => { hiddenParams.delete(key); saveParams(); drawParams(); draw(); }});
      }
      saveParams(); drawParams(); draw(); }
    if (event.target.closest('[data-param-reset]')) { hiddenParams.clear(); ['seq', 'attempt_id'].forEach(key => hiddenParams.add(key)); paramState.showAll = false; saveParams(); drawParams(); draw(); }
    const preset = event.target.closest('[data-highlight-preset]');
    if (preset) {
      const [, label, pattern, keyword, color] = HIGHLIGHT_PRESETS.find(item => item[0] === preset.dataset.highlightPreset);
      if (highlights.some(rule => rule.label === label)) toast(`You already have a ${label} highlight.`);
      else if (highlights.length >= 20) toast('Use at most 20 highlights.');
      else {
        const names = catalog.events.map(item => item.name).filter(name => pattern.test(name));
        highlights.push({label, color, enabled: true, conditions: {match: 'any', conditions: (names.length ? names : [keyword]).map(name => names.length ? eventCondition(name) : {...eventCondition(name), op: 'contains'})}});
        current = -1; persist(); drawRules(); draw();
      }
    }
    if (event.target.closest('#highlight-add')) {
      if (highlights.length >= 20) return;
      highlights.push({label: `Highlight ${highlights.length + 1}`, color: HIGHLIGHT_COLORS[highlights.length % HIGHLIGHT_COLORS.length][0], enabled: true, conditions: conditionGroup([eventCondition(catalog.events[0]?.name)])});
      freshRule = highlights.length - 1; root.querySelector('#timeline-highlights').open = true; current = -1; persist(); drawRules(); draw();
    }
    if (event.target.closest('[data-highlight-remove]')) {highlights.splice(Number(event.target.closest('[data-highlight]').dataset.highlight), 1); current = -1; persist(); drawRules(); draw();}
    const saveRule = event.target.closest('[data-highlight-save], [data-highlight-copy]');
    if (saveRule) library.save(highlights[Number(saveRule.closest('[data-highlight]').dataset.highlight)], saveRule.hasAttribute('data-highlight-copy'));
    const nav = event.target.closest('#highlight-next, #highlight-previous');
    if (nav) {
      const indices = selectedMatches(); if (!indices.length) return;
      const next = nav.id === 'highlight-next';
      jumpTo(highlightNavigationIndex(indices, current, next));
    }
  });
  rulesBox.addEventListener('change', event => {
    const field = event.target.dataset.highlightField; if (!field) return;
    const rule = highlights[Number(event.target.closest('[data-highlight]').dataset.highlight)];
    rule[field] = field === 'enabled' ? event.target.checked : event.target.value;
    current = -1; persist(); if (field !== 'label') drawRules(); draw();
  });
  root.addEventListener('change', event => {
    if (event.target.hasAttribute('data-session-select')) {shownSession = event.target.value; if (!visible(current)) current = -1; draw(); root.querySelector('[data-session-select]')?.focus(); return;}
    if (event.target.id === 'group-repeats') { paramState.group = event.target.checked; saveParams(); draw(); return; }
    const toggle = event.target.closest('[data-param-toggle]'); if (!toggle) return;
    toggle.checked ? hiddenParams.delete(toggle.dataset.paramToggle) : hiddenParams.add(toggle.dataset.paramToggle);
    saveParams(); drawParams(); draw();
  });
  selection.addEventListener('change', () => {current = -1; updateNavigation();});
  // J / K step through highlights, / jumps to the filter box. Ignored while typing; removed once this timeline is gone.
  const onKey = event => {
    if (!box.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]:not(.player-dialog)')) return;
    if (analysisView) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if (event.key === '/' && mode === 'filter') { event.preventDefault(); search.focus(); return; }
    if (mode !== 'highlight' || !['j', 'k'].includes(event.key)) return;
    const indices = selectedMatches(); if (!indices.length) return;
    event.preventDefault(); jumpTo(highlightNavigationIndex(indices, current, event.key === 'j'));
  };
  document.addEventListener('keydown', onKey);
  search.addEventListener('input', draw);
  library = mountHighlightLibrary({container: root.querySelector('#highlight-library'), game,
    onSaved: () => {persist(); drawRules(); draw();},
    onUse: rule => {
      const existing = highlights.find(item => item.savedId === rule.savedId);
      if (existing) {existing.enabled = true; freshRule = highlights.indexOf(existing);}
      else {if (highlights.length >= 20) {toast('Use at most 20 highlights.'); return;} highlights.push(rule); freshRule = highlights.length - 1;}
      current = -1; persist(); drawRules(); draw();
    },
  });
  options.onReady?.({setView(next) {analysisView = next === 'analysis'; draw();}});
  drawRules(); drawParams(); draw();
  try {
    let more = true; let snapshot = null;
    while (more && box.isConnected) {
      const data = await api(`${gameURL(game)}/insights/journey?${new URLSearchParams({start: range.from, end: range.to, player, offset: events.length, ...(snapshot == null ? {} : {snapshot}), tz_offset: timezone === 'utc' ? 0 : localTimezoneOffset()})}`);
      if (!box.isConnected) return;
      snapshot = data.snapshot;
      events.push(...data.events); more = data.truncated && data.events.length > 0; complete = !more;
      sessions = timelineSessions(events);
      sessions.forEach(session => session.items.forEach(item => { events[item.index].session = item.session; }));
      const found = focus && focusIndex < 0 ? events.findIndex(item => item.event_id === focus.event) : -1;
      if (events.length === data.events.length || complete) {
        const byName = new Map();
        events.forEach(event => {
          if (!byName.has(event.name)) byName.set(event.name, {name: event.name, params: new Map()});
          const entry = byName.get(event.name);
          Object.entries(event.params).forEach(([key, value]) => {if (!entry.params.has(key)) entry.params.set(key, new Set()); if (entry.params.get(key).size < 100) entry.params.get(key).add(String(value));});
        });
        catalog = {events: [...byName.values()].map(event => ({name: event.name, params: [...event.params].map(([key, values]) => ({key, values: [...values]}))}))};
        if (!rulesBox.contains(document.activeElement)) drawRules();
        if (!root.querySelector('#param-list').contains(document.activeElement)) drawParams();
      }
      if (found >= 0) focusIndex = found;
      draw();
      // Jump once the whole timeline is in, so later pages can't push the event out of view.
      if (complete && focusIndex >= 0 && !analysisView) jumpTo(focusIndex);
    }
  } catch (error) {if (box.isConnected) {loadFailure = `${error.message} · ${number(events.length)} events loaded; counts are incomplete. Reopen Raw events to retry.`; draw();}}
}

/* ─── Levels: how every level is going ─── */

function levelTransitionCell(row) {
  const transition = row.transition;
  if (!transition?.available) return '<span class="muted" title="No starters here or no observed start for the next numbered level. The next level may not exist or may be unlogged.">— Not enough data</span>';
  const net = transition.net_change;
  return `<button type="button" class="level-drop-button" data-level-toggle="${row.level}" title="Players who started this level but have no later start of level ${transition.next_level} by the end of these dates"><span class="pill ${transition.total_drop ? 'bad' : 'good'}">↓ ${percent(transition.drop_percent)} drop · ${number(transition.total_drop)}</span></button><small class="level-net ${net > 0 ? 'gain' : net < 0 ? 'loss' : ''}" title="Separate comparison of filtered starter totals; includes players entering midway">${net > 0 ? '↑ Net gain +' : net < 0 ? '↓ Net loss ' : 'No net change '}${net ? number(Math.abs(net)) : ''}</small>`;
}

// Who is counted: everyone active in the dates, or new players within their first session.
// A level page shows a player's timeline beside the list when the list area is at least this wide (px).
const PLAYER_PANE_MIN_WIDTH = 1040;
const LEVEL_SCOPES = {all: 'Everyone', first_session: 'New players · first session'};
// The players behind a level: where the drop splits, and who carried on.
const LEVEL_DRILL_GROUPS = [['left', 'Quit during level'], ['finished_stopped', 'Quit after finishing'], ['kept_going', 'Reached next level']];

// The tab a level opens on: the bigger of its two kinds of drop, else who carried on.
function levelDrillGroup(row) {
  const value = row?.transition;
  if (!value) return 'left';
  if (value.left || value.finished_stopped) return value.finished_stopped > value.left ? 'finished_stopped' : 'left';
  return value.kept_going ? 'kept_going' : 'left';
}

// "What they did last" is a short label; hovering or clicking it opens the exact last event above it.
function lastDidHTML(row, index) {
  return `<button type="button" class="last-did" data-last-did="${index}" aria-haspopup="dialog" aria-expanded="false">${escapeHTML(row.last_action || '—')}</button>`;
}

// The popover: the last event sent in that session, when it came, and what they did right after the level.
function lastDidDetailsHTML(row, level) {
  const last = row.last_event;
  const line = (label, body) => `<div><dt>${label}</dt><dd>${body}</dd></div>`;
  const lines = [];
  if (last) {
    const before = last.after ? `<span class="muted">${duration(last.gap)} after ${escapeHTML(last.after)}</span>` : '';
    lines.push(line('Last event in that session', `<span class="mono">${escapeHTML(last.text)}</span>${before}`));
    lines.push(line('When', last.after_level == null ? `It was their last event on level ${level}` : `${duration(last.after_level)} after their last event on level ${level}`));
  }
  if (row.next_action && row.next_action !== row.last_action) lines.push(line(`Right after level ${level}`, escapeHTML(row.next_action)));
  return `<h3>${escapeHTML(row.last_action || 'Unknown')}</h3><dl>${lines.join('')}</dl>`;
}

// One shared popover for those labels, in the top layer so a scrolling table cannot clip it.
function lastDidPopover() {
  let pop = document.querySelector('#last-did-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'last-did-pop'; pop.className = 'last-did-pop'; pop.setAttribute('popover', 'manual');
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Last event details');
    document.body.append(pop);
  }
  return pop;
}

// Above the label when there is room, else below it; always inside the window.
function placePopover(pop, anchor) {
  const box = anchor.getBoundingClientRect();
  const above = box.top - pop.offsetHeight - 8 >= 8;
  pop.style.top = `${Math.round(above ? box.top - pop.offsetHeight - 8 : box.bottom + 8)}px`;
  pop.style.left = `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - pop.offsetWidth - 8)))}px`;
}

// What the group's players did last on the level; pick one to list only those players.
function lastActionsHTML(level, state) {
  if (state.group === 'kept_going' || !state.lastActions?.length) return '';
  return `<div class="last-actions" role="group" aria-label="What players did last on level ${level}"><span class="last-actions-label">What they did last</span>${state.lastActions.map((item, index) => `<button type="button" class="last-action" data-last-action="${index}" aria-pressed="${state.lastAction === item.text}">${escapeHTML(item.text)}<span class="drill-count">${number(item.players)}</span></button>`).join('')}</div>`;
}

// The address the Levels page asks for first, worked out the way the page does, so pointing at the
// Levels link can start the scan before the page opens. Null when the page would open Compare releases.
function resolvedFilters(game) {
  const state = filterState(game);
  const found = presets.find(([key]) => key === (state.range?.preset || '30'));
  const [from, to] = found && state.range?.preset !== 'custom' ? found[2]()
    : state.range ? [state.range.from, state.range.to] : presets.find(([key]) => key === '7')[2]();
  return {...state, range: {from, to}};
}
function levelsPrefetchPath(game) {
  if (['compare', 'explore'].includes(storeGet(`avn-levels-view-${game.id}`))) return null;
  const query = filterQuery(resolvedFilters(game));
  if ((storeGet(`avn-level-nav-${game.id}`) || {}).scope === 'first_session') query.set('scope', 'first_session');
  return `${gameURL(game)}/insights/levels?${query}`;
}
// The Overview's first request, for the same early start.
const overviewPrefetchPath = game => `${gameURL(game)}/insights/summary?${filterQuery(resolvedFilters(game))}`;

// Where the Levels list was left when a level page was opened, so Back finds it as it was.
let levelsReturn = null;
// Levels at a glance: players remaining by level (the two steepest drops marked) and a heat strip, one cell per level.
function levelViz(levels) {
  const rows = levels.filter(row => row.started != null);
  if (rows.length < 2) return '';
  const width = 800, height = 190, left = 40, right = 12, top = 18, bottom = 24;
  const peak = Math.max(1, ...rows.map(row => row.started));
  const x = index => left + index / (rows.length - 1) * (width - left - right);
  const y = value => top + (height - top - bottom) * (1 - value / peak);
  const drop = row => row.transition?.available && !row.low_sample ? row.transition.drop_percent : null;
  const steepest = rows.filter(row => drop(row) != null).sort((a, b) => drop(b) - drop(a)).slice(0, 2).map(row => row.level);
  const line = rows.map((row, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(row.started).toFixed(1)}`).join(' ');
  const every = Math.ceil(rows.length / 12);
  const ticks = [0, Math.round(peak / 2), peak].filter((value, index, list) => list.indexOf(value) === index);
  const maxDrop = Math.max(1, ...rows.map(row => drop(row) ?? 0));
  const summary = `Players remaining by level, from ${number(rows[0].started)} at level ${rows[0].level} to ${number(rows[rows.length - 1].started)} at level ${rows[rows.length - 1].level}${steepest.length ? `. Steepest drops after level ${steepest.join(' and ')}` : ''}.`;
  return `<section class="panel level-viz"><div class="panel-header"><div><h2>Players remaining by level</h2><p>Steep steps are where players stop${steepest.length ? ' · the two steepest are marked' : ''}</p></div></div><div class="panel-body">
    <svg class="level-curve" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(summary)}">
      ${ticks.map(value => `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text class="chart-axis" x="${left - 6}" y="${y(value) + 4}" text-anchor="end">${number(value)}</text>`).join('')}
      <path class="curve-area" d="${line} L${x(rows.length - 1)} ${y(0)} L${x(0)} ${y(0)}Z"/><path class="curve-line" d="${line}"/>
      ${rows.map((row, index) => { const big = steepest.includes(row.level); return `<circle class="curve-dot${big ? ' big' : ''}" cx="${x(index).toFixed(1)}" cy="${y(row.started).toFixed(1)}" r="${big ? 4.5 : 2.6}"/>${big ? `<text class="curve-flag" x="${(x(index) + 7).toFixed(1)}" y="${(y(row.started) - 7).toFixed(1)}">L${row.level} −${Math.round(drop(row))}%</text>` : ''}${index % every === 0 || index === rows.length - 1 ? `<text class="chart-axis" x="${x(index).toFixed(1)}" y="${height - 7}" text-anchor="middle">${row.level}</text>` : ''}`; }).join('')}
    </svg>
    <div class="lvheat-strip" role="group" aria-label="Drop to the next level, per level">${rows.map(row => { const d = drop(row); return `<button type="button" class="lvheat h${d == null ? 0 : Math.max(1, Math.ceil(d / maxDrop * 6))}" data-heat-level="${row.level}" title="Level ${row.level}: ${d == null ? 'no next level yet' : `${percent(d)} did not start the next`}">${row.level}</button>`; }).join('')}</div>
    <p class="foot-note">Cell colour is the drop to the next level, per level: lighter is low, stronger is high. Open a level to see its players.</p></div></section>`;
}

async function renderLevels() {
  const game = currentGame;
  const navKey = `avn-level-nav-${game.id}`;
  const navigation = {sort: 'level', pageSize: '50', scope: 'all', ...(storeGet(navKey) || {})};
  if (!['level', 'drop', 'completion', 'tries', 'time'].includes(navigation.sort)) navigation.sort = 'level';
  if (!['25', '50', '100', 'all'].includes(navigation.pageSize)) navigation.pageSize = '50';
  if (!LEVEL_SCOPES[navigation.scope]) navigation.scope = 'all';
  let page = 0; let highlighted = null;
  shell('Levels', heading('Levels', 'Follow the same players from one level’s start to the next, with a breakdown of where progress stops.') +
    `<div id="filters"></div><div class="range-modes route-tabs levels-views" role="group" aria-label="Levels view"><button type="button" data-levels-view="table">Level by level</button><button type="button" data-levels-view="compare">Compare releases</button></div>
    <div id="level-tools" hidden></div><div id="levels-by-level"><div id="levels-summary"></div>
    <section class="panel levels-panel"><div class="panel-header"><div><h2>Level by level</h2><p id="levels-note">Counted from level start, complete, fail and restart events.</p></div><div class="quiet-actions"><div class="segmented" role="group" aria-label="Which players">${Object.entries(LEVEL_SCOPES).map(([key, label]) => `<button type="button" data-levels-scope="${key}">${label}</button>`).join('')}</div><label class="inline-field">Sort<select id="levels-sort"><option value="level">Level order</option><option value="drop">Highest total drop</option><option value="completion">Lowest completion</option><option value="tries">Most tries per player</option><option value="time">Slowest</option></select></label></div></div><div class="levels-navigation"><form id="levels-jump-form"><label for="levels-jump">Jump to level</label><input id="levels-jump" type="number" min="0" max="1000000" required placeholder="e.g. 120"><button type="submit" class="button small-button">Go</button></form><label class="inline-field">Rows<select id="levels-page-size"><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="all">All</option></select></label><div class="quiet-actions"><button type="button" class="button small-button" id="levels-previous-page">← Previous</button><span id="levels-page-info" class="small muted" aria-live="polite"></span><button type="button" class="button small-button" id="levels-next-page">Next →</button></div></div><div id="levels-table"></div></section></div><div id="level-page" hidden></div>`);
  let data = null; let chosen = null; let latest = 0;
  const tableBox = document.querySelector('#levels-table');
  const pageBox = document.querySelector('#level-page');
  const drill = new Map();
  document.querySelector('#levels-sort').value = navigation.sort;
  document.querySelector('#levels-page-size').value = navigation.pageSize;
  const rememberNavigation = () => storeSet(navKey, {sort: document.querySelector('#levels-sort').value, pageSize: document.querySelector('#levels-page-size').value, scope: navigation.scope});
  const showScope = () => document.querySelectorAll('[data-levels-scope]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.levelsScope === navigation.scope)));
  const firstSession = () => navigation.scope === 'first_session';
  const levelsQuery = state => { const query = filterQuery(state); if (firstSession()) query.set('scope', 'first_session'); return query; };
  const levelsPath = state => `${gameURL(game)}/insights/levels?${levelsQuery(state)}`;
  // Two sub pages: the level table, or Compare releases. Only the open one is shown, and the
  // comparison only queries while open. "explore" is the old name of the comparison page.
  const viewKey = `avn-levels-view-${game.id}`;
  // ?level=12 opens the players of that level on a page of their own.
  const levelParam = new URLSearchParams(location.search).get('level');
  let pageLevel = levelParam !== null && Number.isInteger(Number(levelParam)) ? Number(levelParam) : null;
  const listURL = () => gamePath(game, 'levels');
  const levelURL = level => `${listURL()}?${new URLSearchParams({level})}`;
  let levelsView = pageLevel == null && ['compare', 'explore'].includes(new URLSearchParams(location.search).get('view') || storeGet(viewKey)) ? 'compare' : 'table';
  const showView = () => {
    document.querySelectorAll('[data-levels-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.levelsView === levelsView)));
    document.querySelector('#levels-by-level').hidden = levelsView !== 'table' || pageLevel != null;
    document.querySelector('#level-page').hidden = levelsView !== 'table' || pageLevel == null;
    document.querySelector('#level-tools').hidden = levelsView !== 'compare';
  };
  const chooseView = async next => {
    if (next === 'table' && pageLevel != null) { navigate(listURL()); return; }
    if (next === levelsView) return;
    levelsView = next; storeSet(viewKey, next);
    if (next === 'compare') pageLevel = null;
    const url = new URL(location.href);
    if (next === 'compare') { url.searchParams.set('view', 'compare'); url.searchParams.delete('level'); } else url.searchParams.delete('view');
    history.replaceState(null, '', url);
    showView();
    if (next === 'compare' && chosen) toolsPanel.update(chosen);
    if (next === 'table' && chosen && !data) await load(chosen);
  };
  document.querySelector('.levels-views').addEventListener('click', event => {
    const tab = event.target.closest('[data-levels-view]');
    if (tab) chooseView(tab.dataset.levelsView);
  });
  showView();
  const toolsPanel = mountLevelTools(document.querySelector('#level-tools'), game, view => {
    saveFilters(game, view.filters);
    storeSet(navKey, {sort: view.sort || 'level', pageSize: view.pageSize || '50', scope: view.scope || 'all'});
    renderLevels();
  });
  const playerHref = row => `${gamePath(game, 'players')}?${new URLSearchParams({player: row.player})}`;
  const drillQuery = (level, state, extra = {}) => {
    const query = levelsQuery(chosen); query.set('level', level); query.set('group', state.group); query.set('sort', state.sort);
    if (state.lastAction != null) query.set('last_action', state.lastAction);
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return query;
  };
  // Hover or keyboard focus previews the last event; a click keeps it open until Escape or a click elsewhere.
  let didButton = null; let didPinned = false;
  const hideLastDid = () => {
    const pop = document.querySelector('#last-did-pop');
    if (pop?.matches(':popover-open')) pop.hidePopover();
    didButton?.setAttribute('aria-expanded', 'false');
    didButton = null; didPinned = false;
  };
  const showLastDid = (button, pin) => {
    const level = Number(button.closest('[data-level-drill]')?.dataset.levelDrill);
    const row = drill.get(level)?.players[Number(button.dataset.lastDid)];
    if (!row || !pageBox.isConnected) return;
    didButton?.setAttribute('aria-expanded', 'false');
    const pop = lastDidPopover();
    pop.innerHTML = lastDidDetailsHTML(row, level);
    pop.toggleAttribute('data-pinned', pin);
    if (!pop.matches(':popover-open')) pop.showPopover();
    placePopover(pop, button);
    button.setAttribute('aria-expanded', 'true');
    didButton = button; didPinned = pin;
  };
  const closeLastDid = event => {
    if (!pageBox.isConnected) { hideLastDid(); stopWatching(); return; }
    if (event.type === 'keydown' ? event.key === 'Escape' : event.type !== 'click' || !event.target.closest('.last-did, #last-did-pop')) hideLastDid();
  };
  const watching = [['keydown', document], ['click', document], ['scroll', window], ['resize', window]];
  const stopWatching = () => watching.forEach(([type, target]) => target.removeEventListener(type, closeLastDid, true));
  watching.forEach(([type, target]) => target.addEventListener(type, closeLastDid, true));
  pageBox.addEventListener('pointerover', event => {
    const button = event.target.closest('.last-did');
    if (button && event.pointerType === 'mouse' && !didPinned) showLastDid(button, false);
  });
  pageBox.addEventListener('pointerout', event => {
    if (event.pointerType === 'mouse' && !didPinned && event.target.closest('.last-did')) hideLastDid();
  });
  pageBox.addEventListener('focusin', event => {
    const button = event.target.closest('.last-did');
    if (button && !didPinned && button.matches(':focus-visible')) showLastDid(button, false);
  });
  pageBox.addEventListener('focusout', event => { if (!didPinned && event.target.closest('.last-did')) hideLastDid(); });
  const drawDrill = level => {
    if (!tableBox.isConnected || !data) return;
    const box = document.querySelector(`[data-level-drill="${level}"]`); const state = drill.get(level);
    if (!box || !state) return;
    hideLastDid();
    const counts = state.counts || data.levels.find(row => row.level === level)?.transition;
    const quitting = state.group !== 'kept_going';
    const skipped = counts?.unknown_progress ? `<p class="help">${number(counts.unknown_progress)} more ${counts.unknown_progress === 1 ? 'player' : 'players'} in the drop started a later level without a start of level ${level + 1}.</p>` : '';
    const table = state.error ? loadError(state.error, 'data-retry-drill') : state.loading && !state.players.length ? skeleton('table', 5, 8) : !state.players.length ? '<p class="help">Nobody is in this group in the selected days and filters.</p>' : `<div class="table-wrap"><table class="compact-table"><thead><tr><th>Player</th>${quitting ? '<th title="Hover or click one to see the exact last event">What they did last</th>' : ''}<th class="num">Tries</th><th class="num">Fails</th><th>Last on this level</th><th class="col-secondary">Opened the game later</th><th class="col-secondary">Version</th><th class="num">Session length</th></tr></thead><tbody>${state.players.map((row, index) => `<tr data-player="${escapeHTML(row.player)}"${row.player === state.selected ? ' class="is-selected" aria-current="true"' : ''}><td><a class="row-title" href="${playerHref(row)}"><span class="mono">${escapeHTML(shortId(row.player))}</span></a></td>${quitting ? `<td class="small">${lastDidHTML(row, index)}</td>` : ''}<td class="num">${number(row.tries)}</td><td class="num">${number(row.fails)}</td><td class="small muted">${analysisDate(row.exit_at, chosen.timezone)}</td><td class="col-secondary">${row.came_back ? '<span class="pill good">came back</span>' : '<span class="small muted">—</span>'}</td><td class="small col-secondary">${escapeHTML(row.app_version || '—')}</td><td class="num">${duration(row.session_seconds)}</td></tr>`).join('')}</tbody></table></div><div class="pager"><span class="small muted">${number(state.players.length)} of ${number(state.total)}</span>${state.players.length < state.total ? `<button type="button" class="button" data-drill-more ${state.loading ? 'disabled aria-busy="true"' : ''}>${state.loading ? spinner('Loading…') : 'Show more'}</button>` : ''}</div><p class="help">Session length is the whole session they were last on this level in, not only the time on the level. “Came back” means any later session by the end date. Hover or click what they did last to see the last event the game logged in that session (session start and end aside), when it came, and what they did right after the level. Open a player to start at their last event on this level.</p>`;
    const listScroll = box.querySelector('.table-wrap')?.scrollTop;
    box.innerHTML = `<div class="level-drill-head"><div class="segmented" role="group" aria-label="Players on level ${level}">${LEVEL_DRILL_GROUPS.map(([key, label]) => `<button type="button" data-drill-group="${key}" aria-pressed="${state.group === key}">${label}${counts ? ` <span class="drill-count">${number(counts[key])}</span>` : ''}</button>`).join('')}</div>
      <div class="quiet-actions"><label class="inline-field">Sort<select data-drill-sort><option value="exit_at">Latest on this level</option><option value="tries">Most tries</option><option value="fails">Most fails</option></select></label><button type="button" class="button" data-drill-csv>${icon('export', 14)} CSV</button></div></div>
      ${skipped}${lastActionsHTML(level, state)}${table}`;
    box.querySelector('[data-drill-sort]').value = state.sort;
    if (listScroll) box.querySelector('.table-wrap').scrollTop = listScroll;
  };
  const fetchDrill = async (level, more = false) => {
    const state = drill.get(level); const ticket = ++state.ticket;
    state.loading = true; state.error = null;
    if (!more) { state.players = []; state.total = 0; }
    drawDrill(level);
    let shown = false;
    try {
      const url = `${gameURL(game)}/insights/levels/players?${drillQuery(level, state, {offset: more ? state.players.length : 0, limit: 50})}`;
      const apply = (result, old) => {
        if (ticket !== state.ticket || !tableBox.isConnected) return;
        state.players = more ? [...state.players, ...result.players] : result.players; state.total = result.total; state.counts = result.counts; state.lastActions = result.last_actions;
        if (old) { shown = true; drawDrill(level); }
      };
      // The first page of a group shows what was loaded before, if anything, while the new list loads.
      if (more) apply(await api(url), false); else await apiShowing(url, apply);
    } catch (error) { if (ticket === state.ticket && !shown) state.error = error; }
    if (ticket === state.ticket) { state.loading = false; drawDrill(level); }
  };
  const drawLevelPage = () => {
    if (pageLevel == null || !data || !pageBox.isConnected) return;
    const row = data.levels.find(item => item.level === pageLevel);
    if (!row) { pageBox.innerHTML = `<section class="panel"><div class="panel-body"><a class="back-link" href="${listURL()}">← All levels</a><p class="help">Nobody started level ${pageLevel} in the selected days and filters.</p></div></section>`; return; }
    const numbers = data.levels.map(item => item.level).sort((first, second) => first - second);
    const at = numbers.indexOf(pageLevel);
    const step = (target, label) => target == null ? '' : `<a class="button small-button" href="${levelURL(target)}">${label}</a>`;
    const drop = row.transition;
    const summary = [`<span><strong>${number(row.started)}</strong> started</span>`, `<span><strong>${number(row.completed)}</strong> finished${row.completion != null ? ` · ${percent(row.completion)}` : ''}</span>`,
      drop?.available ? `<span><strong>${percent(drop.drop_percent)}</strong> dropped · ${number(drop.total_drop)} did not start level ${drop.next_level}</span>` : '<span class="muted">drop: not enough data</span>',
      `<span><strong>${row.tries_per_player ?? '—'}</strong> tries / player</span>`, `<span>median <strong>${duration(row.median_seconds)}</strong></span>`].join('');
    pageBox.innerHTML = `<section class="panel level-page"><div class="panel-header"><div><a class="back-link" href="${listURL()}">← All levels</a><h2>Level ${row.level}</h2><div class="level-page-summary">${summary}</div></div><div class="quiet-actions">${step(numbers[at - 1], `← Level ${numbers[at - 1]}`)}${step(numbers[at + 1], `Level ${numbers[at + 1]} →`)}</div></div>
      <div class="panel-body"><div class="level-page-split"><div class="level-drill level-page-list" data-level-drill="${row.level}"></div><aside class="player-pane" id="level-pane" aria-label="Player timeline" hidden></aside></div></div></section>`;
    ensureDrill(row.level);
  };
  tableBox.addEventListener('click', event => {
    const row = event.target.closest('[data-level-row]');
    if (row && !event.target.closest('a[href]')) { levelsReturn = {game: game.id, page, scroll: window.scrollY}; navigate(levelURL(Number(row.dataset.levelRow))); }
  });
  // The players of a level start loading when the pointer reaches its row.
  tableBox.addEventListener('pointerover', event => {
    const row = event.target.closest('[data-level-row]');
    const item = row && data?.levels.find(entry => entry.level === Number(row.dataset.levelRow));
    if (!item || event.pointerType !== 'mouse') return;
    const query = drillQuery(item.level, {group: levelDrillGroup(item), sort: 'exit_at', lastAction: null}, {offset: 0, limit: 50});
    api(`${gameURL(game)}/insights/levels/players?${query}`).catch(() => {});
  });
  const ensureDrill = level => {
    if (!drill.has(level)) drill.set(level, {group: levelDrillGroup(data.levels.find(row => row.level === level)), sort: 'exit_at', lastAction: null, lastActions: [], players: [], total: 0, counts: null, loading: false, error: null, ticket: 0});
    fetchDrill(level);
  };
  pageBox.addEventListener('click', async event => {
    const playerLink = event.target.closest('.level-drill a[href]');
    if (playerLink && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
      const query = new URL(playerLink.href).searchParams;
      if (query.has('player')) {
        event.preventDefault();
        const panel = playerLink.closest('[data-level-drill]');
        const level = Number(panel.dataset.levelDrill);
        const state = drill.get(level);
        const players = [...state.players];
        const snapshot = drillQuery(level, state).toString();
        const focusOf = row => ({event: row.exit_event, label: `Last on level ${level}`});
        const browse = {index: players.findIndex(row => row.player === query.get('player')), total: state.total, focus: focusOf, load: async index => {
          if (!players[index]) {
            const offset = Math.floor(index / 50) * 50;
            const query = new URLSearchParams(snapshot); query.set('offset', offset); query.set('limit', 50);
            const result = await api(`${gameURL(game)}/insights/levels/players?${query}`);
            browse.total = result.total;
            result.players.forEach((row, position) => { players[offset + position] = row; });
          }
          return players[index];
        }};
        const options = {filters: chosen, trigger: playerLink, browse, focus: players[browse.index] ? focusOf(players[browse.index]) : null};
        const split = pageBox.querySelector('.level-page-split');
        if (split && split.clientWidth >= PLAYER_PANE_MIN_WIDTH) {
          // Wide enough: the timeline opens beside the list, which stays in view for Previous / Next.
          const select = chosenPlayer => {
            state.selected = chosenPlayer;
            split.querySelectorAll('tr[data-player]').forEach(row => { const on = row.dataset.player === chosenPlayer; row.classList.toggle('is-selected', on); if (on) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); });
          };
          if (!split.classList.contains('has-pane')) {
            split.classList.add('has-pane');
            split.scrollIntoView({block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
          }
          split.querySelector('#level-pane').hidden = false;
          select(query.get('player'));
          renderJourney(game, query.get('player'), {...options, pane: split.querySelector('#level-pane'), onPlayer: select, onClose: () => { state.selected = null; select(null); split.classList.remove('has-pane'); split.querySelector('#level-pane').hidden = true; split.querySelector('#level-pane').innerHTML = ''; playerLink.focus({preventScroll: true}); }});
        } else renderJourney(game, query.get('player'), {...options, overlay: true});
        return;
      }
    }
    const did = event.target.closest('[data-last-did]');
    if (did) {
      if (didButton === did && didPinned) hideLastDid(); else showLastDid(did, true);
      return;
    }
    const panel = event.target.closest('[data-level-drill]'); if (!panel) return;
    const level = Number(panel.dataset.levelDrill); const state = drill.get(level); if (!state) return;
    const tab = event.target.closest('[data-drill-group]');
    if (tab) { state.group = tab.dataset.drillGroup; state.lastAction = null; fetchDrill(level); return; }
    const action = event.target.closest('[data-last-action]');
    if (action) {
      const text = state.lastActions[Number(action.dataset.lastAction)]?.text ?? null;
      state.lastAction = state.lastAction === text ? null : text; fetchDrill(level); return;
    }
    if (event.target.closest('[data-retry-drill]')) { fetchDrill(level); return; }
    if (event.target.closest('[data-drill-more]')) { fetchDrill(level, true); return; }
    if (event.target.closest('[data-drill-csv]')) {
      try {
        const all = await api(`${gameURL(game)}/insights/levels/players?${drillQuery(level, state, {offset: 0, limit: 2000})}`);
        downloadCSV(`${game.name}-${platformLabel(game.platform)}-level-${level}-${state.group}-${chosen.range.from}_${chosen.range.to}.csv`, [['player', 'last_action', 'next_action', 'last_event', 'last_event_after', 'last_event_gap_seconds', 'last_event_after_level_seconds', 'tries', 'fails', 'finished_level', 'last_on_level_utc', 'last_seen_utc', 'opened_game_later', 'app_version', 'session_seconds'], ...all.players.map(row => [row.player, row.last_action, row.next_action, row.last_event?.text, row.last_event?.after, row.last_event?.gap, row.last_event?.after_level, row.tries, row.fails, row.completed, row.exit_at, row.last_seen, row.came_back, row.app_version, row.session_seconds])]);
      } catch (error) { toastError(error); }
    }
  });
  document.querySelector('#levels-summary').addEventListener('click', event => { const heat = event.target.closest('[data-heat-level]'); if (heat) navigate(levelURL(heat.dataset.heatLevel)); });
  pageBox.addEventListener('change', event => {
    const select = event.target.closest('[data-drill-sort]'); if (!select) return;
    const level = Number(select.closest('[data-level-drill]').dataset.levelDrill); const state = drill.get(level);
    state.sort = select.value; fetchDrill(level);
  });
  const rows = () => {
    const sort = document.querySelector('#levels-sort').value;
    const list = [...data.levels];
    const keys = {drop: row => -(row.transition?.drop_percent ?? -1), completion: row => row.completion ?? 101, tries: row => -(row.tries_per_player ?? -1), time: row => -(row.median_seconds ?? -1)};
    return sort === 'level' ? list : list.sort((a, b) => keys[sort](a) - keys[sort](b));
  };
  const levelsNote = () => (firstSession() ? 'New players only, within their first session. A drop is a first session that ended on the level.' : 'Counted from level start, complete, fail and restart events.') + ' Click a level to see the players behind it.';
  const draw = () => {
    const box = document.querySelector('#levels-table');
    document.querySelector('#levels-note').textContent = levelsNote();
    if (!data.levels.length) { document.querySelector('#levels-page-info').textContent = '0 levels'; document.querySelector('#levels-previous-page').disabled = true; document.querySelector('#levels-next-page').disabled = true; box.innerHTML = empty('No level data yet', 'Levels are read from events that start, complete, fail or restart a level, like “Started level 5”. Send some, or name yours in the event dictionary.', '', 'game'); document.querySelector('#levels-summary').innerHTML = ''; return; }
    const minimum = data.context.minimum_players;
    if (data.levels.some(row => row.low_sample)) {
      document.querySelector('#levels-note').innerHTML = `${levelsNote()} <span class="level-sample-legend"><span class="level-sample-marker" aria-hidden="true">·</span> Small sample: fewer than ${number(minimum)} players started.</span>`;
    }
    const largestDrop = [...data.levels].filter(row => !row.low_sample && row.transition?.available).sort((first, second) => second.transition.drop_percent - first.transition.drop_percent)[0];
    const hardest = [...data.levels].filter(row => !row.low_sample).sort((a, b) => (a.completion ?? 100) - (b.completion ?? 100))[0];
    const slowest = [...data.levels].filter(row => row.median_seconds != null).sort((a, b) => b.median_seconds - a.median_seconds)[0];
    const kpiRow = items => `<div class="kpis">${items.map(([label, value, note]) => `<div class="kpi"><div class="eyebrow">${label}</div><div class="k-v">${value}</div><div class="k-c">${note}</div></div>`).join('')}</div>`;
    document.querySelector('#levels-summary').innerHTML = kpiRow([['Levels seen', number(data.levels.length), `level ${data.levels[0].level} to ${data.levels[data.levels.length - 1].level}`], ['Largest total drop', largestDrop ? `Level ${largestDrop.level}` : '—', largestDrop ? `${percent(largestDrop.transition.drop_percent)} did not start level ${largestDrop.level + 1}${firstSession() ? ' in their first session' : ''}` : `needs at least ${number(minimum)} players`], ['Hardest level', hardest ? `Level ${hardest.level}` : '—', hardest ? `${percent(hardest.completion)} of players finish it` : `needs at least ${number(minimum)} players`], ['Slowest level', slowest ? `Level ${slowest.level}` : '—', slowest ? `median ${duration(slowest.median_seconds)}` : '']]) + levelViz(data.levels);
    const sorted = rows();
    const size = document.querySelector('#levels-page-size').value === 'all' ? sorted.length : Number(document.querySelector('#levels-page-size').value);
    page = Math.min(page, Math.max(0, Math.ceil(sorted.length / size) - 1));
    const visible = sorted.slice(page * size, (page + 1) * size);
    document.querySelector('#levels-page-info').textContent = `${page * size + 1}–${Math.min((page + 1) * size, sorted.length)} of ${number(sorted.length)} levels`;
    document.querySelector('#levels-previous-page').disabled = page === 0;
    document.querySelector('#levels-next-page').disabled = (page + 1) * size >= sorted.length;
    box.innerHTML = `<div class="table-wrap level-scroll levels-scroll" tabindex="0" role="region" aria-label="Level results"><table class="levels-grid"><thead><tr><th>Level</th><th class="num">Start</th><th class="num">Finish</th><th class="num" title="Players who started this level but did not later start the next numbered level ÷ players who started this level">Drop · start → start</th><th class="num">Tries / player</th><th class="num">Fails</th><th class="num">Median time</th></tr></thead><tbody>${visible.map(row => `<tr data-level-row="${row.level}" class="${highlighted === row.level ? 'level-highlight ' : ''}${row.completion != null && !row.low_sample && row.completion < 60 ? 'level-hard' : ''}"><td class="level-number-cell"><button type="button" class="level-toggle" data-level-toggle="${row.level}" aria-label="Open the players behind level ${row.level}">${icon('chevron', 14)}</button><strong>${row.level}</strong>${row.low_sample ? ` <span class="level-sample-marker" role="img" aria-label="Small sample: ${number(row.started)} of ${number(minimum)} players" title="Small sample: ${number(row.started)} players started; threshold is ${number(minimum)}">·</span>` : ''}</td><td class="num">${number(row.started)}</td><td class="num">${number(row.completed)}</td><td class="num">${levelTransitionCell(row)}</td><td class="num">${row.tries_per_player ?? '—'}</td><td class="num">${number(row.fails)}${row.restarts ? ` <span class="muted small">· ${row.restarts} restart${row.restarts === 1 ? '' : 's'}</span>` : ''}</td><td class="num">${duration(row.median_seconds)}</td></tr>`).join('')}</tbody></table></div>
      `;
  };
  // Back from a level page: the same page of levels, scrolled to where it was left.
  const restoreList = () => {
    const back = levelsReturn;
    if (pageLevel != null) return;
    levelsReturn = null;
    if (!back || back.game !== game.id) return;
    page = back.page; draw();
    requestAnimationFrame(() => window.scrollTo(0, back.scroll));
  };
  const load = async state => {
    chosen = structuredClone(state); page = 0; data = null; const ticket = ++latest;
    drill.forEach(state => { state.ticket++; });
    if (levelsView === 'compare') { toolsPanel.update(chosen); return; }
    document.querySelector('#levels-page-info').textContent = '';
    document.querySelector('#levels-previous-page').disabled = true;
    document.querySelector('#levels-next-page').disabled = true;
    const finishSummary = beginLoading(document.querySelector('#levels-summary'), skeleton('stats'));
    const finishTable = beginLoading(tableBox, skeleton('table', 8, 7), {path: levelsPath(state)});
    // Coming back to a list seen a few minutes ago draws it at once and updates it if anything changed.
    const showLevels = result => {
      if (ticket !== latest || !tableBox.isConnected) return;
      const first = data === null;
      data = result; levelsFilters.setContext({anonymous_events: result.context.anonymous_events});
      if (first) drill.clear();
      draw();
      if (first) restoreList();
      if (first || !pageBox.querySelector('.has-pane')) drawLevelPage();
    };
    try { await apiShowing(levelsPath(state), showLevels); }
    catch (error) {
      if (ticket !== latest || !tableBox.isConnected) return;
      if (data) toastError(error);
      else { document.querySelector('#levels-summary').innerHTML = ''; tableBox.innerHTML = loadError(error); }
    }
    finally { finishSummary(); finishTable(); }
  };
  const jumpTo = level => {
    if (!data) return;
    const sorted = rows(); const index = sorted.findIndex(row => row.level === level);
    if (index < 0) { toast('No data for that level in the current filters.'); return; }
    const size = document.querySelector('#levels-page-size').value;
    page = size === 'all' ? 0 : Math.floor(index / Number(size)); highlighted = level; draw();
    const row = document.querySelector(`[data-level-row="${level}"]`);
    row.scrollIntoView({block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    row.querySelector('.level-toggle').focus({preventScroll: true});
  };
  document.querySelector('#levels-jump-form').addEventListener('submit', event => { event.preventDefault(); jumpTo(Number(document.querySelector('#levels-jump').value)); });
  document.querySelector('#level-tools').addEventListener('level-jump', async event => { await chooseView('table'); jumpTo(event.detail); });
  document.querySelector('#levels-previous-page').addEventListener('click', () => { if (page > 0) { page--; draw(); } });
  document.querySelector('#levels-next-page').addEventListener('click', () => { if (!document.querySelector('#levels-next-page').disabled) { page++; draw(); } });
  document.querySelector('#levels-page-size').addEventListener('change', () => { page = 0; rememberNavigation(); if (data) draw(); });
  document.querySelector('#levels-sort').addEventListener('change', () => { page = 0; rememberNavigation(); if (data) draw(); });
  document.querySelector('[aria-label="Which players"]').addEventListener('click', event => {
    const button = event.target.closest('[data-levels-scope]');
    if (!button || button.dataset.levelsScope === navigation.scope) return;
    navigation.scope = button.dataset.levelsScope; rememberNavigation(); showScope();
    if (chosen) load(chosen);
  });
  showScope();
  const levelsFilters = mountFilters(document.querySelector('#filters'), game, load);
}
