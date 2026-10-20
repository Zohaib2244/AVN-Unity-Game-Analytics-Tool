// Custom events: events added to the AVN events standard from the website. They are stored on the
// server and join every setup download as the `custom` tier. Used by the Add AVN Events tab.
// Loaded after dictionary-import.js and before event-setup.js.

const CUSTOM_URL = '/v1/events-standard/custom';
const upperSnake = value => value.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
const noSpaces = value => value.replace(/\s+/g, '');
const blankParam = () => ({key: '', type: 'string', required: false, note: '', values: ''});
const blankState = () => ({name: '', trigger: '', params: []});
const editorModel = event => event
  ? {name: event.name, purpose: event.purpose, states: event.states.map(state => ({...state, params: state.params.map(param => ({...param, values: param.values.join(', ')}))}))}
  : {name: '', purpose: '', states: [blankState()]};

// `prefill` starts a new event from what a game sent ({name, states: [{name, params}]}).
function openCustomEventEditor(existing, done, prefill = null) {
  const model = prefill
    ? {name: prefill.name, purpose: '', states: prefill.states.length ? prefill.states.map(state => ({name: state.name, trigger: '', params: state.params.map(param => ({key: param.key, type: param.type, required: param.required, note: '', values: ''}))})) : [blankState()]}
    : editorModel(existing);
  const locked = Boolean(existing || prefill);
  let focus = null;
  const field = (label, attrs, value, wide = false) => `<div class="field ${wide ? 'wide' : ''}"><label>${label}<input ${attrs} value="${escapeHTML(value)}" autocomplete="off"></label></div>`;
  const paramRow = (param, s, p) => `<div class="custom-param" role="group" aria-label="Parameter ${p + 1}">
      <input data-s="${s}" data-p="${p}" data-f="key" data-id="key-${s}-${p}" value="${escapeHTML(param.key)}" placeholder="KEY" aria-label="Parameter key" autocomplete="off">
      <select data-s="${s}" data-p="${p}" data-f="type" aria-label="Type">${['string', 'int', 'float'].map(type => `<option ${type === param.type ? 'selected' : ''}>${type}</option>`).join('')}</select>
      <label class="check-row"><input type="checkbox" data-s="${s}" data-p="${p}" data-f="required" ${param.required ? 'checked' : ''}> Required</label>
      <input data-s="${s}" data-p="${p}" data-f="values" value="${escapeHTML(param.values)}" placeholder="Values: A, B, C" aria-label="Allowed values, comma separated" autocomplete="off">
      <input data-s="${s}" data-p="${p}" data-f="note" value="${escapeHTML(param.note)}" placeholder="Note" aria-label="Note" maxlength="200" autocomplete="off">
      <button type="button" class="icon-button" data-remove-param="${s}:${p}" aria-label="Remove parameter" title="Remove">${icon('close', 14)}</button></div>`;
  const stateBox = (state, s) => `<fieldset class="custom-state"><legend>State ${s + 1}</legend>
      <div class="custom-state-head">${field('Name', `data-s="${s}" data-f="state-name" data-id="state-${s}" placeholder="Opened"`, state.name)}${field('When is it sent?', `data-s="${s}" data-f="trigger" maxlength="300" placeholder="The shop screen appears"`, state.trigger, true)}
      ${model.states.length > 1 ? `<button type="button" class="icon-button" data-remove-state="${s}" aria-label="Remove state ${s + 1}" title="Remove state">${icon('close', 14)}</button>` : ''}</div>
      ${state.params.map((param, p) => paramRow(param, s, p)).join('')}
      <button type="button" class="button" data-add-param="${s}">${icon('plus', 14)} Parameter</button></fieldset>`;
  const render = () => {
    const form = modal.querySelector('#custom-form');
    form.querySelector('#custom-body').innerHTML = `<div class="custom-top">${field('Event name', `data-f="name" data-id="name" placeholder="SHOP" maxlength="40" ${locked ? 'readonly' : ''}`, model.name)}${field('What does it track?', 'data-f="purpose" maxlength="300" placeholder="The player opens the shop"', model.purpose, true)}</div>
      ${model.states.map(stateBox).join('')}<button type="button" class="button" data-add-state>${icon('plus', 14)} State</button>`;
    if (focus) { modal.querySelector(`[data-id="${focus}"]`)?.focus(); focus = null; }
  };
  modal.className = 'custom-event-dialog';
  modal.innerHTML = `<form id="custom-form" class="custom-form"><div class="player-dialog-head"><h2 id="dialog-title">${existing ? `Edit ${escapeHTML(existing.name)}` : prefill ? `Add ${escapeHTML(prefill.name)} to the standard` : 'Add an AVN event'}</h2><button type="button" class="button" data-action="close" aria-label="Close">Close ×</button></div>
    <div id="custom-body"></div><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button type="submit" class="button primary">${icon('check', 14)} Save event</button></div></form>`;
  modal.addEventListener('close', () => modal.classList.remove('custom-event-dialog'), {once: true});
  const form = modal.querySelector('#custom-form');
  form.addEventListener('input', event => {
    const input = event.target; const f = input.dataset.f; if (!f) return;
    const state = model.states[input.dataset.s]; const param = state?.params[input.dataset.p];
    if (f === 'name') input.value = model.name = upperSnake(input.value);
    else if (f === 'purpose') model.purpose = input.value;
    else if (f === 'state-name') input.value = state.name = noSpaces(input.value);
    else if (f === 'trigger') state.trigger = input.value;
    else if (f === 'key') input.value = param.key = upperSnake(input.value);
    else if (f === 'required') param.required = input.checked;
    else param[f] = input.value;
  });
  form.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if ('addState' in target.dataset) { model.states.push(blankState()); focus = `state-${model.states.length - 1}`; render(); }
    else if (target.dataset.addParam) { const s = Number(target.dataset.addParam); model.states[s].params.push(blankParam()); focus = `key-${s}-${model.states[s].params.length - 1}`; render(); }
    else if (target.dataset.removeState) { model.states.splice(Number(target.dataset.removeState), 1); render(); }
    else if (target.dataset.removeParam) { const [s, p] = target.dataset.removeParam.split(':').map(Number); model.states[s].params.splice(p, 1); render(); }
  });
  render();
  bindForm('#custom-form', async () => {
    const body = {purpose: model.purpose.trim(), states: model.states.map(state => ({name: state.name, trigger: state.trigger.trim(), params: state.params.map(param => ({key: param.key, type: param.type, required: param.required, note: param.note.trim(), values: param.values.split(',').map(value => value.trim()).filter(Boolean)}))}))};
    if (!model.name) throw new Error('Give the event a name.');
    await request(`${CUSTOM_URL}/${encodeURIComponent(model.name)}`, {method: 'PUT', body: JSON.stringify(body)});
    modal.close(); toast(`${model.name} added to the standard.`); done?.();
  });
  modal.showModal();
  (locked ? modal.querySelector('[data-id="state-0"]') : modal.querySelector('[data-id="name"]'))?.focus();
}

