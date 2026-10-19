// The Event setup page: the three steps that get a game's events understood by the dashboards.
//  1. Install the AVN standard with an AI agent.   2. Fill the event dictionary from the code.
//  3. Map events to the moments the dashboards use.
// Loaded after events.js (mapping helpers) and dictionary-import.js (steps 1 and 2).

const SETUP_STEPS = [
  ['install', 'Install the standard', 'An AI agent adds the AVN events to your game, with the same names and parameters in every game.'],
  ['fill', 'Fill the dictionary', 'An AI agent reads your game’s code and writes what each event and parameter means. You review every text.'],
  ['mappings', 'Map your events', 'Tell Retention, Levels, player stories and journeys which events are a session start or a level moment.'],
];
// Steps 1 and 2 are panels; step 3 holds panels of its own, so it only gets a heading.
const setupStep = ([key, title, text], number, extra = '') => {
  const head = `<span class="step-number" aria-hidden="true">${number}</span><div><h2 id="step-${key}-title">${title}</h2><p>${text}</p></div>${extra}`;
  return key === 'mappings'
    ? `<section class="setup-flat section-spacing" id="${key}" aria-labelledby="step-${key}-title"><div class="setup-head">${head}</div><div id="step-${key}-body"></div></section>`
    : `<section class="panel setup-step section-spacing" id="${key}" aria-labelledby="step-${key}-title"><div class="panel-header">${head}</div><div class="panel-body" id="step-${key}-body"></div></section>`;
};

async function renderEventSetup() {
  const game = currentGame;
  shell('Event setup', heading('Event setup', 'Get your game’s events into the dashboards in three steps.', `<div class="heading-actions"><a class="button" href="${gamePath(game, 'dictionary')}">${icon('book', 15)} Event dictionary</a></div>`) +
    `<nav class="setup-jump" aria-label="Steps">${SETUP_STEPS.map(([key, title], index) => `<a href="#${key}"><span class="step-number" aria-hidden="true">${index + 1}</span>${title}</a>`).join('')}</nav>` +
    SETUP_STEPS.map((step, index) => setupStep(step, index + 1, step[0] === 'mappings' ? '<span class="pill" id="mappings-status" hidden></span>' : '')).join(''));
  // Steps 1 and 2 fold away once done, and the page remembers it.
  for (const [key] of SETUP_STEPS.slice(0, 2)) collapsible(document.querySelector(`#${key}`), game, `setup-${key}`);
  mountStandardInstall(document.querySelector('#step-install-body'));
  const load = await mountMappings(document.querySelector('#step-mappings-body'), game);
  mountDictionaryFill(document.querySelector('#step-fill-body'), game, load);
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView({block: 'start'});
}

async function mountMappings(body, game) {
  const wanted = new URLSearchParams(location.search);
  let version = wanted.get('version') || '';
  let data = null; let forms = new Map();
  const rulesOf = name => data.definitions[name] || [];
  const save = async (name, rules) => { await api(`${gameURL(game)}/dictionary/${encodeURIComponent(name)}/mappings`, {method: 'PUT', body: JSON.stringify({canonical: rules})}); cache.clear(); await load(); };
  const how = source => source.via === 'mapped' ? `<span class="pill good">You mapped it</span> <span class="small muted">${escapeHTML(ruleText(source.rule))}</span>` : '<span class="pill">Understood automatically</span>';
  const levelsText = levels => levels ? `levels ${number(levels.min)}–${number(levels.max)} <span class="muted small">(${number(levels.count)} different)</span>` : '';
  const sourceRow = (concept, source) => `<tr><td><a class="row-title" href="${gamePath(game, 'dictionary')}?${new URLSearchParams({event: source.event})}"><code>${escapeHTML(source.event)}</code></a></td><td>${how(source)}</td><td class="num">${number(source.events)}</td><td class="num">${number(source.players)}</td><td class="small">${concept.needs ? levelsText(source.levels) || '<span class="pill bad">no level number found</span>' : ''}</td><td class="num">${source.via === 'mapped' ? `<button type="button" class="button" data-remove-rule="${escapeHTML(source.event)}" data-rule="${escapeHTML(JSON.stringify(source.rule))}">Remove</button>` : ''}</td></tr>`;
  const card = concept => {
    const status = concept.status === 'mapped' ? '<span class="pill good">Mapped</span>' : concept.status === 'auto' ? '<span class="pill good">Understood automatically</span>' : '<span class="pill bad">Not found</span>';
    return `<section class="panel mapping-card section-spacing" data-concept="${concept.key}"><div class="panel-header"><div><h2>${escapeHTML(concept.label)} ${status}</h2><p>${escapeHTML(concept.summary)} Used by ${concept.used_by.join(', ')}.</p></div><button type="button" class="button" data-add-mapping="${concept.key}">${icon('link', 14)} Add a mapping…</button></div>
      <div class="panel-body">${concept.sources.length ? `<div class="table-wrap"><table class="compact-table"><thead><tr><th>Event</th><th>How</th><th class="num">Events</th><th class="num">Players</th><th>${concept.needs ? 'Level numbers' : '<span class="sr-only">Level numbers</span>'}</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${concept.sources.map(source => sourceRow(concept, source)).join('')}</tbody></table></div>` : `<p class="help">Nothing in your data is understood as “${escapeHTML(concept.label.toLowerCase())}” yet. If your game sends it under another name, add a mapping.</p>`}
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
    const pill = document.querySelector('#mappings-status');
    if (pill) { pill.hidden = false; pill.className = `pill ${missing ? 'bad' : 'good'}`; pill.textContent = missing ? `${number(missing)} not found` : 'All covered'; }
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
  return load;
}
