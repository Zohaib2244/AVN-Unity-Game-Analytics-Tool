// The two AI agent steps of the Event setup page. Each is mounted into a container of that page.
//  - mountStandardInstall: install the AVN events standard in a game.
//  - mountDictionaryFill: fill the event dictionary from the game's code (prepare a file and a
//    prompt, upload the filled file, review what it would change, apply it, undo it later).
// Loaded before event-setup.js and app.js.

const IMPORT_DEFAULTS = {
  mode: 'fill_blanks', fields: ['description', 'params'],
  scope: {events: 'undocumented', names: [], prefixes: [], seen_within_days: null, include_not_yet_received: true, include_hidden: false},
  style: {language: 'English', tone: 'concise', max_description_chars: 200, game_context: '', param_values: false},
  code: {include_paths: [], exclude_paths: [], call_patterns: []},
  min_confidence: 'inferred', require_source: true, status: 'draft', max_overwrites: 25, near_duplicates: 'warn', type_conflicts: 'flag',
};
const IMPORT_REASONS = {
  no_proposal: 'Nothing proposed', unknown_confidence: 'The agent was not sure', low_confidence: 'Below the confidence you asked for',
  no_source: 'No source given', already_described: 'Already has text (kept)', written_by_a_person: 'Written by a person (kept)',
  unchanged: 'Same as now', field_not_allowed: 'Not part of this import', too_long: 'Longer than the limit',
  too_many_params: 'Too many parameters', near_duplicate: 'Name looks like an existing event', sdk_event: 'Built-in event',
  hidden: 'Hidden event', not_yet_received: 'Not received yet', not_seen_recently: 'Not sent recently', not_listed: 'Not in your list',
  already_documented: 'Already documented',
};
const IMPORT_FLAGS = {
  near_duplicate: flag => `Similar to ${flag.similar.join(', ')}`,
  type_conflict: flag => `${flag.field.replace('param:', '')} is sent as ${flag.types.join(' and ')}`,
  type_mismatch: flag => `${flag.field.replace('param:', '')}: code says ${flag.code}, data says ${flag.observed.join('/')}`,
  changed_since_template: () => 'Changed since this file was prepared',
};
// A short left-to-right row of what to do, each with an icon.
const flow = items => `<ol class="setup-flow">${items.map(([symbol, text]) => `<li>${icon(symbol, 16)}<span>${text}</span></li>`).join('')}</ol>`;
const importList = value => String(value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);
const importField = field => field === 'description' ? 'description' : field.replace('param:', 'parameter ');
const importMerge = (base, saved) => {
  const out = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(saved || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object') Object.assign(out[key], value);
    else if (key in out) out[key] = value;
  }
  return out;
};

