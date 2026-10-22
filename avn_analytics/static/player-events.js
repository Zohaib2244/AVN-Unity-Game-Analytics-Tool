// Event Analysis uses the exact paginated snapshot displayed by the raw timeline.
const analysisValueKey = value => JSON.stringify([typeof value, value]);

function analysisMatchesFilters(event, filters, except = null) {
  return [...filters].every(([key, value]) => key === except || (Object.hasOwn(event.params || {}, key) && analysisValueKey(event.params[key]) === value.token));
}

function analysisParameterValues(items, filters, parameter) {
  const values = new Map();
  for (const event of items) {
    if (!analysisMatchesFilters(event, filters, parameter) || !Object.hasOwn(event.params || {}, parameter)) continue;
    const value = event.params[parameter]; const token = analysisValueKey(value);
    if (!values.has(token)) values.set(token, {value, token, count: 0});
    values.get(token).count++;
  }
  return [...values.values()].sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

function playerEventAnalysis(events, session = 'all') {
  const scoped = events.flatMap((event, index) => session === 'all' || String(event.session) === session ? [{...event, index}] : []);
  const groups = new Map();
  for (const event of scoped) {
    if (!groups.has(event.name)) groups.set(event.name, {name: event.name, items: [], params: new Map(), sessions: new Set()});
    const group = groups.get(event.name);
    group.items.push(event); group.sessions.add(event.session);
    for (const [key, value] of Object.entries(event.params || {})) {
      if (!group.params.has(key)) group.params.set(key, new Map());
      const values = group.params.get(key); const token = analysisValueKey(value);
      if (!values.has(token)) values.set(token, {value, token, count: 0});
      values.get(token).count++;
    }
  }
  return {
    total: scoped.length,
    levels: new Set(scoped.map(event => event.level).filter(level => level != null)).size,
    groups: [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name)),
  };
}

