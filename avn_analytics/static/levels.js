/* ─── Levels: compare two releases level by level, and saved Levels views ─── */
function mountLevelTools(container, game, restore) {
  const preferenceKey = `avn-level-tools-${game.id}`;
  const viewKey = `avn-level-views-${game.id}`;
  const activeViewKey = `avn-level-active-view-${game.id}`;
  const prefs = {...(storeGet(preferenceKey) || {})};
  let selected = null; let comparisonTicket = 0;
  const remember = () => storeSet(preferenceKey, prefs);
  container.innerHTML = `<section class="panel level-explore"><div class="panel-header"><div><h2>Compare releases</h2><p>Start, finish and drop of two app versions, level by level.</p></div></div>
    <details class="level-saved-options"><summary>Saved views on this device</summary><div class="level-saved-views"><label class="inline-field">Saved view<select id="levels-saved-view" aria-label="Saved level view"><option value="">Choose a saved view…</option></select></label><button type="button" class="button small-button" id="levels-save-view">Save current view</button><button type="button" class="button small-button" id="levels-delete-view" disabled>Delete view</button></div></details>
    <div id="release-comparison" class="panel-body"><div class="level-analysis-controls"><label>Release A<select id="release-a"></select></label><label>Release B<select id="release-b"></select></label><button type="button" class="button" id="compare-refresh">Compare</button></div><p class="help">Same dates and other filters for both releases. These selectors replace the app-version filter here only. Players are grouped by the version at each level’s start, then followed across updates until the end date. Samples may overlap when players replay after updating.</p><div id="release-results" aria-live="polite"></div></div></section>`;
  const comparison = container.querySelector('#release-results');
  const versions = [container.querySelector('#release-a'), container.querySelector('#release-b')];
  const savedSelect = container.querySelector('#levels-saved-view');
  const drawViews = () => {
    const current = storeGet(activeViewKey) || '';
    savedSelect.innerHTML = '<option value="">Choose a saved view…</option>' + Object.keys(storeGet(viewKey) || {}).map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
    savedSelect.value = current;
    container.querySelector('#levels-delete-view').disabled = !savedSelect.value;
  };
  const valid = ticket => ticket === comparisonTicket && container.isConnected;
  const compare = async () => {
    if (!selected || container.hidden) return;
    const ticket = ++comparisonTicket;
    comparison.innerHTML = spinner('Comparing releases…');
    try {
      const facets = await api(`${gameURL(game)}/insights/facets?${new URLSearchParams({start: selected.range.from, end: selected.range.to, tz_offset: timezoneOffset(selected)})}`);
      if (!valid(ticket)) return;
      const choices = (facets.app_version || []).map(item => item.value).sort((first, second) => second.localeCompare(first, undefined, {numeric: true}));
      if (choices.length < 2) { versions.forEach(select => { select.innerHTML = ''; }); comparison.innerHTML = '<p class="help">Choose dates containing at least two releases to compare.</p>'; return; }
      for (const [index, select] of versions.entries()) {
        select.innerHTML = choices.map(value => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join('');
        const preferred = index ? prefs.releaseB : prefs.releaseA;
        select.value = choices.includes(preferred) ? preferred : choices[index ? 0 : 1];
      }
      const releaseA = versions[0].value; const releaseB = versions[1].value;
      if (releaseA === releaseB) { comparison.innerHTML = '<p class="help">Choose two different releases.</p>'; return; }
      prefs.releaseA = releaseA; prefs.releaseB = releaseB; remember();
      const state = structuredClone(selected);
      const results = await Promise.all([releaseA, releaseB].map(version => api(`${gameURL(game)}/insights/levels?${filterQuery({...state, app_version: [version]})}`)));
      if (!valid(ticket)) return;
      const maps = results.map(result => new Map(result.levels.map(row => [row.level, row])));
      const numbers = [...new Set(results.flatMap(result => result.levels.map(row => row.level)))].sort((first, second) => first - second);
      const drop = row => row?.transition?.drop_percent == null ? '—' : `${percent(row.transition.drop_percent)} · ${number(row.transition.total_drop)}${row.low_sample ? ' · small sample' : ''}`;
      comparison.innerHTML = numbers.length ? `<div class="level-scroll comparison-scroll" tabindex="0" role="region" aria-label="Release comparison"><table class="compact-table comparison-table"><thead><tr><th rowspan="2">Level</th><th colspan="3">${escapeHTML(releaseA)}</th><th colspan="3">${escapeHTML(releaseB)}</th><th rowspan="2">Drop change · B vs A</th></tr><tr><th>Start</th><th>Finish</th><th>Drop</th><th>Start</th><th>Finish</th><th>Drop</th></tr></thead><tbody>${numbers.map(level => {
        const first = maps[0].get(level); const second = maps[1].get(level);
        const before = first?.transition?.drop_percent; const after = second?.transition?.drop_percent;
        const change = before == null || after == null ? null : Math.round((after - before) * 10) / 10;
        const small = first?.low_sample || second?.low_sample;
        const difference = change == null ? '<span class="muted">Not comparable</span>' : `<span class="${small ? 'muted' : change > 0 ? 'loss' : change < 0 ? 'gain' : 'muted'}">${change > 0 ? '↑ +' : change < 0 ? '↓ −' : ''}${Math.abs(change)} pp · ${change > 0 ? 'more drop' : change < 0 ? 'less drop' : 'unchanged'}${small ? ' · small sample' : ''}</span>`;
        return `<tr><td><button type="button" class="text-link level-jump-link" data-jump-level="${level}">${level}</button></td>${[first, second].map(row => `<td>${row ? number(row.started) : '—'}</td><td>${row ? number(row.completed) : '—'}</td><td>${drop(row)}</td>`).join('')}<td>${difference}</td></tr>`;
      }).join('')}</tbody></table></div><p class="help">pp = percentage points. Missing next-level data is not treated as zero drop. Small samples are marked; these comparisons describe observed behavior, not proof a release caused a change.</p>` : '<p class="help">No level events for these releases and filters.</p>';
    } catch (error) { if (valid(ticket)) comparison.innerHTML = loadError(error, 'data-retry-comparison'); }
  };
  container.addEventListener('click', event => {
    if (event.target.closest('[data-retry-comparison]')) compare();
    const jump = event.target.closest('[data-jump-level]');
    if (jump) container.dispatchEvent(new CustomEvent('level-jump', {detail: Number(jump.dataset.jumpLevel)}));
  });
  container.querySelector('#compare-refresh').addEventListener('click', compare);
  versions.forEach((select, index) => select.addEventListener('change', () => { prefs[index ? 'releaseB' : 'releaseA'] = select.value; remember(); compare(); }));
  savedSelect.addEventListener('change', () => {
    storeSet(activeViewKey, savedSelect.value);
    container.querySelector('#levels-delete-view').disabled = !savedSelect.value;
    const view = (storeGet(viewKey) || {})[savedSelect.value];
    if (view) { storeSet(preferenceKey, view.tools || {}); restore(view); }
  });
  container.querySelector('#levels-save-view').addEventListener('click', () => {
    if (!selected) return;
    modal.innerHTML = '<form id="save-level-view"><h2 id="dialog-title">Save level view</h2><p>Remember these filters, sorting, players and chosen releases in this browser.</p><label for="level-view-name">Name</label><input id="level-view-name" name="name" maxlength="80" required placeholder="Latest release · highest drops"><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button type="submit" class="button primary">Save view</button></div></form>';
    modal.showModal();
    bindForm('#save-level-view', async (form, values) => {
      const name = values.name.trim();
      if (!name) throw new Error('Enter a name for this view.');
      storeSet(viewKey, {...(storeGet(viewKey) || {}), [name]: {filters: structuredClone(selected), tools: {...prefs}, sort: document.querySelector('#levels-sort').value, pageSize: document.querySelector('#levels-page-size').value, scope: document.querySelector('[data-levels-scope][aria-pressed="true"]')?.dataset.levelsScope || 'all'}});
      storeSet(activeViewKey, name);
      await dismissModal(); drawViews(); toast('Level view saved.');
    });
  });
  container.querySelector('#levels-delete-view').addEventListener('click', () => {
    const name = savedSelect.value;
    confirmDialog(`Delete “${name}”?`, 'This removes the saved view from this browser. Your event data is not affected.', 'Delete view', () => {
      const views = storeGet(viewKey) || {}; delete views[name]; storeSet(viewKey, views); storeSet(activeViewKey, ''); drawViews();
    });
  });
  drawViews();
  return {update(state) { selected = structuredClone(state); comparisonTicket++; compare(); }};
}
