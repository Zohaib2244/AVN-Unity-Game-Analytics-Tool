/* ─── Levels: how far new players get in their first session ───
   One table, laid out like "Level by level": a row per level, and the chevron opens the players
   behind it with the same tabs, player table and "Show more" pager. */
const FLOW_STAGES = {during: 'In the level', between: 'After the win'};
const FLOW_EXCLUDED = {
  outside_level_range: 'started no levels in this range',
  started_at_other_level: 'started somewhere other than the first level',
  no_level_started: 'never started a level',
  outside_filters: 'outside the filters',
};
const FLOW_GROUPS = [['ended_at', 'Stopped here'], ['completed', 'Completed'], ['started', 'Started'], ['flagged_at', 'Other activity']];

// The headline numbers above the table.
function flowSummaryHTML(data) {
  const ended = data.steps.filter(step => step.ended).sort((first, second) => second.ended - first.ended)[0];
  const sorted = data.run_lengths.flatMap(item => Array(item.players).fill(item.levels));
  const middle = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const small = data.players < data.minimum_players ? `fewer than ${number(data.minimum_players)}, a small sample` : 'first session only';
  return stats([
    ['New players', number(data.players), small],
    [data.config.mode === 'all' ? 'Levels completed' : 'Levels in a row', number(middle), data.config.mode === 'all' ? 'median per first session' : 'median, without a break'],
    [data.config.mode === 'all' ? 'Most sessions stop at' : 'Most runs end at', ended ? `Level ${ended.level}` : '—', ended ? `${number(ended.ended)} of ${number(data.players)} players` : ''],
    [data.config.mode === 'all' ? 'Completed last level' : 'Played to the end', number(data.reached_end), `level ${data.config.last_level} in this range`],
  ]);
}