function mountPlayerEventAnalysis(container, {timezone, onJump, onHighlight}) {
  container.innerHTML = `<p class="help">Expand an event for parameter counts and individual calls. Use type and action together to distinguish ad shows from requests or rewards.</p>
    <div class="analysis-toolbar"><div class="analysis-totals" role="status" aria-live="polite"></div>
    <label class="analysis-search">Find an event<input type="search" data-analysis-search placeholder="Event name…"></label></div>
    <div data-analysis-error></div><div data-analysis-events></div><div data-analysis-detail></div>`;
  let data = {total: 0, levels: 0, groups: []}; let selected = null; let parameter = ''; const filters = new Map();
  let limit = 50; let valueLimit = 20; let complete = false; let failure = '';
  const search = container.querySelector('[data-analysis-search]');
  const detail = container.querySelector('[data-analysis-detail]');
  const selectedGroup = () => data.groups.find(group => group.name === selected);
  const drawDetail = () => {
    const group = selectedGroup();
    if (!group) {detail.innerHTML = ''; return;}
    const keys = [...group.params.keys()].sort((a, b) => Number(!/type|stage|state|action/i.test(a)) - Number(!/type|stage|state|action/i.test(b)) || a.localeCompare(b));
    if (!keys.includes(parameter)) parameter = keys[0] || '';
    const values = analysisParameterValues(group.items, filters, parameter);
    const occurrences = group.items.filter(event => analysisMatchesFilters(event, filters));
    detail.innerHTML = `<section class="analysis-event-detail"><div class="panel-header"><div><h3>${escapeHTML(group.name)}</h3><p>${number(group.items.length)} calls · ${number(group.sessions.size)} session${group.sessions.size === 1 ? '' : 's'}${complete ? '' : ' · partial counts'}</p></div><button type="button" class="button small-button" data-analysis-close>Close event</button></div>
      ${keys.length ? `<label class="analysis-parameter">Break down by parameter<select data-analysis-parameter>${keys.map(key => `<option value="${escapeHTML(key)}" ${key === parameter ? 'selected' : ''}>${escapeHTML(key)}</option>`).join('')}</select></label>
      <p class="help">Select a value, then choose another parameter to narrow it further. Counts include the other selected details.</p>
      <div class="analysis-values">${values.slice(0, valueLimit).map((value, index) => `<button type="button" class="analysis-value" data-analysis-value="${index}" aria-pressed="${value.token === filters.get(parameter)?.token}"><code>${escapeHTML(JSON.stringify(value.value))}</code><strong>${number(value.count)}</strong></button>`).join('')}</div>${values.length > valueLimit ? '<button type="button" class="button small-button" data-analysis-values-more>Show more values</button>' : ''}` : '<p class="help">This event has no parameters.</p>'}
      <div class="analysis-filter-chips">${[...filters].map(([key, value]) => `<button type="button" class="button small-button" data-analysis-remove-filter="${escapeHTML(key)}">${escapeHTML(key)} = ${escapeHTML(JSON.stringify(value.value))} ×</button>`).join('')}</div>
      <div class="analysis-occurrence-head"><h3>${number(occurrences.length)} matching occurrences${complete ? '' : ' so far'}</h3>${filters.size ? '<button type="button" class="button small-button" data-analysis-clear>Clear details</button>' : ''}<button type="button" class="button small-button" data-analysis-highlight>Highlight these events</button></div>
      <div class="analysis-occurrences">${occurrences.slice(0, limit).map(event => `<div class="analysis-occurrence"><div><strong>${analysisDate(event.client_ts, timezone)}</strong><span class="small muted">Session ${number(event.session + 1)} · ${escapeHTML(Object.entries(event.params || {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(' · ') || 'No parameters')}</span></div><button type="button" class="button small-button" data-analysis-jump="${event.index}">Show in raw events</button></div>`).join('')}</div>
      ${occurrences.length > limit ? `<button type="button" class="button small-button" data-analysis-more>Show more occurrences (${number(occurrences.length - limit)} left)</button>` : ''}</section>`;
  };
  const draw = () => {
    const suffix = failure ? ' · incomplete: timeline loading failed' : complete ? '' : ' · loading remaining events; counts are partial';
    container.querySelector('.analysis-totals').textContent = `${number(data.total)} calls · ${number(data.groups.length)} unique events · ${number(data.levels)} unique mapped levels${suffix}`;
    container.querySelector('[data-analysis-error]').innerHTML = failure ? `<p class="error" role="alert">${escapeHTML(failure)}</p><button type="button" class="button small-button" data-retry-story>Retry loading events</button>` : '';
    const groups = data.groups.filter(group => group.name.toLowerCase().includes(search.value.trim().toLowerCase()));
    container.querySelector('[data-analysis-events]').innerHTML = groups.length ? `<div class="table-wrap"><table class="event-analysis-table"><thead><tr><th>Event</th><th class="num">Calls</th><th class="num">Sessions</th><th>First / last call</th></tr></thead><tbody>${groups.map(group => `<tr><td><button type="button" class="event-analysis-name" data-analysis-event="${escapeHTML(group.name)}" aria-expanded="${selected === group.name}">${escapeHTML(group.name)}</button></td><td class="num">${number(group.items.length)}</td><td class="num">${number(group.sessions.size)}</td><td class="small muted">${analysisDate(group.items[0].client_ts, timezone)}<br>${analysisDate(group.items.at(-1).client_ts, timezone)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="help">${search.value ? 'No event names match your search.' : complete ? 'No events in this session and date range.' : 'Loading events…'}</p>`;
    drawDetail();
  };
  search.addEventListener('input', draw);
  container.addEventListener('change', event => {
    if (event.target.matches('[data-analysis-parameter]')) {parameter = event.target.value; limit = 50; valueLimit = 20; drawDetail(); detail.querySelector('[data-analysis-parameter]')?.focus();}
  });
  container.addEventListener('click', event => {
    const pick = event.target.closest('[data-analysis-event]');
    if (pick) {selected = selected === pick.dataset.analysisEvent ? null : pick.dataset.analysisEvent; parameter = ''; filters.clear(); limit = 50; valueLimit = 20; draw(); detail.querySelector('h3')?.scrollIntoView({block: 'nearest'});}
    if (event.target.closest('[data-analysis-close]')) {selected = null; draw();}
    const value = event.target.closest('[data-analysis-value]');
    if (value) {
      const values = analysisParameterValues(selectedGroup().items, filters, parameter);
      const chosen = values[Number(value.dataset.analysisValue)];
      if (filters.get(parameter)?.token === chosen.token) filters.delete(parameter);
      else filters.set(parameter, chosen);
      limit = 50; drawDetail(); detail.querySelector(`[data-analysis-value="${value.dataset.analysisValue}"]`)?.focus();
    }
    if (event.target.closest('[data-analysis-clear]')) {filters.clear(); limit = 50; drawDetail();}
    const removeFilter = event.target.closest('[data-analysis-remove-filter]');
    if (removeFilter) {filters.delete(removeFilter.dataset.analysisRemoveFilter); limit = 50; drawDetail();}
    if (event.target.closest('[data-analysis-more]')) {limit += 50; drawDetail();}
    if (event.target.closest('[data-analysis-values-more]')) {valueLimit += 20; drawDetail();}
    const jump = event.target.closest('[data-analysis-jump]');
    if (jump) onJump(Number(jump.dataset.analysisJump));
    if (event.target.closest('[data-analysis-highlight]')) {
      const group = selectedGroup();
      const details = [...filters].map(([key, value]) => `${key} = ${value.value}`).join(' · ');
      onHighlight({label: `${group.name}${details ? ` · ${details}` : ''}`.slice(0, 80), color: 'gold', enabled: true,
        conditions: conditionGroup([eventCondition(group.name), ...[...filters].map(([key, value]) => ({...paramCondition(key), value: String(value.value)}))])});
    }
  });
  return {update(events, session, done, error = '') {data = playerEventAnalysis(events, session); complete = done; failure = error; draw();}};
}

function mountHighlightLibrary({container, game, onUse, onSaved}) {
  let rules = []; let loaded = false; let busy = false; let selected = ''; let confirmDelete = false; let message = '';
  const base = `${gameURL(game)}/insights/highlights`;
  const draw = () => {
    if (!container.isConnected) return;
    container.innerHTML = `<div class="highlight-library-head"><strong>Saved rules</strong><button type="button" class="button small-button" data-library-load ${busy ? 'disabled' : ''}>${busy ? 'Working…' : loaded ? 'Refresh saved rules' : 'Browse saved rules'}</button></div><p class="help">Save a named rule below, then reuse it for any player. Saved rules belong to this game and are shared with its team. Your active selections stay in this browser.</p>
      ${loaded ? `<div class="highlight-library-controls"><label>Choose a saved rule<select data-library-select ${busy ? 'disabled' : ''}><option value="">Choose a rule…</option>${rules.map(rule => `<option value="${escapeHTML(rule.id)}" ${selected === rule.id ? 'selected' : ''}>${escapeHTML(rule.name)}</option>`).join('')}</select></label><button type="button" class="button small-button" data-library-use ${busy || !selected ? 'disabled' : ''}>Use rule</button><button type="button" class="button small-button" data-library-delete ${busy || !selected ? 'disabled' : ''}>${confirmDelete ? 'Confirm delete saved rule' : 'Delete saved rule'}</button></div>${!rules.length ? '<p class="help">No saved rules yet. Create a highlight and choose Save rule.</p>' : ''}` : ''}<p class="small muted" role="status">${escapeHTML(message)}</p>`;
  };
  const reload = async () => {rules = await request(base); loaded = true; if (!rules.some(rule => rule.id === selected)) selected = '';};
  container.addEventListener('change', event => {if (event.target.matches('[data-library-select]')) {selected = event.target.value; confirmDelete = false; draw();}});
  container.addEventListener('click', async event => {
    if (busy) return;
    if (event.target.closest('[data-library-use]')) {
      const rule = rules.find(rule => rule.id === selected);
      if (rule) onUse({label: rule.name, color: rule.color, enabled: true, savedId: rule.id, conditions: structuredClone(rule.conditions)});
      return;
    }
    const remove = event.target.closest('[data-library-delete]');
    if (remove && !confirmDelete) {confirmDelete = true; draw(); return;}
    if (!remove && !event.target.closest('[data-library-load]')) return;
    busy = true; message = ''; draw();
    try {if (remove) {await api(`${base}/${selected}`, {method: 'DELETE'}); confirmDelete = false; message = 'Saved rule deleted. Active highlights are unchanged.';} await reload();}
    catch (error) {message = error.message;}
    finally {busy = false; draw();}
  });
  draw();
  return {async save(rule, asCopy = false) {
    if (busy) {toast('Wait for the current saved-rule request to finish.'); return;}
    const error = conditionError(rule.conditions);
    if (error || !rule.label.trim()) {toast(error || 'Give this highlight a name first.'); return;}
    busy = true; message = 'Saving rule…'; draw();
    try {
      const id = asCopy ? null : rule.savedId;
      const saved = await api(id ? `${base}/${id}` : base, {method: id ? 'PUT' : 'POST', body: JSON.stringify({name: rule.label.trim(), color: rule.color, conditions: rule.conditions})});
      rule.savedId = saved.id; onSaved();
      message = `Saved “${saved.name}”.`; selected = saved.id; toast(message);
      await reload();
    } catch (error) {message = error.message; toastError(error);}
    finally {busy = false; draw();}
  }};
}
