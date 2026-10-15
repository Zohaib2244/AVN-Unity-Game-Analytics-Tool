// The Events page (the event dictionary: every event, how often it is sent, what it means) and the
// Mappings page (which of your events stand for the moments the dashboards understand).
// Loaded after insights.js and before app.js, so it can use the helpers of both.

const CONCEPT_NAMES = {session_start: 'Session start', level_started: 'Level started', level_completed: 'Level completed', level_failed: 'Level failed', level_restarted: 'Level restarted'};
const conceptName = key => CONCEPT_NAMES[key] || String(key).replace(/_/g, ' ');
const MAPPING_OPERATORS = [['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['exists', 'exists']];
const operatorText = op => (MAPPING_OPERATORS.find(([key]) => key === op) || [op, op])[1];
const ruleText = rule => `${rule.app_version ? `version ${rule.app_version} · ` : 'all versions · '}${rule.param ? `when ${rule.param} ${operatorText(rule.op)}${rule.op === 'exists' ? '' : ` ${rule.value}`}` : 'every time'}${rule.number_param ? ` · level in ${rule.number_param}` : ''}`;
const agoText = value => {
  if (!value) return 'never';
  const seconds = (Date.now() - Date.parse(value)) / 1000;
  return !(seconds >= 60) ? 'just now' : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : seconds < 86400 ? `${Math.round(seconds / 3600)} h ago` : `${Math.round(seconds / 86400)} d ago`;
};
const sparkline = (values, label) => {
  const width = 90; const height = 22; const peak = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((value, index) => [index * step, height - 2 - (height - 4) * value / peak]);
  const last = points[points.length - 1] || [0, height - 2];
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(label)}"><polyline points="${points.map(point => point.map(n => n.toFixed(1)).join(',')).join(' ')}"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2"/></svg>`;
};

/* ─── Mapping health: the Mappings button on the Events page and the notice on the overview ─── */

const mappingIssueText = issue => issue.kind === 'missing'
  ? `${issue.label} is not mapped to any of your events, so ${issue.used_by.join(', ')} cannot read it.`
  : `${issue.event} is mapped to ${issue.label}, but no event your game sent matches that rule.`;
const mappingSignature = status => status.issues.map(issue => `${issue.kind}:${issue.concept}:${issue.event || ''}`).sort().join('|');
function markMappingsButton(button, status) {
  const badge = button?.querySelector('.button-badge');
  if (!badge || !status.has_events) return;
  const count = status.issues.length;
  button.classList.toggle('attention', count > 0); button.classList.toggle('fine', count === 0);
  badge.hidden = false;
  badge.innerHTML = count ? String(count) : icon('check', 12);
  button.title = count ? status.issues.map(mappingIssueText).join('\n') : 'Your mappings look good.';
  button.setAttribute('aria-label', count ? `Mappings, ${count} to fix` : 'Mappings, all good');
}
// The overview's banner. Dismissing it is remembered per game until the problems change.
function mappingNotice(game, status) {
  const key = `avn-mapping-dismissed-${game.id}`;
  if (!status.has_events || !status.issues.length || storeGet(key) === mappingSignature(status)) return '';
  const first = mappingIssueText(status.issues[0]);
  const more = status.issues.length > 1 ? ` And ${status.issues.length - 1} more.` : '';
  return `<div class="notice-banner" role="status">${icon('pulse', 18)}<div><strong>Mappings need attention.</strong> ${escapeHTML(first)}${more} <span class="muted">If your game has no levels, you can dismiss this.</span></div><a class="button" href="${gamePath(game, 'mappings')}">Open mappings</a><button type="button" class="button" data-dismiss-mapping-notice="${escapeHTML(mappingSignature(status))}">Dismiss</button></div>`;
}

/* ─── Events ─── */

function eventDictionaryNav(game, active) {
  return `<nav class="event-dictionary-nav section-spacing" aria-label="Event dictionary"><a class="button ${active === 'dictionary' ? 'primary' : ''}" ${active === 'dictionary' ? 'aria-current="page"' : ''} href="${gamePath(game, 'dictionary')}">${icon('book', 15)} Dictionary</a><a class="button ${active === 'mappings' ? 'primary' : ''}" ${active === 'mappings' ? 'aria-current="page"' : ''} id="events-mappings" href="${gamePath(game, 'mappings')}">${icon('link', 15)} Mappings<span class="button-badge" hidden></span></a></nav>`;
}

async function renderDictionary() {
  const game = currentGame;
  shell('Event dictionary', heading('Event dictionary', 'Describe your events and map them to the moments your dashboards use.') + eventDictionaryNav(game, 'dictionary') +
    `<div id="filters"></div><div id="events-summary"></div>
    <section class="panel section-spacing" id="dictionary-panel"><div class="panel-header"><div><h2>Dictionary status</h2><p>How much of your events is described and mapped.</p></div></div><div class="panel-body" id="dictionary-status"></div></section>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>All events</h2><p id="events-note">Counts are for the selected days and filters.</p></div><div class="quiet-actions"><label class="inline-field">Sort<select id="events-sort"><option value="sent">Most sent</option><option value="players">Most players</option><option value="attention">Needs attention</option><option value="last">Last sent</option><option value="name">Name</option></select></label><button type="button" class="button" id="events-csv">${icon('export', 14)} CSV</button></div></div>
    <div class="toolbar events-toolbar"><div class="search">${icon('search', 16)}<input id="events-search" type="search" aria-label="Search events" placeholder="Search by event name or description…"></div><div class="range-modes" role="group" aria-label="Show" id="events-filter"></div></div>
    <div id="events-table"></div></section>`);
  api(`${gameURL(game)}/mappings/status`).then(status => markMappingsButton(document.querySelector('#events-mappings'), status)).catch(() => { /* the button just stays plain */ });
  // The dictionary's own progress lives in a panel of its own, folded away until someone opens it.
  const dictionaryPanel = collapsible(document.querySelector('#dictionary-panel'), game, 'dictionary');
  if (!('dictionary' in (storeGet(`avn-collapsed-${game.id}`) || {}))) dictionaryPanel.set(true, false);
  const saved = storeGet(`avn-events-view-${game.id}`) || {};
  const view = {filter: saved.filter === 'drafts' ? 'all' : saved.filter || 'all', sort: saved.sort || 'sent', query: ''};
  const persist = () => storeSet(`avn-events-view-${game.id}`, {filter: view.filter, sort: view.sort});
  const open = new Set(); const detail = new Map(); const tabs = new Map();
  const activityStates = new Map();
  let data = null; let chosen = null; let latest = 0; let observer = null;
  const attention = item => (!item.described && !item.sdk && item.ever) || (item.defined && item.params_missing.length) || item.type_conflicts.length;
  const FILTERS = [['all', 'All', () => true], ['attention', 'Needs attention', attention], ['undescribed', 'No description', item => !item.described && !item.sdk], ['described', 'Described', item => item.described], ['mapped', 'Mapped', item => item.definition.canonical.length], ['hidden', 'Hidden', item => item.definition.hidden], ['quiet', 'Quiet or never sent', item => item.status !== 'active']];
  const SORTS = {sent: (a, b) => b.range.events - a.range.events || a.name.localeCompare(b.name), players: (a, b) => b.range.players - a.range.players || a.name.localeCompare(b.name), attention: (a, b) => Number(Boolean(attention(b))) - Number(Boolean(attention(a))) || b.range.events - a.range.events, last: (a, b) => (b.ever?.last_seen || '').localeCompare(a.ever?.last_seen || ''), name: (a, b) => a.name.localeCompare(b.name)};
  const visible = () => {
    const query = view.query.toLowerCase(); const keep = FILTERS.find(([key]) => key === view.filter)[2];
    return data.events.filter(item => keep(item) && (!query || `${item.name} ${item.definition.description}`.toLowerCase().includes(query))).sort(SORTS[view.sort]);
  };
  const statusPills = item => {
    const meaning = item.sdk && !item.described ? '<span class="pill">Built in</span>' : item.described ? '<span class="pill good">Described</span>' : '<span class="pill bad">Needs a description</span>';
    const activity = item.status === 'never' ? '<span class="pill bad">Never received</span>' : item.status === 'stale' ? `<span class="pill bad" title="Last sent ${agoText(item.ever.last_seen)}">Quiet ${data.stale_days}+ days</span>` : '';
    return `${meaning} ${activity}`;
  };
  const rowHTML = item => {
    const mapped = item.definition.canonical.map(rule => `<span class="pill good" title="${escapeHTML(ruleText(rule))}">${escapeHTML(conceptName(rule.action))}</span>`).join(' ');
    const params = item.params_seen ? `${number(item.params_seen)}${item.defined && item.params_missing.length ? ` <span class="pill bad" title="${escapeHTML(item.params_missing.join(', '))}">${item.params_missing.length} undescribed</span>` : ''}${item.type_conflicts.length ? ` <span class="pill bad" title="Sent as both text and number: ${escapeHTML(item.type_conflicts.join(', '))}">type changes</span>` : ''}` : '<span class="muted">—</span>';
    return `<tr class="${open.has(item.name) ? 'event-open' : ''}"><td class="event-name-cell"><button type="button" class="level-toggle" data-event-toggle="${escapeHTML(item.name)}" aria-expanded="${open.has(item.name)}" aria-label="Open ${escapeHTML(item.name)}">${icon('chevron', 14)}</button><code>${escapeHTML(item.name)}</code>${item.definition.hidden ? ` <span class="pill" title="Left out of player stories and journeys">hidden</span>` : ''}${item.similar.length ? ` <span class="pill bad" title="Looks like the same event as ${escapeHTML(item.similar.join(', '))}">similar name</span>` : ''}</td><td>${statusPills(item)}</td><td class="num">${number(item.range.events)}</td><td>${sparkline(item.series, `${item.name} per day`)}</td><td class="num">${number(item.range.players)}</td><td class="small muted">${item.ever ? agoText(item.ever.last_seen) : '—'}</td><td>${mapped || '<span class="muted small">—</span>'}</td><td>${params}</td></tr><tr class="level-detail" data-event-detail="${escapeHTML(item.name)}" ${open.has(item.name) ? '' : 'hidden'}><td colspan="8"><div class="level-drill event-detail" data-event-panel="${escapeHTML(item.name)}"></div></td></tr>`;
  };
  const fit = name => { const box = document.querySelector(`[data-event-panel="${CSS.escape(name)}"]`); const wrap = box?.closest('.table-wrap'); if (wrap) box.style.width = `${wrap.clientWidth}px`; };

  const drawSummary = () => {
    const s = data.summary;
    const inRange = data.events.reduce((sum, item) => sum + item.range.events, 0);
    document.querySelector('#events-summary').innerHTML = stats([
      ['Events received', number(s.received_total), `${number(inRange)} in the selected days · ${number(s.event_types)} event type${s.event_types === 1 ? '' : 's'}`],
      ['Database size', fileSize(s.database_bytes), 'all of this game’s events on disk'],
      ['Quiet or never sent', number(s.stale + s.never_received), `no event in ${data.stale_days}+ days, or never`],
    ]);
    document.querySelector('#dictionary-status').innerHTML = stats([
      ['Described', `${number(s.described)} of ${number(s.events)}`, s.events ? `${Math.round(100 * s.described / s.events)}% have a description` : ''],
      ['Need a description', number(s.needs_description), s.with_missing_params ? `${number(s.with_missing_params)} more have undescribed parameters` : 'Built-in events are exempt'],
      ['Mapped', number(s.mapped), 'stand for a shared moment'],
      ['Hidden', number(s.hidden), 'left out of stories and journeys'],
    ]);
    dictionaryPanel.setNote(`${number(s.described)} of ${number(s.events)} described`);
  };
  const drawFilterChips = () => {
    document.querySelector('#events-filter').innerHTML = FILTERS.map(([key, label, keep]) => `<button type="button" data-events-filter="${key}" aria-pressed="${view.filter === key}">${label} <span class="drill-count">${number(data.events.filter(keep).length)}</span></button>`).join('');
  };
  const draw = () => {
    const box = document.querySelector('#events-table');
    drawSummary(); drawFilterChips();
    document.querySelector('#events-sort').value = view.sort;
    const list = visible();
    if (!data.events.length) { box.innerHTML = empty('No events yet', 'Events appear here as soon as your game sends them, and you can describe them right away.', '', 'game'); return; }
    box.innerHTML = list.length ? `<div class="table-wrap"><table class="events-grid"><thead><tr><th>Event</th><th>Status</th><th class="num">Sent</th><th>Per day</th><th class="num">Players</th><th>Last sent</th><th>Understood as</th><th>Parameters</th></tr></thead><tbody>${list.map(rowHTML).join('')}</tbody></table></div>` : empty('No events match', 'Try another search or filter.', '', 'game');
    open.forEach(name => drawDetail(name));
    observer?.disconnect();
    const wrap = box.querySelector('.table-wrap');
    if (wrap && window.ResizeObserver) { observer = new ResizeObserver(() => open.forEach(fit)); observer.observe(wrap); }
  };

  // ---- one event's panel
  const detailQuery = name => { const query = filterQuery(chosen); query.set('name', name); return query; };
  const fetchDetail = async name => {
    const entry = detail.get(name) || {};
    if (entry.data || entry.loading) return;
    detail.set(name, {loading: true});
    try { detail.set(name, {data: await api(`${gameURL(game)}/insights/events/detail?${detailQuery(name)}`)}); }
    catch (error) { detail.set(name, {error: error.message}); }
    drawDetail(name);
  };
  const meaningTab = (item, info) => {
    const observed = info?.data?.params || [];
    const known = new Set(observed.map(param => param.key));
    const rows = [...observed.map(param => ({key: param.key, types: param.types, count: param.count, values: param.values, distinct: param.distinct, text: item.definition.params[param.key] || ''})),
      ...Object.keys(item.definition.params).filter(key => !known.has(key)).map(key => ({key, types: [], count: 0, values: [], distinct: 0, text: item.definition.params[key], quiet: true}))];
    const mapped = item.definition.canonical.length ? item.definition.canonical.map(rule => `<span class="pill good">${escapeHTML(conceptName(rule.action))}</span> <span class="small muted">${escapeHTML(ruleText(rule))}</span>`).join('<br>') : '<span class="muted">Nothing yet.</span>';
    return `<form class="event-form" data-event-form="${escapeHTML(item.name)}">
      <div class="field"><label for="desc-${escapeHTML(item.name)}">What does this event mean?</label><textarea id="desc-${escapeHTML(item.name)}" name="description" rows="2" maxlength="4000" placeholder="The player finished a level successfully.">${escapeHTML(item.definition.description)}</textarea></div>
      <div class="event-counts-as"><span class="small muted">Counts as</span><div>${mapped}</div><a class="button" href="${gamePath(game, 'mappings')}?${new URLSearchParams({event: item.name})}">${icon('link', 14)} ${item.definition.canonical.length ? 'Change mapping' : 'Map this event'}…</a></div>
      <h3 class="event-sub">Parameters</h3>
      ${!info || info.loading ? skeleton('table', 4, 4) : info.error ? `<p class="error">${escapeHTML(info.error)}</p>` : rows.length ? `<div class="table-wrap"><table class="compact-table event-params"><thead><tr><th>Parameter</th><th>Seen</th><th>Values</th><th>What it means</th></tr></thead><tbody>${rows.map(row => `<tr><td><code>${escapeHTML(row.key)}</code>${row.types.length ? `<br><span class="small muted">${row.types.join(' / ')}${row.types.length > 1 ? ' · type changes' : ''}</span>` : ''}</td><td class="num small">${row.quiet ? '<span class="muted">not in these days</span>' : number(row.count)}</td><td class="small">${row.values.length ? `${row.values.slice(0, 4).map(value => `<span class="chip" title="${number(value.count)} times">${escapeHTML(value.value)}</span>`).join(' ')}${row.distinct > 4 ? ` <span class="muted">+${number(row.distinct - 4)} more</span>` : ''}` : '<span class="muted">—</span>'}</td><td><input name="param:${escapeHTML(row.key)}" value="${escapeHTML(row.text)}" maxlength="2000" aria-label="Meaning of ${escapeHTML(row.key)}" placeholder="${row.text ? '' : 'What does it hold?'}"></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">This event has no parameters in these days.</p>'}
      <div class="field"><label for="labels-${escapeHTML(item.name)}">How it reads in player stories <span class="muted">(optional)</span></label><textarea id="labels-${escapeHTML(item.name)}" name="labels" rows="2" maxlength="2000" placeholder="Started => Started level {Started}">${escapeHTML(item.definition.labels)}</textarea><p class="help">One rule per line: <code>parameter => text</code>. Use <code>{Parameter}</code> to insert its value.</p></div>
      <label class="check-row"><input type="checkbox" name="hidden" value="1" ${item.definition.hidden ? 'checked' : ''}> Leave it out of player stories and journeys (noise)</label>
      <div class="error" role="alert"></div>
      <div class="modal-actions event-actions">${item.defined ? `<button type="button" class="button danger-text" data-event-delete="${escapeHTML(item.name)}">Delete definition</button>` : ''}<button type="submit" class="button primary">Save</button><button type="submit" class="button" data-save-next>Save and next event without a description →</button></div>
    </form>`;
  };
  const activityTab = info => {
    if (!info || info.loading) return skeleton('chart');
    if (info.error) return `<p class="error">${escapeHTML(info.error)}</p>`;
    const d = info.data;
    const table = (title, rows, cells) => rows.length ? `<div><h3 class="event-sub">${title}</h3><table class="compact-table"><tbody>${rows.map(cells).join('')}</tbody></table></div>` : '';
    return `<details class="conditional-activity" data-disclosure="conditional-activity" open><summary>Conditional activity</summary><div class="conditional-activity-body"><p class="help">Count this event when its parameters match. Combine conditions with AND / OR groups. Leave conditions empty to count every occurrence.</p><div data-activity-editor></div><div class="condition-actions"><button type="button" class="button primary" data-activity-apply>Apply conditions</button><button type="button" class="button" data-activity-clear>Clear conditions</button></div><div data-activity-result role="status" aria-live="polite"></div></div></details>
      <h3 class="event-sub">All activity for this event</h3><div class="chart-wrap event-chart">${d.days.some(day => day.events) ? dailyChart(d.days, chosen.range, 'events') : '<p class="help">Not sent in these days.</p>'}</div>
      ${d.missing_in_newest ? `<p class="event-warning">${icon('pulse', 15)}<span>The newest version in your data (<strong>${escapeHTML(d.newest_version)}</strong>) has not sent this event. If you expected it, check that build.</span></p>` : ''}
      <div class="event-breakdowns">${table('App versions (all time)', d.versions, row => `<tr><td>${escapeHTML(row.version)}${row.version === d.newest_version ? ' <span class="pill">newest</span>' : ''}</td><td class="num">${number(row.events)}</td><td class="num muted small">${number(row.players)} players</td><td class="muted small">last ${agoText(row.last_seen)}</td></tr>`)}
      ${table('Environments', d.environments, row => `<tr><td>${escapeHTML(row.value)}</td><td class="num">${number(row.events)}</td><td class="num muted small">${number(row.players)} players</td></tr>`)}
      ${table('Countries', d.countries, row => `<tr><td>${row.value === 'unknown' ? 'unknown' : countryTag(row.value)} <span class="muted small">${row.value === 'unknown' ? '' : escapeHTML(countryName(row.value))}</span></td><td class="num">${number(row.events)}</td><td class="num muted small">${number(row.players)} players</td></tr>`)}</div>`;
  };
  const examplesTab = info => {
    if (!info || info.loading) return skeleton('table', 4, 3);
    if (info.error) return `<p class="error">${escapeHTML(info.error)}</p>`;
    return info.data.samples.length ? `<table class="compact-table event-examples"><thead><tr><th>When</th><th>Version</th><th>Environment</th><th>Parameters</th></tr></thead><tbody>${info.data.samples.map(sample => `<tr><td class="small muted">${analysisDate(sample.client_ts, chosen.timezone)}</td><td class="small">${escapeHTML(sample.version || '—')}</td><td class="small">${escapeHTML(sample.environment || '—')}</td><td>${paramChips(sample.params)}</td></tr>`).join('')}</tbody></table>` : '<p class="help">No examples in these days and filters.</p>';
  };
  const mountActivity = (box, name, info) => {
    const editorBox = box.querySelector('[data-activity-editor]');
    if (!editorBox) return;
    if (!activityStates.has(name)) activityStates.set(name, {tree: storeGet(`avn-event-conditions-${game.id}-${name}`) || conditionGroup(), revision: 0});
    const state = activityStates.get(name);
    const resultBox = box.querySelector('[data-activity-result]');
    const button = box.querySelector('[data-activity-apply]');
    const persistTree = () => storeSet(`avn-event-conditions-${game.id}-${name}`, state.tree);
    const changed = () => {
      state.revision++; persistTree(); button.disabled = false;
      const error = state.tree.conditions.length ? conditionError(state.tree) : '';
      resultBox.innerHTML = error ? `<p class="error" role="alert">${escapeHTML(error)}</p>` : '<p class="help">Conditions changed. Apply to update counts.</p>';
    };
    const editor = mountConditionEditor({container: editorBox, tree: state.tree,
      catalog: () => ({events: [{name, params: (info.data.params || []).map(param => ({key: param.key, values: param.values.map(value => value.value)}))}]}), onChange: changed});
    const run = async (force = false) => {
      const error = state.tree.conditions.length ? conditionError(state.tree) : '';
      if (error) {resultBox.innerHTML = `<p class="error" role="alert">${escapeHTML(error)}</p>`; return;}
      const body = {...filterBody(chosen), name, conditions: state.tree.conditions.length ? state.tree : null};
      const key = JSON.stringify(body); const ticket = ++state.revision;
      const renderResult = result => {
        const decimal = value => Number(value).toLocaleString(undefined, {maximumFractionDigits: 2});
        resultBox.innerHTML = `<dl class="activity-stats"><div><dt>Matching events</dt><dd>${number(result.events)}</dd></div><div><dt>Matching players</dt><dd>${number(result.players)}</dd></div><div><dt>Events / matching player</dt><dd>${decimal(result.per_matching_player)}</dd></div><div><dt>Events / active player</dt><dd>${decimal(result.per_active_player)}</dd></div></dl>
          <p class="help">Averages use ${number(result.identified_events)} matching events with a player ID. Matching-player average divides by ${number(result.players)} matching players; active-player average divides by all ${number(result.active_players)} active players across all events in the selected days and filters, including players with zero matches.${result.anonymous_events ? ` ${number(result.anonymous_events)} events without a player ID are included in the event count only.` : ''}</p>
          <div class="chart-wrap event-chart">${result.days.some(day => day.events) ? dailyChart(result.days, chosen.range, 'events') : '<p class="help">No events match these conditions in the selected days and filters.</p>'}</div>`;
      };
      if (!force && state.resultKey === key && Date.now() - state.resultTime < 30000) {renderResult(state.result); return;}
      button.disabled = true; resultBox.innerHTML = '<p class="help">Counting matching events…</p>';
      try {
        const result = await api(`${gameURL(game)}/insights/events/activity`, {method: 'POST', body: key});
        if (state.revision !== ticket || !resultBox.isConnected) return;
        state.resultKey = key; state.result = result; state.resultTime = Date.now(); renderResult(result);
      } catch (error) {
        if (state.revision === ticket && resultBox.isConnected) resultBox.innerHTML = `<p class="error" role="alert">${escapeHTML(error.message)}</p>`;
      } finally {if (state.revision === ticket) button.disabled = false;}
    };
    button.addEventListener('click', () => run(true));
    box.querySelector('[data-activity-clear]').addEventListener('click', () => {state.tree.conditions.splice(0); editor.redraw(); changed(); run();});
    run();
  };
  function drawDetail(name) {
    const box = document.querySelector(`[data-event-panel="${CSS.escape(name)}"]`); const item = data.events.find(entry => entry.name === name);
    if (!box || !item) return;
    fit(name);
    const tab = tabs.get(name) || 'meaning'; const info = detail.get(name);
    const body = tab === 'activity' ? activityTab(info) : tab === 'examples' ? examplesTab(info) : meaningTab(item, info);
    const typing = box.querySelector(':focus')?.name;
    box.innerHTML = `<div class="level-drill-head"><div class="segmented" role="group" aria-label="${escapeHTML(name)}">${[['meaning', 'Meaning'], ['activity', 'Activity'], ['examples', 'Examples']].map(([key, label]) => `<button type="button" data-event-tab="${key}" aria-pressed="${tab === key}">${label}</button>`).join('')}</div><span class="small muted">${item.ever ? `${number(item.ever.events)} events from ${number(item.ever.players)} players since ${analysisDate(item.ever.first_seen, chosen.timezone)}` : 'Never received'}</span></div><div class="event-body">${body}</div>`;
    mountDisclosures(box, `avn-event-disclosures-${game.id}-${name}`);
    if (tab === 'activity' && info?.data) mountActivity(box, name, info);
    if (typing) box.querySelector(`[name="${CSS.escape(typing)}"]`)?.focus();
  }

  // ---- loading
  const load = async state => {
    chosen = state; const ticket = ++latest;
    document.querySelector('#events-summary').innerHTML = skeleton('stats');
    document.querySelector('#dictionary-status').innerHTML = skeleton('stats');
    document.querySelector('#events-table').innerHTML = skeleton('table', 8, 6);
    try {
      const result = await api(`${gameURL(game)}/insights/events?${filterQuery(state)}`);
      if (ticket !== latest || !table.isConnected) return;
      data = result; detail.clear();
      const requestedEvent = new URLSearchParams(location.search).get('event');
      if (requestedEvent && data.events.some(item => item.name === requestedEvent)) open.add(requestedEvent);
      draw(); open.forEach(fetchDetail);
    } catch (error) { if (ticket === latest && table.isConnected) { document.querySelector('#events-summary').innerHTML = ''; document.querySelector('#dictionary-status').innerHTML = ''; document.querySelector('#events-table').innerHTML = loadError(error); } }
  };
  const reload = async message => { cache.clear(); detail.clear(); const result = await api(`${gameURL(game)}/insights/events?${filterQuery(chosen)}`); data = result; draw(); open.forEach(fetchDetail); if (message) toast(message); };

  // ---- events
  const table = document.querySelector('#events-table');
  table.addEventListener('click', event => {
    const toggle = event.target.closest('[data-event-toggle]');
    if (toggle) {
      const name = toggle.dataset.eventToggle; const row = document.querySelector(`[data-event-detail="${CSS.escape(name)}"]`);
      if (open.has(name)) { open.delete(name); row.hidden = true; toggle.setAttribute('aria-expanded', 'false'); return; }
      open.add(name); row.hidden = false; toggle.setAttribute('aria-expanded', 'true'); drawDetail(name); fetchDetail(name); return;
    }
    const tab = event.target.closest('[data-event-tab]');
    if (tab) { const name = tab.closest('[data-event-panel]').dataset.eventPanel; tabs.set(name, tab.dataset.eventTab); drawDetail(name); return; }
    const remove = event.target.closest('[data-event-delete]');
    if (remove) {
      const name = remove.dataset.eventDelete;
      confirmDialog(`Delete the definition of ${name}?`, 'Its description, parameter notes, story rule and mappings are removed. Collected events are not affected.', 'Delete definition', async () => {
        await api(`${gameURL(game)}/dictionary/${encodeURIComponent(name)}`, {method: 'DELETE'});
        await reload('Definition deleted.');
      });
    }
  });
  table.addEventListener('submit', async event => {
    const form = event.target.closest('[data-event-form]'); if (!form) return;
    event.preventDefault();
    const name = form.dataset.eventForm; const item = data.events.find(entry => entry.name === name);
    const next = event.submitter?.hasAttribute('data-save-next');
    const params = {};
    for (const [key, value] of new FormData(form)) if (key.startsWith('param:') && value.trim()) params[key.slice(6)] = value.trim();
    for (const [key, value] of Object.entries(item.definition.params)) if (!(key in params) && !form.querySelector(`[name="param:${CSS.escape(key)}"]`)) params[key] = value;
    const fields = form.elements; // not form.hidden: that is the form's own "hidden" attribute
    const body = {description: fields.description.value.trim(), params, labels: fields.labels.value.trim(), hidden: fields.hidden.checked, canonical: item.definition.canonical};
    const list = visible(); const here = list.findIndex(entry => entry.name === name);
    const nextName = next ? [...list.slice(here + 1), ...list.slice(0, Math.max(here, 0))].find(entry => !entry.described && !entry.sdk && entry.ever && entry.name !== name)?.name : null;
    const buttons = form.querySelectorAll('[type="submit"]'); buttons.forEach(button => { button.disabled = true; });
    form.querySelector('.error').textContent = '';
    try {
      await api(`${gameURL(game)}/dictionary/${encodeURIComponent(name)}`, {method: 'PUT', body: JSON.stringify(body)});
      await reload(`${name} saved.`);
      if (nextName) {
        open.delete(name); open.add(nextName); tabs.set(nextName, 'meaning'); draw(); fetchDetail(nextName);
        document.querySelector(`[data-event-detail="${CSS.escape(nextName)}"]`)?.scrollIntoView({block: 'center', behavior: 'smooth'});
      } else if (next) toast('Every event now has a description.');
    } catch (error) { form.querySelector('.error').textContent = error.message; buttons.forEach(button => { button.disabled = false; }); }
  });
  document.querySelector('#events-search').addEventListener('input', event => { view.query = event.target.value; if (data) draw(); });
  document.querySelector('#events-sort').addEventListener('change', event => { view.sort = event.target.value; persist(); if (data) draw(); });
  document.querySelector('#events-filter').addEventListener('click', event => {
    const button = event.target.closest('[data-events-filter]'); if (!button || !data) return;
    view.filter = button.dataset.eventsFilter; persist(); draw();
  });
  document.querySelector('#events-csv').addEventListener('click', () => {
    if (!data) return;
    downloadCSV(`${game.name}-${platformLabel(game.platform)}-events-${chosen.range.from}_${chosen.range.to}.csv`, [['event', 'described', 'description', 'counts_as', 'hidden', 'sent_in_range', 'players_in_range', 'sent_all_time', 'first_seen', 'last_seen', 'parameters_seen', 'parameters_undescribed'], ...visible().map(item => [item.name, item.described, item.definition.description, item.definition.canonical.map(rule => rule.action).join(' '), item.definition.hidden, item.range.events, item.range.players, item.ever?.events ?? 0, item.ever?.first_seen ?? '', item.ever?.last_seen ?? '', item.params_seen, item.params_missing.join(' ')])]);
  });
  mountFilters(document.querySelector('#filters'), game, load);
}

/* ─── Mappings ─── */

async function renderMappings() {
  const game = currentGame;
  shell('Event dictionary', heading('Event dictionary', 'Map your events once for Levels, Retention, player stories and journeys.', `<button type="button" class="button" id="mappings-import">${icon('book', 15)} Fill with AI agent</button>`) + eventDictionaryNav(game, 'mappings') + `<div id="mappings-body">${skeleton('stats')}${skeleton('table')}</div>`);
  const wanted = new URLSearchParams(location.search);
  let version = wanted.get('version') || '';
  let data = null; let forms = new Map();
  document.querySelector('#mappings-import').addEventListener('click', () => openDictionaryImport(game, load));
  const body = document.querySelector('#mappings-body');
  const rulesOf = name => data.definitions[name] || [];
  const save = async (name, rules) => { await api(`${gameURL(game)}/dictionary/${encodeURIComponent(name)}/mappings`, {method: 'PUT', body: JSON.stringify({canonical: rules})}); cache.clear(); await load(); };
  const how = source => source.via === 'mapped' ? `<span class="pill good">You mapped it</span> <span class="small muted">${escapeHTML(ruleText(source.rule))}</span>` : '<span class="pill">Understood automatically</span>';
  const levelsText = levels => levels ? `levels ${number(levels.min)}–${number(levels.max)} <span class="muted small">(${number(levels.count)} different)</span>` : '';
  const sourceRow = (concept, source) => `<tr><td><a class="row-title" href="${gamePath(game, 'dictionary')}?${new URLSearchParams({event: source.event})}"><code>${escapeHTML(source.event)}</code></a></td><td>${how(source)}</td><td class="num">${number(source.events)}</td><td class="num">${number(source.players)}</td><td class="small">${concept.needs ? levelsText(source.levels) || '<span class="pill bad">no level number found</span>' : ''}</td><td class="num">${source.via === 'mapped' ? `<button type="button" class="button" data-remove-rule="${escapeHTML(source.event)}" data-rule="${escapeHTML(JSON.stringify(source.rule))}">Remove</button>` : ''}</td></tr>`;
  const card = concept => {
    const status = concept.status === 'mapped' ? '<span class="pill good">Mapped</span>' : concept.status === 'auto' ? '<span class="pill good">Understood automatically</span>' : '<span class="pill bad">Not found</span>';
    return `<section class="panel mapping-card section-spacing" data-concept="${concept.key}"><div class="panel-header"><div><h2>${escapeHTML(concept.label)} ${status}</h2><p>${escapeHTML(concept.summary)} Used by ${concept.used_by.join(', ')}.</p></div><button type="button" class="button" data-add-mapping="${concept.key}">${icon('link', 14)} Add a mapping…</button></div>
      <div class="panel-body">${concept.sources.length ? `<div class="table-wrap"><table class="compact-table"><thead><tr><th>Event</th><th>How</th><th class="num">Events</th><th class="num">Players</th><th>${concept.needs ? 'Level numbers' : ''}</th><th></th></tr></thead><tbody>${concept.sources.map(source => sourceRow(concept, source)).join('')}</tbody></table></div>` : `<p class="help">Nothing in your data is understood as “${escapeHTML(concept.label.toLowerCase())}” yet. If your game sends it under another name, add a mapping.</p>`}
      ${concept.silent_rules.length ? `<p class="help mapping-silent">${icon('pulse', 14)} These mappings matched none of the latest ${number(data.scanned)} events: ${concept.silent_rules.map(item => `<code>${escapeHTML(item.event)}</code> ${escapeHTML(ruleText(item.rule))} <button type="button" class="button" data-remove-rule="${escapeHTML(item.event)}" data-rule="${escapeHTML(JSON.stringify(item.rule))}">Remove</button>`).join(' · ')}</p>` : ''}
      <div class="mapping-form-slot" data-form-slot="${concept.key}"></div></div></section>`;
  };
  const draw = () => {
    const concepts = data.concepts;
    const mapped = concepts.filter(concept => concept.status === 'mapped').length; const auto = concepts.filter(concept => concept.status === 'auto').length; const missing = concepts.filter(concept => concept.status === 'missing').length;
    const chosenEvent = data.events.find(item => item.name === wanted.get('event'));
    const asking = chosenEvent ? `<section class="panel section-spacing mapping-ask"><div class="panel-body"><p>What does <code>${escapeHTML(chosenEvent.name)}</code> stand for?${rulesOf(chosenEvent.name).length ? ` <span class="muted small">Already: ${rulesOf(chosenEvent.name).map(rule => escapeHTML(conceptName(rule.action))).join(', ')}.</span>` : ''}</p><div class="quiet-actions">${concepts.map(concept => `<button type="button" class="button" data-add-mapping="${concept.key}">${escapeHTML(concept.label)}</button>`).join('')}</div></div></section>` : '';
    const versions = [...new Set([...data.versions, version].filter(Boolean))];
    const suggestions = data.events.flatMap(item => item.suggestions.filter(rule => !rulesOf(item.name).some(existing => JSON.stringify(existing) === JSON.stringify(rule))).map(rule => ({event: item.name, rule})));
    body.innerHTML = `<section class="panel section-spacing"><div class="panel-body"><div class="field"><label for="mapping-version">App version</label><select id="mapping-version"><option value="">All versions</option>${versions.map(item => `<option value="${escapeHTML(item)}" ${item === version ? 'selected' : ''}>${escapeHTML(item)}</option>`).join('')}</select><p class="help">${version ? `New mappings apply only to ${escapeHTML(version)}. For an event with version-specific rules, those replace its shared rules.` : 'New mappings apply to every app version. Pick a version to map a release separately.'} All analytics pages use these same mappings.</p></div></div></section>${asking}<section class="panel ${asking ? 'section-spacing' : ''}"><div class="panel-body"><p>Retention, Levels, player stories and journeys need to know which of your events are a session start, or a level being started, completed, failed or restarted. AVN Analytics recognises the common shapes by itself (a <code>session_start</code> event, or level events that carry a <code>level</code> parameter). For anything else, point the right event at the right moment below. Any event your game has sent works, described yet or not.</p><p class="help">A mapping lives with the event in the dictionary. It changes how the dashboards read your events, never the stored events themselves. ${data.capped ? `Counts come from the latest ${number(data.scanned)} events.` : `Counts cover all ${number(data.scanned)} events.`}</p></div></section>
      ${data.conflicts.length ? `<div class="notice-banner section-spacing" role="alert">${icon('pulse', 18)}<div><strong>Some mappings overlap.</strong> ${data.conflicts.map(item => `${escapeHTML(item.event)}: ${number(item.events)} events count as more than one level action`).join('; ')}. Add a condition such as <code>STATE = Completed</code>, or remove the broad rule.</div></div>` : ''}
      <div id="mappings-summary" class="section-spacing">${stats([['Moments understood', `${number(mapped + auto)} of ${number(concepts.length)}`, `${number(mapped)} mapped by you · ${number(auto)} automatically`], ['Not found', number(missing), missing ? 'Their dashboards will be empty or partial' : 'Everything is covered']])}</div>
      ${suggestions.length ? `<section class="panel section-spacing"><div class="panel-header"><div><h2>Suggested mappings</h2><p>Known event shapes, ready to preview. Review each before saving.</p></div></div><div class="panel-body mapping-suggestions">${suggestions.map(item => `<div><code>${escapeHTML(item.event)}</code><span>${escapeHTML(conceptName(item.rule.action))} · ${escapeHTML(ruleText(item.rule))}</span><button type="button" class="button" data-suggest-event="${escapeHTML(item.event)}" data-suggest-rule="${escapeHTML(JSON.stringify(item.rule))}">Review mapping</button></div>`).join('')}</div></section>` : ''}
      <details class="panel section-spacing"><summary class="panel-body">Standard event format</summary><div class="panel-body"><p>For new integrations, send one event per moment: <code>level_started</code>, <code>level_completed</code>, <code>level_failed</code> or <code>level_restarted</code>, with <code>{"level": 3}</code> in parameters. Keep <code>app_version</code> in the event envelope.</p><p class="help">Existing formats work too: <code>LEVEL_ANALYSIS</code> with <code>{"Started": 3}</code>, or <code>level_analysis</code> with <code>{"action": "started", "level": 3}</code>. Also recognised: <code>{"STATE": "Started", "NUMBER": 3}</code>. When the parameter name is the action, choose “exists” and use that same parameter for the level number.</p></div></details>
      ${concepts.map(card).join('')}
      ${data.other.length ? `<section class="panel section-spacing"><div class="panel-header"><div><h2>Other mappings</h2><p>These name something the dashboards don’t use. They are kept in the dictionary and exports.</p></div></div><div class="panel-body"><table class="compact-table"><tbody>${data.other.map(item => `<tr><td><code>${escapeHTML(item.event)}</code></td><td><code>${escapeHTML(item.rule.action)}</code> <span class="small muted">${escapeHTML(ruleText(item.rule))}</span></td><td class="num"><button type="button" class="button" data-remove-rule="${escapeHTML(item.event)}" data-rule="${escapeHTML(JSON.stringify(item.rule))}">Remove</button></td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
    forms.forEach((_, key) => openForm(key, true));
  };

  // ---- the add form of a card
  const openForm = (key, again = false, suggested = null) => {
    const slot = body.querySelector(`[data-form-slot="${key}"]`); const concept = data.concepts.find(item => item.key === key); if (!slot) return;
    const previous = forms.get(key) || {};
    const candidate = data.events.find(item => item.suggestions.some(rule => rule.action === key));
    const state = again ? previous : {event: previous.event || wanted.get('event') || candidate?.name || data.events[0]?.name || '', param: '', op: 'eq', value: '', number_param: '', app_version: version};
    if (suggested) Object.assign(state, suggested.rule, {event: suggested.event});
    if (!again && !suggested) {
      const guess = data.events.find(item => item.name === state.event)?.suggestions.find(rule => rule.action === key);
      if (guess) Object.assign(state, guess);
    }
    forms.set(key, state);
    const info = () => data.events.find(item => item.name === state.event) || {params: []};
    const render = () => {
      const params = info().params; const examples = (params.find(param => param.key === state.param)?.examples || []);
      slot.innerHTML = `<form class="mapping-form" data-mapping-form="${key}"><h3 class="event-sub">Add a mapping for “${escapeHTML(concept.label)}”</h3>
        <p class="help">Applies to ${state.app_version ? escapeHTML(state.app_version) : 'all versions'} across all analytics pages.</p><div class="mapping-fields"><div class="field"><label>Which event?</label><select name="event" aria-label="Which event?">${data.events.map(item => `<option value="${escapeHTML(item.name)}" ${item.name === state.event ? 'selected' : ''}>${escapeHTML(item.name)} · ${number(item.events)} sent${item.defined ? '' : ' · not described'}</option>`).join('')}</select></div>
        <div class="field"><label>Only when… <span class="muted">(optional)</span></label><div class="mapping-condition"><select name="param" aria-label="Parameter"><option value="">Every time it is sent</option>${params.map(param => `<option value="${escapeHTML(param.key)}" ${param.key === state.param ? 'selected' : ''}>${escapeHTML(param.key)}</option>`).join('')}</select>${state.param ? `<select name="op" aria-label="Comparison">${MAPPING_OPERATORS.map(([op, text]) => `<option value="${op}" ${op === state.op ? 'selected' : ''}>${text}</option>`).join('')}</select>${state.op === 'exists' ? '' : `<input name="value" aria-label="Comparison value" value="${escapeHTML(state.value)}" list="mapping-values-${key}" placeholder="value" autocomplete="off"><datalist id="mapping-values-${key}">${examples.map(value => `<option value="${escapeHTML(value)}">`).join('')}</datalist>`}` : ''}</div></div>
        ${concept.needs ? `<div class="field"><label>The level number is in</label><select name="number_param" aria-label="Level number parameter"><option value="">Find it automatically (a parameter called “level”)</option>${params.map(param => `<option value="${escapeHTML(param.key)}" ${param.key === state.number_param ? 'selected' : ''}>${escapeHTML(param.key)}${param.examples.length ? ` · e.g. ${escapeHTML(param.examples.slice(0, 3).join(', '))}` : ''}</option>`).join('')}</select></div>` : ''}</div>
        <p class="mapping-preview help" aria-live="polite"><span class="skeleton-line" role="status" aria-label="Checking mapping"></span></p><details class="mapping-sample" hidden><summary>Example matching parameters</summary><pre></pre></details><div class="error" role="alert"></div>
        <div class="modal-actions"><button type="button" class="button" data-cancel-mapping>Cancel</button><button type="submit" class="button primary">Add mapping</button></div></form>`;
    };
    const ruleOf = () => ({action: key, param: state.param, op: state.param ? state.op : 'eq', value: state.param && state.op !== 'exists' ? state.value.trim() : '', number_param: concept.needs ? state.number_param : '', app_version: state.app_version});
    let timer = null;
    const preview = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const line = slot.querySelector('.mapping-preview'); if (!line) return;
        const rule = ruleOf();
        if (!state.event) { line.textContent = 'This game has not sent any events yet.'; return; }
        if (rule.param && rule.op !== 'exists' && !rule.value) { line.textContent = 'Add a value to compare with.'; return; }
        try {
          const result = await request(`${gameURL(game)}/mappings/preview`, {method: 'POST', body: JSON.stringify({event: state.event, rule})});
          if (!line.isConnected) return;
          const bits = [`Matches ${number(result.events)} of its latest ${number(result.scanned)} events from ${number(result.players)} players`];
          if (concept.needs && result.events) bits.push(result.with_level_number ? `level numbers found in ${number(result.with_level_number)} of them (levels ${number(result.levels.min)}–${number(result.levels.max)})` : '<strong>no level number found — choose the parameter that holds it</strong>');
          if (result.conflicting_events) bits.push(`<strong>${number(result.conflicting_events)} also match another level action. Remove or narrow the overlapping rule.</strong>`);
          const sample = slot.querySelector('.mapping-sample');
          if (sample) { sample.hidden = !result.sample; sample.querySelector('pre').textContent = JSON.stringify(result.sample, null, 2); }
          line.innerHTML = `${bits.join(' · ')}.${result.events ? '' : ' <strong>Nothing matches yet.</strong>'}`;
        } catch (error) { if (line.isConnected) line.textContent = error.message; }
      }, 250);
    };
    render(); preview();
    slot.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    slot.onchange = event => {
      const field = event.target; if (!field.name) return;
      state[field.name] = field.value;
      if (field.name === 'event') Object.assign(state, {param: '', op: 'eq', value: '', number_param: ''}, info().suggestions.find(rule => rule.action === key) || {});
      if (field.name === 'param') {
        const suggestion = info().suggestions.find(rule => rule.action === key && rule.param === state.param);
        Object.assign(state, {op: suggestion?.op || 'eq', value: suggestion?.value || '', number_param: suggestion?.number_param || state.number_param});
      }
      render(); preview();
    };
    slot.oninput = event => { if (event.target.name === 'value') { state.value = event.target.value; preview(); } };
    slot.onclick = event => { if (event.target.closest('[data-cancel-mapping]')) { forms.delete(key); slot.innerHTML = ''; } };
    slot.onsubmit = async event => {
      event.preventDefault();
      const rule = ruleOf(); const error = slot.querySelector('.error'); const button = slot.querySelector('[type="submit"]');
      if (rule.param && rule.op !== 'exists' && !rule.value) { error.textContent = 'Add a value to compare with.'; return; }
      button.disabled = true; error.textContent = '';
      const kept = forms.get(key); forms.delete(key);
      try { await save(state.event, [...rulesOf(state.event), rule]); toast(`${state.event} now counts as ${concept.label.toLowerCase()}.`); }
      catch (failure) { forms.set(key, kept); error.textContent = failure.message; button.disabled = false; }
    };
  };
  body.addEventListener('click', event => {
    const suggestion = event.target.closest('[data-suggest-rule]');
    if (suggestion) { const rule = JSON.parse(suggestion.dataset.suggestRule); openForm(rule.action, false, {event: suggestion.dataset.suggestEvent, rule}); return; }
    const add = event.target.closest('[data-add-mapping]');
    if (add) { openForm(add.dataset.addMapping); return; }
    const remove = event.target.closest('[data-remove-rule]');
    if (remove) {
      const name = remove.dataset.removeRule; const rule = JSON.parse(remove.dataset.rule);
      const rest = rulesOf(name).filter(item => JSON.stringify(item) !== JSON.stringify(rule));
      confirmDialog(`Stop treating ${name} as ${conceptName(rule.action).toLowerCase()}?`, 'Only the mapping is removed. The event, its description and the stored data stay as they are.', 'Remove mapping', async () => { await save(name, rest); toast('Mapping removed.'); });
    }
  });
  body.addEventListener('change', event => {
    if (event.target.id !== 'mapping-version') return;
    version = event.target.value; forms.clear();
    const query = new URLSearchParams(location.search);
    if (version) query.set('version', version); else query.delete('version');
    history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`);
    load();
  });
  let loading = 0;
  const load = async () => {
    const revision = ++loading;
    body.innerHTML = skeleton('stats') + skeleton('table');
    try { const result = await api(`${gameURL(game)}/mappings?${new URLSearchParams({version})}`); if (revision !== loading || !body.isConnected) return; data = result; draw(); }
    catch (error) { if (revision === loading && body.isConnected) body.innerHTML = loadError(error); }
  };
  await load();
  if (data && wanted.get('concept') && data.concepts.some(item => item.key === wanted.get('concept'))) openForm(wanted.get('concept'));
}
