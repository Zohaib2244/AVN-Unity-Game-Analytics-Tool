// Game dashboards: overview, funnels and player journeys, computed live on the server from the game's
// events (game time, UTC). Loaded before app.js; uses its helpers (api, shell, heading, metric,
// rangeMarkup, bindRange…) at call time.

const MAX_STEPS = 100;
const TEST_ENVIRONMENTS = ['editor', 'development', 'test', 'debug'];
const DIMENSION_LABELS = {environment: 'Environment', app_version: 'App version', build: 'Build', country: 'Country', platform: 'Device platform'};
const FILTER_KEYS = {environment: 'env', app_version: 'version', build: 'build', country: 'country', platform: 'platform'};
const OPERATORS = [['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['exists', 'any value']];

function duration(seconds) {
  if (seconds == null) return '—';
  const value = Math.round(seconds);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, '0')}s`;
  if (value < 86400) return `${Math.floor(value / 3600)}h ${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}m`;
  return `${Math.floor(value / 86400)}d ${Math.floor(value % 86400 / 3600)}h`;
}
const clock = value => new Date(value).toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});
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

/* ─── Filters: days + environment, version, build, country, platform. Remembered per game. ─── */

function filterState(game) {
  const saved = storeGet(`avn-filters-${game.id}`) || {};
  return {range: saved.range || null, hideTest: saved.hideTest ?? true, environment: saved.environment || [], app_version: saved.app_version || [], build: saved.build || [], country: saved.country || [], platform: saved.platform || []};
}
function saveFilters(game, state) { storeSet(`avn-filters-${game.id}`, state); }
function filterQuery(state) {
  const query = new URLSearchParams({start: state.range.from, end: state.range.to});
  if (state.hideTest && !state.environment.length) TEST_ENVIRONMENTS.forEach(value => query.append('not_env', value));
  for (const [dimension, key] of Object.entries(FILTER_KEYS)) state[dimension].forEach(value => query.append(key, value));
  return query;
}
function filterBody(state) {
  return {start: state.range.from, end: state.range.to, filters: {
    environments: state.environment, exclude_environments: state.hideTest && !state.environment.length ? TEST_ENVIRONMENTS : [],
    app_versions: state.app_version, builds: state.build, countries: state.country, platforms: state.platform}};
}
const activeFilters = state => Object.keys(FILTER_KEYS).reduce((sum, dimension) => sum + state[dimension].length, 0);

// The filter bar at the top of every game dashboard: days, one "Filters" menu, and chips for what's
// active. onChange(state) runs now and after each change.
function mountFilters(container, game, onChange) {
  const state = filterState(game);
  let facets = {};
  container.innerHTML = `<div class="filter-bar"><div id="filter-range"></div><details class="filter-menu"><summary>${icon('funnel',14)} Filters <span class="count" id="filter-count" hidden></span></summary><div class="filter-options filter-popover" id="filter-options"></div></details></div><div class="filter-chips" id="filter-chips"></div>`;
  const changed = () => { saveFilters(game, state); draw(); onChange(state); };
  const draw = () => {
    const options = container.querySelector('#filter-options');
    const scroll = options.scrollTop;
    options.innerHTML = `<label class="filter-switch"><input type="checkbox" id="hide-test" ${state.hideTest ? 'checked' : ''} ${state.environment.length ? 'disabled' : ''}><span>Hide editor & development data</span></label>` +
      Object.keys(FILTER_KEYS).map(dimension => {
        const values = [...new Set([...(facets[dimension] || []).map(item => item.value), ...state[dimension]])];
        const counts = Object.fromEntries((facets[dimension] || []).map(item => [item.value, item.events]));
        return `<fieldset data-dimension="${dimension}"><legend>${DIMENSION_LABELS[dimension]}</legend>${values.length ? values.map(value => `<label><input type="checkbox" value="${escapeHTML(value)}" ${state[dimension].includes(value) ? 'checked' : ''}><span>${escapeHTML(value)}</span><small>${number(counts[value] || 0)}</small></label>`).join('') : '<p class="help">None in these days</p>'}</fieldset>`;
      }).join('');
    options.scrollTop = scroll;
    const active = activeFilters(state);
    const count = container.querySelector('#filter-count');
    count.hidden = !active; count.textContent = active;
    const chips = Object.keys(FILTER_KEYS).flatMap(dimension => state[dimension].map(value => `<button type="button" class="filter-chip" data-remove-dimension="${dimension}" data-remove-value="${escapeHTML(value)}" title="Remove this filter">${DIMENSION_LABELS[dimension]}: ${escapeHTML(value)} ${icon('close',11)}</button>`));
    container.querySelector('#filter-chips').innerHTML = chips.join('') + (state.hideTest && !state.environment.length ? '<span class="filter-note">Editor & development data hidden</span>' : '') + (chips.length > 1 ? '<button type="button" class="filter-clear" data-clear>Clear all</button>' : '');
  };
  container.addEventListener('change', event => {
    if (event.target.id === 'hide-test') { state.hideTest = event.target.checked; changed(); return; }
    const group = event.target.closest('fieldset[data-dimension]'); if (!group) return;
    state[group.dataset.dimension] = [...group.querySelectorAll('input:checked')].map(input => input.value);
    changed();
  });
  container.addEventListener('click', event => {
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
    try { facets = await api(`${gameURL(game)}/insights/facets?${new URLSearchParams({start: range.from, end: range.to})}`); draw(); } catch { /* the menu keeps the chosen values */ }
  }, state.range?.preset || '30', state.range);
  return {state, toggle(dimension, value) { const list = state[dimension]; state[dimension] = list.includes(value) ? list.filter(item => item !== value) : [...list, value]; changed(); }};
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

// A row of headline numbers without card chrome.
const stats = items => `<div class="stat-strip">${items.map(([label, value, note]) => `<div class="stat"><span class="stat-label">${label}</span><strong class="stat-value">${value}</strong>${note ? `<span class="stat-note">${note}</span>` : ''}</div>`).join('')}</div>`;

function breakdownTable(dimension, rows, total, chosen) {
  const peak = Math.max(1, ...rows.map(row => row.players));
  return rows.length ? `<table class="breakdown"><thead><tr><th>${DIMENSION_LABELS[dimension]}</th><th></th><th class="num">Players</th><th class="num">Share</th></tr></thead><tbody>${rows.map(row => `<tr class="${chosen.includes(row.value) ? 'chosen' : ''}"><td><button type="button" class="link-button" data-filter-dimension="${dimension}" data-filter-value="${escapeHTML(row.value)}" title="${chosen.includes(row.value) ? 'Remove this filter' : 'Show only this'}">${escapeHTML(row.value)}</button></td><td class="breakdown-bar"><span data-width="${Math.max(2, 100 * row.players / peak)}"></span></td><td class="num">${number(row.players)}</td><td class="num muted">${total ? percent(100 * row.players / total) : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="help panel-body">No data.</p>';
}

async function renderGameOverview() {
  const game = currentGame;
  const archived = game.archived_at ? `<div class="archived-banner">${icon('lock',18)}<div><strong>Archived.</strong> Collection is paused for this platform.</div><a class="button" href="${gamePath(game, 'settings')}">Game settings</a></div>` : '';
  shell('Overview', heading(game.name, `${platformLabel(game.platform)} · ${game.bundle_id}`, `<a class="button primary" href="${gamePath(game, 'exports')}">${icon('export',15)} Export data</a>`) + archived +
    `<div id="filters"></div><div id="totals"></div>
    <section class="panel"><div class="panel-header"><h2>Activity per day</h2><div class="segmented" role="group" aria-label="Measure">${[['players','Players'],['sessions','Sessions'],['events','Events']].map(([key, label]) => `<button type="button" data-measure="${key}" aria-pressed="${key === 'players'}">${label}</button>`).join('')}</div></div><div class="panel-body chart-wrap" id="daily"><p class="help">Loading…</p></div></section>
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
      document.querySelector('#totals').innerHTML = stats([['Players', number(data.players), `${number(data.new_players)} new`], ['Sessions', number(data.sessions), data.players ? `${(data.sessions / data.players).toFixed(1)} per player` : ''], ['Events', number(data.events), data.players ? `${number(Math.round(data.events / data.players))} per player` : '']]);
      drawDaily(); drawBreakdown();
      document.querySelector('#top-events').innerHTML = data.top_events.length ? `<table class="compact-table"><thead><tr><th>Event</th><th class="num">Events</th><th class="num">Players</th></tr></thead><tbody>${data.top_events.slice(0, 10).map(row => `<tr><td class="mono">${escapeHTML(row.name)}</td><td class="num">${number(row.events)}</td><td class="num">${number(row.players)}</td></tr>`).join('')}</tbody></table>` : '<p class="help panel-body">No events.</p>';
    } catch (error) { if (ticket === latest) document.querySelector('#daily').innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  });
}

