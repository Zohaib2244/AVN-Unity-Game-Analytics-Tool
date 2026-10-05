// Team management (admin) and per-game access (admin and team leads). Loaded before app.js.

const ACTION_LABELS = {
  'game.register': 'Registered a game', 'game.update': 'Edited a game', 'game.delete': 'Deleted a game',
  'icon.set': 'Changed a game icon', 'icon.clear': 'Removed a game icon',
  'key.create': 'Created an API key', 'key.delete': 'Deleted an API key',
  'dictionary.set': 'Edited the event dictionary', 'dictionary.delete': 'Removed a dictionary entry',
  'export.download': 'Exported data', 'user.add': 'Added a person', 'user.role': 'Changed a role',
  'user.remove': 'Removed a person', 'workspace.create': 'Created a workspace', 'workspace.rename': 'Renamed a workspace', 'workspace.delete': 'Deleted a workspace', 'game.move': 'Moved a game', 'access.set': 'Changed a person’s games', 'access.game': 'Changed who sees a game',
};
const gameLabel = game => `${game.name} · ${platformLabel(game.platform)}`;

async function renderTeam() {
  if (!me.can_manage_team) {
    shell('Team', heading('Team', 'Only the admin can manage the team.') + '<a class="button" href="/">Back to games</a>');
    return;
  }
  const [people, activity] = await Promise.all([request('/v1/team'), request('/v1/audit')]);
  const here = currentWorkspace;
  const members = people.filter(person => person.memberships[here]);
  const admins = people.filter(person => person.admin);
  const games = overview.games;
  const names = Object.fromEntries(games.map(game => [game.id, gameLabel(game)]));
  const seen = value => value ? displayDate(value) : 'Never';
  const row = person => `<tr data-email="${escapeHTML(person.email)}"><td>${escapeHTML(person.name || person.email.split('@')[0])}<p class="small muted">${escapeHTML(person.email)}</p></td>
      <td><select data-role aria-label="Role of ${escapeHTML(person.email)}"><option value="member" ${person.memberships[here] === 'member' ? 'selected' : ''}>Member</option><option value="lead" ${person.memberships[here] === 'lead' ? 'selected' : ''}>Team lead</option></select></td>
      <td>${person.memberships[here] === 'member' ? `<button type="button" class="link-button" data-games>${person.game_ids.filter(id => names[id]).length ? `${person.game_ids.filter(id => names[id]).length} game${person.game_ids.filter(id => names[id]).length === 1 ? '' : 's'}` : 'None yet'} · choose</button>` : '<span class="muted">All games</span>'}</td>
      <td class="small muted">${seen(person.last_seen_at)}</td>
      <td><button type="button" class="button danger table-action" data-remove>Remove</button></td></tr>`;
  shell('Team', heading('Team', `Who can use ${workspaceName()}, and what they can do there. People who sign in without being listed see a “no access” page.`, `<button class="button primary" id="add-person">${icon('plus',15)} Add person</button>`) +
    `<section class="panel"><div class="panel-header"><h2>${escapeHTML(workspaceName())} <span class="count">${members.length}</span></h2><p class="small muted">Team lead: manages the workspace’s games and who sees them · Member: works with the games they’re given</p></div>
    ${members.length ? `<div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Games</th><th>Last seen</th><th></th></tr></thead><tbody>${members.map(row).join('')}</tbody></table></div>` : '<p class="help panel-body">Nobody yet. Add the people who work on these games.</p>'}</section>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>Admins <span class="count">${admins.length}</span></h2><p>See and manage every workspace, plus workspaces and people</p></div></div><div class="table-wrap"><table><tbody>${admins.map(person => `<tr data-admin="${escapeHTML(person.email)}"><td>${escapeHTML(person.name || person.email.split('@')[0])}<p class="small muted">${escapeHTML(person.email)}</p></td><td class="small muted">${seen(person.last_seen_at)}</td><td>${person.email === me.email ? '<span class="muted small">You</span>' : '<button type="button" class="button danger table-action" data-demote>Remove admin</button>'}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>Recent activity</h2><p>The last ${activity.length} changes across every workspace</p></div></div>${activity.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${activity.map(item => `<tr><td class="small muted">${displayDate(item.at)}</td><td class="small">${escapeHTML(item.actor)}</td><td>${escapeHTML(ACTION_LABELS[item.action] || item.action)}</td><td class="small muted">${item.game_id && names[item.game_id] ? `${escapeHTML(names[item.game_id])} · ` : ''}${escapeHTML(item.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help panel-body">Nothing yet.</p>'}</section>`);

  const reload = async message => { cache.clear(); overviewStale = true; await loadOverview(); await renderTeam(); if (message) toast(message); };
  const gameBoxes = chosen => games.length ? `<div class="check-list">${games.map(game => `<label class="check-row"><input type="checkbox" name="game" value="${game.id}" ${chosen.includes(game.id) ? 'checked' : ''}> ${escapeHTML(gameLabel(game))}</label>`).join('')}</div>` : '<p class="help">No games in this workspace yet.</p>';
  const patch = (email, body) => request(`/v1/team/${encodeURIComponent(email)}`, {method:'PATCH', body: JSON.stringify(body)});

  document.querySelector('#add-person').addEventListener('click', () => {
    modal.innerHTML = `<form id="person-form"><h2 id="dialog-title">Add a person to ${escapeHTML(workspaceName())}</h2><p>They sign in through Cloudflare, so also allow their email there. This list decides what they can do.</p>
      <div class="field"><label for="person-email">Email</label><input id="person-email" name="email" type="email" required placeholder="name@example.com" autocomplete="off"></div>
      <div class="field"><label for="person-name">Name (optional)</label><input id="person-name" name="name" maxlength="80"></div>
      <div class="field"><label for="person-role">Role</label><select id="person-role" name="role"><option value="member">Member: works with the games they’re given</option><option value="lead">Team lead: manages this workspace’s games and who sees them</option><option value="admin">Admin: everything, in every workspace</option></select></div>
      <div class="field" id="person-games"><label>Games they can see</label>${gameBoxes([])}</div>
      <div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Add person</button></div></form>`;
    modal.showModal();
    const role = modal.querySelector('#person-role');
    role.addEventListener('change', () => { modal.querySelector('#person-games').hidden = role.value !== 'member'; });
    bindForm('#person-form', async (form, values) => {
      const game_ids = [...form.querySelectorAll('input[name="game"]:checked')].map(input => input.value);
      await request('/v1/team', {method:'POST', body: JSON.stringify({email: values.email, name: values.name, role: values.role, workspace_id: here, game_ids: values.role === 'member' ? game_ids : []})});
      modal.close(); await reload('Person added.');
    });
  });
  document.querySelectorAll('tr[data-email]').forEach(tr => {
    const email = tr.dataset.email; const person = people.find(item => item.email === email);
    tr.querySelector('[data-role]')?.addEventListener('change', async event => {
      try { await patch(email, {workspace_id: here, role: event.target.value}); await reload('Role updated.'); }
      catch (error) { toast(error.message); await reload(); }
    });
    tr.querySelector('[data-games]')?.addEventListener('click', () => {
      modal.innerHTML = `<form id="games-form"><h2 id="dialog-title">Games for ${escapeHTML(person.name || email)}</h2><p>${escapeHTML(email)} can open only the games ticked here.</p>${gameBoxes(person.game_ids)}<div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Save</button></div></form>`;
      modal.showModal();
      bindForm('#games-form', async form => {
        await patch(email, {workspace_id: here, game_ids: [...form.querySelectorAll('input[name="game"]:checked')].map(input => input.value)});
        modal.close(); await reload('Access updated.');
      });
    });
    tr.querySelector('[data-remove]')?.addEventListener('click', () => confirmDialog(`Remove ${person.name || email} from ${workspaceName()}?`, `They lose access to this workspace immediately${Object.keys(person.memberships).length > 1 ? ' and keep their other workspaces' : ', and will see a “no access” page if they have no other workspace'}.`, 'Remove', async () => {
      await request(`/v1/team/${encodeURIComponent(email)}?workspace_id=${encodeURIComponent(here)}`, {method:'DELETE'}); modal.close(); await reload('Person removed.');
    }));
  });
  document.querySelectorAll('[data-demote]').forEach(button => button.addEventListener('click', async () => {
    const email = button.closest('tr').dataset.admin;
    try { await patch(email, {admin: false}); await reload('Admin rights removed. They keep any workspace roles they have.'); } catch (error) { toast(error.message); }
  }));
}

async function renderWorkspaces() {
  if (!me.can_manage_team) {
    shell('Workspaces', heading('Workspaces', 'Only the admin can manage workspaces.') + '<a class="button" href="/">Back to games</a>');
    return;
  }
  const list = await request('/v1/workspaces');
  shell('Workspaces', heading('Workspaces', 'A workspace is a separate set of games and people, such as work and personal projects.', `<button class="button primary" id="new-workspace">${icon('plus',15)} New workspace</button>`) +
    `<section class="panel"><div class="table-wrap"><table><thead><tr><th>Name</th><th class="num">Games</th><th class="num">People</th><th></th></tr></thead><tbody>${list.map(item => `<tr data-id="${item.id}"><td>${escapeHTML(item.name)}${item.id === currentWorkspace ? ' <span class="pill good">Current</span>' : ''}</td><td class="num">${number(item.games)}</td><td class="num">${number(item.members)}</td><td class="row-actions"><button type="button" class="button small-button" data-open>Open</button> <button type="button" class="button small-button" data-rename>Rename</button> <button type="button" class="button small-button danger-text" data-delete>Delete</button></td></tr>`).join('')}</tbody></table></div></section>
    <p class="help section-spacing">Admins see every workspace. Everyone else sees only the workspaces they’ve been added to, and an admin can move a game between workspaces from its settings.</p>`);
  const reload = async message => { await refreshMe(); await renderWorkspaces(); if (message) toast(message); };
  document.querySelector('#new-workspace').addEventListener('click', () => {
    modal.innerHTML = `<form id="ws-form"><h2 id="dialog-title">New workspace</h2><div class="field"><label for="ws-name">Name</label><input id="ws-name" name="name" required maxlength="60" placeholder="e.g. Personal projects"></div><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Create</button></div></form>`;
    modal.showModal();
    bindForm('#ws-form', async (form, values) => { await request('/v1/workspaces', {method:'POST', body: JSON.stringify({name: values.name})}); modal.close(); await reload('Workspace created.'); });
  });
  document.querySelectorAll('tr[data-id]').forEach(tr => {
    const item = list.find(entry => entry.id === tr.dataset.id);
    tr.querySelector('[data-open]').addEventListener('click', () => { chooseWorkspace(item.id); navigate('/'); });
    tr.querySelector('[data-rename]').addEventListener('click', () => {
      modal.innerHTML = `<form id="ws-form"><h2 id="dialog-title">Rename workspace</h2><div class="field"><label for="ws-name">Name</label><input id="ws-name" name="name" required maxlength="60" value="${escapeHTML(item.name)}"></div><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Save</button></div></form>`;
      modal.showModal();
      bindForm('#ws-form', async (form, values) => { await request(`/v1/workspaces/${item.id}`, {method:'PATCH', body: JSON.stringify({name: values.name})}); modal.close(); await reload('Workspace renamed.'); });
    });
    tr.querySelector('[data-delete]').addEventListener('click', () => {
      const others = list.filter(entry => entry.id !== item.id);
      if (!others.length) { toast('There must always be at least one workspace.'); return; }
      modal.innerHTML = `<form id="ws-delete"><h2 id="dialog-title">Delete ${escapeHTML(item.name)}?</h2><p>This removes the workspace and takes its ${number(item.members)} ${item.members === 1 ? 'person' : 'people'} out of it.</p>
        ${item.games ? `<div class="field"><label class="check-row"><input type="radio" name="what" value="move" checked> Move its ${number(item.games)} game${item.games === 1 ? '' : 's'} to another workspace</label><select name="target" aria-label="Move games to">${others.map(entry => `<option value="${entry.id}">${escapeHTML(entry.name)}</option>`).join('')}</select><label class="check-row"><input type="radio" name="what" value="delete"> Delete its games too (their data goes to the server’s <code>data/deleted</code> folder, not erased)</label></div>` : ''}
        <div class="field"><label for="ws-confirm">Type <code>${escapeHTML(item.name)}</code> to confirm</label><input id="ws-confirm" name="confirm" autocomplete="off" required></div>
        <div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button danger" type="submit">Delete workspace</button></div></form>`;
      modal.showModal();
      bindForm('#ws-delete', async (form, values) => {
        const query = new URLSearchParams({confirm: values.confirm});
        if (item.games) { if (values.what === 'move') query.set('move_to', values.target); else query.set('delete_games', 'true'); }
        await request(`/v1/workspaces/${item.id}?${query}`, {method:'DELETE'});
        modal.close();
        if (currentWorkspace === item.id) ensureWorkspace(values.what === 'move' ? values.target : null);
        await reload('Workspace deleted.');
      });
    });
  });
}

// "Who can see this game": tick the members who may open it (admins and leads always can).
async function loadGameAccess(game) {
  const box = document.querySelector('#access-list'); if (!box) return;
  try {
    const people = await request(`${gameURL(game)}/access`);
    const members = people.filter(person => person.role === 'member');
    const everyone = people.filter(person => person.role !== 'member');
    box.innerHTML = `${members.length ? `<div class="check-list">${members.map(person => `<label class="check-row"><input type="checkbox" value="${escapeHTML(person.email)}" ${person.has_access ? 'checked' : ''}> ${escapeHTML(person.name || person.email.split('@')[0])} <span class="muted small">${escapeHTML(person.email)}</span></label>`).join('')}</div><div class="form-actions"><button class="button primary" type="button" id="save-access">Save access</button></div>` : '<p class="help">There are no members yet. The admin can add people on the Team page.</p>'}${everyone.length ? `<p class="small muted section-spacing">Always have access: ${escapeHTML(everyone.map(person => person.name || person.email).join(', '))}</p>` : ''}`;
    box.querySelector('#save-access')?.addEventListener('click', async () => {
      const emails = [...box.querySelectorAll('input:checked')].map(input => input.value);
      try { await request(`${gameURL(game)}/access`, {method:'PUT', body: JSON.stringify({emails})}); cache.clear(); toast('Access updated.'); }
      catch (error) { toast(error.message); }
    });
  } catch (error) { box.innerHTML = `<p class="error">${escapeHTML(error.message)}</p>`; }
}
