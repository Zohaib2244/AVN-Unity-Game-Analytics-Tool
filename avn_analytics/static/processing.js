// Analytics processing (admins only, on the Settings page): start or stop the analytics worker,
// and see what it is doing. Game events are collected either way. Loaded before app.js.

const PROCESSING_URL = '/v1/admin/analytics-worker';
const PROCESSING_POLL_MS = 5000;
const PROCESSING_STATES = {
  running: ['good', 'Running', 'Answers are prepared in the background and kept fresh.'],
  catching_up: ['', 'Catching up', 'Working through events and changes that arrived since it last caught up.'],
  starting: ['', 'Starting', 'Start was requested; waiting for the worker to pick it up.'],
  stopping: ['', 'Stopping', 'Stop was requested; the worker stops after the step it is on.'],
  stopped: ['bad', 'Stopped', 'Events are still collected. Dashboards work things out when opened, which takes longer, and nothing is prepared in advance.'],
  unavailable: ['bad', 'Unavailable', 'The worker is not running or has stopped reporting. Events are still collected and dashboards still work, more slowly. Check the worker container.'],
};

function processingWaiting(status) {
  const pending = status.pending || {};
  const parts = [];
  if (pending.facts_remaining) parts.push(`${number(pending.facts_remaining)} older events to copy or check`);
  if (pending.views_waiting) parts.push(`${number(pending.views_waiting)} answers to bring up to date`);
  if (pending.lag_seconds) parts.push(`newest unprocessed change ${Math.round(pending.lag_seconds)} s old`);
  return parts.length ? parts.join(' · ') : 'Nothing';
}

function processingFacts(game) {
  const facts = game.facts;
  if (facts.ready) return 'Ready';
  const share = facts.total ? ` · ${Math.min(99, Math.floor(100 * facts.done / facts.total))}% of this step` : '';
  return `${{backfill: 'Copying older events', coverage: 'Checking every event is copied', values: 'Checking copied values'}[facts.phase] || facts.phase}${share}`;
}

async function mountProcessingPanel(root) {
  if (!root) return;
  let status;
  try { status = await request(PROCESSING_URL); }
  catch (problem) { root.innerHTML = `<div class="panel-body"><p class="error">${escapeHTML(problem.message)}</p></div>`; return; }
  root.innerHTML = `<div class="panel-header"><div><h2>Analytics processing</h2><p>Prepares the dashboards’ answers in the background, for every game.</p></div><span class="pill" data-processing-pill></span></div>
    <div class="panel-body">
      <p class="help" data-processing-explain></p>
      <ul class="status-list">
        <li><span>Requested</span><strong data-processing-requested></strong></li>
        <li><span>Worker</span><strong data-processing-worker></strong></li>
        <li><span>Working on</span><strong data-processing-job></strong></li>
        <li><span>Waiting</span><strong data-processing-waiting></strong></li>
        <li><span>Last update</span><strong data-processing-success></strong></li>
      </ul>
      <p class="error" role="alert" data-processing-error hidden></p>
      <div class="form-actions"><button type="button" class="button" data-processing-toggle></button><span class="small muted" role="status" data-processing-ack></span></div>
      <details class="section-spacing"><summary class="small">Each game</summary><ul class="status-list" data-processing-games></ul></details>
      <p class="help">Game events are always collected, whether processing runs or not. Stopping is safe at any time: work resumes where it left off.</p>
    </div>`;
  const find = name => root.querySelector(`[data-processing-${name}]`);
  const toggle = find('toggle');
  const show = next => {
    status = next;
    const [kind, label, explain] = PROCESSING_STATES[status.state] || ['', status.state, ''];
    const pill = find('pill');
    pill.className = `pill ${kind}`;
    pill.textContent = label;
    find('explain').textContent = explain;
    find('requested').textContent = `${status.desired === 'running' ? 'Run' : 'Stop'} · by ${status.changed_by} · ${displayDate(status.changed_at)}`;
    const worker = status.worker;
    find('worker').textContent = !worker ? 'Never seen' : status.state === 'unavailable' ? `Last seen ${agoText(worker.heartbeat_at)}` : `Seen ${Math.round(worker.heartbeat_age_seconds)} s ago`;
    find('job').textContent = worker && worker.job && status.state !== 'unavailable' ? `${worker.game || 'A game'} · ${worker.job}` : 'Nothing';
    find('waiting').textContent = processingWaiting(status);
    find('success').textContent = status.last_success_at ? displayDate(status.last_success_at) : 'Not yet';
    const error = find('error');
    error.hidden = !status.error;
    error.textContent = status.errors.map(item => `${item.game || 'A game'} · ${displayDate(item.at)}: ${item.message}`).join(' · ');
    if (!toggle.disabled) toggle.textContent = status.desired === 'running' ? 'Stop processing' : 'Start processing';
    toggle.classList.toggle('primary', status.desired !== 'running');
    find('games').innerHTML = status.games.map(game => `<li><span>${escapeHTML(game.name)}</span><strong>${escapeHTML(processingFacts(game))}${game.views ? ` · ${number(game.views)} prepared answer${game.views === 1 ? '' : 's'}` : ''}</strong></li>`).join('') || '<li><span>No games yet</span></li>';
  };
  show(status);
  toggle.addEventListener('click', async () => {
    if (toggle.disabled) return;
    const desired = status.desired === 'running' ? 'stopped' : 'running';
    const hadFocus = document.activeElement === toggle;
    toggle.disabled = true;
    toggle.setAttribute('aria-busy', 'true');
    toggle.innerHTML = spinner('Saving…');
    find('ack').textContent = '';
    try {
      status = await request(PROCESSING_URL, {method: 'PUT', body: JSON.stringify({desired})});
      find('ack').textContent = desired === 'running' ? 'Start requested.' : 'Stop requested. Events are still collected.';
    } catch (problem) {
      toastError(problem);
    } finally {
      toggle.removeAttribute('aria-busy');
      toggle.disabled = false;
      show(status);
      if (hadFocus && root.isConnected) toggle.focus();
    }
  });
  // Keep the status current while the page is open, without rebuilding it (focus stays put).
  const timer = setInterval(async () => {
    if (!root.isConnected) { clearInterval(timer); return; }
    if (document.hidden || toggle.disabled) return;
    try { const next = await request(PROCESSING_URL); if (root.isConnected) show(next); } catch { /* the next poll tries again */ }
  }, PROCESSING_POLL_MS);
}