// The list on the Add AVN Events tab. Only the admin changes the standard; everyone sees the list.
function customEventsHTML(list, sent) {
  const canEdit = me.can_manage_team;
  return `<div class="custom-head"><h3>${icon('sparkle', 16)} Custom events ${list.length ? `<span class="count">${number(list.length)}</span>` : ''}</h3>${canEdit ? `<button type="button" class="button" data-custom-add>${icon('plus', 14)} Add event</button>` : ''}</div>
    ${list.length ? `<ul class="custom-list">${list.map(item => `<li><code>${escapeHTML(item.name)}</code><span class="small muted">${number(item.states.length)} state${item.states.length === 1 ? '' : 's'} · ${item.states.map(state => escapeHTML(state.name)).join(', ')}</span>${item.tier === 'core' ? '<span class="pill" title="Always in the setup files">Core</span>' : ''}${sent ? (sent[item.name] ? `<span class="pill good">Sent · ${number(sent[item.name].events)}</span>` : '<span class="pill">Not sent yet</span>') : ''}${canEdit ? `<span class="custom-actions"><button type="button" class="button" data-custom-tier="${escapeHTML(item.name)}:${item.tier === 'core' ? 'custom' : 'core'}">${item.tier === 'core' ? 'Demote to custom' : 'Promote to core'}</button><button type="button" class="icon-button" data-custom-edit="${escapeHTML(item.name)}" aria-label="Edit ${escapeHTML(item.name)}" title="Edit">${icon('edit', 14)}</button><button type="button" class="icon-button" data-custom-delete="${escapeHTML(item.name)}" aria-label="Delete ${escapeHTML(item.name)}" title="Delete">${icon('close', 14)}</button></span>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">None yet.</p>'}`;
}

function bindCustomEvents(box, getList, refresh) {
  box.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if ('customAdd' in target.dataset) openCustomEventEditor(null, refresh);
    else if (target.dataset.customEdit) openCustomEventEditor(getList().find(item => item.name === target.dataset.customEdit), refresh);
    else if (target.dataset.customTier) {
      const [name, tier] = target.dataset.customTier.split(':');
      const promote = tier === 'core';
      confirmDialog(promote ? `Promote ${name} to core?` : `Demote ${name} to custom?`,
        promote ? 'Core events are in every setup download, even when custom events are left out. Games should send it from now on.' : 'It stays in the standard, but only comes with the setup files when custom events are included.',
        promote ? 'Promote' : 'Demote', async () => { await request(`${CUSTOM_URL}/${encodeURIComponent(name)}/tier`, {method: 'PUT', body: JSON.stringify({tier})}); toast(promote ? `${name} is now a core event.` : `${name} is a custom event again.`); refresh(); });
    }
    else if (target.dataset.customDelete) {
      const name = target.dataset.customDelete;
      confirmDialog(`Delete ${name}?`, 'It leaves the standard and the setup downloads. Games already using it keep sending it, and the events stay in your data.', 'Delete event', async () => { await request(`${CUSTOM_URL}/${encodeURIComponent(name)}`, {method: 'DELETE'}); toast(`${name} deleted.`); refresh(); });
    }
  });
}

