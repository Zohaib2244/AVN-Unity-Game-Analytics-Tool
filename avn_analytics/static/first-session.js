/* ─── Levels: how far new players get in their first session ─── */
const FLOW_STAGES = {during: 'In the level', between: 'After the win'};

// A player count that opens the list of those players.
const flowCount = (target, count) => `<button type="button" class="text-link" data-flow-list="${escapeHTML(JSON.stringify(target))}" title="Show these players">${number(count)}</button>`;

function flowResultsHTML(data) {
  if (!data.players) {
    const reasons = Object.entries(data.excluded || {}).map(([key, count]) => `${number(count)} ${FLOW_EXCLUDED[key] || key}`).join(', ');
    return `<p class="help">No new players in these dates started the chosen first level in their first session.${reasons ? ` Left out: ${escapeHTML(reasons)}.` : ''}</p>`;
  }
  const small = data.players < data.minimum_players ? ' · small sample' : '';
  const left = Object.entries(data.excluded || {}).map(([key, count]) => `${number(count)} ${FLOW_EXCLUDED[key] || key}`).join(', ');
  const steps = `<div class="level-scroll funnel-scroll" tabindex="0" role="region" aria-label="Levels played in one unbroken run"><table class="compact-table"><thead><tr><th>Level</th><th>Started in the run</th><th>Finished in the run</th><th>Of new players</th></tr></thead><tbody>${data.steps.map(step => `<tr><td>${step.level}</td><td>${flowCount({kind: 'step', level: step.level, which: 'started'}, step.started)}</td><td>${flowCount({kind: 'step', level: step.level, which: 'completed'}, step.completed)}</td><td><div class="level-funnel-bar"><span data-width="${step.percent ?? 0}"></span></div><span>${step.percent == null ? '—' : percent(step.percent)}</span></td></tr>`).join('')}</tbody></table></div>`;
  const runs = `<table class="compact-table"><thead><tr><th>Levels in a row</th><th>Players</th><th>Share</th></tr></thead><tbody>${data.run_lengths.map(item => `<tr><td>${item.levels}</td><td>${flowCount({kind: 'run', levels: item.levels}, item.players)}</td><td>${percent(100 * item.players / data.players)}</td></tr>`).join('')}</tbody></table>`;
  const ends = data.ends.length ? `<div class="level-scroll funnel-scroll" tabindex="0" role="region" aria-label="Where runs ended"><table class="compact-table"><thead><tr><th>Level</th><th>What ended the run</th><th>Players</th></tr></thead><tbody>${data.ends.map(item => `<tr><td>${item.level}</td><td>${escapeHTML(item.reason)}</td><td>${flowCount({kind: 'end', level: item.level, stage: item.stage, reason: item.reason}, item.players)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Nobody’s run ended before the last level.</p>';
  const flags = data.flags.length ? `<h3>Flagged detours</h3><p class="help">These players took an allowed detour and kept going.</p><table class="compact-table"><thead><tr><th>Level</th><th>When</th><th>Detour</th><th>Players</th></tr></thead><tbody>${data.flags.map(item => `<tr><td>${item.level}</td><td>${FLOW_STAGES[item.stage]}</td><td>${escapeHTML(item.path)}</td><td>${flowCount({kind: 'flag', level: item.level, stage: item.stage, path: item.path}, item.players)}</td></tr>`).join('')}</tbody></table>` : '';
  return `<p class="help"><strong>${number(data.players)} new players${small}.</strong> ${data.reached_end ? flowCount({kind: 'finished'}, data.reached_end) : '0'} played through the last level without a break.${left ? ` Left out: ${escapeHTML(left)}.` : ''}</p>${steps}<h3>How many levels in a row</h3>${runs}<h3>Where runs ended</h3>${ends}${flags}`;
}
const FLOW_EXCLUDED = {
  started_at_other_level: 'started somewhere other than the first level',
  no_level_started: 'never started a level',
  outside_filters: 'outside the filters',
};

function flowPathsHTML(paths) {
  if (!paths.length) return '<p class="help">No detours seen. Every new player went straight from a win to the next start.</p>';
  return `<div class="level-scroll funnel-scroll" tabindex="0" role="region" aria-label="Paths seen in first sessions"><table class="compact-table"><thead><tr><th>Keeps the run going</th><th>When</th><th>What happened</th><th>Players</th></tr></thead><tbody>${paths.map(item => `<tr><td><label class="check-row"><input type="checkbox" data-flow-path="${escapeHTML(item.key)}" ${item.allowed ? 'checked' : ''}> <span>Allow</span></label></td><td>${FLOW_STAGES[item.stage]}</td><td>${escapeHTML(item.path)}</td><td>${flowCount({kind: 'path', stage: item.stage, path: item.path}, item.players)}</td></tr>`).join('')}</tbody></table></div>`;
}

function flowPlayersHTML(list, title, more) {
  const rows = list.players.map((row, index) => `<tr><td><button type="button" class="text-link" data-flow-player="${index}">${escapeHTML(shortId(row.player))}</button></td><td class="num">${number(row.levels_in_a_row)}</td><td>${escapeHTML(row.ended)}</td><td>${escapeHTML(row.app_version || 'unknown')}</td><td>${escapeHTML(row.first_seen.slice(0, 16).replace('T', ' '))} UTC</td></tr>`).join('');
  return `<div class="panel-header"><h3>${escapeHTML(title)}</h3><button type="button" class="button small-button" data-flow-close>Close list</button></div><p class="help">${number(list.total)} ${list.total === 1 ? 'player' : 'players'}. Open one to see every event of their first session and after.</p><div class="level-scroll funnel-scroll" tabindex="0" role="region" aria-label="Players in this row"><table class="compact-table"><thead><tr><th>Player</th><th class="num">Levels in a row</th><th>How the run ended</th><th>App version</th><th>First seen</th></tr></thead><tbody>${rows}</tbody></table></div>${more ? '<button type="button" class="button small-button" data-flow-more>Show more</button>' : ''}`;
}

function flowTargetTitle(target) {
  const when = FLOW_STAGES[target.stage] || '';
  return {
    end: `Run ended at level ${target.level}: ${target.reason}`,
    finished: 'Played through the last level without a break',
    flag: `Flagged at level ${target.level} (${when.toLowerCase()}): ${target.path}`,
    run: `${target.levels} ${target.levels === 1 ? 'level' : 'levels'} in a row`,
    step: `${target.which === 'started' ? 'Started' : 'Finished'} level ${target.level} in the run`,
    path: `${when}: ${target.path}`,
  }[target.kind] || 'Players';
}

function mountFirstSession(container, game) {
  const storeKey = `avn-first-session-${game.id}`;
  const defaults = {first_level: 1, last_level: 20, max_away_seconds: 60, allow: []};
  const settings = {...defaults, ...(storeGet(storeKey) || {})};
  settings.allow = Array.isArray(settings.allow) ? settings.allow : [];
  let selected = null; let ticket = 0; let saved = []; let current = {id: '', name: ''};
  container.innerHTML = `<div class="level-saved-views"><label class="inline-field">Saved flow<select id="flow-saved" aria-label="Saved first-session flow"><option value="">Choose a saved flow…</option></select></label><button type="button" class="button small-button" id="flow-save">Save</button><button type="button" class="button small-button" id="flow-save-as">Save as…</button><button type="button" class="button small-button" id="flow-delete" disabled>Delete</button></div>
    <form id="flow-form" class="level-analysis-controls"><label>First level<input id="flow-first" type="number" min="0" max="1000" required></label><label>Through level<input id="flow-last" type="number" min="1" max="1000" required></label><label>Leaving the app breaks the run after (seconds)<input id="flow-away" type="number" min="0" max="86400" required></label><button class="button" type="submit">Update</button></form>
    <p class="help">Follows players whose very first event is in these dates, through their first session only. A run is a level start, then its win, then the next level’s start, with nothing else in between. Tick a path in “Paths seen” below to let it keep the run going; it is then flagged. Changing the app version or other filters above applies here too.</p>
    <div id="flow-results" aria-live="polite"></div><div id="flow-players" class="section-spacing" hidden></div><h3>Paths seen</h3><p class="help">Everything players did inside a level or between a win and the next start. Untick to make it end the run.</p><div id="flow-paths"></div>`;
  const results = container.querySelector('#flow-results');
  const pathsBox = container.querySelector('#flow-paths');
  const playersBox = container.querySelector('#flow-players');
  const savedSelect = container.querySelector('#flow-saved');
  const fill = () => {
    container.querySelector('#flow-first').value = settings.first_level;
    container.querySelector('#flow-last').value = settings.last_level;
    container.querySelector('#flow-away').value = settings.max_away_seconds;
    container.querySelector('#flow-delete').disabled = !current.id;
  };
  const remember = () => storeSet(storeKey, settings);
  const body = () => ({first_level: settings.first_level, last_level: settings.last_level, max_away_seconds: settings.max_away_seconds, allow: settings.allow});
  const drawSaved = () => {
    savedSelect.innerHTML = '<option value="">Choose a saved flow…</option>' + saved.map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`).join('');
    savedSelect.value = current.id;
    container.querySelector('#flow-delete').disabled = !current.id;
  };
  const loadSaved = async () => { try { saved = await api(`${gameURL(game)}/insights/flows`); } catch (error) { saved = []; } if (!saved.some(item => item.id === current.id)) current = {id: '', name: ''}; drawSaved(); };
  const load = async () => {
    if (!selected || !container.isConnected || container.hidden) return;
    const mine = ++ticket;
    results.innerHTML = '<p class="help">Following new players through their first session…</p>';
    try {
      const data = await api(`${gameURL(game)}/insights/levels/first-session`, {method: 'POST', body: JSON.stringify({...filterBody(selected), ...body()})});
      if (mine !== ticket || !container.isConnected) return;
      results.innerHTML = flowResultsHTML(data);
      playersBox.hidden = true; list = null;
      pathsBox.innerHTML = flowPathsHTML(data.paths);
      setWidths(results);
    } catch (error) { if (mine === ticket && container.isConnected) results.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  };
  // The players behind one row. Rows are read in pages of 50 against the settings in force when
  // the list was opened, so ticking another path never reshuffles a list someone is reading.
  let list = null;
  const listBody = (target, offset) => ({...filterBody(list.state), ...list.body, target, offset, limit: 50});
  const fetchList = async offset => api(`${gameURL(game)}/insights/levels/first-session/players`, {method: 'POST', body: JSON.stringify(listBody(list.target, offset))});
  const drawList = () => {
    playersBox.hidden = false;
    playersBox.innerHTML = flowPlayersHTML({total: list.total, players: list.players}, flowTargetTitle(list.target), list.players.length < list.total);
  };
  const openList = async target => {
    list = {target, body: body(), state: structuredClone(selected), players: [], total: 0};
    playersBox.hidden = false;
    playersBox.innerHTML = '<p class="help">Finding these players…</p>';
    playersBox.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    try {
      const result = await fetchList(0);
      list.players = result.players; list.total = result.total; drawList();
    } catch (error) { playersBox.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
  };
  const nameDialog = () => {
    modal.innerHTML = `<form id="flow-name-form"><h2 id="dialog-title">Save flow</h2><p>Saved flows are stored on the server, so they’re there on every device you use.</p><div class="field"><label for="flow-name">Name</label><input id="flow-name" name="name" required maxlength="80" value="${escapeHTML(current.name)}" placeholder="e.g. Strict, settings allowed"></div><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Save</button></div></form>`;
    modal.showModal();
    bindForm('#flow-name-form', async (form, values) => {
      const created = await api(`${gameURL(game)}/insights/flows`, {method: 'POST', body: JSON.stringify({...body(), name: values.name.trim()})});
      current = {id: created.id, name: created.name}; await loadSaved(); modal.close(); toast('Flow saved.');
    });
  };
  container.querySelector('#flow-form').addEventListener('submit', event => {
    event.preventDefault();
    settings.first_level = Number(container.querySelector('#flow-first').value);
    settings.last_level = Number(container.querySelector('#flow-last').value);
    settings.max_away_seconds = Number(container.querySelector('#flow-away').value);
    remember(); load();
  });
  container.addEventListener('click', async event => {
    const opener = event.target.closest('[data-flow-list]');
    if (opener) { openList(JSON.parse(opener.dataset.flowList)); return; }
    if (event.target.closest('[data-flow-close]')) { playersBox.hidden = true; list = null; return; }
    if (event.target.closest('[data-flow-more]') && list) {
      try { const result = await fetchList(list.players.length); list.players = [...list.players, ...result.players]; list.total = result.total; drawList(); }
      catch (error) { toast(error.message); }
      return;
    }
    const open = event.target.closest('[data-flow-player]');
    if (!open || !list) return;
    const players = [...list.players]; const snapshot = list;
    const browse = {index: Number(open.dataset.flowPlayer), total: snapshot.total, load: async index => {
      if (!players[index]) {
        const offset = Math.floor(index / 50) * 50;
        const result = await api(`${gameURL(game)}/insights/levels/first-session/players`, {method: 'POST', body: JSON.stringify({...filterBody(snapshot.state), ...snapshot.body, target: snapshot.target, offset, limit: 50})});
        browse.total = result.total;
        result.players.forEach((row, position) => { players[offset + position] = row; });
      }
      return players[index];
    }};
    renderJourney(game, players[browse.index].player, {overlay: true, filters: snapshot.state, trigger: open, browse});
  });
  pathsBox.addEventListener('change', event => {
    const box = event.target.closest('[data-flow-path]');
    if (!box) return;
    const key = box.dataset.flowPath;
    settings.allow = box.checked ? [...new Set([...settings.allow, key])] : settings.allow.filter(item => item !== key);
    remember(); load();
  });
  savedSelect.addEventListener('change', () => {
    const chosen = saved.find(item => item.id === savedSelect.value);
    current = chosen ? {id: chosen.id, name: chosen.name} : {id: '', name: ''};
    if (chosen) { Object.assign(settings, {first_level: chosen.first_level, last_level: chosen.last_level, max_away_seconds: chosen.max_away_seconds, allow: chosen.allow}); remember(); fill(); load(); }
    container.querySelector('#flow-delete').disabled = !current.id;
  });
  container.querySelector('#flow-save').addEventListener('click', async () => {
    if (!current.id) return nameDialog();
    try { await api(`${gameURL(game)}/insights/flows/${current.id}`, {method: 'PUT', body: JSON.stringify({...body(), name: current.name})}); await loadSaved(); toast('Flow saved.'); }
    catch (error) { toast(error.message); }
  });
  container.querySelector('#flow-save-as').addEventListener('click', nameDialog);
  container.querySelector('#flow-delete').addEventListener('click', () => confirmDialog(`Delete “${current.name}”?`, 'Only the saved settings are removed. No event data is affected.', 'Delete flow', async () => {
    await api(`${gameURL(game)}/insights/flows/${current.id}`, {method: 'DELETE'});
    current = {id: '', name: ''}; await loadSaved(); toast('Flow deleted.');
  }));
  fill(); loadSaved();
  return {update(state) { selected = structuredClone(state); load(); }, show() { load(); }};
}
