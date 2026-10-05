// Team management (admin) and per-game access (admin and team leads). Loaded before app.js.

const ACTION_LABELS = {
  'game.register': 'Registered a game', 'game.update': 'Edited a game', 'game.delete': 'Deleted a game',
  'icon.set': 'Changed a game icon', 'icon.clear': 'Removed a game icon',
  'key.create': 'Created an API key', 'key.delete': 'Deleted an API key',
  'dictionary.set': 'Edited the event dictionary', 'dictionary.delete': 'Removed a dictionary entry',
  'export.download': 'Exported data', 'user.add': 'Added a person', 'user.role': 'Changed a role',
  'user.remove': 'Removed a person', 'access.set': 'Changed a person’s games', 'access.game': 'Changed who sees a game',
};
const gameLabel = game => `${game.name} · ${platformLabel(game.platform)}`;

async function renderTeam() {
  if (!me.can_manage_team) {
    shell('Team', heading('Team', 'Only the admin can manage the team.') + '<a class="button" href="/">Back to games</a>');
    return;
  }
  const [users, activity] = await Promise.all([request('/v1/team'), request('/v1/audit')]);
  const games = overview.games;
  const names = Object.fromEntries(games.map(game => [game.id, gameLabel(game)]));
  const seen = value => value ? displayDate(value) : 'Never';
  shell('Team', heading('Team', 'Only people listed here can use the dashboard, even if their email gets through Cloudflare.', `<button class="button primary" id="add-person">${icon('plus',15)} Add person</button>`) +
    `<section class="panel"><div class="panel-header"><h2>People <span class="count">${users.length}</span></h2><p class="small muted">Admin: everything · Team lead: manages games and access · Member: works with the games they’re given</p></div>
    <div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Games</th><th>Last seen</th><th></th></tr></thead><tbody>${users.map(user => `<tr data-email="${escapeHTML(user.email)}"><td>${escapeHTML(user.name || user.email.split('@')[0])}<p class="small muted">${escapeHTML(user.email)}</p></td>
      <td><select data-role aria-label="Role of ${escapeHTML(user.email)}" ${user.email === me.email ? 'disabled' : ''}>${Object.entries(ROLE_LABELS).map(([key, label]) => `<option value="${key}" ${key === user.role ? 'selected' : ''}>${label}</option>`).join('')}</select></td>
      <td>${user.role === 'member' ? `<button type="button" class="link-button" data-games>${user.game_ids.length ? `${user.game_ids.length} game${user.game_ids.length === 1 ? '' : 's'}` : 'None yet'} · choose</button>` : '<span class="muted">All games</span>'}</td>
      <td class="small muted">${seen(user.last_seen_at)}</td>
      <td>${user.email === me.email ? '' : '<button type="button" class="button danger table-action" data-remove>Remove</button>'}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="panel section-spacing"><div class="panel-header"><div><h2>Recent activity</h2><p>The last ${activity.length} changes: who did what, and when</p></div></div>${activity.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${activity.map(row => `<tr><td class="small muted">${displayDate(row.at)}</td><td class="small">${escapeHTML(row.actor)}</td><td>${escapeHTML(ACTION_LABELS[row.action] || row.action)}</td><td class="small muted">${row.game_id && names[row.game_id] ? `${escapeHTML(names[row.game_id])} · ` : ''}${escapeHTML(row.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help panel-body">Nothing yet.</p>'}</section>`);

  const reload = async message => { cache.clear(); await renderTeam(); if (message) toast(message); };
  const gameBoxes = chosen => games.length ? `<div class="check-list">${games.map(game => `<label class="check-row"><input type="checkbox" name="game" value="${game.id}" ${chosen.includes(game.id) ? 'checked' : ''}> ${escapeHTML(gameLabel(game))}</label>`).join('')}</div>` : '<p class="help">No games registered yet.</p>';

  document.querySelector('#add-person').addEventListener('click', () => {
    modal.innerHTML = `<form id="person-form"><h2 id="dialog-title">Add a person</h2><p>They sign in through Cloudflare with their work email; this list decides what they can do.</p>
      <div class="field"><label for="person-email">Work email</label><input id="person-email" name="email" type="email" required placeholder="name@finz.io" autocomplete="off"></div>
      <div class="field"><label for="person-name">Name (optional)</label><input id="person-name" name="name" maxlength="80"></div>
      <div class="field"><label for="person-role">Role</label><select id="person-role" name="role"><option value="member">Member: works with the games they’re given</option><option value="lead">Team lead: manages games and who sees them</option><option value="admin">Admin: everything, including this page</option></select></div>
      <div class="field" id="person-games"><label>Games they can see</label>${gameBoxes([])}</div>
      <div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Add person</button></div></form>`;
    modal.showModal();
    const role = modal.querySelector('#person-role');
    role.addEventListener('change', () => { modal.querySelector('#person-games').hidden = role.value !== 'member'; });
    bindForm('#person-form', async (form, values) => {
      const game_ids = [...form.querySelectorAll('input[name="game"]:checked')].map(input => input.value);
      await request('/v1/team', {method:'POST', body: JSON.stringify({email: values.email, name: values.name, role: values.role, game_ids: values.role === 'member' ? game_ids : []})});
      modal.close(); await reload('Person added.');
    });
  });
  document.querySelectorAll('tr[data-email]').forEach(row => {
    const email = row.dataset.email; const user = users.find(item => item.email === email);
    row.querySelector('[data-role]')?.addEventListener('change', async event => {
      try { await request(`/v1/team/${encodeURIComponent(email)}`, {method:'PATCH', body: JSON.stringify({role: event.target.value})}); await reload('Role updated.'); }
      catch (error) { toast(error.message); await reload(); }
    });
    row.querySelector('[data-games]')?.addEventListener('click', () => {
      modal.innerHTML = `<form id="games-form"><h2 id="dialog-title">Games for ${escapeHTML(user.name || email)}</h2><p>${escapeHTML(email)} can open only the games ticked here.</p>${gameBoxes(user.game_ids)}<div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">Save</button></div></form>`;
      modal.showModal();
      bindForm('#games-form', async form => {
        const game_ids = [...form.querySelectorAll('input[name="game"]:checked')].map(input => input.value);
        await request(`/v1/team/${encodeURIComponent(email)}`, {method:'PATCH', body: JSON.stringify({game_ids})});
        modal.close(); await reload('Access updated.');
      });
    });
    row.querySelector('[data-remove]')?.addEventListener('click', () => confirmDialog(`Remove ${user.name || email}?`, 'They lose access immediately. Their past activity stays in the log.', 'Remove person', async () => {
      await request(`/v1/team/${encodeURIComponent(email)}`, {method:'DELETE'}); modal.close(); await reload('Person removed.');
    }));
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