function mountDictionaryFill(root, game, done) {
  const storeKey = `avn-import-options-${game.id}`;
  let options = importMerge(IMPORT_DEFAULTS, storeGet(storeKey));
  let tab = 'prepare';
  let prepared = null;      // {file, prompt}
  let uploaded = null;      // the parsed file the person chose
  let preview = null;       // the last dry run
  let override = null;      // reviewer's changes to the file's own options
  const url = `${gameURL(game)}/dictionary`;

  const draw = () => {
    root.innerHTML = `<div class="segmented" role="group" aria-label="Import step">${[['prepare', 'Prepare', 'file'], ['upload', 'Upload and review', 'export'], ['history', 'History', 'refresh']].map(([key, label, symbol]) => `<button type="button" data-import-tab="${key}" aria-pressed="${tab === key}">${icon(symbol, 15)} ${label}</button>`).join('')}</div>
      <div class="import-body" id="import-body"></div>`;
    root.querySelector('#import-body').innerHTML = tab === 'prepare' ? prepareHTML() : tab === 'upload' ? uploadHTML() : skeleton('table', 4, 4);
    if (tab === 'history') drawHistory();
    if (tab === 'prepare') bindPrepare();
    if (tab === 'upload') bindUpload();
  };
  const onTab = event => {
    const next = event.target.closest('[data-import-tab]')?.dataset.importTab;
    if (next && next !== tab) { tab = next; draw(); }
  };
  root.addEventListener('click', onTab);

  // ---- 1 · prepare
  const select = (name, value, choices) => `<select name="${name}">${choices.map(([key, label]) => `<option value="${key}" ${String(value) === String(key) ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  const check = (name, value, label) => `<label class="check-row"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}> ${label}</label>`;
  function prepareHTML() {
    const o = options;
    const listed = [...o.scope.names, ...o.scope.prefixes.map(prefix => `${prefix}*`)].join('\n');
    const choice = o.scope.events === 'undocumented' && o.mode === 'fill_blanks' ? 'missing' : o.scope.events === 'all' && o.mode === 'overwrite_all' ? 'all' : '';
    const card = (value, title, text) => `<label class="import-choice"><input type="radio" name="coverage" value="${value}" ${choice === value ? 'checked' : ''}><span><strong>${title}</strong><small>${text}</small></span></label>`;
    return `<form id="import-prepare" class="import-form">
        <div class="import-choices" role="radiogroup" aria-label="What should the agent cover?">
          ${card('missing', 'Missing only', 'Only what has no description yet')}
          ${card('all', 'All events', 'Re-check everything, you approve each change')}
        </div>
        ${choice ? '' : '<p class="help">Custom coverage is set under Advanced settings.</p>'}
        <details class="import-advanced"><summary>Advanced settings</summary>
        <fieldset><legend>What may change</legend>
          <div class="field"><label>When a field already has text</label>${select('mode', o.mode, [['fill_blanks', 'Only fill blanks (keep all existing text)'], ['overwrite_ai_drafts', 'Also replace earlier AI drafts nobody confirmed'], ['overwrite_all', 'Replace existing text']])}</div>
          ${check('field-description', o.fields.includes('description'), 'Event descriptions')}
          ${check('field-params', o.fields.includes('params'), 'Parameter descriptions')}
          <p class="help">Story rules, hidden events and mappings are never touched by an import, and an import never deletes anything.</p>
        </fieldset>
        <fieldset><legend>Which events</legend>
          <div class="field"><label>Cover</label>${select('events', o.scope.events, [['undocumented', 'Events that still need a description'], ['all', 'All events'], ['listed', 'Only the events I list']])}</div>
          <div class="field"><label for="import-names">Events to list <span class="muted">(one per line; end with * for a prefix)</span></label><textarea id="import-names" name="names" rows="2">${escapeHTML(listed)}</textarea></div>
          <div class="field-row"><div class="field"><label for="import-days">Only events sent in the last N days</label><input id="import-days" name="seen_within_days" type="number" min="1" max="3650" value="${o.scope.seen_within_days ?? ''}" placeholder="any time"></div></div>
          ${check('include_not_yet_received', o.scope.include_not_yet_received, 'Also add events found in the code that were never received')}
          ${check('include_hidden', o.scope.include_hidden, 'Include events hidden from stories')}
        </fieldset>
        <fieldset><legend>How to write</legend>
          <div class="field-row"><div class="field"><label for="import-language">Language</label><input id="import-language" name="language" maxlength="40" value="${escapeHTML(o.style.language)}"></div><div class="field"><label>Length</label>${select('tone', o.style.tone, [['one_sentence', 'One short sentence'], ['concise', 'Concise'], ['detailed', 'Detailed']])}</div></div>
          <div class="field-row"><div class="field"><label for="import-max">Longest description (characters)</label><input id="import-max" name="max_description_chars" type="number" min="20" max="4000" value="${o.style.max_description_chars}"></div><div class="field"><label>Minimum confidence</label>${select('min_confidence', o.min_confidence, [['inferred', 'Inferred or certain'], ['certain', 'Certain only']])}</div></div>
          <div class="field"><label for="import-context">About the game <span class="muted">(terms and what the game is, so nothing is guessed)</span></label><textarea id="import-context" name="game_context" rows="2" maxlength="2000">${escapeHTML(o.style.game_context)}</textarea></div>
          ${check('param_values', o.style.param_values, 'List the values a parameter can take')}
        </fieldset>
        <fieldset><legend>Where to look in the code</legend>
          <div class="field"><label for="import-include">Only look in <span class="muted">(folders, one per line)</span></label><textarea id="import-include" name="include_paths" rows="2">${escapeHTML(o.code.include_paths.join('\n'))}</textarea></div>
          <div class="field"><label for="import-exclude">Skip <span class="muted">(folders, one per line)</span></label><textarea id="import-exclude" name="exclude_paths" rows="2">${escapeHTML(o.code.exclude_paths.join('\n'))}</textarea></div>
          <div class="field"><label for="import-patterns">Your own wrappers around LogEvent <span class="muted">(one per line, e.g. <code>Analytics.Track(</code>)</span></label><textarea id="import-patterns" name="call_patterns" rows="2">${escapeHTML(o.code.call_patterns.join('\n'))}</textarea></div>
        </fieldset>
        <fieldset><legend>Safety</legend>
          ${check('require_source', o.require_source, 'Ignore text that names no place in the code')}
          <div class="field-row"><div class="field"><label>Imported text is</label>${select('status', o.status, [['draft', 'A draft until someone confirms it'], ['confirmed', 'Confirmed straight away']])}</div><div class="field"><label for="import-overwrites">Refuse to replace more than</label><input id="import-overwrites" name="max_overwrites" type="number" min="0" max="100000" value="${o.max_overwrites}"></div></div>
          <div class="field-row"><div class="field"><label>Names that look like an existing event</label>${select('near_duplicates', o.near_duplicates, [['warn', 'Warn'], ['reject', 'Reject']])}</div><div class="field">${check('type_conflicts', o.type_conflicts === 'flag', 'Flag parameters whose type disagrees with the data')}</div></div>
        </fieldset>
        </details>
        <div class="error" role="alert"></div>
        <div class="modal-actions"><button type="submit" class="button primary">${icon('sparkle', 15)} Prepare file and prompt</button></div>
      </form>
      <div id="import-prepared">${prepared ? preparedHTML() : ''}</div>`;
  }
  function preparedHTML() {
    const count = Object.keys(prepared.file.events).length;
    return `<section class="import-prepared"><h3 class="event-sub">${number(count)} event${count === 1 ? '' : 's'} in the file</h3>
      ${flow([['export', 'Save <code>avn-events.json</code> in your game'], ['sparkle', 'Run the prompt in your AI agent'], ['file', 'Upload the filled file']])}
      <div class="modal-actions import-actions"><button type="button" class="button" data-import-download>${icon('export', 14)} Download avn-events.json</button><button type="button" class="button" data-import-copy>${icon('copy', 14)} Copy the prompt</button><button type="button" class="button primary" data-import-tab="upload">Upload the filled file ${icon('arrow', 14)}</button></div>
      <details class="import-prompt"><summary>Show the prompt</summary><textarea readonly rows="10" aria-label="Agent prompt">${escapeHTML(prepared.prompt)}</textarea></details></section>`;
  }
  const readOptions = form => {
    const data = new FormData(form); const get = name => data.get(name);
    const fields = [get('field-description') ? 'description' : null, get('field-params') ? 'params' : null].filter(Boolean);
    const listed = importList(get('names'));
    return {
      mode: get('mode'), fields: fields.length ? fields : ['description', 'params'],
      scope: {events: get('events'), names: listed.filter(item => !item.endsWith('*')), prefixes: listed.filter(item => item.endsWith('*') && item.length > 1).map(item => item.slice(0, -1)),
        seen_within_days: get('seen_within_days') ? Number(get('seen_within_days')) : null, include_not_yet_received: Boolean(get('include_not_yet_received')), include_hidden: Boolean(get('include_hidden'))},
      style: {language: String(get('language') || 'English').trim() || 'English', tone: get('tone'), max_description_chars: Number(get('max_description_chars')) || 200, game_context: String(get('game_context') || '').trim(), param_values: Boolean(get('param_values'))},
      code: {include_paths: importList(get('include_paths')), exclude_paths: importList(get('exclude_paths')), call_patterns: importList(get('call_patterns'))},
      min_confidence: get('min_confidence'), require_source: Boolean(get('require_source')), status: get('status'),
      max_overwrites: Math.max(0, Number(get('max_overwrites')) || 0), near_duplicates: get('near_duplicates'), type_conflicts: get('type_conflicts') ? 'flag' : 'ignore',
    };
  };
  function bindPrepare() {
    const form = root.querySelector('#import-prepare');
    const sync = () => {
      const listed = form.elements.events.value === 'listed';
      form.elements.names.disabled = !listed;
    };
    form.elements.events.addEventListener('change', sync); sync();
    // The two presets set the advanced controls they stand for; those stay editable below.
    form.querySelectorAll('[name="coverage"]').forEach(radio => radio.addEventListener('change', () => {
      const all = radio.value === 'all';
      form.elements.mode.value = all ? 'overwrite_all' : 'fill_blanks';
      form.elements.events.value = all ? 'all' : 'undocumented';
      form.elements.max_overwrites.value = all ? Math.max(500, Number(form.elements.max_overwrites.value) || 0) : 25;
      sync();
    }));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]'); const error = form.querySelector('.error');
      error.textContent = ''; button.disabled = true;
      try {
        options = readOptions(form); storeSet(storeKey, options);
        prepared = await request(`${url}/import/prepare`, {method: 'POST', body: JSON.stringify({options})});
        root.querySelector('#import-prepared').innerHTML = preparedHTML();
        bindPrepared();
      } catch (problem) { error.textContent = problem.message; }
      finally { button.disabled = false; }
    });
    bindPrepared();
  }
  function bindPrepared() {
    const box = root.querySelector('#import-prepared');
    box.querySelector('[data-import-download]')?.addEventListener('click', () => {
      const href = URL.createObjectURL(new Blob([JSON.stringify(prepared.file, null, 2)], {type: 'application/json'}));
      const anchor = Object.assign(document.createElement('a'), {href, download: 'avn-events.json'});
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000);
    });
    box.querySelector('[data-import-copy]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(prepared.prompt); toast('Prompt copied.'); } catch { toast('Open "Show the prompt" and copy it by hand.'); }
    });
  }

  // ---- 2 · upload and review
  // The reviewer ticks the texts to import (client side); nothing is written until one of the
  // approve buttons, which re-reads exactly that selection from the server first.
  const textKey = change => `${change.name}/${change.field}`;
  const allChanges = () => preview ? preview.events.flatMap(entry => entry.changes) : [];
  const selected = new Set();
  function uploadHTML() {
    return `<div class="field"><label for="import-file">Filled <code>avn-events.json</code></label><input id="import-file" type="file" accept=".json,application/json"></div>
      <div class="error" role="alert" id="import-error"></div>
      <div id="import-review">${preview ? reviewHTML() : ''}</div>`;
  }
  function bindUpload() {
    root.querySelector('#import-file').addEventListener('change', async event => {
      const file = event.target.files[0]; if (!file) return;
      const error = root.querySelector('#import-error'); error.textContent = '';
      try {
        uploaded = JSON.parse(await file.text()); override = null;
        await runPreview();
      } catch (problem) { uploaded = null; preview = null; root.querySelector('#import-review').innerHTML = ''; error.textContent = problem instanceof SyntaxError ? 'That file is not valid JSON. Ask the agent to fix it, or re-run it.' : problem.message; }
    });
    bindReview();
  }
  const requestBody = extra => ({file: uploaded, ...(override ? {options: override} : {}), exclude: [], ...extra});
  async function runPreview() {
    preview = await request(`${url}/import`, {method: 'POST', body: JSON.stringify(requestBody({}))});
    override = override || preview.options;
    // everything is ticked, except names that only differ from an existing event by case or punctuation
    selected.clear();
    preview.events.forEach(entry => {
      const similar = entry.flags.some(flag => flag.flag === 'near_duplicate');
      if (!similar) entry.changes.forEach(change => selected.add(textKey(change)));
    });
    root.querySelector('#import-review').innerHTML = reviewHTML(); bindReview();
  }
  const changeText = change => `<li><label class="import-text"><input type="checkbox" data-import-text="${escapeHTML(textKey(change))}" ${selected.has(textKey(change)) ? 'checked' : ''} aria-label="Import ${escapeHTML(importField(change.field))} of ${escapeHTML(change.name)}"><span><span class="small muted">${importField(change.field)}</span> ${change.before ? `<del>${escapeHTML(change.before)}</del> → ` : ''}<ins>${escapeHTML(change.after)}</ins>${change.kind === 'fill' ? '' : ` <span class="pill bad">${change.kind === 'overwrite_draft' ? 'replaces a draft' : 'replaces text'}</span>`}</span></label></li>`;
  function reviewHTML() {
    const o = override || preview.options; const total = allChanges().length;
    const rows = preview.events.filter(entry => entry.changes.length || entry.rejected.length || entry.flags.length || entry.status === 'out_of_scope' || entry.skipped.some(item => item.reason !== 'no_proposal'));
    const why = entry => [...entry.skipped, ...entry.rejected].map(item => `${item.field === '*' ? '' : `${importField(item.field)}: `}${IMPORT_REASONS[item.reason] || item.reason}`);
    const extra = [preview.summary.skipped ? `${number(preview.summary.skipped)} events left out by the rules` : '', preview.summary.flags ? `${number(preview.summary.flags)} to look at` : ''].filter(Boolean).join(' · ');
    return `<section class="import-review">
      <div class="import-rules"><span class="small muted">Rules in this file</span> ${select('o-mode', o.mode, [['fill_blanks', 'Only fill blanks'], ['overwrite_ai_drafts', 'Replace AI drafts too'], ['overwrite_all', 'Replace existing text']])} ${select('o-status', o.status, [['draft', 'Land as drafts'], ['confirmed', 'Land as confirmed']])} <label class="inline-field">Max replaced <input name="o-max" type="number" min="0" value="${o.max_overwrites}"></label></div>
      ${preview.blocked ? `<p class="event-warning">${icon('pulse', 15)}<span>${escapeHTML(preview.blocked)}</span></p>` : ''}
      ${preview.unresolved.length ? `<details><summary>${preview.unresolved.length} name${preview.unresolved.length === 1 ? '' : 's'} the agent could not resolve</summary><ul class="import-list">${preview.unresolved.map(item => `<li><code>${escapeHTML(item.source)}</code> ${escapeHTML(item.note)}</li>`).join('')}</ul></details>` : ''}
      ${preview.not_found_in_code.length ? `<details><summary>${preview.not_found_in_code.length} event${preview.not_found_in_code.length === 1 ? '' : 's'} not found in the code</summary><p class="small">${preview.not_found_in_code.map(name => `<code>${escapeHTML(name)}</code>`).join(' ')}</p></details>` : ''}
      ${total ? `<div class="import-approve"><label class="check-row"><input type="checkbox" data-import-all> Select all</label><span class="import-count" data-import-count aria-live="polite"></span><span class="spacer"></span><button type="button" class="button" data-import-selected>Approve selected</button><button type="button" class="button primary" data-import-approve-all ${preview.blocked ? 'disabled' : ''}>Approve all ${number(total)}</button></div>
      ${extra ? `<p class="help">${escapeHTML(extra)}</p>` : ''}
      <div class="table-wrap"><table class="compact-table import-table"><thead><tr><th>Event</th><th>Text the agent wrote</th><th>Notes</th></tr></thead><tbody>${rows.map(entry => `<tr><td>${entry.changes.length ? `<label class="import-text"><input type="checkbox" data-import-event="${escapeHTML(entry.name)}" aria-label="Import all texts of ${escapeHTML(entry.name)}"><code>${escapeHTML(entry.name)}</code></label>` : `<code>${escapeHTML(entry.name)}</code>`}${entry.origin === 'code' ? ' <span class="pill" title="Not received yet; found in the code">new</span>' : ''}</td><td>${entry.changes.length ? `<ul class="import-list">${entry.changes.map(changeText).join('')}</ul>` : '<span class="muted small">—</span>'}</td><td class="small">${[...why(entry).map(text => `<span class="muted">${escapeHTML(text)}</span>`), ...entry.flags.map(flag => `<span class="pill bad">${escapeHTML((IMPORT_FLAGS[flag.flag] || (() => flag.flag))(flag))}</span>`)].join('<br>')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Nothing in this file would change the dictionary.</p>'}
    </section>`;
  }
  function syncSelection(box) {
    const changes = allChanges();
    box.querySelectorAll('[data-import-text]').forEach(input => { input.checked = selected.has(input.dataset.importText); });
    box.querySelectorAll('[data-import-event]').forEach(input => {
      const keys = changes.filter(change => change.name === input.dataset.importEvent).map(textKey);
      const on = keys.filter(key => selected.has(key)).length;
      input.checked = on === keys.length; input.indeterminate = on > 0 && on < keys.length;
    });
    const all = box.querySelector('[data-import-all]');
    if (all) { all.checked = changes.length > 0 && selected.size === changes.length; all.indeterminate = selected.size > 0 && selected.size < changes.length; }
    const count = box.querySelector('[data-import-count]');
    if (count) count.textContent = `${number(selected.size)} of ${number(changes.length)} texts selected`;
    const picked = box.querySelector('[data-import-selected]');
    if (picked) { picked.disabled = selected.size === 0 || selected.size === changes.length; picked.textContent = `Approve selected${selected.size && selected.size < changes.length ? ` ${number(selected.size)}` : ''}`; }
  }
  // Re-reads exactly the chosen texts from the server, checks they are what was shown, then applies.
  async function approve(keys, button) {
    const error = root.querySelector('#import-error'); error.textContent = '';
    const buttons = root.querySelectorAll('[data-import-selected],[data-import-approve-all]');
    const label = button.textContent; buttons.forEach(item => { item.disabled = true; }); button.textContent = 'Importing…';
    try {
      const left = allChanges().filter(change => !keys.has(textKey(change))).map(textKey);
      const check = await request(`${url}/import`, {method: 'POST', body: JSON.stringify(requestBody({exclude: left}))});
      const shown = new Map(allChanges().map(change => [textKey(change), change]));
      const changed = check.changes.length !== keys.size || check.changes.some(change => { const was = shown.get(textKey(change)); return !was || was.before !== change.before || was.after !== change.after; });
      if (changed) { await runPreview(); error.textContent = 'The dictionary changed while you were reviewing, so nothing was saved. The review is up to date; check it and approve again.'; return; }
      if (check.blocked) { error.textContent = check.blocked; return; }
      const result = await api(`${url}/import`, {method: 'POST', body: JSON.stringify(requestBody({exclude: left, preview: check.preview}))});
      const count = result.summary.fields_changed;
      toast(`Imported ${count} text${count === 1 ? '' : 's'}${override?.status === 'confirmed' ? '.' : '. They are drafts until someone confirms them.'}`);
      preview = null; uploaded = null; selected.clear(); tab = 'history'; draw();
      done?.();
    } catch (problem) { error.textContent = problem.message; }
    finally { button.textContent = label; if (root.contains(button)) syncSelection(root.querySelector('#import-review')); }
  }
  function bindReview() {
    const box = root.querySelector('#import-review'); if (!box || !preview) return;
    const error = root.querySelector('#import-error');
    syncSelection(box);
    const toggle = (keys, on) => { keys.forEach(key => on ? selected.add(key) : selected.delete(key)); syncSelection(box); };
    box.addEventListener('change', event => {
      const text = event.target.closest('[data-import-text]'); const whole = event.target.closest('[data-import-event]'); const all = event.target.closest('[data-import-all]');
      if (text) toggle([text.dataset.importText], text.checked);
      else if (whole) toggle(allChanges().filter(change => change.name === whole.dataset.importEvent).map(textKey), whole.checked);
      else if (all) toggle(allChanges().map(textKey), all.checked);
    });
    const rerun = async () => { try { error.textContent = ''; await runPreview(); } catch (problem) { error.textContent = problem.message; } };
    const rules = () => {
      const current = override || preview.options;
      override = {...current, mode: box.querySelector('[name="o-mode"]').value, status: box.querySelector('[name="o-status"]').value, max_overwrites: Math.max(0, Number(box.querySelector('[name="o-max"]').value) || 0)};
      rerun();
    };
    box.querySelectorAll('[name="o-mode"],[name="o-status"],[name="o-max"]').forEach(input => input.addEventListener('change', rules));
    box.querySelector('[data-import-approve-all]')?.addEventListener('click', event => approve(new Set(allChanges().map(textKey)), event.currentTarget));
    box.querySelector('[data-import-selected]')?.addEventListener('click', event => approve(new Set(selected), event.currentTarget));
  }

  // ---- history
  async function drawHistory() {
    const box = root.querySelector('#import-body');
    try {
      const list = await request(`${url}/imports`);
      box.innerHTML = list.length ? `<div class="table-wrap"><table class="compact-table"><thead><tr><th>When</th><th>Who</th><th>Texts</th><th>Rules</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${list.map(item => `<tr><td class="small">${escapeHTML(displayDate(item.created_at))}</td><td class="small">${escapeHTML(item.actor)}</td><td class="num">${number(item.summary.fields_changed)}</td><td class="small muted">${escapeHTML(item.options.mode.replace(/_/g, ' '))} · ${escapeHTML(item.options.status)}</td><td>${item.undone_at ? '<span class="pill">Undone</span>' : `<button type="button" class="button danger-text" data-import-undo="${escapeHTML(item.id)}">Undo</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help">No imports yet.</p>';
      box.querySelectorAll('[data-import-undo]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await api(`${url}/imports/${button.dataset.importUndo}/undo`, {method: 'POST'});
          toast(`Put back ${result.reverted} text${result.reverted === 1 ? '' : 's'}${result.kept.length ? `; kept ${result.kept.length} someone edited` : ''}.`);
          done?.(); drawHistory();
        } catch (problem) { toast(problem.message); button.disabled = false; }
      }));
    } catch (problem) { box.innerHTML = `<p class="error">${escapeHTML(problem.message)}</p>`; }
  }

  draw();
}

// Set up the AVN events standard in a game: pick tiers, then download the prompt with the spec
// (or copy the prompt) for the AI agent the developer runs in the game's code.
const STANDARD_TIERS = [
  ['core', 'Core', 'Levels, ads, coins, app. Always on.'],
  ['standard', 'Standard', 'Tutorials, powerups, menus, purchases, player.'],
  ['extended', 'Extended', 'Device hardware.'],
];

function mountStandardInstall(root, game) {
  const storeKey = 'avn-standard-tiers';
  const saved = storeGet(storeKey);
  let tiers = Array.isArray(saved) ? STANDARD_TIERS.map(([key]) => key).filter(key => key === 'core' || saved.includes(key)) : ['core', 'standard'];
  let summary = null; let loading = 0; let custom = []; let gameStatus = null;
  // Custom events are part of the standard, so they are always in the downloads.
  const query = () => new URLSearchParams([...tiers, ...(custom.length ? ['custom'] : [])].map(tier => ['tiers', tier])).toString();

  const draw = () => {
    root.innerHTML = `<div class="import-choices standard-tiers" role="group" aria-label="Which events">
        ${STANDARD_TIERS.map(([key, title, text]) => `<label class="import-choice"><input type="checkbox" name="tier" value="${key}" ${tiers.includes(key) ? 'checked' : ''} ${key === 'core' ? 'checked disabled' : ''}><span><strong>${title}</strong><small>${text}</small></span></label>`).join('')}
      </div>
      <div id="unlisted-events" class="custom-events unlisted-events" hidden></div>
      <div id="custom-events" class="custom-events"></div>
      <div class="error" role="alert"></div>
      <div class="import-actions setup-actions"><button type="button" class="button primary" data-standard-download>${icon('export', 15)} Download setup files</button><button type="button" class="button" data-standard-copy>${icon('copy', 15)} Copy prompt</button></div>
      ${flow([['export', 'Unzip in your game'], ['sparkle', 'Run <code>AGENT_PROMPT.md</code> in your AI agent'], ['pulse', 'Send a test build']])}
      <div id="standard-summary">${skeleton('table', 3, 3)}</div>
      <details class="import-prompt"><summary>Show the prompt</summary><textarea readonly rows="12" aria-label="Agent prompt" id="standard-prompt"></textarea></details>`;
    drawCustom();
    root.querySelectorAll('[name="tier"]').forEach(box => box.addEventListener('change', () => {
      tiers = [...root.querySelectorAll('[name="tier"]:checked')].map(item => item.value);
      storeSet(storeKey, tiers); load();
    }));
    root.querySelector('[data-standard-copy]').addEventListener('click', async () => {
      if (!summary) return;
      try { await navigator.clipboard.writeText(summary.prompt); toast('Prompt copied.'); } catch { toast('Open "Show the prompt" and copy it by hand.'); }
    });
    root.querySelector('[data-standard-download]').addEventListener('click', async event => {
      const button = event.currentTarget; const error = root.querySelector('.error');
      error.textContent = ''; button.disabled = true;
      try {
        const response = await fetch(`/v1/events-standard/download?${query()}`, {credentials: 'same-origin'});
        if (!response.ok) { const problem = await response.json().catch(() => ({})); throw new Error(typeof problem.detail === 'string' ? problem.detail : 'Download failed. Please try again.'); }
        const href = URL.createObjectURL(await response.blob());
        const anchor = Object.assign(document.createElement('a'), {href, download: 'avn-events-setup.zip'});
        document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000);
      } catch (problem) { error.textContent = problem.message; }
      finally { button.disabled = false; }
    });
  };
  const drawCustom = () => {
    root.querySelector('#custom-events').innerHTML = customEventsHTML(custom, gameStatus?.sent);
    const unlisted = root.querySelector('#unlisted-events');
    unlisted.hidden = !(gameStatus && (gameStatus.unlisted.length || gameStatus.ignored.length));
    if (!unlisted.hidden) unlisted.innerHTML = unlistedEventsHTML(gameStatus);
  };
  const refresh = async () => {
    try { custom = await request('/v1/events-standard/custom'); } catch { /* the list stays as it was */ }
    try { gameStatus = await request(`/v1/games/${encodeURIComponent(game.id)}/standard`); } catch { /* no status shown */ }
    drawCustom(); load();
  };
  const load = async () => {
    const current = ++loading; const box = root.querySelector('#standard-summary');
    try {
      const result = await request(`/v1/events-standard?${query()}`);
      if (current !== loading) return;
      summary = result;
      box.innerHTML = `<details class="import-prompt standard-events"><summary>Show the ${number(result.events.length)} events</summary><div class="table-wrap"><table class="import-table"><thead><tr><th>Event</th><th>Tier</th><th>States</th><th class="num">Sent by this game</th></tr></thead><tbody>${result.events.map(item => `<tr><td><code>${escapeHTML(item.name)}</code></td><td>${escapeHTML(item.tier)}</td><td>${item.states.map(state => `<code>${escapeHTML(state)}</code>`).join(' ')}</td><td class="num">${gameStatus?.sent[item.name] ? number(gameStatus.sent[item.name].events) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div></details>`;
      root.querySelector('#standard-prompt').value = result.prompt;
    } catch (problem) { if (current === loading) box.innerHTML = `<p class="error">${escapeHTML(problem.message)}</p>`; }
  };

  draw(); bindCustomEvents(root.querySelector('#custom-events'), () => custom, refresh);
  bindUnlistedEvents(root.querySelector('#unlisted-events'), () => gameStatus, game, refresh); refresh();
}