function flowTableHTML(data, open) {
  if (!data.players) {
    const left = Object.entries(data.excluded || {}).map(([key, count]) => `${number(count)} ${FLOW_EXCLUDED[key] || key}`).join(', ');
    return empty('No new players here', `No matching new players started ${data.config.mode === 'all' ? `a level from ${data.config.first_level} to ${data.config.last_level}` : `level ${data.config.first_level}`} in their first session.${left ? ` Left out: ${left}.` : ''}`, '', 'game');
  }
  const dash = '<span class="muted">—</span>';
  const rows = data.steps.map(step => `<tr data-flow-row="${step.level}"><td class="level-number-cell"><button type="button" class="level-toggle" data-flow-toggle="${step.level}" aria-expanded="${open.has(step.level)}" aria-label="Show the players behind level ${step.level}">${icon('chevron', 14)}</button><strong>${step.level}</strong></td><td class="num">${number(step.started)}</td><td class="num">${number(step.completed)}</td><td><div class="level-funnel-bar"><span data-width="${step.percent ?? 0}"></span></div><span class="small">${step.percent == null ? '—' : percent(step.percent)}</span></td><td class="num">${step.ended ? number(step.ended) : dash}</td><td>${step.reasons.length ? escapeHTML(step.reasons[0].reason) : dash}</td><td class="num">${step.flagged ? number(step.flagged) : dash}</td></tr><tr class="level-detail" data-flow-detail="${step.level}" ${open.has(step.level) ? '' : 'hidden'}><td colspan="7"><div class="level-drill" data-flow-drill="${step.level}"></div></td></tr>`).join('');
  return `<div class="table-wrap level-scroll levels-scroll" tabindex="0" role="region" aria-label="First-session runs by level"><table class="levels-grid"><thead><tr><th>Level</th><th class="num">Started</th><th class="num">Completed</th><th>Completed / cohort</th><th class="num">Stopped here</th><th>Main reason</th><th class="num">Other activity</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// What ended runs at one level, then the players of the chosen tab.
function flowDrillHTML(step, state, playerHref, when) {
  // The five biggest reasons show; the rest fold away so a long tail never buries the players.
  const reason = (item, index) => `<li><button type="button" class="flow-reason" data-flow-reason="${index}" aria-pressed="${state.group === 'end' && state.reason === index}"><span class="pill">${FLOW_STAGES[item.stage]}</span><span class="flow-reason-text">${escapeHTML(item.reason)}</span><span class="drill-count">${number(item.players)}</span></button></li>`;
  const top = step.reasons.slice(0, 5).map(reason).join('');
  const rest = step.reasons.slice(5).map((item, index) => reason(item, index + 5)).join('');
  const reasons = step.reasons.length ? `<div class="flow-reasons-block"><ul class="flow-reasons">${top}</ul>${rest ? `<details class="flow-reasons-more" ${state.reason >= 5 ? 'open' : ''}><summary>${number(step.reasons.length - 5)} more ${step.reasons.length - 5 === 1 ? 'reason' : 'reasons'}</summary><ul class="flow-reasons">${rest}</ul></details>` : ''}</div>` : '';
  const counts = {ended_at: step.ended, completed: step.completed, started: step.started, flagged_at: step.flagged};
  const tabs = `<div class="level-drill-head"><div class="segmented" role="group" aria-label="Players on level ${step.level}">${FLOW_GROUPS.map(([key, label]) => `<button type="button" data-flow-group="${key}" aria-pressed="${state.group === key || (key === 'ended_at' && state.group === 'end')}">${label} <span class="drill-count">${number(counts[key])}</span></button>`).join('')}</div></div>`;
  const ending = row => row.ended_stage ? `${FLOW_STAGES[row.ended_stage]}: ${row.ended}` : row.ended;
  const detours = row => row.flags.length ? row.flags.map(flag => `Level ${flag.level}: ${flag.path}`).join('; ') : '—';
  const table = state.error ? loadError(state.error, 'data-flow-retry') : state.loading && !state.players.length ? skeleton('table', 5, 5) : !state.players.length ? '<p class="help">Nobody is in this group.</p>' : `<div class="table-wrap"><table class="compact-table"><thead><tr><th>Player</th><th class="num">Levels completed</th><th>${state.group === 'flagged_at' ? 'Other activity' : 'Where progress stopped'}</th><th>Version</th><th>First seen</th></tr></thead><tbody>${state.players.map(row => `<tr><td><a class="row-title" href="${playerHref(row)}"><span class="mono">${escapeHTML(shortId(row.player))}</span></a></td><td class="num">${number(row.levels_in_a_row)}</td><td class="small">${escapeHTML(state.group === 'flagged_at' ? detours(row) : ending(row))}</td><td class="small">${escapeHTML(row.app_version || '—')}</td><td class="small muted">${when(row.first_seen)}</td></tr>`).join('')}</tbody></table></div><div class="pager"><span class="small muted">${number(state.players.length)} of ${number(state.total)}</span>${state.players.length < state.total ? `<button type="button" class="button" data-flow-more ${state.loading ? 'disabled aria-busy="true"' : ''}>${state.loading ? spinner('Loading…') : 'Show more'}</button>` : ''}</div>`;
  return `${reasons ? `<p class="level-drill-note small muted">Why progress stopped at level ${step.level}. Pick one to list only those players.</p>${reasons}` : ''}${tabs}${table}`;
}

function flowPathsHTML(paths) {
  if (!paths.length) return '<p class="help">No detours seen in the observed level paths.</p>';
  return `<ul class="flow-paths">${paths.map(item => `<li><label class="check-row"><input type="checkbox" data-flow-path="${escapeHTML(item.key)}" ${item.allowed ? 'checked' : ''}> <span>${escapeHTML(item.path)}</span></label><span class="pill">${FLOW_STAGES[item.stage]}</span><span class="small muted">${number(item.players)} ${item.players === 1 ? 'player' : 'players'}</span></li>`).join('')}</ul>`;
}

function mountFirstSession(container, game) {
  const storeKey = `avn-first-session-v2-${game.id}`;
  const settings = {mode: 'all', first_level: 1, last_level: 20, max_away_seconds: 60, allow: [], ...(storeGet(storeKey) || {})};
  settings.allow = Array.isArray(settings.allow) ? settings.allow : [];
  let selected = null; let ticket = 0; let saved = []; let current = {id: '', name: ''}; let data = null; let request = null;
  const open = new Set(); const drill = new Map();
  container.innerHTML = `<form id="flow-form" class="level-analysis-controls flow-toolbar"><label>First level<input id="flow-first" type="number" inputmode="numeric" min="0" max="1000" required></label><label>Through level<input id="flow-last" type="number" inputmode="numeric" min="1" max="1000" required></label><button class="button" type="submit">Update</button>
      <details class="flow-saved-options"><summary>Saved flows</summary><div class="flow-saved"><label class="inline-field">Saved flow<select id="flow-saved"><option value="">None</option></select></label><button type="button" class="button" id="flow-save">Save</button><button type="button" class="button" id="flow-save-as">Save as…</button><button type="button" class="button" id="flow-delete" disabled>Delete</button></div></details></form>
    <p class="help" id="flow-scope"></p>
    <details class="flow-settings" id="flow-conditions"><summary>${icon('settings', 16)}<span class="flow-settings-title">Optional run conditions</span><span class="small muted" id="flow-allowed"></span><span class="flow-settings-toggle">${icon('chevron', 14)}</span></summary><label class="check-row"><input id="flow-strict" type="checkbox"> Only count uninterrupted runs</label><p class="help">Off by default. All first-session progress counts, including ads, menus, retries, skips and time away. Turn this on to stop counting at the first interruption.</p><div id="flow-strict-options" hidden><label class="inline-field">Stop after time away (seconds)<input id="flow-away" type="number" inputmode="numeric" min="0" max="86400" value="60" form="flow-form" required></label><p class="help">Exceptions: check an observed path to allow it in an uninterrupted run. Unchecked paths stop the run. Changes apply immediately.</p><div id="flow-paths"></div></div></details>
    <div id="flow-summary"></div>
    <div id="flow-table" aria-live="polite"></div>`;
  const summaryBox = container.querySelector('#flow-summary');
  const tableBox = container.querySelector('#flow-table');
  const pathsBox = container.querySelector('#flow-paths');
  const savedSelect = container.querySelector('#flow-saved');
  const playerHref = row => `${gamePath(game, 'players')}?${new URLSearchParams({player: row.player})}`;
  const when = value => analysisDate(value, selected?.timezone);
  const body = () => ({mode: settings.mode, first_level: settings.first_level, last_level: settings.last_level, max_away_seconds: settings.max_away_seconds, allow: settings.allow});
  const remember = () => storeSet(storeKey, settings);
  const fill = () => {
    container.querySelector('#flow-first').value = settings.first_level;
    container.querySelector('#flow-last').value = settings.last_level;
    container.querySelector('#flow-away').value = settings.max_away_seconds;
    const strict = settings.mode === 'strict';
    container.querySelector('#flow-strict').checked = strict;
    container.querySelector('#flow-strict-options').hidden = !strict;
    container.querySelector('#flow-away').disabled = !strict;
    container.querySelector('#flow-allowed').textContent = strict ? 'Uninterrupted runs only' : 'None · all progress included';
    container.querySelector('#flow-scope').textContent = strict ? 'New players in the selected dates. Progress stops at the first interruption under your conditions.' : 'All new players who started a level in this range, in their first session. Ads, menus, retries and skips do not hide later progress. Dates and filters above still apply.';
  };
  const drawSaved = () => {
    savedSelect.innerHTML = '<option value="">None</option>' + saved.map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`).join('');
    savedSelect.value = current.id;
    container.querySelector('#flow-delete').disabled = !current.id;
  };
  const loadSaved = async () => {
    try { saved = await api(`${gameURL(game)}/insights/flows`); } catch { saved = []; }
    if (!saved.some(item => item.id === current.id)) current = {id: '', name: ''};
    drawSaved();
  };

  // Players of one level, 50 at a time, against the settings the table was drawn with.
  const target = (level, state) => {
    if (state.group === 'end') {
      const {stage, reason} = data.steps.find(step => step.level === level).reasons[state.reason];
      return {kind: 'end', level, stage, reason};
    }
    if (state.group === 'started' || state.group === 'completed') return {kind: 'step', level, which: state.group};
    return {kind: state.group, level};
  };
  const fetchPlayers = (level, state, offset) => api(`${gameURL(game)}/insights/levels/first-session/players`, {method: 'POST', body: JSON.stringify({...request, target: target(level, state), offset, limit: 50})});
  const drawDrill = level => {
    const box = container.querySelector(`[data-flow-drill="${level}"]`); const state = drill.get(level);
    const step = data?.steps.find(item => item.level === level);
    if (box && state && step) box.innerHTML = flowDrillHTML(step, state, playerHref, when);
  };
  const fetchDrill = async (level, more = false) => {
    const state = drill.get(level); const mine = ++state.ticket;
    state.loading = true; state.error = null;
    if (!more) { state.players = []; state.total = 0; }
    drawDrill(level);
    try {
      const result = await fetchPlayers(level, state, more ? state.players.length : 0);
      if (mine !== state.ticket) return;
      state.players = more ? [...state.players, ...result.players] : result.players; state.total = result.total;
    } catch (error) { if (mine === state.ticket) state.error = error; }
    if (mine === state.ticket) { state.loading = false; drawDrill(level); }
  };
  const draw = () => {
    const excluded = Object.entries(data.excluded || {}).map(([key, count]) => `${number(count)} ${FLOW_EXCLUDED[key] || key}`).join(', ');
    summaryBox.innerHTML = data.players ? flowSummaryHTML(data) + (excluded ? `<p class="help">Outside this report: ${escapeHTML(excluded)}.</p>` : '') : '';
    pathsBox.innerHTML = flowPathsHTML(data.paths);
    fill();
    tableBox.innerHTML = flowTableHTML(data, open);
    setWidths(tableBox);
  };
  const load = async () => {
    if (!selected || !container.isConnected || container.hidden) return;
    const mine = ++ticket;
    request = {...filterBody(selected), ...body()};
    drill.clear(); open.clear();
    const finishLoading = beginLoading(tableBox, skeleton('table', 6, 7));
    try {
      const result = await api(`${gameURL(game)}/insights/levels/first-session`, {method: 'POST', body: JSON.stringify(request)});
      if (mine !== ticket || !container.isConnected) return;
      data = result; draw();
    } catch (error) { if (mine === ticket && container.isConnected) { summaryBox.innerHTML = ''; tableBox.innerHTML = loadError(error, 'data-flow-reload'); } }
    finally { finishLoading(); }
  };
  const nameDialog = () => {
    modal.innerHTML = `<form id="flow-name-form"><h2 id="dialog-title">Save flow</h2><p>Saved flows are stored on the server, so they’re there on every device you use.</p><div class="field"><label for="flow-name">Name</label><input id="flow-name" name="name" required maxlength="80" autocomplete="off" value="${escapeHTML(current.name)}" placeholder="e.g. Uninterrupted with retries"></div><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Save flow</button></div></form>`;
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
    remember(); fill(); load();
  });
  container.querySelector('#flow-strict').addEventListener('change', event => {
    settings.mode = event.target.checked ? 'strict' : 'all';
    remember(); fill(); load();
  });
  container.querySelector('#flow-away').addEventListener('change', event => {
    if (!event.target.checkValidity()) { event.target.reportValidity(); return; }
    settings.max_away_seconds = Number(event.target.value); remember(); load();
  });
  pathsBox.addEventListener('change', event => {
    const box = event.target.closest('[data-flow-path]'); if (!box) return;
    const key = box.dataset.flowPath;
    settings.allow = box.checked ? [...new Set([...settings.allow, key])] : settings.allow.filter(item => item !== key);
    remember(); fill(); load();
  });
  tableBox.addEventListener('click', event => {
    const playerLink = event.target.closest('.level-drill a[href]');
    if (playerLink && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault();
      const level = Number(playerLink.closest('[data-flow-drill]').dataset.flowDrill);
      const state = drill.get(level); const players = [...state.players]; const snapshot = {...state};
      const player = new URL(playerLink.href).searchParams.get('player');
      const browse = {index: players.findIndex(row => row.player === player), total: state.total, load: async index => {
        if (!players[index]) {
          const offset = Math.floor(index / 50) * 50;
          const result = await fetchPlayers(level, snapshot, offset);
          browse.total = result.total;
          result.players.forEach((row, position) => { players[offset + position] = row; });
        }
        return players[index];
      }};
      renderJourney(game, player, {overlay: true, filters: selected, trigger: playerLink, browse});
      return;
    }
    if (event.target.closest('[data-flow-reload]')) { load(); return; }
    const toggle = event.target.closest('[data-flow-toggle]');
    if (toggle) {
      const level = Number(toggle.dataset.flowToggle); const row = container.querySelector(`[data-flow-detail="${level}"]`);
      const opening = !open.has(level);
      if (opening) open.add(level); else open.delete(level);
      row.hidden = !opening; toggle.setAttribute('aria-expanded', String(opening));
      if (opening && !drill.has(level)) {
        drill.set(level, {group: data.steps.find(step => step.level === level).ended ? 'ended_at' : 'completed', reason: null, players: [], total: 0, loading: false, error: null, ticket: 0});
        fetchDrill(level);
      }
      return;
    }
    const panel = event.target.closest('[data-flow-drill]'); if (!panel) return;
    const level = Number(panel.dataset.flowDrill); const state = drill.get(level); if (!state) return;
    const tab = event.target.closest('[data-flow-group]');
    if (tab) { state.group = tab.dataset.flowGroup; state.reason = null; fetchDrill(level); return; }
    const reason = event.target.closest('[data-flow-reason]');
    if (reason) {
      const index = Number(reason.dataset.flowReason);
      if (state.group === 'end' && state.reason === index) { state.group = 'ended_at'; state.reason = null; } else { state.group = 'end'; state.reason = index; }
      fetchDrill(level); return;
    }
    if (event.target.closest('[data-flow-retry]')) { fetchDrill(level); return; }
    if (event.target.closest('[data-flow-more]')) fetchDrill(level, true);
  });
  savedSelect.addEventListener('change', () => {
    const chosen = saved.find(item => item.id === savedSelect.value);
    current = chosen ? {id: chosen.id, name: chosen.name} : {id: '', name: ''};
    container.querySelector('#flow-delete').disabled = !current.id;
    if (chosen) { Object.assign(settings, {mode: chosen.mode || 'strict', first_level: chosen.first_level, last_level: chosen.last_level, max_away_seconds: chosen.max_away_seconds, allow: chosen.allow}); remember(); fill(); load(); }
  });
  container.querySelector('#flow-save').addEventListener('click', async () => {
    if (!current.id) return nameDialog();
    try { await api(`${gameURL(game)}/insights/flows/${current.id}`, {method: 'PUT', body: JSON.stringify({...body(), name: current.name})}); await loadSaved(); toast('Flow saved.'); }
    catch (error) { toastError(error); }
  });
  container.querySelector('#flow-save-as').addEventListener('click', nameDialog);
  container.querySelector('#flow-delete').addEventListener('click', () => confirmDialog(`Delete “${current.name}”?`, 'Only the saved settings are removed. No event data is affected.', 'Delete flow', async () => {
    await api(`${gameURL(game)}/insights/flows/${current.id}`, {method: 'DELETE'});
    current = {id: '', name: ''}; await loadSaved(); toast('Flow deleted.');
  }));
  // Conditions are optional; keep the default view focused on results.
  const conditions = container.querySelector('#flow-conditions');
  const conditionsKey = `avn-first-session-conditions-${game.id}`;
  conditions.open = settings.mode === 'strict' || storeGet(conditionsKey) === 'open';
  conditions.addEventListener('toggle', () => storeSet(conditionsKey, conditions.open ? 'open' : 'closed'));
  fill(); loadSaved();
  return {update(state) { selected = structuredClone(state); load(); }, show() { load(); }};
}