/* ─── Funnels ─── */

const blankStep = event => ({event: event || '', param: '', op: 'eq', value: '', label: ''});

async function renderFunnels() {
  const game = currentGame;
  shell('Funnels', heading('Funnels', 'How many players get through each step, and where they stop.') +
    `<div id="filters"></div>
    <section class="panel section-spacing"><div class="panel-header funnel-header"><div class="saved-row"><select id="saved-funnel" aria-label="Saved funnels"></select></div><div class="quiet-actions"><button class="button small-button" type="button" id="save-funnel">Save</button><button class="button small-button" type="button" id="save-as">Save as…</button><button class="button small-button danger-text" type="button" id="delete-funnel">Delete</button></div></div>
      <div class="panel-body"><div id="funnel-steps"></div>
        <div class="funnel-actions"><div class="quiet-actions"><button class="button small-button" type="button" id="add-step">${icon('plus',14)} Add step</button><button class="button small-button" type="button" id="quick-levels">${icon('plus',14)} Level steps…</button><button class="button ghost small-button" type="button" id="clear-steps">Clear</button></div><button class="button primary" type="button" id="run-funnel">Run funnel</button></div>
        <details class="funnel-more"><summary>Options <span id="options-summary" class="muted"></span></summary><div class="funnel-options"><label class="inline-field">Count<select id="funnel-scope"><option value="player">Per player, across sessions</option><option value="session">Within one session</option></select></label><label class="inline-field">Finish within<select id="funnel-window"><option value="">Any time</option><option value="0.25">15 minutes</option><option value="1">1 hour</option><option value="24">1 day</option><option value="168">7 days</option><option value="720">30 days</option></select></label><label class="inline-field">Break down by<select id="funnel-breakdown"><option value="">Nothing</option>${Object.entries(DIMENSION_LABELS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label></div></details></div></section>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>Result</h2><p id="funnel-note">Add at least two steps.</p></div><button class="button small-button" type="button" id="funnel-csv" hidden>${icon('export',14)} CSV</button></div><div id="funnel-summary"></div><div class="panel-body" id="funnel-result"><p class="help">No result yet.</p></div></section>
    <section class="panel section-spacing" id="journeys-panel"></section>
    <section class="panel section-spacing" id="breakdown-panel" hidden><div class="panel-header"><div><h2 id="breakdown-title">Breakdown</h2><p>Players reaching each step, per segment · a player’s segment comes from their step 1 event</p></div></div><div id="breakdown-result"></div></section>`);
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
  const changed = (redraw = true) => { persist(); drawSaved(); if (redraw) drawSteps(); };

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
      if (ticket === latest) { lastResult = data; drawResult(data); journeys.refresh(); }
    } catch (error) { if (ticket === latest) result.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  }
  const timing = times => times ? `<span title="${number(times.count)} players · average ${duration(times.average)} · fastest ${duration(times.min)} · slowest ${duration(times.max)}">median ${duration(times.median)} · 90% within ${duration(times.p90)}</span>` : '';
  const drawResult = data => {
    const rows = data.steps; const first = rows[0].players; const last = rows[rows.length - 1];
    document.querySelector('#funnel-note').textContent = first ? `${current.scope === 'session' ? 'Each player’s best single session' : 'Each player, across all their sessions'}${current.window_hours ? ` · finished within ${document.querySelector('#funnel-window').selectedOptions[0].textContent}` : ''} · hover times for averages` : 'Nobody did the first step with these filters and days.';
    document.querySelector('#funnel-csv').hidden = false;
    document.querySelector('#funnel-summary').innerHTML = first ? `<div class="panel-body funnel-stats">${stats([['Started', number(first), 'did step 1'], ['Completed', number(last.players), 'reached the last step'], ['Conversion', percent(last.of_first), 'first → last step'], ['Time to complete', data.time_to_complete ? duration(data.time_to_complete.median) : '—', data.time_to_complete ? `median · 90% within ${duration(data.time_to_complete.p90)}` : 'nobody finished']])}</div>` : '';
    let worst = null;
    rows.forEach((row, index) => { if (index && rows[index - 1].players && row.of_previous < 100 && (!worst || row.of_previous < worst.rate)) worst = {index, rate: row.of_previous}; });
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
      document.querySelector('#breakdown-result').innerHTML = data.segments.length ? `<div class="table-wrap"><table><thead><tr><th>${DIMENSION_LABELS[data.breakdown]}</th>${rows.map((row, index) => `<th class="num" title="${escapeHTML(row.label || row.event)}">${String(index + 1).padStart(2, '0')}</th>`).join('')}<th class="num">Conversion</th></tr></thead><tbody>${data.segments.map(segment => `<tr><td>${escapeHTML(segment.value)}</td>${segment.players.map(count => `<td class="num">${number(count)}</td>`).join('')}<td class="num"><strong>${segment.players[0] ? percent(100 * segment.players[segment.players.length - 1] / segment.players[0]) : '—'}</strong></td></tr>`).join('')}</tbody></table></div>${data.segments_total > data.segments.length ? `<p class="help panel-body">Showing the ${data.segments.length} largest of ${data.segments_total} segments.</p>` : ''}` : '<p class="help panel-body">No segments.</p>';
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
  drawOptions(); drawSaved(); drawSteps();
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

async function renderPlayers() {
  const game = currentGame;
  const player = new URLSearchParams(location.search).get('player');
  if (player) return renderJourney(game, player);
  shell('Players', heading('Players', 'Open a player to see everything they did, session by session.') +
    `<div id="filters"></div>
    <section class="panel section-spacing"><div class="panel-header"><h2>Players <span class="count" id="player-count">0</span></h2><div class="search">${icon('search',16)}<input id="player-search" type="search" aria-label="Search players" placeholder="Search by user or install ID…"></div></div><div id="player-list"><p class="help panel-body">Loading…</p></div></section>`);
  const list = document.querySelector('#player-list');
  let offset = 0; let search = ''; let latest = 0; let chosen = null;
  const load = async () => {
    const ticket = ++latest;
    try {
      const data = await api(`${gameURL(game)}/insights/players?${filterQuery(chosen)}&${new URLSearchParams({search, offset})}`);
      if (ticket !== latest) return;
      document.querySelector('#player-count').textContent = number(data.total);
      if (!data.players.length) { list.innerHTML = empty(search ? 'No matching players' : 'No players', search ? 'Try another ID.' : 'Pick other days or filters, or check that your game is sending events.', '', 'users'); return; }
      const link = row => `${gamePath(game, 'players')}?${new URLSearchParams({player: row.player})}`;
      list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Player</th><th class="num">Events</th><th class="num">Sessions</th><th>First seen</th><th>Last seen</th><th>Version</th><th>Env</th><th>Country</th></tr></thead><tbody>${data.players.map(row => `<tr><td><a class="row-title" href="${link(row)}"><span class="mono">${escapeHTML(shortId(row.player))}</span></a><p class="small muted">${row.has_user_id ? 'User ID' : 'Install ID'} · ${platformLabel(row.platform || '—')}</p></td><td class="num">${number(row.events)}</td><td class="num">${number(row.sessions)}</td><td class="small muted">${displayDate(row.first_seen)}</td><td class="small muted">${displayDate(row.last_seen)}</td><td class="small">${escapeHTML(row.app_version || '—')}</td><td><span class="pill ${TEST_ENVIRONMENTS.includes(row.environment) ? '' : 'good'}">${escapeHTML(row.environment || '—')}</span></td><td class="small">${escapeHTML(row.country || '—')}</td></tr>`).join('')}</tbody></table></div>
        <div class="pager"><span class="small muted">${number(offset + 1)}–${number(offset + data.players.length)} of ${number(data.total)}</span><span><button class="button" data-page="-1" ${offset ? '' : 'disabled'}>Previous</button> <button class="button" data-page="1" ${offset + data.players.length < data.total ? '' : 'disabled'}>Next</button></span></div>`;
    } catch (error) { if (ticket === latest) list.innerHTML = `<p class="error panel-body">${escapeHTML(error.message)}</p>`; }
  };
  list.addEventListener('click', event => { const page = event.target.closest('[data-page]'); if (page) { offset = Math.max(0, offset + 50 * Number(page.dataset.page)); load(); } });
  let typing;
  document.querySelector('#player-search').addEventListener('input', event => { clearTimeout(typing); typing = setTimeout(() => { search = event.target.value.trim(); offset = 0; load(); }, 250); });
  mountFilters(document.querySelector('#filters'), game, state => { chosen = state; offset = 0; load(); });
}


/* ─── One player: their story in plain words (default) or every raw event ─── */

const levelTable = rows => `<table class="level-mini"><thead><tr><th>Level</th><th>Result</th><th class="num">Time</th></tr></thead><tbody>${rows.map(row => `<tr><td>${row.level}</td><td>${row.completed ? 'Completed' : row.failed ? 'Failed' : 'Started'}${row.failed ? ` · failed ${row.failed}×` : ''}${row.restarted ? ` · restarted ${row.restarted}×` : ''}${row.completed && row.started > 1 ? ` · ${row.started} tries` : ''}</td><td class="num">${row.seconds != null ? duration(row.seconds) : '—'}</td></tr>`).join('')}</tbody></table>`;

function storyChapter(chapter) {
  const came = chapter.gap == null ? '' : chapter.gap >= 1800 ? ` · came back ${duration(chapter.gap)} after the last session` : ` · ${duration(chapter.gap)} after the last session`;
  return `<section class="story-chapter"><div class="story-head"><strong>Session ${chapter.number}</strong><span>${displayDate(chapter.start)} · ${duration(chapter.seconds)} played${came}</span></div>
    <ol class="story-lines">${chapter.segments.map(segment => {
      const slow = segment.slowest ? `<span class="story-flag">Level ${segment.slowest.level} took ${duration(segment.slowest.seconds)}</span>` : '';
      const extras = segment.extras?.length ? `<span class="story-extras">${segment.extras.map(extra => `<span class="chip">${escapeHTML(extra.text)}${extra.count > 1 ? ` ×${extra.count}` : ''}</span>`).join('')}</span>` : '';
      const details = segment.type === 'levels' ? `<details class="story-details"><summary>Level by level</summary>${levelTable(segment.levels)}</details>` : Object.keys(segment.params || {}).filter(key => key !== 'seq').length ? `<details class="story-details"><summary>Details</summary><span class="story-params">${paramChips(Object.fromEntries(Object.entries(segment.params).filter(([key]) => key !== 'seq')))}</span></details>` : '';
      return `<li class="story-line ${segment.type}"><time datetime="${escapeHTML(segment.t)}">${clock(segment.t)}</time><div><span class="story-text">${escapeHTML(segment.text)}</span>${slow}${extras}${details}</div></li>`;
    }).join('') || '<li class="help">Nothing but session start and end.</li>'}</ol></section>`;
}

async function renderJourney(game, player) {
  shell('Player story', `<a class="back-link" href="${gamePath(game, 'players')}">← Back to players</a>` + heading('Player story', player) +
    `<div class="filter-bar"><div id="story-range"></div></div><div id="story-metrics"></div>
    <div class="range-modes route-tabs" role="tablist" aria-label="View"><button type="button" role="tab" data-story-view="story">Story</button><button type="button" role="tab" data-story-view="raw">Raw events</button></div>
    <div id="story-body"></div>`);
  let view = storeGet(`avn-story-view-${game.id}`) || 'story';
  let range = null; let showHidden = false;
  const body = document.querySelector('#story-body');
  const tabs = () => document.querySelectorAll('[data-story-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.storyView === view)));
  const draw = async () => {
    tabs();
    if (view === 'raw') { await renderRawEvents(game, player, range); return; }
    body.innerHTML = '<p class="help">Reading their story…</p>';
    try {
      const data = await api(`${gameURL(game)}/insights/story?${new URLSearchParams({start: range.from, end: range.to, player, hidden: String(showHidden)})}`);
      document.querySelector('#story-metrics').innerHTML = stats([['Sessions', number(data.sessions), data.first_seen ? `${displayDate(data.first_seen)} → ${displayDate(data.last_seen)}` : ''], ['Events', number(data.events), ''], ['Highest level', data.highest_level != null ? number(data.highest_level) : '—', ''], ['Where', [data.country, platformLabel(data.platform || ''), data.app_version && `v${data.app_version}`].filter(Boolean).join(' · ') || '—', data.environment || '']]);
      body.innerHTML = data.chapters.length ? `<label class="check-row story-toggle"><input type="checkbox" id="story-hidden" ${showHidden ? 'checked' : ''}> Also show events hidden in the dictionary</label>${data.chapters.map(storyChapter).join('')}` : '<p class="help">No events from this player in these days.</p>';
      body.querySelector('#story-hidden')?.addEventListener('change', event => { showHidden = event.target.checked; draw(); });
    } catch (error) { body.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  };
  document.querySelector('[aria-label="View"]').addEventListener('click', event => {
    const tab = event.target.closest('[data-story-view]');
    if (tab && range) { view = tab.dataset.storyView; storeSet(`avn-story-view-${game.id}`, view); draw(); }
  });
  const saved = filterState(game);
  const rangeBox = document.querySelector('#story-range');
  rangeBox.innerHTML = compactRangeMarkup();
  bindRange(rangeBox, next => { range = next; draw(); }, saved.range?.preset || '30', saved.range);
}

async function renderRawEvents(game, player, range) {
  document.querySelector('#story-body').innerHTML = `<section class="panel"><div class="panel-header"><div><h2>Timeline</h2><p>Every event, grouped by session · times in your local time · the gap is the time since the previous event</p></div><div class="search">${icon('search',16)}<input id="journey-filter" type="search" aria-label="Filter events" placeholder="Filter by event or parameter…"></div></div><div class="panel-body" id="journey"><p class="help">Loading…</p></div></section>`;
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
      return `<div class="journey-session"><div class="journey-session-head"><strong>Session ${index + 1}</strong><span>${displayDate(start)} · ${duration((Date.parse(end) - Date.parse(start)) / 1000)} · ${session.items.length} event${session.items.length === 1 ? '' : 's'}</span></div>
        <ol class="journey-events">${items.map(item => `<li><time datetime="${escapeHTML(item.client_ts)}">${clock(item.client_ts)}</time><span class="journey-gap ${item.gap > 60 ? 'long' : ''}">${item.gap == null ? '' : `+${duration(item.gap)}`}</span><span class="journey-name">${escapeHTML(item.name)}</span><span class="journey-params">${paramChips(item.params)}</span></li>`).join('')}</ol></div>`;
    }).join('') || '<p class="help">No events match the filter.</p>';
  };
  document.querySelector('#journey-filter').addEventListener('input', draw);
  try {
    const data = await api(`${gameURL(game)}/insights/journey?${new URLSearchParams({start: range.from, end: range.to, player})}`);
    events = data.events;
    document.querySelector('#story-metrics').innerHTML = stats([['Events', number(events.length), data.truncated ? 'first 5,000 shown' : ''], ['Sessions', number(new Set(events.map(event => event.session_id)).size), '']]);
    draw();
  } catch (error) { box.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
}

/* ─── Levels: how every level is going ─── */

async function renderLevels() {
  const game = currentGame;
  shell('Levels', heading('Levels', 'How many players start and finish each level, how long it takes, and where they leave.') +
    `<div id="filters"></div><div id="levels-summary"></div>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>Level by level</h2><p id="levels-note">Counted from level start, complete, fail and restart events.</p></div><div class="quiet-actions"><label class="inline-field">Sort<select id="levels-sort"><option value="level">Level order</option><option value="completion">Lowest completion</option><option value="quit">Most players leaving</option><option value="tries">Most tries per player</option><option value="time">Slowest</option></select></label><button class="button small-button" type="button" id="levels-csv">${icon('export',14)} CSV</button></div></div><div id="levels-table"></div></section>`);
  let data = null; let chosen = null; let latest = 0;
  const rows = () => {
    const sort = document.querySelector('#levels-sort').value;
    const list = [...data.levels];
    const keys = {completion: row => row.completion ?? 101, quit: row => -(row.quit_percent ?? -1), tries: row => -(row.tries_per_player ?? -1), time: row => -(row.median_seconds ?? -1)};
    return sort === 'level' ? list : list.sort((a, b) => keys[sort](a) - keys[sort](b));
  };
  const draw = () => {
    const box = document.querySelector('#levels-table');
    if (!data.levels.length) { box.innerHTML = empty('No level data yet', 'Levels are read from events that start, complete, fail or restart a level, like “Started level 5”. Send some, or name yours in the event dictionary.', '', 'game'); document.querySelector('#levels-summary').innerHTML = ''; return; }
    const hardest = [...data.levels].filter(row => row.started >= 3).sort((a, b) => (a.completion ?? 100) - (b.completion ?? 100))[0];
    const biggest = [...data.levels].sort((a, b) => b.quit - a.quit)[0];
    const slowest = [...data.levels].filter(row => row.median_seconds != null).sort((a, b) => b.median_seconds - a.median_seconds)[0];
    document.querySelector('#levels-summary').innerHTML = stats([['Levels seen', number(data.levels.length), `level ${data.levels[0].level} to ${data.levels[data.levels.length - 1].level}`], ['Hardest level', hardest ? `Level ${hardest.level}` : '—', hardest ? `${percent(hardest.completion)} of players finish it` : 'needs at least 3 players'], ['Most players leave at', biggest && biggest.quit ? `Level ${biggest.level}` : '—', biggest && biggest.quit ? `${number(biggest.quit)} player${biggest.quit === 1 ? '' : 's'} had their last event there` : ''], ['Slowest level', slowest ? `Level ${slowest.level}` : '—', slowest ? `median ${duration(slowest.median_seconds)}` : '']]);
    const peak = Math.max(1, ...data.levels.map(row => row.started));
    box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Level</th><th class="num">Started</th><th class="num">Finished</th><th>Completion</th><th class="num">Tries / player</th><th class="num">Fails</th><th class="num">Median time</th><th class="num">Slowest 10%</th><th class="num">Power-ups</th><th class="num">Left here</th></tr></thead><tbody>${rows().map(row => `<tr class="${row.completion != null && row.started >= 3 && row.completion < 60 ? 'level-hard' : ''}"><td><strong>${row.level}</strong></td><td class="num">${number(row.started)}</td><td class="num">${number(row.completed)}</td><td><div class="completion"><progress class="progress mini" max="100" value="${row.completion ?? 0}" aria-label="${row.completion != null ? percent(row.completion) : 'n/a'}"></progress><span>${row.completion != null ? percent(row.completion) : '—'}</span></div></td><td class="num">${row.tries_per_player ?? '—'}</td><td class="num">${number(row.fails)}${row.restarts ? ` <span class="muted small">· ${row.restarts} restart${row.restarts === 1 ? '' : 's'}</span>` : ''}</td><td class="num">${duration(row.median_seconds)}</td><td class="num">${duration(row.p90_seconds)}</td><td class="num" title="${escapeHTML(row.top_powerups.map(item => `${item.text} ×${item.count}`).join('\n'))}">${row.powerups ? number(row.powerups) : '—'}</td><td class="num">${row.quit ? `${number(row.quit)} <span class="muted small">· ${percent(row.quit_percent)}</span>` : '—'}</td></tr>`).join('')}</tbody></table></div>
      <p class="help panel-body">“Left here” counts players whose very last level event was on that level (they started, restarted or failed it and never came back to play on). Rows with less than 60% completion are highlighted.</p>`;
  };
  const load = async state => {
    chosen = state; const ticket = ++latest;
    document.querySelector('#levels-table').innerHTML = '<p class="help panel-body">Counting…</p>';
    try { const result = await api(`${gameURL(game)}/insights/levels?${filterQuery(state)}`); if (ticket === latest) { data = result; draw(); } }
    catch (error) { if (ticket === latest) document.querySelector('#levels-table').innerHTML = `<p class="error panel-body">${escapeHTML(error.message)}</p>`; }
  };
  document.querySelector('#levels-sort').addEventListener('change', () => data && draw());
  document.querySelector('#levels-csv').addEventListener('click', () => {
    if (!data) return;
    downloadCSV(`${game.name}-${platformLabel(game.platform)}-levels-${chosen.range.from}_${chosen.range.to}.csv`, [['level', 'started', 'completed', 'completion_percent', 'attempts', 'tries_per_player', 'fails', 'restarts', 'median_seconds', 'p90_seconds', 'powerups', 'left_here', 'left_here_percent'], ...data.levels.map(row => [row.level, row.started, row.completed, row.completion, row.attempts, row.tries_per_player, row.fails, row.restarts, row.median_seconds, row.p90_seconds, row.powerups, row.quit, row.quit_percent])]);
  });
  mountFilters(document.querySelector('#filters'), game, load);
}