// Which app versions the event counts are for. `choice` is {version: ''|'@latest'|'1.4.2', newer}.
function versionFilterHTML(versions, choice) {
  const latest = versions.find(item => item.players)?.version;
  const selected = choice.version === '@latest' ? (latest ?? '') : choice.version;
  const label = item => `${item.version} · ${number(item.players)} player${item.players === 1 ? '' : 's'} · last seen ${agoText(item.last_seen)}`;
  return `<div class="inline-field"><label for="version-filter-select">Events sent by</label><select id="version-filter-select"><option value="">All versions</option>${versions.map(item => `<option value="${escapeHTML(item.version)}" ${item.version === selected ? 'selected' : ''}>${escapeHTML(label(item))}</option>`).join('')}</select></div>
    <label class="check-row"><input type="checkbox" id="version-filter-newer" ${choice.newer ? 'checked' : ''} ${selected ? '' : 'disabled'}> and newer versions</label>`;
}

function bindVersionFilter(box, getStatus, getChoice, choose) {
  box.addEventListener('change', event => {
    const versions = getStatus()?.versions || [];
    const newer = box.querySelector('#version-filter-newer').checked;
    if (event.target.id === 'version-filter-select') {
      const value = event.target.value;
      // Picking the newest version follows the newest from then on, as new builds ship.
      choose({version: value && value === versions.find(item => item.players)?.version ? '@latest' : value, newer});
    } else if (event.target.id === 'version-filter-newer') choose({...getChoice(), newer});
  });
}

