// NutBot: the assistant panel on game pages. It talks to the server, which runs a local AI agent CLI
// with this app's tools; answers stream back as newline-delimited JSON. Loaded before app.js and
// uses its helpers (request, icon, escapeHTML, toast, navigate, gamePath, filterState…) at call time.

const NUTBOT_KEEP = 60; // messages remembered per game in this browser
let nutbotState = {open: false, busy: false, game: null, info: null, convo: null, controller: null, usable: false};

function nbMarkdown(source) {
  const inline = text => escapeHTML(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  const lines = String(source).replace(/\r/g, '').split('\n');
  const html = []; let i = 0;
  const special = line => /^(```|#{1,4}\s|\s*[-*]\s+|\s*\d+[.)]\s+|\|)/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const body = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++; html.push(`<pre><code>${escapeHTML(body.join('\n'))}</code></pre>`); continue;
    }
    if (/^\|.*\|\s*$/.test(line) && lines[i + 1] && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      html.push(`<div class="nb-table"><table><thead><tr>${head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) { html.push(`<h4>${inline(heading[1])}</h4>`); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      html.push(`<ul>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      html.push(`<ol>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ol>`); continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !(paragraph.length && special(lines[i]))) paragraph.push(lines[i++]);
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return html.join('');
}

const nbFace = state => `<span class="nb-face ${state}" aria-hidden="true"><svg viewBox="0 0 32 32" width="30" height="30"><rect x="3" y="5" width="26" height="22" rx="6" class="nb-head"/><rect x="9" y="12" width="4" height="6" rx="1.5" class="nb-eye nb-eye-l"/><rect x="19" y="12" width="4" height="6" rx="1.5" class="nb-eye nb-eye-r"/><path d="M11 22h10" class="nb-mouth"/><path d="M16 5V2" class="nb-antenna"/><circle cx="16" cy="2" r="1.4" class="nb-tip"/></svg></span>`;

const nbKey = game => `avn-nutbot-${game.id}`;
const nbPrefs = () => storeGet('avn-nutbot-prefs') || {};
function nbLoad(game) {
  const saved = storeGet(nbKey(game));
  return saved && Array.isArray(saved.messages) ? saved : {session: null, harness: null, messages: []};
}
function nbSave() {
  const {convo, game} = nutbotState;
  if (!convo || !game) return;
  storeSet(nbKey(game), {session: convo.session, harness: convo.harness, messages: convo.messages.slice(-NUTBOT_KEEP)});
}

function nbAllowed(game) {
  const workspace = me.workspaces.find(item => item.id === (game.workspace_id || currentWorkspace));
  return Boolean(me.is_admin || workspace?.nutbot);
}

function nbContext(game) {
  const filters = filterState(game);
  const query = new URLSearchParams(location.search);
  let funnel = storeGet(`avn-funnel-draft-${game.id}`);
  if (funnel?.steps?.length) funnel = {steps: funnel.steps.map(({event, param, op, value, label}) => ({event, param, op, value, label})).slice(0, 30), scope: funnel.scope, window_hours: funnel.window_hours};
  else funnel = null;
  return {
    page: currentSection,
    range: filters.range ? {from: filters.range.from, to: filters.range.to} : undefined,
    hide_test: filters.hideTest,
    filters: {environments: filters.environment, app_versions: filters.app_version, builds: filters.build, countries: filters.country, platforms: filters.platform},
    player: query.get('player') || undefined,
    funnel: funnel || undefined,
  };
}

function nbOpenAction(action) {
  const game = nutbotState.game;
  if (!game || action.game_id !== game.id) { toast('That belongs to another game.'); return; }
  if (action.start && action.end) {
    const filters = filterState(game);
    saveFilters(game, {...filters, range: {preset: 'custom', from: action.start, to: action.end}});
  }
  if (action.page === 'funnels' && action.funnel?.steps?.length) {
    storeSet(`avn-funnel-draft-${game.id}`, {id: null, name: '', steps: action.funnel.steps.map(step => ({event: step.event, param: step.param || '', op: step.op || 'eq', value: step.value || '', label: step.label || ''})), scope: action.funnel.scope || 'player', window_hours: action.funnel.window_hours || null});
    if (action.show_journeys) storeSet(`avn-pending-journeys-${game.id}`, 1);
  }
  const query = action.page === 'players' && action.player ? `?${new URLSearchParams({player: action.player})}` : '';
  navigate(`${gamePath(game, action.page)}${query}`);
}

function nbMessageHTML(message, index, streaming) {
  if (message.role === 'user') return `<div class="nb-msg user"><div class="nb-bubble">${escapeHTML(message.text)}</div></div>`;
  const tools = (message.tools || []).map(tool => `<span class="nb-tool ${tool.done ? 'done' : ''}">${escapeHTML(tool.label)}${tool.done ? '' : '…'}</span>`).join('');
  const actions = (message.actions || []).map((action, position) => `<button type="button" class="button small-button nb-action" data-action-index="${index}:${position}">${icon('arrow', 13)} ${escapeHTML(action.title)}</button>`).join('');
  const body = message.text ? nbMarkdown(message.text) : streaming ? '<p class="muted nb-wait">Thinking…</p>' : '';
  const error = message.error ? `<p class="nb-error">${escapeHTML(message.error)}</p>` : '';
  const meta = message.usage && !streaming ? `<div class="nb-meta">${message.usage.output_tokens != null ? `${number(message.usage.output_tokens)} tokens out` : ''}${message.seconds ? ` · ${message.seconds}s` : ''}</div>` : '';
  return `<div class="nb-msg bot">${tools ? `<div class="nb-tools">${tools}</div>` : ''}<div class="nb-bubble">${body}${error}</div>${actions ? `<div class="nb-actions">${actions}</div>` : ''}${meta}</div>`;
}

function nbRender() {
  const root = document.querySelector('#nutbot-root');
  const list = root?.querySelector('.nb-messages');
  if (!list) return;
  const {convo, busy} = nutbotState;
  const stuck = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.innerHTML = !nutbotState.usable ? '' : convo.messages.length ? convo.messages.map((message, index) => nbMessageHTML(message, index, busy && index === convo.messages.length - 1)).join('') : `<div class="nb-hello">${nbFace('idle')}<h3>Ask me about your players</h3><p>I can run funnels, follow journeys, read a player’s story, check levels, and save what we find. Try:</p><div class="nb-suggest">${['Where are players dropping off in the first 10 levels?', 'Which level is hardest, and why do you think so?', 'Show me what a typical first session looks like.', 'Build a funnel from first open to level 10.'].map(text => `<button type="button" class="nb-chip" data-suggest="${escapeHTML(text)}">${escapeHTML(text)}</button>`).join('')}</div></div>`;
  if (stuck || busy) list.scrollTop = list.scrollHeight;
  root.querySelector('.nb-head-face').innerHTML = nbFace(busy ? 'thinking' : 'idle');
  root.querySelector('.nb-send').innerHTML = busy ? `${icon('close', 14)} Stop` : `${icon('arrow', 14)} Send`;
  root.querySelector('.nb-send').classList.toggle('danger', busy);
  root.querySelector('.nb-send').classList.toggle('primary', !busy);
}

async function nbSend(text) {
  const state = nutbotState;
  if (state.busy || !text.trim()) return;
  const root = document.querySelector('#nutbot-root');
  const prefs = nbPrefs();
  const harness = root.querySelector('.nb-harness').value;
  const model = root.querySelector('.nb-model').value;
  if (state.convo.harness && state.convo.harness !== harness) state.convo.session = null; // another assistant can't continue that chat
  state.convo.harness = harness;
  state.convo.messages.push({role: 'user', text: text.trim()});
  const answer = {role: 'assistant', text: '', tools: [], actions: []};
  state.convo.messages.push(answer);
  state.busy = true; state.controller = new AbortController();
  storeSet('avn-nutbot-prefs', {...prefs, harness, models: {...(prefs.models || {}), [harness]: model}});
  nbRender();
  const started = Date.now();
  try {
    const response = await fetch(`/v1/games/${encodeURIComponent(state.game.id)}/nutbot/chat`, {
      method: 'POST', credentials: 'same-origin', signal: state.controller.signal, headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message: text.trim(), harness, model: model || undefined, session_id: state.convo.session || undefined, context: nbContext(state.game)}),
    });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(typeof error.detail === 'string' ? error.detail : 'NutBot could not answer.'); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'session') state.convo.session = event.id;
        else if (event.type === 'text') answer.text += event.text;
        else if (event.type === 'tool') answer.tools.push({name: event.name, label: event.label, done: false});
        else if (event.type === 'tool_result') { const open = answer.tools.find(tool => !tool.done); if (open) open.done = true; }
        else if (event.type === 'action') answer.actions.push(event);
        else if (event.type === 'usage') answer.usage = event;
        else if (event.type === 'error') answer.error = event.message;
        else if (event.type === 'done') answer.seconds = event.seconds;
        nbRender();
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') answer.error = error.message;
    else answer.error = 'Stopped.';
  } finally {
    answer.tools.forEach(tool => { tool.done = true; });
    answer.seconds = answer.seconds || Math.round((Date.now() - started) / 100) / 10;
    state.busy = false; state.controller = null;
    nbSave(); nbRender();
  }
}

function nbModelOptions(harness, chosen) {
  const info = nutbotState.info?.harnesses.find(item => item.id === harness);
  const models = info?.models?.length ? info.models : [''];
  return models.map(model => `<option value="${escapeHTML(model)}" ${model === chosen ? 'selected' : ''}>${escapeHTML(model || 'default')}</option>`).join('');
}

function nbOpen() {
  const state = nutbotState;
  if (!state.game) return;
  state.open = true;
  let root = document.querySelector('#nutbot-root');
  if (!root) { root = document.createElement('div'); root.id = 'nutbot-root'; document.body.append(root); }
  state.convo = state.convo || nbLoad(state.game);
  const info = state.info; const prefs = nbPrefs();
  const usable = info?.harnesses.filter(item => item.available) || [];
  state.usable = usable.length > 0;
  const harness = [state.convo.harness, prefs.harness, info?.default, usable[0]?.id].find(id => usable.some(item => item.id === id)) || usable[0]?.id || '';
  root.innerHTML = `<aside class="nb-panel" role="dialog" aria-label="NutBot" aria-modal="false">
    <header class="nb-header"><span class="nb-head-face"></span><div class="nb-title"><strong>NutBot</strong><span class="small muted">${escapeHTML(state.game.name)} · ${escapeHTML(platformLabel(state.game.platform))}</span></div>
      <button type="button" class="icon-button" data-nb="new" title="New chat" aria-label="New chat">${icon('plus', 15)}</button><button type="button" class="icon-button" data-nb="close" title="Close" aria-label="Close">${icon('close', 15)}</button></header>
    <div class="nb-setup">${usable.length ? `<label class="inline-field">Assistant<select class="nb-harness">${(info.harnesses).map(item => `<option value="${item.id}" ${item.id === harness ? 'selected' : ''} ${item.available ? '' : 'disabled'} title="${escapeHTML(item.reason || '')}">${escapeHTML(item.label)}${item.available ? '' : ' (not set up)'}</option>`).join('')}</select></label><label class="inline-field">Model<select class="nb-model">${nbModelOptions(harness, (prefs.models || {})[harness])}</select></label>` : ''}</div>
    ${usable.length ? '' : `<div class="nb-setup-help"><h3>NutBot isn’t set up on this server yet</h3><p>An admin needs to connect an assistant (Claude, OpenCode or Codex). The steps are in the README under “NutBot”.</p>${(info?.harnesses || []).map(item => `<p class="small muted"><strong>${escapeHTML(item.label)}:</strong> ${escapeHTML(item.reason)}</p>`).join('')}</div>`}
    <div class="nb-messages" aria-live="polite"></div>
    <form class="nb-form"><textarea class="nb-input" rows="2" maxlength="4000" placeholder="Ask about your players…" ${usable.length ? '' : 'disabled'}></textarea><button type="submit" class="button primary nb-send" ${usable.length ? '' : 'disabled'}></button></form>
    <p class="nb-foot small muted">NutBot can read this game’s data. It asks before saving anything. Answers can be wrong: check the numbers that matter.</p></aside>`;
  root.classList.add('open');
  document.querySelector('.nb-launcher')?.setAttribute('aria-expanded', 'true');
  root.querySelector('.nb-harness')?.addEventListener('change', event => {
    root.querySelector('.nb-model').innerHTML = nbModelOptions(event.target.value, (nbPrefs().models || {})[event.target.value]);
  });
  root.querySelector('.nb-form').addEventListener('submit', event => {
    event.preventDefault();
    if (state.busy) { state.controller?.abort(); return; }
    const input = root.querySelector('.nb-input'); const text = input.value; input.value = '';
    nbSend(text);
  });
  root.querySelector('.nb-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); root.querySelector('.nb-form').requestSubmit(); }
    if (event.key === 'Escape') nbClose();
  });
  if (!root.dataset.bound) root.addEventListener('click', event => {
    const state = nutbotState;
    const control = event.target.closest('[data-nb]');
    if (control?.dataset.nb === 'close') nbClose();
    if (control?.dataset.nb === 'new' && !state.busy) { state.convo = {session: null, harness: null, messages: []}; nbSave(); nbRender(); }
    const suggest = event.target.closest('[data-suggest]');
    if (suggest && !state.busy) nbSend(suggest.dataset.suggest);
    const button = event.target.closest('[data-action-index]');
    if (button) { const [message, position] = button.dataset.actionIndex.split(':').map(Number); const action = state.convo.messages[message]?.actions?.[position]; if (action) nbOpenAction(action); }
  });
  root.dataset.bound = '1';
  nbRender();
  root.querySelector('.nb-input').focus();
}

function nbClose() {
  nutbotState.open = false;
  document.querySelector('#nutbot-root')?.classList.remove('open');
  document.querySelector('.nb-launcher')?.setAttribute('aria-expanded', 'false');
  document.querySelector('.nb-launcher')?.focus();
}

// Called after every page render: shows the launcher on game pages (locked when this person has no access).
async function mountNutBot() {
  const game = typeof currentGame !== 'undefined' ? currentGame : null;
  document.querySelector('.nb-launcher')?.remove();
  if (!game) { nutbotState.game = null; document.querySelector('#nutbot-root')?.classList.remove('open'); nutbotState.open = false; return; }
  if (nutbotState.game?.id !== game.id) { nutbotState.convo = null; if (nutbotState.open) { nutbotState.open = false; document.querySelector('#nutbot-root')?.classList.remove('open'); } }
  nutbotState.game = game;
  const allowed = nbAllowed(game);
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = `nb-launcher ${allowed ? '' : 'locked'}`;
  launcher.setAttribute('aria-expanded', String(nutbotState.open));
  launcher.title = allowed ? 'Ask NutBot' : 'NutBot isn’t switched on for your role in this workspace. Ask an admin.';
  launcher.innerHTML = `${allowed ? nbFace('idle') : `<span class="nb-lock">${icon('lock', 18)}</span>`}<span>NutBot</span>`;
  launcher.addEventListener('click', async () => {
    if (!allowed) { toast('NutBot isn’t switched on for your role in this workspace. Ask an admin to enable it.'); return; }
    if (nutbotState.open) { nbClose(); return; }
    if (!nutbotState.info) { try { nutbotState.info = await request('/v1/nutbot'); } catch (error) { toast(error.message); return; } }
    if (!nutbotState.info.enabled) { toast('NutBot is turned off on this server.'); return; }
    nbOpen();
  });
  (document.querySelector('.topbar-right') || document.body).prepend(launcher);
  if (nutbotState.open && allowed) nbOpen();
}
