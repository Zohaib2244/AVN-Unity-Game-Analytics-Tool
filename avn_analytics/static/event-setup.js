// The Event setup page: three independent tabs, open any of them in any order.
//  Add AVN Events (an AI agent adds the AVN events, and custom events can join the standard), Fill
//  Dictionary (an AI agent describes the events from the code), Mappings (which events stand for the
//  moments the dashboards use).
// Loaded after events.js (mapping helpers) and dictionary-import.js (the two AI agent tabs).

const SETUP_TABS = [
  ['install', 'Add AVN Events', 'export'],
  ['fill', 'Fill Dictionary', 'edit'],
  ['mappings', 'Mappings', 'link'],
];

async function renderEventSetup() {
  const game = currentGame;
  const tabKey = `avn-setup-tab-${game.id}`;
  const query = new URLSearchParams(location.search);
  const keys = SETUP_TABS.map(([key]) => key);
  const fromAddress = keys.includes(location.hash.slice(1)) ? location.hash.slice(1) : ['event', 'concept', 'version'].some(name => query.has(name)) ? 'mappings' : '';
  let active = fromAddress || (keys.includes(storeGet(tabKey)) ? storeGet(tabKey) : 'install');
  shell('Event setup', heading('Event setup', '', `<div class="heading-actions"><a class="button" href="${gamePath(game, 'dictionary')}">${icon('book', 15)} Event dictionary</a></div>`) +
    `<div class="setup-tabs" role="tablist" aria-label="Event setup">${SETUP_TABS.map(([key, title, symbol]) => `<button type="button" class="setup-tab" role="tab" id="tab-${key}" data-setup-tab="${key}" aria-controls="panel-${key}">${icon(symbol, 16)}<span>${title}</span>${key === 'mappings' ? '<span class="pill" id="mappings-status" hidden></span>' : ''}</button>`).join('')}</div>` +
    SETUP_TABS.map(([key]) => `<section class="setup-panel ${key === 'mappings' ? '' : 'panel'}" role="tabpanel" id="panel-${key}" aria-labelledby="tab-${key}"><div id="step-${key}-body" class="${key === 'mappings' ? '' : 'panel-body'}"></div></section>`).join(''));
  const show = (key, remember = true) => {
    active = key;
    document.querySelectorAll('[data-setup-tab]').forEach(tab => { const on = tab.dataset.setupTab === key; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; });
    SETUP_TABS.forEach(([name]) => { document.querySelector(`#panel-${name}`).hidden = name !== key; });
    if (remember) storeSet(tabKey, key);
    history.replaceState(null, '', `${location.pathname}${location.search}#${key}`);
  };
  const bar = document.querySelector('.setup-tabs');
  bar.addEventListener('click', event => { const tab = event.target.closest('[data-setup-tab]'); if (tab) show(tab.dataset.setupTab); });
  bar.addEventListener('keydown', event => {
    const step = {ArrowRight: 1, ArrowLeft: -1}[event.key]; if (!step) return;
    event.preventDefault();
    const next = keys[(keys.indexOf(active) + step + keys.length) % keys.length];
    show(next); document.querySelector(`#tab-${next}`).focus();
  });
  show(active, false);
  mountStandardInstall(document.querySelector('#step-install-body'));
  const load = await mountMappings(document.querySelector('#step-mappings-body'), game);
  mountDictionaryFill(document.querySelector('#step-fill-body'), game, load);
}

