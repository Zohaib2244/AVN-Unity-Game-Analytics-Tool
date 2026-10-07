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
const paramChips = params => Object.entries(params).map(([key, value]) => `<span class="chip"><b>${escapeHTML(key)}</b> ${escapeHTML(typeof value === 'object' ? JSON.stringify(value) : value)}</span>`).join('');
const shortId = id => id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
const setWidths = container => container.querySelectorAll('[data-width]').forEach(bar => { bar.style.width = `${bar.dataset.width}%`; }); // CSP: no inline style attributes
function storeGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function storeSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }
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
  return {range: saved.range || null, timezone: saved.timezone === 'utc' ? 'utc' : 'local', hideTest: saved.hideTest ?? true, environment: saved.environment || [], app_version: saved.app_version || [], build: saved.build || [], country: saved.country || [], platform: saved.platform || []};
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
  container.innerHTML = `<div class="filter-bar"><div id="filter-range"></div><div class="segmented timezone-toggle" role="group" aria-label="Time zone"><button type="button" data-timezone="local">Local</button><button type="button" data-timezone="utc">UTC</button></div><details class="filter-menu"><summary>${icon('funnel',14)} Filters <span class="count" id="filter-count" hidden></span></summary><div class="filter-options filter-popover" id="filter-options"></div></details></div><div class="filter-chips" id="filter-chips"></div><div class="analysis-context" aria-live="polite"></div>`;
  const changed = () => { saveFilters(game, state); draw(); onChange(state); };
  const draw = () => {
    const options = container.querySelector('#filter-options');
    const scroll = options.scrollTop;
    options.innerHTML = `<label class="filter-switch"><input type="checkbox" id="hide-test" ${state.hideTest ? 'checked' : ''} ${state.environment.length ? 'disabled' : ''}><span>Hide editor & development data</span></label>` +
      Object.keys(FILTER_KEYS).map(dimension => {
        const values = [...new Set([...(facets[dimension] || []).map(item => item.value), ...state[dimension]])];
        const counts = Object.fromEntries((facets[dimension] || []).map(item => [item.value, item.events]));
        return `<fieldset data-dimension="${dimension}"><legend>${DIMENSION_LABELS[dimension]}</legend>${values.length ? values.map(value => `<label><input type="checkbox" value="${escapeHTML(value)}" ${state[dimension].includes(value) ? 'checked' : ''}><span>${escapeHTML(dimensionText(dimension, value))}</span><small>${number(counts[value] || 0)}</small></label>`).join('') : '<p class="help">None in these days</p>'}</fieldset>`;
      }).join('');
    options.scrollTop = scroll;
    const active = activeFilters(state);
    const count = container.querySelector('#filter-count');
    count.hidden = !active; count.textContent = active;
    container.querySelectorAll('[data-timezone]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.timezone === state.timezone)));
    const chips = Object.keys(FILTER_KEYS).flatMap(dimension => state[dimension].map(value => `<button type="button" class="filter-chip" data-remove-dimension="${dimension}" data-remove-value="${escapeHTML(value)}" title="Remove this filter">${DIMENSION_LABELS[dimension]}: ${escapeHTML(dimensionText(dimension, value))} ${icon('close',11)}</button>`));
    container.querySelector('#filter-chips').innerHTML = chips.join('') + (state.hideTest && !state.environment.length ? '<span class="filter-note">Editor & development data hidden</span>' : '') + (chips.length > 1 ? '<button type="button" class="filter-clear" data-clear>Clear all</button>' : '');
  };
  container.addEventListener('change', event => {
    if (event.target.id === 'hide-test') { state.hideTest = event.target.checked; changed(); return; }
    const group = event.target.closest('fieldset[data-dimension]'); if (!group) return;
    state[group.dataset.dimension] = [...group.querySelectorAll('input:checked')].map(input => input.value);
    changed();
  });
  container.addEventListener('click', event => {
    const timezone = event.target.closest('[data-timezone]');
    if (timezone && timezone.dataset.timezone !== state.timezone) { state.timezone = timezone.dataset.timezone; changed(); return; }
    if (event.target.closest('[data-include-test]')) { state.hideTest = false; changed(); return; }
    const chip = event.target.closest('[data-remove-dimension]');
    if (chip) { state[chip.dataset.removeDimension] = state[chip.dataset.removeDimension].filter(value => value !== chip.dataset.removeValue); changed(); }
    if (event.target.closest('[data-clear]')) { for (const dimension of Object.keys(FILTER_KEYS)) state[dimension] = []; changed(); }
  });
  const rangeBox = container.querySelector('#filter-range');
  rangeBox.innerHTML = compactRangeMarkup();
  bindRange(rangeBox, async range => {
    state.range = {from: range.from, to: range.to, preset: range.preset};
    saveFilters(game, state);
    draw(); onChange(state);
    try { facets = await api(`${gameURL(game)}/insights/facets?${new URLSearchParams({start: range.from, end: range.to, tz_offset: timezoneOffset(state)})}`); draw(); } catch { /* the menu keeps the chosen values */ }
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
  return rows.length ? `<table class="breakdown"><thead><tr><th>${DIMENSION_LABELS[dimension]}</th><th></th><th class="num">Players</th><th class="num">Share</th></tr></thead><tbody>${rows.map(row => `<tr class="${chosen.includes(row.value) ? 'chosen' : ''}"><td><button type="button" class="link-button" data-filter-dimension="${dimension}" data-filter-value="${escapeHTML(row.value)}" title="${chosen.includes(row.value) ? 'Remove this filter' : 'Show only this'}">${escapeHTML(dimensionText(dimension, row.value))}</button></td><td class="breakdown-bar"><span data-width="${Math.max(2, 100 * row.players / peak)}"></span></td><td class="num">${number(row.players)}</td><td class="num muted">${total ? percent(100 * row.players / total) : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="help panel-body">No data.</p>';
}

async function renderGameOverview() {
  const game = currentGame;
  const archived = game.archived_at ? `<div class="archived-banner">${icon('lock',18)}<div><strong>Archived.</strong> Collection is paused for this platform.</div><a class="button" href="${gamePath(game, 'settings')}">Game settings</a></div>` : '';
  shell('Overview', heading(game.name, `${platformLabel(game.platform)} · ${game.bundle_id}`, `<a class="button primary" href="${gamePath(game, 'exports')}">${icon('export',15)} Export data</a>`) + archived +
    `<div id="filters"></div><div id="totals"></div><div id="anomalies"></div><div id="active"></div>
    <section class="panel"><div class="panel-header"><h2>Activity per day</h2><div class="segmented" role="group" aria-label="Measure">${[['players','Players (DAU)'],['sessions','Sessions'],['events','Events']].map(([key, label]) => `<button type="button" data-measure="${key}" aria-pressed="${key === 'players'}">${label}</button>`).join('')}</div></div><div class="panel-body chart-wrap" id="daily"><p class="help">Loading…</p></div></section>
    <div class="section-grid overview-grid section-spacing"><section class="panel"><div class="panel-header"><h2>Who’s playing</h2><div class="segmented" aria-label="Break down by">${Object.entries(DIMENSION_LABELS).map(([key, label], index) => `<button type="button" data-dimension-tab="${key}" aria-pressed="${index === 0}">${label.replace('Device platform', 'Platform').replace('App version', 'Version')}</button>`).join('')}</div></div><div id="breakdowns"></div></section>
    <section class="panel"><div class="panel-header"><h2>Top events</h2><a class="text-link" href="${gamePath(game, 'dictionary')}">Dictionary ${icon('arrow',13)}</a></div><div id="top-events"></div></section></div>`);
  let summary = null; let measure = 'players'; let dimension = 'environment'; let latest = 0;
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
    try {
      const data = await api(`${gameURL(game)}/insights/summary?${filterQuery(state)}`);
      if (ticket !== latest) return;
      summary = data;
      filters.setContext({...data.context, players: data.players});
      document.querySelector('#totals').innerHTML = stats([['Players', number(data.players), `${number(data.new_players)} new · unique player IDs`], ['Sessions', number(data.sessions), data.players ? `${(data.sessions / data.players).toFixed(1)} per player` : 'with a player ID'], ['Events', number(data.events), `${number(data.context.identified_events)} player-linked · ${number(data.context.anonymous_events)} without an ID`]]);
      document.querySelector('#anomalies').innerHTML = data.anomalies.length ? `<section class="anomaly-strip" aria-label="Notable changes from the preceding period"><div><strong>Notable change${data.anomalies.length === 1 ? '' : 's'}</strong><span>Compared with the preceding ${daysBetween(state.range.from, state.range.to) + 1}-day period</span></div>${data.anomalies.map(item => `<span class="anomaly-item ${item.direction}"><b>${escapeHTML(item.label)}</b> ${item.change_percent > 0 ? '+' : ''}${percent(item.change_percent)} <small>${number(item.previous)} → ${number(item.current)}</small></span>`).join('')}</section>` : '';
      document.querySelector('#active').innerHTML = data.events ? activeUsers(data.active) : '';
      drawDaily(); drawBreakdown();
      document.querySelector('#top-events').innerHTML = data.top_events.length ? `<table class="compact-table"><thead><tr><th>Event</th><th class="num">Events</th><th class="num">Players</th></tr></thead><tbody>${data.top_events.slice(0, 10).map(row => `<tr><td class="mono">${escapeHTML(row.name)}</td><td class="num">${number(row.events)}</td><td class="num">${number(row.players)}</td></tr>`).join('')}</tbody></table>` : '<p class="help panel-body">No events.</p>';
    } catch (error) { if (ticket === latest) document.querySelector('#daily').innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  });
}

/* ─── Retention: first qualifying session_start cohort, then exact return days ─── */

const retentionTone = value => value == null ? '' : `retention-${Math.min(4, Math.floor(value / 20))}`;
const retentionValue = value => value == null ? '<span class="muted">Not mature</span>' : `<strong>${percent(value.percent)}</strong><small>${number(value.players)} returned</small>`;

async function renderRetention() {
  const game = currentGame;
  shell('Retention', heading('Retention', 'Group player IDs by their first session start, then see who returns on exact later days.') +
    `<div id="filters"></div><div id="retention-summary"></div>
    <section class="panel"><div class="panel-header"><div><h2>Cohort retention</h2><p id="retention-note">A return requires another session_start on that exact day.</p></div></div><div id="retention-table"><p class="help panel-body">Loading…</p></div></section>`);
  let latest = 0;
  const filters = mountFilters(document.querySelector('#filters'), game, async state => {
    const ticket = ++latest;
    try {
      const data = await api(`${gameURL(game)}/insights/retention?${filterQuery(state)}`);
      if (ticket !== latest) return;
      filters.setContext({...data.context, players: data.context.identified_players});
      const aggregate = day => data.aggregate[String(day)];
      document.querySelector('#retention-summary').innerHTML = stats([
        ['Cohort users', number(data.context.identified_players), 'first qualifying session start in these days'],
        ['Day 1', aggregate(1).percent == null ? '—' : percent(aggregate(1).percent), aggregate(1).cohort_players ? `${number(aggregate(1).players)} of ${number(aggregate(1).cohort_players)}` : 'no mature cohorts'],
        ['Day 7', aggregate(7).percent == null ? '—' : percent(aggregate(7).percent), aggregate(7).cohort_players ? `${number(aggregate(7).players)} of ${number(aggregate(7).cohort_players)}` : 'no mature cohorts'],
        ['Day 30', aggregate(30).percent == null ? '—' : percent(aggregate(30).percent), aggregate(30).cohort_players ? `${number(aggregate(30).players)} of ${number(aggregate(30).cohort_players)}` : 'no mature cohorts'],
      ]);
      const mapped = data.context.mapped_event_names;
      document.querySelector('#retention-note').textContent = `A return requires another session_start on that exact day · days after ${prettyDay(data.context.latest_complete_day)} are not mature${mapped.length ? ` · also mapped from ${mapped.join(', ')}` : ''}.`;
      const box = document.querySelector('#retention-table');
      if (!data.cohorts.length) {
        box.innerHTML = empty('No retention cohorts in these days', 'Retention starts with a player ID and a session_start event. Try earlier days, loosen filters, or map your game’s session event in the dictionary.', '', 'pulse');
        return;
      }
      box.innerHTML = `<div class="table-wrap"><table class="retention-table"><thead><tr><th>Cohort day</th><th class="num">New users</th>${data.days.map(day => `<th class="num">Day ${day}</th>`).join('')}</tr></thead><tbody>${data.cohorts.map(row => `<tr><td><strong>${escapeHTML(prettyDay(row.day))}</strong>${row.low_sample ? ' <span class="pill sample">small sample</span>' : ''}</td><td class="num"><strong>${number(row.players)}</strong></td>${data.days.map(day => { const value = row.retained[String(day)]; return `<td class="num retention-cell ${retentionTone(value?.percent)}">${retentionValue(value)}</td>`; }).join('')}</tr>`).join('')}</tbody><tfoot><tr><th>Weighted total</th><th class="num">${number(data.context.identified_players)}</th>${data.days.map(day => { const value = data.aggregate[String(day)]; return `<th class="num retention-cell ${retentionTone(value.percent)}">${retentionValue(value.percent == null ? null : value)}</th>`; }).join('')}</tr></tfoot></table></div><p class="help panel-body">The selected dates choose first-session cohort days. Rates are weighted by cohort size. “Not mature” means the return day has not fully ended yet.</p>`;
    } catch (error) {
      if (ticket === latest) document.querySelector('#retention-table').innerHTML = `<p class="error panel-body">${escapeHTML(error.message)}</p>`;
    }
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
        <details class="funnel-more"><summary>Options <span id="options-summary" class="muted"></span></summary><div class="funnel-options"><label class="inline-field">Count<select id="funnel-scope"><option value="player">Per player, across sessions</option><option value="session">Within one session</option></select></label><label class="inline-field">Finish within<select id="funnel-window"><option value="">Any time</option><option value="0.25">15 minutes</option><option value="1">1 hour</option><option value="24">1 day</option><option value="168">7 days</option><option value="720">30 days</option></select></label><label class="inline-field">Break down by<select id="funnel-breakdown"><option value="">Nothing</option>${Object.entries(DIMENSION_LABELS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label></div></details></div></section>
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
    document.querySelector('#options-summary').textContent = `· ${parts.join(' · ')}`;
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
    catch (error) { toast(error.message); }
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
    result.innerHTML = '<p class="help">Counting players…</p>';
    const breakdown = document.querySelector('#funnel-breakdown').value;
    try {
      const data = await api(`${gameURL(game)}/insights/funnel`, {method:'POST', body: JSON.stringify({...filterBody(filters.state), steps: body.steps, scope: body.scope, ...(body.window_hours ? {window_hours: body.window_hours} : {}), ...(breakdown ? {breakdown} : {})})});
      if (ticket === latest) {
        lastResult = data; filters.setContext({...data.context, players: data.steps[0]?.players || 0}); drawResult(data);
        if (storeGet(`avn-pending-journeys-${game.id}`)) { storeSet(`avn-pending-journeys-${game.id}`, null); journeys.run(); } else journeys.refresh();
      }
    } catch (error) { if (ticket === latest) result.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  }
  const timing = times => times ? `<span title="${number(times.count)} players · average ${duration(times.average)} · fastest ${duration(times.min)} · slowest ${duration(times.max)}">median ${duration(times.median)} · 90% within ${duration(times.p90)}</span>` : '';
  const drawResult = data => {
    const rows = data.steps; const first = rows[0].players; const last = rows[rows.length - 1];
    document.querySelector('#funnel-note').textContent = first ? `${current.scope === 'session' ? 'Each player’s best single session' : 'Each player, across all their sessions'}${current.window_hours ? ` · finished within ${document.querySelector('#funnel-window').selectedOptions[0].textContent}` : ''} · hover times for averages` : 'Nobody did the first step with these filters and days.';
    document.querySelector('#funnel-csv').hidden = false;
    panels.result.setNote(first ? `${number(first)} started · ${number(last.players)} completed · ${percent(last.of_first)}` : 'nobody did step 1');
    document.querySelector('#funnel-summary').innerHTML = first ? `<div class="panel-body funnel-stats">${stats([['Started', number(first), 'did step 1'], ['Completed', number(last.players), 'reached the last step'], ['Conversion', percent(last.of_first), 'first → last step'], ['Time to complete', data.time_to_complete ? duration(data.time_to_complete.median) : '—', data.time_to_complete ? `median · 90% within ${duration(data.time_to_complete.p90)}` : 'nobody finished']])}</div>` : '';
    let worst = null;
    rows.forEach((row, index) => { if (index && rows[index - 1].players && row.of_previous < 100 && (!worst || row.of_previous < worst.rate)) worst = {index, rate: row.of_previous}; });
    result.classList.toggle('many', rows.length > 15);
    result.innerHTML = `<ol class="funnel">${rows.map((row, index) => {
      const isWorst = worst && worst.index === index;
      const gap = index ? `<li class="funnel-gap ${isWorst ? 'worst' : ''}"><span>${percent(row.of_previous)} continued${isWorst ? ' · biggest drop' : ''}</span>${timing(row.time_from_previous)}</li>` : '';
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
    catch (error) { toast(error.message); catalog = {events: []}; }
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
    <p class="help" id="journeys-intro">Pick where to start and end, then “Show journeys”. The steps come from your funnel above. Events are named from your event dictionary; fill in “How it reads in player stories” there to rename them.</p>
    <div id="journeys-views" hidden>
      <div class="range-modes route-tabs" role="tablist" aria-label="How to view journeys"><button type="button" role="tab" data-view="journeys">Journeys</button><button type="button" role="tab" data-view="exits">Where players stop</button></div>
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
    $('#journeys-players-title').textContent = title; $('#journeys-players-note').textContent = ''; $('#journeys-players').innerHTML = '<p class="help">Loading players…</p>';
    wrap.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    try {
      const data = await api(`${gameURL(game)}/insights/journeys/players`, {method: 'POST', body: JSON.stringify({...lastBody, target})});
      $('#journeys-players-note').textContent = `${number(data.total)} player${data.total === 1 ? '' : 's'}${data.total > data.players.length ? ` · showing the latest ${number(data.players.length)}` : ''} · open one to read their story`;
      $('#journeys-players').innerHTML = data.players.length ? `<div class="table-wrap"><table><thead><tr><th>Player</th><th>Outcome</th><th>What they did</th><th>Last event</th></tr></thead><tbody>${data.players.map(item => `<tr><td><a class="mono" href="${gamePath(game, 'players')}?${new URLSearchParams({player: item.player})}">${escapeHTML(shortId(item.player))}</a></td><td>${outcome(item.status)}</td><td class="route-cell">${escapeHTML(item.line || '—')}</td><td class="small muted">${displayDate(item.last_seen)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Nobody.</p>';
      $('#journeys-players-csv').onclick = () => downloadCSV(`${game.name}-journey-players.csv`, [['player', 'outcome', 'what_they_did', 'last_event'], ...data.players.map(item => [item.player, item.status, item.line, item.last_seen])]);
    } catch (error) { $('#journeys-players').innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  }

  async function run() {
    active = true;
    const ticket = ++latest;
    const steps = hooks.steps();
    const intro = $('#journeys-intro');
    if (steps.length < 2) { $('#journeys-views').hidden = true; intro.hidden = false; intro.textContent = 'Add at least two steps to your funnel first.'; return; }
    intro.hidden = false; intro.textContent = 'Following players…'; $('#journeys-players-wrap').hidden = true;
    try {
      lastBody = {...hooks.query(), route_from: state.from, route_to: state.to, ignore: state.ignore, span: state.span};
      const data = await api(`${gameURL(game)}/insights/journeys`, {method: 'POST', body: JSON.stringify(lastBody)});
      if (ticket !== latest) return;
      $('#journeys-summary').innerHTML = data.started ? stats([['Started', number(data.started), `did “${escapeHTML(startName())}”`], ['Reached the end', number(data.reached), percent(100 * data.reached / data.started)], ['Stopped', number(data.stopped), percent(100 * data.stopped / data.started)], ['Kept going', number(data.continued), ''], ['Different journeys', number(data.distinct), '']]) : '';
      if (!data.started) { $('#journeys-views').hidden = true; intro.hidden = false; intro.textContent = 'Nobody did the start step with these days and filters.'; return; }
      lastData = data; outcomeFilter = 'all'; shown = 12;
      intro.hidden = true; $('#journeys-views').hidden = false; drawViews();
    } catch (error) { if (ticket === latest) { $('#journeys-views').hidden = true; intro.hidden = false; intro.innerHTML = `<span class="error">${escapeHTML(error.message)}</span>`; } }
  }
  $('#journeys-run').addEventListener('click', run);
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
const BASE_SORTS = [['last_seen', 'Last active'], ['first_seen', 'First seen'], ['events', 'Events'], ['sessions', 'Sessions'], ['session_length', 'Session length'], ['version', 'App version']];

async function renderPlayers() {
  const game = currentGame;
  const player = new URLSearchParams(location.search).get('player');
  if (player) return renderJourney(game, player);
  const viewKey = `avn-players-view-${game.id}`;
  const view = {sort: 'last_seen', order: 'desc', conditions: [], metrics: [], ...(storeGet(viewKey) || {})};
  let catalog = {events: []};
  shell('Players', heading('Players', 'A player uses user_id when available, otherwise device_id. Open one to read their story, sort the list, or add event-based columns.') +
    `<div id="filters"></div>
    <section class="panel section-spacing"><div class="panel-header"><h2>Players <span class="count" id="player-count">0</span></h2><div class="search">${icon('search',16)}<input id="player-search" type="search" aria-label="Search players" placeholder="Search by user or install ID…"></div></div>
      <div class="players-toolbar"><label class="inline-field">Sort by<select id="player-sort"></select></label><button type="button" class="button small-button" id="player-order"></button>
        <button type="button" class="button small-button rules-toggle" id="rules-toggle" aria-expanded="false" aria-controls="player-rules">${icon('funnel', 14)} Event rules <span class="count" id="rules-count" hidden></span></button><span class="rules-summary small muted" id="rules-summary"></span>
        <div class="player-rules" id="player-rules" hidden>
          <section class="rule-section" id="conditions-section"><button type="button" class="rule-section-toggle" aria-expanded="true"><span class="rule-chevron">${icon('chevron', 15)}</span><span class="rule-section-title">Only show players who…</span><span class="count" id="conditions-count" hidden></span><span class="rule-section-note small muted" id="conditions-note"></span></button><div class="rule-section-body"><p class="help">Every rule here must be true. For example: <em>Did</em> <code>POWERUP_CONSUMED</code> at least 3 times, or <em>Never did</em> <code>SETTINGS_OPENED</code>.</p><div id="condition-list"></div></div></section>
          <section class="rule-section" id="metrics-section"><button type="button" class="rule-section-toggle" aria-expanded="true"><span class="rule-chevron">${icon('chevron', 15)}</span><span class="rule-section-title">Add a column (and sort by it)</span><span class="count" id="metrics-count" hidden></span><span class="rule-section-note small muted" id="metrics-note"></span></button><div class="rule-section-body"><p class="help">Pick what to work out for each player, from an event: how many times, the highest, lowest or total of one of its parameters, or when it first or last happened.</p><div id="metric-list"></div></div></section></div></div>
      <div id="player-list"><p class="help panel-body">Loading…</p></div></section>`);
  const list = document.querySelector('#player-list');
  let offset = 0; let search = ''; let latest = 0; let chosen = null; let lastMetrics = [];
  const persist = () => storeSet(viewKey, view);
  const panel = document.querySelector('#player-rules'); const toggle = document.querySelector('#rules-toggle');
  const showRules = open => { panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); toggle.classList.toggle('active', open); };
  toggle.addEventListener('click', () => { view.rulesOpen = panel.hidden; persist(); showRules(view.rulesOpen); });
  showRules(Boolean(view.rulesOpen));
  view.fold = view.fold || {};
  const foldSection = (id, name) => {
    const section = document.querySelector(id); const button = section.querySelector('.rule-section-toggle');
    const apply = () => { section.classList.toggle('collapsed', Boolean(view.fold[name])); button.setAttribute('aria-expanded', String(!view.fold[name])); };
    button.addEventListener('click', () => { view.fold[name] = !view.fold[name]; persist(); apply(); });
    apply();
  };
  foldSection('#conditions-section', 'conditions'); foldSection('#metrics-section', 'metrics');
  const rulesBody = () => ({conditions: usableRules(view.conditions).map(rule => ({...rule, does: rule.does || 'did', min_times: rule.min_times || 1})), metrics: usableRules(view.metrics).map(rule => ({...rule, agg: rule.agg || 'count'}))});

  const drawControls = () => {
    const metrics = rulesBody().metrics;
    const options = [...BASE_SORTS, ...metrics.map((metric, position) => [`metric${position}`, metricLabel(metric)])];
    if (!options.some(([key]) => key === view.sort)) view.sort = 'last_seen';
    document.querySelector('#player-sort').innerHTML = options.map(([key, label]) => `<option value="${key}" ${key === view.sort ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('');
    const timeSort = ['last_seen', 'first_seen', 'version'].includes(view.sort) || metrics[Number(view.sort.replace('metric', ''))]?.agg?.match(/first|last/);
    const orderLabel = view.sort === 'session_length'
      ? (view.order === 'desc' ? 'Longest first' : 'Shortest first')
      : (view.order === 'desc' ? (timeSort ? 'Newest first' : 'Highest first') : (timeSort ? 'Oldest first' : 'Lowest first'));
    document.querySelector('#player-order').innerHTML = `${view.order === 'desc' ? '↓' : '↑'} ${orderLabel}`;
    const conditions = rulesBody().conditions;
    const active = conditions.length + metrics.length;
    const count = document.querySelector('#rules-count'); count.hidden = !active; count.textContent = active;
    const part = (name, count, texts) => { const badge = document.querySelector(`#${name}-count`); badge.hidden = !count; badge.textContent = count; document.querySelector(`#${name}-note`).textContent = texts.join(' · '); };
    part('conditions', conditions.length, conditions.map(rule => `${rule.does === 'didnt' ? 'never' : 'did'} ${rule.event}${rule.param ? ` (${rule.param})` : ''}`));
    part('metrics', metrics.length, metrics.map(metricLabel));
    document.querySelector('#rules-summary').textContent = active ? [...conditions.map(rule => `${rule.does === 'didnt' ? 'never' : 'did'} ${rule.event}${rule.param ? ` (${rule.param})` : ''}`), ...metrics.map(metricLabel)].join(' · ') : '';
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
    try {
      const query = `${filterQuery(chosen)}&${new URLSearchParams({search, offset, sort: view.sort, order: view.order, ...(body.conditions.length || body.metrics.length ? {rules: JSON.stringify(body)} : {})})}`;
      const data = await api(`${gameURL(game)}/insights/players?${query}`);
      if (ticket !== latest) return;
      filtersControl?.setContext(data.context || {});
      document.querySelector('#player-count').textContent = number(data.total);
      if (!data.players.length) { list.innerHTML = empty(search || body.conditions.length ? 'No matching players' : 'No players', search || body.conditions.length ? 'Try another ID, or loosen the event rules.' : 'Pick other days or filters, or check that your game is sending events.', '', 'users'); return; }
      const link = row => `${gamePath(game, 'players')}?${new URLSearchParams({player: row.player})}`;
      const head = (key, label, extra = '') => `<th class="${extra} sortable ${view.sort === key ? 'sorted' : ''}" data-sort="${key}" aria-sort="${view.sort === key ? (view.order === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button">${escapeHTML(label)}<span class="sort-arrow">${view.sort === key ? (view.order === 'asc' ? '▲' : '▼') : ''}</span></button></th>`;
      list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Player</th>${head('events', 'Events', 'num')}${head('sessions', 'Sessions', 'num')}${head('session_length', 'Avg session', 'num')}${head('first_seen', 'First seen')}${head('last_seen', 'Last active')}${body.metrics.map((metric, position) => head(`metric${position}`, metricLabel(metric), 'num metric')).join('')}${head('version', 'Version')}<th>Env</th><th>Country</th></tr></thead><tbody>${data.players.map(row => `<tr><td><a class="row-title" href="${link(row)}"><span class="mono">${escapeHTML(shortId(row.player))}</span></a><p class="small muted">${row.has_user_id ? 'User ID' : 'Install ID'} · ${platformLabel(row.platform || '—')}</p></td><td class="num">${number(row.events)}</td><td class="num">${number(row.sessions)}</td><td class="num">${duration(row.avg_session_seconds)}</td><td class="small muted">${analysisDate(row.first_seen, chosen.timezone)}</td><td class="small muted">${analysisDate(row.last_seen, chosen.timezone)}</td>${body.metrics.map((metric, position) => `<td class="num metric">${metricValue(metric, row.metrics[position], chosen.timezone)}</td>`).join('')}<td class="small">${escapeHTML(row.app_version || '—')}</td><td><span class="pill ${TEST_ENVIRONMENTS.includes(row.environment) ? '' : 'good'}">${escapeHTML(row.environment || '—')}</span></td><td class="small">${countryTag(row.country)}</td></tr>`).join('')}</tbody></table></div>
        <div class="pager"><span class="small muted">${number(offset + 1)}–${number(offset + data.players.length)} of ${number(data.total)}</span><span><button class="button" data-page="-1" ${offset ? '' : 'disabled'}>Previous</button> <button class="button" data-page="1" ${offset + data.players.length < data.total ? '' : 'disabled'}>Next</button></span></div>`;
    } catch (error) { if (ticket === latest) list.innerHTML = `<p class="error panel-body">${escapeHTML(error.message)}</p>`; }
  };
  list.addEventListener('click', event => {
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
    try { catalog = await api(`${gameURL(game)}/insights/catalog?${filterQuery(state)}`); conditionList.redraw(); metricList.redraw(); } catch { catalog = {events: []}; }
    load();
  });
}

/* ─── One player: their story in plain words (default) or every raw event ─── */

const levelTable = rows => `<table class="level-mini"><thead><tr><th>Level</th><th>Result</th><th class="num">Time</th></tr></thead><tbody>${rows.map(row => `<tr><td>${row.level}</td><td>${row.completed ? 'Completed' : row.failed ? 'Failed' : 'Started'}${row.failed ? ` · failed ${row.failed}×` : ''}${row.restarted ? ` · restarted ${row.restarted}×` : ''}${row.completed && row.started > 1 ? ` · ${row.started} tries` : ''}</td><td class="num">${row.seconds != null ? duration(row.seconds) : '—'}</td></tr>`).join('')}</tbody></table>`;

function storyChapter(chapter, timezone, focusLevel = null) {
  const came = chapter.gap == null ? '' : chapter.gap >= 1800 ? ` · came back ${duration(chapter.gap)} after the last session` : ` · ${duration(chapter.gap)} after the last session`;
  return `<section class="story-chapter"><div class="story-head"><strong>Session ${chapter.number}</strong><span>${analysisDate(chapter.start, timezone)} · ${duration(chapter.seconds)} played${came}</span></div>
    <ol class="story-lines">${chapter.segments.map(segment => {
      const slow = segment.slowest ? `<span class="story-flag">Level ${segment.slowest.level} took ${duration(segment.slowest.seconds)}</span>` : '';
      const extras = segment.extras?.length ? `<span class="story-extras">${segment.extras.map(extra => `<span class="chip">${escapeHTML(extra.text)}${extra.count > 1 ? ` ×${extra.count}` : ''}</span>`).join('')}</span>` : '';
      const focus = focusLevel != null && segment.type === 'levels' && segment.levels.some(row => row.level === focusLevel);
      const details = segment.type === 'levels' ? `<details class="story-details" ${focus ? 'open' : ''}><summary>Level by level</summary>${levelTable(segment.levels)}</details>` : Object.keys(segment.params || {}).filter(key => key !== 'seq').length ? `<details class="story-details"><summary>Details</summary><span class="story-params">${paramChips(Object.fromEntries(Object.entries(segment.params).filter(([key]) => key !== 'seq')))}</span></details>` : '';
      return `<li class="story-line ${segment.type} ${focus ? 'focus' : ''}"><time datetime="${escapeHTML(segment.t)}">${clock(segment.t, timezone)}</time><div><span class="story-text">${escapeHTML(segment.text)}</span>${slow}${extras}${details}</div></li>`;
    }).join('') || '<li class="help">Nothing but session start and end.</li>'}</ol></section>`;
}

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

async function renderJourney(game, player) {
  shell('Player story', `<a class="back-link" href="${gamePath(game, 'players')}">← Back to players</a>` + heading('Player story', player) +
    `<div class="filter-bar"><div id="story-range"></div><div class="segmented timezone-toggle" role="group" aria-label="Player event time zone"><button type="button" data-story-timezone="local">Local</button><button type="button" data-story-timezone="utc">UTC</button></div></div><div class="analysis-context" id="story-context"></div><div id="story-metrics"></div>
    <div class="range-modes route-tabs" role="tablist" aria-label="View"><button type="button" role="tab" data-story-view="story">Story</button><button type="button" role="tab" data-story-view="raw">Raw events</button><button type="button" role="tab" data-story-view="info">Player info</button></div>
    <div id="story-body"></div>`);
  let view = storeGet(`avn-story-view-${game.id}`) || 'story';
  const saved = filterState(game);
  let range = null; let showHidden = false; let timezone = saved.timezone; let fetchedDevice = null;
  // Opened from the Levels page: only up to (or from) the level they were looking at.
  const asked = new URLSearchParams(location.search);
  const focusLevel = /^\d{1,7}$/.test(asked.get('level') || '') ? Number(asked.get('level')) : null;
  let focusCut = focusLevel != null && ['until', 'from'].includes(asked.get('cut')) ? asked.get('cut') : null;
  const body = document.querySelector('#story-body');
  const tabs = () => document.querySelectorAll('[data-story-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.storyView === view)));
  const draw = async () => {
    tabs();
    document.querySelectorAll('[data-story-timezone]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.storyTimezone === timezone)));
    document.querySelector('#story-context').textContent = `${timezone === 'utc' ? 'UTC' : 'Local time'} · player ID = user_id, otherwise device_id`;
    body.innerHTML = '<p class="help">Reading their story…</p>';
    try {
      const data = await api(`${gameURL(game)}/insights/story?${new URLSearchParams({start: range.from, end: range.to, player, hidden: String(showHidden), tz_offset: timezone === 'utc' ? 0 : localTimezoneOffset(), ...(focusCut ? {level: focusLevel, cut: focusCut} : {})})}`);
      document.querySelector('#story-metrics').innerHTML = stats([['Sessions', number(data.sessions), data.first_seen ? `${analysisDate(data.first_seen, timezone)} → ${analysisDate(data.last_seen, timezone)}` : ''], ['Events', number(data.events), ''], ['Play time', duration(data.total_play_seconds), data.average_session_seconds != null ? `${duration(data.average_session_seconds)} average session` : ''], ['Highest level', data.highest_level != null ? number(data.highest_level) : '—', '']]);
      if (view === 'info') {
        body.innerHTML = playerInformation(data, timezone, fetchedDevice);
        const fetchButton = body.querySelector('#fetch-device-info');
        fetchButton?.addEventListener('click', async () => {
          fetchButton.disabled = true; fetchButton.textContent = 'Fetching…';
          const result = body.querySelector('#device-specs-result');
          result.innerHTML = deviceCatalog({loading: true});
          try {
            fetchedDevice = await api(`${gameURL(game)}/insights/device-specs?${new URLSearchParams({player})}`);
            result.innerHTML = deviceCatalog(fetchedDevice);
            fetchButton.textContent = 'Device info fetched';
          } catch (error) {
            result.innerHTML = deviceCatalog(fetchedDevice);
            toast(error.message);
            fetchButton.disabled = false; fetchButton.textContent = 'Try device lookup again';
          }
        });
        return;
      }
      if (view === 'raw') { await renderRawEvents(game, player, range, timezone); return; }
      const focusBar = focusLevel == null ? '' : `<div class="story-focus"><div class="segmented" role="group" aria-label="How much of the story">${[['until', `Up to level ${focusLevel}`], ['from', `From level ${focusLevel}`], [null, 'Everything']].map(([key, label]) => `<button type="button" data-story-cut="${key ?? ''}" aria-pressed="${focusCut === key}">${label}</button>`).join('')}</div><span class="small muted">${!focusCut ? `Level ${focusLevel} is highlighted.` : !data.cut?.found ? `This player has no level ${focusLevel} events in these days, so everything is shown.` : focusCut === 'until' ? `Up to the last time they played level ${focusLevel}${data.cut.hidden ? ` · ${number(data.cut.hidden)} later event${data.cut.hidden === 1 ? '' : 's'} hidden` : ''}.` : `From the first time they started level ${focusLevel}${data.cut.hidden ? ` · ${number(data.cut.hidden)} earlier event${data.cut.hidden === 1 ? '' : 's'} hidden` : ''}.`}</span></div>`;
      body.innerHTML = focusBar + (data.chapters.length ? `<label class="check-row story-toggle"><input type="checkbox" id="story-hidden" ${showHidden ? 'checked' : ''}> Also show events hidden in the dictionary</label>${data.chapters.map(chapter => storyChapter(chapter, timezone, focusLevel)).join('')}` : '<p class="help">No events from this player in these days.</p>');
      body.querySelector('[aria-label="How much of the story"]')?.addEventListener('click', event => {
        const button = event.target.closest('[data-story-cut]'); if (!button) return;
        focusCut = button.dataset.storyCut || null;
        const url = new URL(location.href); focusCut ? url.searchParams.set('cut', focusCut) : url.searchParams.delete('cut');
        history.replaceState(null, '', url); draw();
      });
      body.querySelector('#story-hidden')?.addEventListener('change', event => { showHidden = event.target.checked; draw(); });
    } catch (error) { body.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  };
  document.querySelector('[aria-label="View"]').addEventListener('click', event => {
    const tab = event.target.closest('[data-story-view]');
    if (tab && range) { view = tab.dataset.storyView; storeSet(`avn-story-view-${game.id}`, view); draw(); }
  });
  document.querySelector('[aria-label="Player event time zone"]').addEventListener('click', event => {
    const button = event.target.closest('[data-story-timezone]');
    if (!button || button.dataset.storyTimezone === timezone) return;
    timezone = button.dataset.storyTimezone;
    saveFilters(game, {...filterState(game), timezone});
    if (range) draw();
  });
  const rangeBox = document.querySelector('#story-range');
  rangeBox.innerHTML = compactRangeMarkup();
  bindRange(rangeBox, next => { range = next; draw(); }, saved.range?.preset || '30', saved.range);
}

async function renderRawEvents(game, player, range, timezone) {
  document.querySelector('#story-body').innerHTML = `<section class="panel"><div class="panel-header"><div><h2>Timeline</h2><p>Every event, grouped by session · times in ${timezone === 'utc' ? 'UTC' : 'your local time'} · the gap is the time since the previous event</p></div><div class="search">${icon('search',16)}<input id="journey-filter" type="search" aria-label="Filter events" placeholder="Filter by event or parameter…"></div></div><div class="panel-body" id="journey"><p class="help">Loading…</p></div></section>`;
  let events = [];
  const box = document.querySelector('#journey');
  const draw = () => {
    const query = document.querySelector('#journey-filter').value.trim().toLowerCase();
    if (!events.length) { box.innerHTML = '<p class="help">No events from this player in these days.</p>'; return; }
    const sessions = [];
    events.forEach((event, index) => {
      const previous = events[index - 1];
      const gap = previous ? (Date.parse(event.client_ts) - Date.parse(previous.client_ts)) / 1000 : null;
      if (!sessions.length || sessions[sessions.length - 1].id !== event.session_id) sessions.push({id: event.session_id, items: []});
      sessions[sessions.length - 1].items.push({...event, gap});
    });
    const matches = item => !query || `${item.name} ${Object.entries(item.params).map(([key, value]) => `${key} ${value}`).join(' ')}`.toLowerCase().includes(query);
    box.innerHTML = sessions.map((session, index) => {
      const items = session.items.filter(matches);
      if (!items.length) return '';
      const start = session.items[0].client_ts; const end = session.items[session.items.length - 1].client_ts;
      return `<div class="journey-session"><div class="journey-session-head"><strong>Session ${index + 1}</strong><span>${analysisDate(start, timezone)} · ${duration((Date.parse(end) - Date.parse(start)) / 1000)} · ${session.items.length} event${session.items.length === 1 ? '' : 's'}</span></div>
        <ol class="journey-events">${items.map(item => `<li><time datetime="${escapeHTML(item.client_ts)}">${clock(item.client_ts, timezone)}</time><span class="journey-gap ${item.gap > 60 ? 'long' : ''}">${item.gap == null ? '' : `+${duration(item.gap)}`}</span><span class="journey-name">${escapeHTML(item.name)}</span><span class="journey-params">${paramChips(item.params)}</span></li>`).join('')}</ol></div>`;
    }).join('') || '<p class="help">No events match the filter.</p>';
  };
  document.querySelector('#journey-filter').addEventListener('input', draw);
  try {
    const data = await api(`${gameURL(game)}/insights/journey?${new URLSearchParams({start: range.from, end: range.to, player, tz_offset: timezone === 'utc' ? 0 : localTimezoneOffset()})}`);
    events = data.events;
    draw();
  } catch (error) { box.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
}

/* ─── Levels: how every level is going ─── */

function levelTransition(row, levels) {
  const next = levels.find(candidate => candidate.level === row.level + 1);
  if (!next || !row.completed) return null;
  const difference = row.completed - next.started;
  return {next: next.level, started: next.started, difference, percent: Math.round(1000 * difference / row.completed) / 10};
}

function levelTransitionCell(row, levels) {
  const transition = levelTransition(row, levels);
  if (!transition) return '<span class="muted" title="No finishers or no data for the next numbered level">—</span>';
  const {next, started, difference, percent: rate} = transition;
  const detail = `Level ${row.level}: ${row.completed} finished → level ${next}: ${started} started. Count difference within the selected dates and filters; not a matched-player cohort.`;
  return `<span title="${escapeHTML(detail)}">${percent(Math.abs(rate))}${difference < 0 ? ' gain' : ' drop'} <span class="muted small">· ${number(Math.abs(difference))} player${Math.abs(difference) === 1 ? '' : 's'}</span></span>`;
}

async function renderLevels() {
  const game = currentGame;
  shell('Levels', heading('Levels', 'How many players start and finish each level, how long it takes, and where they leave.') +
    `<div id="filters"></div><div id="levels-summary"></div>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>Level by level</h2><p id="levels-note">Counted from level start, complete, fail and restart events.</p></div><div class="quiet-actions"><label class="inline-field">Sort<select id="levels-sort"><option value="level">Level order</option><option value="completion">Lowest completion</option><option value="quit">Most quit mid-level</option><option value="tries">Most tries per player</option><option value="time">Slowest</option></select></label><button class="button small-button" type="button" id="levels-csv">${icon('export',14)} CSV</button></div></div><div id="levels-table"></div></section>`);
  let data = null; let chosen = null; let latest = 0;
  const open = new Set(); const drill = new Map();
  const drillGroups = [['left', 'Quit mid-level'], ['finished_stopped', 'Finished, then stopped'], ['kept_going', 'Kept going'], ['stuck', 'Stuck'], ['started', 'Everyone who started']];
  const drillNotes = {
    left: 'Their very last level event in these days was starting, restarting or failing this level, so they stopped without finishing it. This is the table’s “Quit mid-level” number.',
    finished_stopped: 'They finished this level and never started a higher one in these days. Someone still playing right now can be here too, so check when they were last seen.',
    kept_going: 'They finished this level and later started a higher level.',
    stuck: 'Three or more tries (or fails) on this level without finishing it.',
    started: 'Everyone who started this level in these days.',
  };
  const storyLink = (row, level, cut) => `${gamePath(game, 'players')}?${new URLSearchParams({player: row.player, ...(cut ? {level, cut} : {})})}`;
  const drillQuery = (level, state, extra = {}) => { const query = filterQuery(chosen); query.set('level', level); query.set('group', state.group); query.set('sort', state.sort); for (const [key, value] of Object.entries(extra)) query.set(key, value); return query; };
  // The panel is as wide as the visible part of the table and stays in view when the table scrolls sideways.
  const fitDrill = level => { const box = document.querySelector(`[data-level-drill="${level}"]`); const wrap = box?.closest('.table-wrap'); if (wrap) box.style.width = `${wrap.clientWidth}px`; };
  let fitObserver = null;
  const drawDrill = level => {
    const box = document.querySelector(`[data-level-drill="${level}"]`); const state = drill.get(level);
    if (!box || !state) return;
    fitDrill(level);
    const counts = state.counts;
    const table = state.error ? `<p class="error">${escapeHTML(state.error)}</p>` : state.loading && !state.players.length ? '<p class="help">Reading players…</p>' : !state.players.length ? '<p class="help">Nobody is in this group in the selected days and filters.</p>' : `<div class="table-wrap"><table class="compact-table"><thead><tr><th>Player</th><th class="num">Tries</th><th class="num">Fails</th><th>Last on this level</th><th>Opened the game later</th><th>Version</th><th>Country</th><th>Their story</th></tr></thead><tbody>${state.players.map(row => `<tr><td><a class="row-title" href="${storyLink(row)}"><span class="mono">${escapeHTML(shortId(row.player))}</span></a></td><td class="num">${number(row.tries)}</td><td class="num">${number(row.fails)}</td><td class="small muted">${analysisDate(row.exit_at, chosen.timezone)}</td><td>${row.came_back ? '<span class="pill good">came back</span>' : '<span class="small muted">—</span>'}</td><td class="small">${escapeHTML(row.app_version || '—')}</td><td class="small">${countryTag(row.country)}</td><td class="small level-story-links"><a class="text-link" href="${storyLink(row, level, 'until')}">Up to level ${level}</a> <a class="text-link" href="${storyLink(row, level, 'from')}">From level ${level}</a></td></tr>`).join('')}</tbody></table></div><div class="pager"><span class="small muted">${number(state.players.length)} of ${number(state.total)}</span>${state.players.length < state.total ? `<button type="button" class="button" data-drill-more>${state.loading ? 'Loading…' : 'Show more'}</button>` : ''}</div>`;
    box.innerHTML = `<div class="level-drill-head"><div class="segmented" role="group" aria-label="Players on level ${level}">${drillGroups.map(([key, label]) => `<button type="button" data-drill-group="${key}" aria-pressed="${state.group === key}">${label}${counts ? ` <span class="drill-count">${number(counts[key])}</span>` : ''}</button>`).join('')}</div>
      <div class="quiet-actions"><label class="inline-field">Sort<select data-drill-sort><option value="exit_at">Latest on this level</option><option value="tries">Most tries</option><option value="fails">Most fails</option></select></label><button type="button" class="button" data-drill-csv>${icon('export', 14)} CSV</button></div></div>
      <p class="help level-drill-note">${drillNotes[state.group]}</p>${table}`;
    box.querySelector('[data-drill-sort]').value = state.sort;
  };
  const fetchDrill = async (level, more = false) => {
    const state = drill.get(level); const ticket = ++state.ticket;
    state.loading = true; state.error = null;
    if (!more) { state.players = []; state.total = 0; }
    drawDrill(level);
    try {
      const result = await api(`${gameURL(game)}/insights/levels/players?${drillQuery(level, state, {offset: more ? state.players.length : 0, limit: 50})}`);
      if (ticket !== state.ticket) return;
      state.players = more ? [...state.players, ...result.players] : result.players; state.total = result.total; state.counts = result.counts;
    } catch (error) { if (ticket === state.ticket) state.error = error.message; }
    if (ticket === state.ticket) { state.loading = false; drawDrill(level); }
  };
  const ensureDrill = level => {
    if (!drill.has(level)) drill.set(level, {group: 'left', sort: 'exit_at', players: [], total: 0, counts: null, loading: false, error: null, ticket: 0});
    fetchDrill(level);
  };
  document.querySelector('#levels-table').addEventListener('click', async event => {
    const toggle = event.target.closest('[data-level-toggle]');
    if (toggle) {
      const level = Number(toggle.dataset.levelToggle); const row = document.querySelector(`[data-level-detail="${level}"]`);
      if (open.has(level)) { open.delete(level); row.hidden = true; toggle.setAttribute('aria-expanded', 'false'); return; }
      open.add(level); row.hidden = false; toggle.setAttribute('aria-expanded', 'true');
      if (!drill.has(level)) ensureDrill(level);
      return;
    }
    const panel = event.target.closest('[data-level-drill]'); if (!panel) return;
    const level = Number(panel.dataset.levelDrill); const state = drill.get(level); if (!state) return;
    const tab = event.target.closest('[data-drill-group]');
    if (tab) { state.group = tab.dataset.drillGroup; fetchDrill(level); return; }
    if (event.target.closest('[data-drill-more]')) { fetchDrill(level, true); return; }
    if (event.target.closest('[data-drill-csv]')) {
      try {
        const all = await api(`${gameURL(game)}/insights/levels/players?${drillQuery(level, state, {offset: 0, limit: 2000})}`);
        downloadCSV(`${game.name}-${platformLabel(game.platform)}-level-${level}-${state.group}-${chosen.range.from}_${chosen.range.to}.csv`, [['player', 'tries', 'fails', 'finished_level', 'last_on_level_utc', 'last_seen_utc', 'opened_game_later', 'app_version', 'country'], ...all.players.map(row => [row.player, row.tries, row.fails, row.completed, row.exit_at, row.last_seen, row.came_back, row.app_version, row.country])]);
      } catch (error) { toast(error.message); }
    }
  });
  document.querySelector('#levels-table').addEventListener('change', event => {
    const select = event.target.closest('[data-drill-sort]'); if (!select) return;
    const level = Number(select.closest('[data-level-drill]').dataset.levelDrill); const state = drill.get(level);
    state.sort = select.value; fetchDrill(level);
  });
  const rows = () => {
    const sort = document.querySelector('#levels-sort').value;
    const list = [...data.levels];
    const keys = {completion: row => row.completion ?? 101, quit: row => -(row.quit_percent ?? -1), tries: row => -(row.tries_per_player ?? -1), time: row => -(row.median_seconds ?? -1)};
    return sort === 'level' ? list : list.sort((a, b) => keys[sort](a) - keys[sort](b));
  };
  const draw = () => {
    const box = document.querySelector('#levels-table');
    document.querySelector('#levels-note').textContent = 'Counted from level start, complete, fail and restart events.';
    if (!data.levels.length) { box.innerHTML = empty('No level data yet', 'Levels are read from events that start, complete, fail or restart a level, like “Started level 5”. Send some, or name yours in the event dictionary.', '', 'game'); document.querySelector('#levels-summary').innerHTML = ''; return; }
    const minimum = data.context.minimum_players;
    if (data.levels.some(row => row.low_sample)) {
      document.querySelector('#levels-note').innerHTML = `Counted from level start, complete, fail and restart events. <span class="level-sample-legend"><span class="level-sample-marker" aria-hidden="true">·</span> Small sample: fewer than ${number(minimum)} players started.</span>`;
    }
    const hardest = [...data.levels].filter(row => !row.low_sample).sort((a, b) => (a.completion ?? 100) - (b.completion ?? 100))[0];
    const biggest = [...data.levels].sort((a, b) => b.quit - a.quit)[0];
    const slowest = [...data.levels].filter(row => row.median_seconds != null).sort((a, b) => b.median_seconds - a.median_seconds)[0];
    document.querySelector('#levels-summary').innerHTML = stats([['Levels seen', number(data.levels.length), `level ${data.levels[0].level} to ${data.levels[data.levels.length - 1].level}`], ['Hardest level', hardest ? `Level ${hardest.level}` : '—', hardest ? `${percent(hardest.completion)} of players finish it` : `needs at least ${number(minimum)} players`], ['Most quit mid-level at', biggest && biggest.quit ? `Level ${biggest.level}` : '—', biggest && biggest.quit ? `${number(biggest.quit)} player${biggest.quit === 1 ? '' : 's'} had their last event there` : ''], ['Slowest level', slowest ? `Level ${slowest.level}` : '—', slowest ? `median ${duration(slowest.median_seconds)}` : '']]);
    const peak = Math.max(1, ...data.levels.map(row => row.started));
    box.innerHTML = `<div class="table-wrap"><table class="levels-grid"><thead><tr><th>Level</th><th class="num">Started</th><th class="num">Finished</th><th>Completion</th><th class="num" title="(Finished − next level started) ÷ Finished">Drop after finishing</th><th class="num">Tries / player</th><th class="num">Fails</th><th class="num">Median time</th><th class="num">Slowest 10%</th><th class="num" title="Events with “powerup” or “boost” in their name that carry this level’s number">Power-ups</th><th class="num" title="Players whose very last level event was starting, restarting or failing this level: they quit in the middle of it">Quit mid-level</th></tr></thead><tbody>${rows().map(row => `<tr class="${row.completion != null && !row.low_sample && row.completion < 60 ? 'level-hard' : ''}"><td class="level-number-cell" title="${escapeHTML(row.top_other.map(item => `${item.text} ×${item.count}`).join('\n'))}"><button type="button" class="level-toggle" data-level-toggle="${row.level}" aria-expanded="${open.has(row.level)}" aria-label="Show the players behind level ${row.level}">${icon('chevron', 14)}</button><strong>${row.level}</strong>${row.low_sample ? ` <span class="level-sample-marker" role="img" aria-label="Small sample: ${number(row.started)} of ${number(minimum)} players" title="Small sample: ${number(row.started)} players started; threshold is ${number(minimum)}">·</span>` : ''}${row.other_events ? ` <span class="muted small" title="Other events that carry this level number">+${number(row.other_events)}</span>` : ''}</td><td class="num">${number(row.started)}</td><td class="num">${number(row.completed)}</td><td><div class="completion"><progress class="progress mini" max="100" value="${row.completion ?? 0}" aria-label="${row.completion != null ? percent(row.completion) : 'n/a'}"></progress><span>${row.completion != null ? percent(row.completion) : '—'}</span></div></td><td class="num">${levelTransitionCell(row, data.levels)}</td><td class="num">${row.tries_per_player ?? '—'}</td><td class="num">${number(row.fails)}${row.restarts ? ` <span class="muted small">· ${row.restarts} restart${row.restarts === 1 ? '' : 's'}</span>` : ''}</td><td class="num">${duration(row.median_seconds)}</td><td class="num">${duration(row.p90_seconds)}</td><td class="num" title="${escapeHTML(row.top_powerups.map(item => `${item.text} ×${item.count}`).join('\n'))}">${row.powerups ? number(row.powerups) : '—'}</td><td class="num">${row.quit ? `${number(row.quit)} <span class="muted small">· ${percent(row.quit_percent)}</span>` : '—'}</td></tr><tr class="level-detail" data-level-detail="${row.level}" ${open.has(row.level) ? '' : 'hidden'}><td colspan="11"><div class="level-drill" data-level-drill="${row.level}"></div></td></tr>`).join('')}</tbody></table></div>
      <p class="help panel-body">Two different groups of players stop at a level. <strong>Quit mid-level</strong> started it (or failed it) and never finished: their very last level event was on that level. <strong>Drop after finishing</strong> compares this level’s finishers with the next numbered level’s starters, so it only counts people who <em>did</em> finish and then never began the next one. It compares counts, so players returning from earlier days can produce a gain, and missing next-level data is shown as —. Open a row with the arrow to see the players behind each number. Completion below 60% is highlighted only when at least ${number(minimum)} players started; smaller samples remain visible and are labelled.</p>`;
    open.forEach(drawDrill);
    fitObserver?.disconnect();
    const wrap = box.querySelector('.table-wrap');
    if (wrap && window.ResizeObserver) { fitObserver = new ResizeObserver(() => open.forEach(fitDrill)); fitObserver.observe(wrap); }
  };
  const load = async state => {
    chosen = state; const ticket = ++latest;
    document.querySelector('#levels-table').innerHTML = '<p class="help panel-body">Counting…</p>';
    try { const result = await api(`${gameURL(game)}/insights/levels?${filterQuery(state)}`); if (ticket === latest) { data = result; levelsFilters.setContext({anonymous_events: result.context.anonymous_events}); drill.clear(); draw(); open.forEach(ensureDrill); } }
    catch (error) { if (ticket === latest) document.querySelector('#levels-table').innerHTML = `<p class="error panel-body">${escapeHTML(error.message)}</p>`; }
  };
  document.querySelector('#levels-sort').addEventListener('change', () => data && draw());
  document.querySelector('#levels-csv').addEventListener('click', () => {
    if (!data) return;
    downloadCSV(`${game.name}-${platformLabel(game.platform)}-levels-${chosen.range.from}_${chosen.range.to}.csv`, [['level', 'started', 'completed', 'completion_percent', 'next_level', 'next_level_started', 'drop_to_next_players', 'drop_to_next_percent', 'attempts', 'tries_per_player', 'fails', 'restarts', 'median_seconds', 'p90_seconds', 'powerups', 'left_here', 'left_here_percent'], ...data.levels.map(row => [row.level, row.started, row.completed, row.completion, levelTransition(row, data.levels)?.next, levelTransition(row, data.levels)?.started, levelTransition(row, data.levels)?.difference, levelTransition(row, data.levels)?.percent, row.attempts, row.tries_per_player, row.fails, row.restarts, row.median_seconds, row.p90_seconds, row.powerups, row.quit, row.quit_percent])]);
  });
  const levelsFilters = mountFilters(document.querySelector('#filters'), game, load);
}