// Events the game sends that the standard does not have: add them to the standard, or ignore them.
function unlistedEventsHTML(status) {
  const canAdd = me.can_manage_team;
  const more = versions => versions.length > 3 ? ` +${versions.length - 3}` : '';
  const row = item => `<li><code>${escapeHTML(item.name)}</code><span class="small muted">${number(item.events)} event${item.events === 1 ? '' : 's'} · last seen ${escapeHTML(agoText(item.last_seen))}${item.versions.length ? ` · ${item.versions.slice(0, 3).map(escapeHTML).join(', ')}${more(item.versions)}` : ''}</span>${item.valid_name ? '' : '<span class="pill" title="Event names in the standard are UPPER_SNAKE">Name not UPPER_SNAKE</span>'}<span class="custom-actions">${item.valid_name && canAdd ? `<button type="button" class="button" data-unlisted-add="${escapeHTML(item.name)}">${icon('plus', 14)} Add to standard</button>` : ''}<button type="button" class="button" data-unlisted-ignore="${escapeHTML(item.name)}">Ignore</button></span></li>`;
  const shown = status.unlisted.length < status.total_unlisted ? ` <span class="small muted">showing ${number(status.unlisted.length)}</span>` : '';
  const older = status.older_only.length ? `<p class="older-note small muted">${number(status.older_only.length)} more event${status.older_only.length === 1 ? ' is' : 's are'} only sent by older versions. ${canAdd ? `<button type="button" class="button" data-unlisted-older>Ignore ${status.older_only.length === 1 ? 'it' : 'them'}</button>` : ''}</p>` : '';
  return `${status.unlisted.length ? `<div class="custom-head"><h3>${icon('pulse', 16)} Sent, not in the standard <span class="count">${number(status.total_unlisted)}</span>${shown}</h3></div><ul class="custom-list">${status.unlisted.map(row).join('')}</ul>` : ''}
    ${older}
    ${status.ignored.length ? `<details class="mapping-how"><summary>Ignored (${number(status.ignored.length)})</summary><ul class="custom-list">${status.ignored.map(item => `<li><code>${escapeHTML(item.name)}</code><span class="small muted">${number(item.events)} events</span><span class="custom-actions"><button type="button" class="button" data-unlisted-restore="${escapeHTML(item.name)}">Restore</button></span></li>`).join('')}</ul></details>` : ''}`;
}

function bindUnlistedEvents(box, getStatus, game, refresh, getChoice) {
  const url = name => `/v1/games/${encodeURIComponent(game.id)}/standard/ignored/${encodeURIComponent(name)}`;
  box.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const {unlistedAdd, unlistedIgnore, unlistedRestore} = target.dataset;
    if ('unlistedOlder' in target.dataset) {
      const count = getStatus().older_only.length;
      confirmDialog(`Ignore ${number(count)} event${count === 1 ? '' : 's'} from older versions?`, 'They are hidden for this game in every version. Restore any of them from the Ignored list.', 'Ignore', async () => {
        const {version, newer} = getChoice();
        const result = await request(`/v1/games/${encodeURIComponent(game.id)}/standard/ignore-older`, {method: 'POST', body: JSON.stringify({version, newer})});
        toast(`${number(result.ignored)} event${result.ignored === 1 ? '' : 's'} ignored for this game.`); refresh();
      });
    }
    else if (unlistedAdd) openCustomEventEditor(null, refresh, getStatus().unlisted.find(item => item.name === unlistedAdd));
    else if (unlistedIgnore || unlistedRestore) {
      target.disabled = true;
      try { await request(url(unlistedIgnore || unlistedRestore), {method: unlistedIgnore ? 'PUT' : 'DELETE'}); toast(unlistedIgnore ? `${unlistedIgnore} ignored for this game.` : `${unlistedRestore} restored.`); refresh(); }
      catch (error) { toastError(error); target.disabled = false; }
    }
  });
}