async function mountMappings(body, game) {
  const wanted = new URLSearchParams(location.search);
  let version = wanted.get('version') || '';
  let data = null; let forms = new Map();
  const rulesOf = name => data.definitions[name] || [];
  const save = async (name, rules) => { await api(`${gameURL(game)}/dictionary/${encodeURIComponent(name)}/mappings`, {method: 'PUT', body: JSON.stringify({canonical: rules})}); cache.clear(); await load(); };
  const removeButton = (event, rule) => `<button type="button" class="icon-button" data-remove-rule="${escapeHTML(event)}" data-rule="${escapeHTML(JSON.stringify(rule))}" aria-label="Remove mapping of ${escapeHTML(event)}" title="Remove mapping">${icon('close', 14)}</button>`;
  const levelsText = levels => levels ? `levels ${number(levels.min)}–${number(levels.max)}` : '';
  const sourceLine = (concept, source) => `<li class="mapping-source"><a class="row-title" href="${gamePath(game, 'dictionary')}?${new URLSearchParams({event: source.event})}"><code>${escapeHTML(source.event)}</code></a>${source.via === 'mapped' ? `<span class="small muted">${escapeHTML(ruleText(source.rule))}</span>` : ''}<span class="small muted">${number(source.events)} events · ${number(source.players)} players${concept.needs && levelsText(source.levels) ? ` · ${levelsText(source.levels)}` : ''}</span>${concept.needs && !source.levels ? '<span class="pill bad">No level number</span>' : ''}${source.via === 'mapped' ? removeButton(source.event, source.rule) : ''}</li>`;
  const row = concept => {
    const status = concept.status === 'mapped' ? '<span class="pill good">Mapped</span>' : concept.status === 'auto' ? '<span class="pill good">Auto</span>' : '<span class="pill bad">Not found</span>';
    const silent = concept.silent_rules.map(item => `<li class="mapping-source"><code>${escapeHTML(item.event)}</code><span class="small muted">${escapeHTML(ruleText(item.rule))}</span><span class="pill">No matches</span>${removeButton(item.event, item.rule)}</li>`).join('');
    return `<div class="mapping-row" data-concept="${concept.key}"><div class="mapping-name"><strong title="Used by ${escapeHTML(concept.used_by.join(', '))}">${escapeHTML(concept.label)}</strong>${status}</div>
      <ul class="mapping-sources">${concept.sources.map(source => sourceLine(concept, source)).join('')}${silent}</ul>
      <button type="button" class="button" data-add-mapping="${concept.key}">${icon('plus', 14)} Add</button>
      <div class="mapping-form-slot" data-form-slot="${concept.key}"></div></div>`;
  };
  const draw = () => {
    const concepts = data.concepts;
    const mapped = concepts.filter(concept => concept.status === 'mapped').length; const auto = concepts.filter(concept => concept.status === 'auto').length; const missing = concepts.filter(concept => concept.status === 'missing').length;
    const chosenEvent = data.events.find(item => item.name === wanted.get('event'));
    const asking = chosenEvent ? `<section class="panel section-spacing mapping-ask"><div class="panel-body"><p>What does <code>${escapeHTML(chosenEvent.name)}</code> stand for?${rulesOf(chosenEvent.name).length ? ` <span class="muted small">Already: ${rulesOf(chosenEvent.name).map(rule => escapeHTML(conceptName(rule.action))).join(', ')}.</span>` : ''}</p><div class="quiet-actions">${concepts.map(concept => `<button type="button" class="button" data-add-mapping="${concept.key}">${escapeHTML(concept.label)}</button>`).join('')}</div></div></section>` : '';
    const versions = [...new Set([...data.versions, version].filter(Boolean))];
    const suggestions = data.events.flatMap(item => item.suggestions.filter(rule => !rulesOf(item.name).some(existing => JSON.stringify(existing) === JSON.stringify(rule))).map(rule => ({event: item.name, rule})));
    const covered = mapped + auto;
    body.innerHTML = `<div class="mapping-bar"><div class="mapping-progress"><span><strong>${number(covered)} of ${number(concepts.length)}</strong> moments covered</span><progress class="mapping-meter" max="${concepts.length}" value="${covered}" aria-label="Moments covered"></progress></div>
      <div class="inline-field"><label for="mapping-version">App version</label><select id="mapping-version"><option value="">All versions</option>${versions.map(item => `<option value="${escapeHTML(item)}" ${item === version ? 'selected' : ''}>${escapeHTML(item)}</option>`).join('')}</select></div></div>
      ${data.conflicts.length ? `<div class="notice-banner" role="alert">${icon('pulse', 18)}<div><strong>Overlapping mappings.</strong> ${data.conflicts.map(item => `${escapeHTML(item.event)}: ${number(item.events)} events count as more than one level action`).join('; ')}. Add a condition such as <code>STATE = Completed</code>, or remove the broad rule.</div></div>` : ''}${asking}
      <section class="panel mapping-list">${concepts.map(row).join('')}</section>
      ${suggestions.length ? `<section class="panel section-spacing"><div class="panel-header"><div><h2>${icon('sparkle', 16)} Suggested <span class="count">${number(suggestions.length)}</span></h2></div></div><div class="panel-body mapping-suggestions">${suggestions.map(item => `<div><code>${escapeHTML(item.event)}</code><span>${escapeHTML(conceptName(item.rule.action))} · ${escapeHTML(ruleText(item.rule))}</span><button type="button" class="button" data-suggest-event="${escapeHTML(item.event)}" data-suggest-rule="${escapeHTML(JSON.stringify(item.rule))}">Review</button></div>`).join('')}</div></section>` : ''}
      ${data.other.length ? `<details class="mapping-how"><summary>Other mappings (${number(data.other.length)})</summary><table class="compact-table"><tbody>${data.other.map(item => `<tr><td><code>${escapeHTML(item.event)}</code></td><td><code>${escapeHTML(item.rule.action)}</code> <span class="small muted">${escapeHTML(ruleText(item.rule))}</span></td><td class="num">${removeButton(item.event, item.rule)}</td></tr>`).join('')}</tbody></table></details>` : ''}
      <details class="mapping-how"><summary>Standard event format</summary><div><p>Send one event per moment: <code>level_started</code>, <code>level_completed</code>, <code>level_failed</code> or <code>level_restarted</code>, with <code>{"level": 3}</code>. Also recognised: <code>LEVEL_ANALYSIS</code> with <code>{"Started": 3}</code>, <code>{"action": "started", "level": 3}</code> and <code>{"STATE": "Started", "NUMBER": 3}</code>.</p></div></details>`;
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
