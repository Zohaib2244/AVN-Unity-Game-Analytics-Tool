// AVN UX tools shared by every page: toasts and the notifications bell, popovers, the inspector drawer,
// definition tooltips, auto-refresh, the shortcuts dialog and the entrance motion. Loaded before app.js.

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const uxIcon = (name, size = 16) => (typeof icon === 'function' ? icon(name, size) : '');

/* ─── Toasts and notifications ─── */
const NOTES = [];
const NOTES_KEY = 'avn-notifications';
try { NOTES.push(...JSON.parse(sessionStorage.getItem(NOTES_KEY) || '[]')); } catch { /* storage unavailable */ }
const saveNotes = () => { try { sessionStorage.setItem(NOTES_KEY, JSON.stringify(NOTES.slice(-50))); } catch { /* storage unavailable */ } };
const TOAST_ICON = {ok: 'check', info: 'sparkle', warn: 'shield', bad: 'close'};
const TOAST_MS = {ok: 5000, info: 5000, warn: 8000, bad: 0};
const SUCCESS_WORDS = /\b(copied|saved|added|removed|deleted|created|updated|done|ready|started|hid|restored|renamed|moved|downloaded|imported|applied|cleared|revoked|turned)\b/i;

function toastBox() {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  return box;
}

// toast(message, {label, run}?, 'status' | 'error' | 'info' | 'warn', detail?)
function toast(message, action = null, kind = 'status', detail = '') {
  const tone = kind === 'error' ? 'bad' : kind === 'warn' ? 'warn' : kind === 'info' ? 'info' : SUCCESS_WORDS.test(message) ? 'ok' : 'info';
  const box = toastBox();
  const text = String(message);
  const again = [...box.children].find(item => item.dataset.title === text && item.dataset.tone === tone);
  if (again) {
    const count = Number(again.dataset.count || 1) + 1; again.dataset.count = String(count);
    again.querySelector('.t-n').textContent = `×${count}`; again.querySelector('.t-n').hidden = false;
    restartToast(again); return again;
  }
  const item = document.createElement('div');
  item.className = `toast ${tone}`; item.dataset.title = text; item.dataset.tone = tone;
  item.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
  item.innerHTML = `<span class="t-i">${uxIcon(TOAST_ICON[tone], 13)}</span><div class="t-b"><b>${escapeHTML(text)} <span class="t-n" hidden></span></b>${detail ? `<span class="m">${escapeHTML(detail)}</span>` : ''}</div><button type="button" class="t-x" aria-label="Dismiss">${uxIcon('close', 14)}</button><span class="t-bar" hidden></span>`;
  if (action) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 't-a'; button.textContent = action.label;
    button.addEventListener('click', () => { dismissToast(item); action.run(); }, {once: true});
    item.querySelector('.t-b').append(button);
  }
  item.querySelector('.t-x').addEventListener('click', () => dismissToast(item));
  item.addEventListener('pointerenter', () => pauseToast(item)); item.addEventListener('pointerleave', () => restartToast(item));
  item.addEventListener('focusin', () => pauseToast(item)); item.addEventListener('focusout', () => restartToast(item));
  box.append(item); mo.enter(item, 'toast');
  // At most four on screen; a fifth pushes out the oldest one that is not an error.
  while (box.children.length > 4) { const old = [...box.children].find(child => child.dataset.tone !== 'bad') || box.firstChild; old.remove(); }
  restartToast(item);
  NOTES.push({kind: tone, title: text, msg: detail, time: Date.now(), read: false}); saveNotes(); updateBell();
  return item;
}
function toastError(error) {
  if (error?.name !== 'AbortError') toast(error.message || 'The action failed. Please try again.', null, 'error');
}
function dismissToast(item) {
  if (!item.isConnected) return;
  clearTimeout(item._timer);
  if (reducedMotion()) { item.remove(); return; }
  if (mo.on()) { mo.leave(item, 'toast').then(() => item.remove()); return; }
  item.classList.add('out'); setTimeout(() => item.remove(), 200);
}
function pauseToast(item) { clearTimeout(item._timer); const bar = item.querySelector('.t-bar'); if (bar) bar.getAnimations?.().forEach(animation => animation.pause()); }
function restartToast(item) {
  clearTimeout(item._timer);
  const ms = TOAST_MS[item.dataset.tone] || 0;
  const bar = item.querySelector('.t-bar');
  bar.hidden = !ms;
  if (!ms) return;
  bar.getAnimations?.().forEach(animation => animation.cancel());
  if (!reducedMotion() && bar.animate) bar.animate([{transform: 'scaleX(1)'}, {transform: 'scaleX(0)'}], {duration: ms, easing: 'linear', fill: 'forwards'});
  item._timer = setTimeout(() => dismissToast(item), ms);
}

function updateBell() {
  const unread = NOTES.filter(note => !note.read).length;
  const badge = document.querySelector('#bell-n'); if (!badge) return;
  const was = badge.hidden; badge.hidden = !unread; badge.textContent = unread > 9 ? '9+' : String(unread);
  if (unread && was) mo.pop(badge);
}
const relativeTime = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
function notesHTML() {
  const rows = NOTES.length ? [...NOTES].reverse().map(note => `<div class="note-i ${note.kind}"><span class="t-i">${uxIcon(TOAST_ICON[note.kind], 12)}</span><span><b>${escapeHTML(note.title)}</b>${note.msg ? `<span class="m">${escapeHTML(note.msg)}</span>` : ''}<span class="m" title="${new Date(note.time).toLocaleString()}">${relativeTime(note.time)}</span></span></div>`).join('')
    : '<div class="cmdk-empty">Nothing yet. Results of exports, saves and errors land here, so a toast you missed is never lost.</div>';
  return `<div class="pop-head"><b>Notifications</b>${NOTES.length ? '<button type="button" class="btn sm ghost" data-notes-clear>Clear all</button>' : ''}</div><div class="pop-scroll">${rows}</div>`;
}

/* ─── Popovers: one shared element, under its control (bottom sheet on phones) ─── */
let popFor = null, popToken = 0;
function popEls() {
  let bg = document.querySelector('#pop-bg'), pop = document.querySelector('#pop');
  if (!pop) {
    bg = document.createElement('div'); bg.id = 'pop-bg'; bg.className = 'pop-bg'; bg.hidden = true;
    pop = document.createElement('div'); pop.id = 'pop'; pop.className = 'pop'; pop.hidden = true; pop.setAttribute('role', 'dialog');
    document.body.append(bg, pop);
    bg.addEventListener('click', closePop);
  }
  return {bg, pop};
}
function openPop(anchor, html, {width = 280, label = 'Options', onClose = null} = {}) {
  const {bg, pop} = popEls();
  if (popFor === anchor) { closePop(); return null; }
  closePop(true);
  pop.innerHTML = html; pop.setAttribute('aria-label', label); pop._onClose = onClose;
  popToken++; bg.hidden = pop.hidden = false; popFor = anchor; mo.enter(pop, 'pop');
  const box = anchor.getBoundingClientRect();
  const w = Math.min(width, innerWidth - 16);
  pop.style.setProperty('--w', `${w}px`);
  pop.style.setProperty('--x', `${Math.max(8, Math.min(innerWidth - w - 8, box.right - w > 8 && box.left + w > innerWidth - 8 ? box.right - w : box.left))}px`);
  pop.style.setProperty('--y', `${Math.min(innerHeight - 120, box.bottom + 6)}px`);
  anchor.setAttribute('aria-expanded', 'true');
  return pop;
}
function closePop(instant = false) {
  const pop = document.querySelector('#pop'); if (!pop || pop.hidden) return;
  const token = ++popToken;
  const hide = () => { if (token === popToken) { pop.hidden = true; document.querySelector('#pop-bg').hidden = true; } };
  document.querySelector('#pop-bg').hidden = true;
  if (instant || !mo.on()) hide(); else mo.leave(pop, 'pop').then(hide);
  popFor?.setAttribute?.('aria-expanded', 'false'); popFor?.focus?.({preventScroll: true});
  const done = pop._onClose; pop._onClose = null; popFor = null; done?.();
}

/* ─── Inspector drawer: opens from the right (bottom sheet on phones); the page keeps its place ─── */
const drawerStack = [];
let drawerReturn = null, drawerToken = 0;
function drawerEls() {
  let bg = document.querySelector('#drawer-bg'), drawer = document.querySelector('#drawer');
  if (!drawer) {
    bg = document.createElement('div'); bg.id = 'drawer-bg'; bg.className = 'drawer-bg'; bg.hidden = true;
    drawer = document.createElement('aside'); drawer.id = 'drawer'; drawer.className = 'drawer'; drawer.hidden = true; drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true'); drawer.tabIndex = -1;
    document.body.append(bg, drawer);
    bg.addEventListener('click', () => closeDrawer());
  }
  return {bg, drawer};
}
// header: title, a sub line, optional step through neighbours (prev/next handlers) and a back arrow when stacked.
function drawerHead(title, sub = '', {prev = null, next = null} = {}) {
  return `<div class="dh">${drawerStack.length > 1 ? `<button type="button" class="icon-btn" data-drawer-back aria-label="Back">${uxIcon('arrow', 16)}</button>` : ''}<div class="sp1"><h2 id="drawer-title">${escapeHTML(title)}</h2>${sub ? `<span class="sub">${escapeHTML(sub)}</span>` : ''}</div>${prev ? '<button type="button" class="icon-btn" data-drawer-prev aria-label="Previous">‹</button>' : ''}${next ? '<button type="button" class="icon-btn" data-drawer-next aria-label="Next">›</button>' : ''}<button type="button" class="icon-btn" data-drawer-close aria-label="Close">${uxIcon('close', 16)}</button></div>`;
}
// render() returns the drawer's inner HTML; it runs again on redrawDrawer(). hooks: {prev, next, bind}
function openDrawer(render, hooks = {}, push = false) {
  const {bg, drawer} = drawerEls();
  if (!push) drawerStack.length = 0;
  if (drawer.hidden) drawerReturn = document.activeElement;
  drawerStack.push({render, hooks});
  drawerToken++; bg.hidden = drawer.hidden = false; drawerRender();
  mo.enter(drawer, 'drawer'); mo.enter(bg, 'fade');
  document.querySelector('.app')?.classList.add('drawer-open');
  drawer.focus({preventScroll: true});
}
function drawerRender() {
  const {drawer} = drawerEls(); const top = drawerStack[drawerStack.length - 1]; if (!top) return;
  drawer.setAttribute('aria-labelledby', 'drawer-title');
  drawer.innerHTML = top.render(); top.hooks.bind?.(drawer);
}
const redrawDrawer = () => drawerRender();
function closeDrawer() {
  const {bg, drawer} = drawerEls(); if (drawer.hidden) return;
  const top = drawerStack[drawerStack.length - 1];
  const token = ++drawerToken;
  const finish = () => { if (token !== drawerToken) return; drawer.hidden = bg.hidden = true; drawer.innerHTML = ''; drawer.classList.remove('player-drawer'); };
  drawerStack.length = 0;
  document.querySelector('.app')?.classList.remove('drawer-open');
  if (mo.on()) { mo.leave(bg, 'fade'); mo.leave(drawer, 'drawer').then(finish); } else finish();
  top?.hooks.onClose?.(); drawerReturn?.focus?.({preventScroll: true}); drawerReturn = null;
}
document.addEventListener('click', event => {
  const target = event.target;
  if (target.closest('[data-drawer-close]')) { closeDrawer(); return; }
  if (target.closest('[data-drawer-back]')) { drawerStack.pop(); if (drawerStack.length) drawerRender(); else closeDrawer(); return; }
  const top = drawerStack[drawerStack.length - 1];
  if (target.closest('[data-drawer-prev]')) top?.hooks.prev?.();
  if (target.closest('[data-drawer-next]')) top?.hooks.next?.();
});

/* ─── Definitions: dotted labels that explain how a number is counted ─── */
const DEFINITIONS = {
  'Players': ['Distinct players in the range. A player is their user_id, or their device_id when there is none.', 'Editor and development data left out unless you include it'],
  'Sessions': ['A session starts when the game opens, or when it comes back after 30 or more minutes away.', 'From the SDK'],
  'Events': ['Every event the server stored for these days and filters.', ''],
  'Daily active': ['Players with at least one event on the last day of the range.', ''],
  'Stickiness': ['Average daily players divided by monthly players. Higher means people come back more often.', ''],
  'Levels seen': ['Distinct levels with at least one start event in the range.', ''],
  'Largest total drop': ['The level the most players stop at before starting the next one.', 'A level with a small sample is not ranked'],
  'Hardest level': ['The level with the lowest share of starters who finish it.', ''],
  'Slowest level': ['The level with the longest median time from start to finish.', ''],
  'Started': ['Players who did the first step.', ''],
  'Completed': ['Players who reached the last step, in order.', ''],
  'Conversion': ['Completed divided by started.', ''],
  'Time to complete': ['The middle time from the first step to the last: half the players were faster.', ''],
  'Events today': ['Events received since midnight, local time.', ''],
  'Events collected': ['Every event stored for this workspace. Nothing is counted twice.', ''],
  'Players today': ['Distinct player IDs with an event today, local time, editor data left out.', ''],
};
const defineLabel = label => DEFINITIONS[label] ? `<span class="def" tabindex="0" data-def="${escapeHTML(label)}">${escapeHTML(label)}</span>` : escapeHTML(label);
function tipEl() { let tip = document.querySelector('#tip'); if (!tip) { tip = document.createElement('div'); tip.id = 'tip'; tip.className = 'tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip'); document.body.append(tip); } return tip; }
function showTip(target) {
  const definition = DEFINITIONS[target.dataset.def]; if (!definition) return;
  const tip = tipEl();
  tip.innerHTML = `<b>${escapeHTML(target.dataset.def)}</b>${escapeHTML(definition[0])}${definition[1] ? `<small>${escapeHTML(definition[1])}</small>` : ''}`;
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  let y = box.bottom + 8; if (y + tip.offsetHeight > innerHeight - 8) y = box.top - tip.offsetHeight - 8;
  tip.style.setProperty('--x', `${Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, box.left))}px`); tip.style.setProperty('--y', `${y}px`);
}
const hideTip = () => { const tip = document.querySelector('#tip'); if (tip) tip.hidden = true; };
document.addEventListener('mouseover', event => { const target = event.target.closest?.('.def'); if (target) showTip(target); });
document.addEventListener('mouseout', event => { if (event.target.closest?.('.def')) hideTip(); });
document.addEventListener('focusin', event => { const target = event.target.closest?.('.def'); if (target) showTip(target); });
document.addEventListener('focusout', event => { if (event.target.closest?.('.def')) hideTip(); });
window.addEventListener('scroll', hideTip, true);
// Labels on key-number cards and the headers of tables get their definition after each draw.
function applyDefinitions(root = document) {
  root.querySelectorAll('.kpi .eyebrow').forEach(label => { if (!label.querySelector('.def') && DEFINITIONS[label.textContent.trim()]) label.innerHTML = defineLabel(label.textContent.trim()); });
}

/* ─── Auto-refresh and freshness ─── */
let autoMinutes = Number(localStorage.getItem('avn-auto-refresh') || 0), autoTimer = null;
function setAutoRefresh(minutes, announce = true) {
  autoMinutes = minutes; clearInterval(autoTimer);
  try { localStorage.setItem('avn-auto-refresh', String(minutes)); } catch { /* storage unavailable */ }
  const tag = document.querySelector('#auto-tag'); if (tag) { tag.hidden = !minutes; tag.textContent = minutes ? `${minutes}m` : ''; }
  if (minutes) autoTimer = setInterval(() => { if (!document.hidden && !modal.open && document.querySelector('#drawer')?.hidden !== false) document.querySelector('[data-action="refresh"]')?.click(); }, minutes * 60000);
  if (announce) toast(minutes ? `Auto-refresh every ${minutes} min` : 'Auto-refresh off', null, 'info', minutes ? 'The page refreshes while this tab is open.' : '');
}
let lastUpdated = Date.now();
function markFresh() { lastUpdated = Date.now(); tickFresh(); }
function tickFresh() { document.querySelectorAll('[data-fresh]').forEach(node => { node.textContent = `Updated ${relativeTime(lastUpdated)}`; }); }
setInterval(tickFresh, 20000);
const freshStamp = () => `<button type="button" class="fresh" data-action="refresh" title="Refresh this page">${uxIcon('refresh', 13)}<span data-fresh>Updated ${relativeTime(lastUpdated)}</span></button>`;

function refreshMenuHTML() {
  return `<div class="pop-scroll"><button type="button" class="opt" data-refresh-now><span class="tick">${uxIcon('refresh', 15)}</span><span class="ot">Refresh now</span><span class="oc">this page</span></button><div class="pop-grp"><span class="eyebrow">Auto-refresh</span></div>${[[0, 'Off'], [1, 'Every minute'], [5, 'Every 5 minutes'], [15, 'Every 15 minutes']].map(([minutes, label]) => `<button type="button" class="opt" role="menuitemradio" aria-checked="${autoMinutes === minutes}" data-auto="${minutes}"><span class="tick">${uxIcon('check', 14)}</span><span class="ot">${label}</span></button>`).join('')}</div>`;
}

/* ─── Shortcuts dialog (Ctrl/Cmd + /) ─── */
function openShortcuts() {
  const keys = [['Ctrl K', 'Search pages, games and actions'], ['Ctrl J', 'Ask NutBot'], ['Ctrl /', 'This list'], ['Esc', 'Close the open panel, menu or drawer'], ['↑ ↓ Enter', 'Move and choose in lists'], ['Enter', 'Open a focused table row']];
  modal.innerHTML = `<h2 id="dialog-title">Keyboard shortcuts</h2><ul class="shortcut-list">${keys.map(([key, text]) => `<li><span>${text}</span><span class="keys">${key.split(' ').map(part => `<kbd>${part}</kbd>`).join('')}</span></li>`).join('')}</ul><p class="help">There are no single-letter shortcuts, so typing never triggers one.</p><div class="modal-actions"><button type="button" class="button" data-action="close">Close</button></div>`;
  modal.setAttribute('aria-labelledby', 'dialog-title'); modal.showModal();
}

/* ─── Entrance motion: new page blocks rise in one after another; key numbers count up once ─── */
function riseIn(main) {
  if (window.Motion) { mo.pageIn(main); return; }
  if (!main || reducedMotion()) return;
  [...main.children].forEach((child, index) => { if (child.classList.contains('footnote')) return; child.classList.add('rise'); child.style.setProperty('--i', String(Math.min(index, 8))); });
}
function countUp(root = document) {
  root.querySelectorAll('.k-v').forEach(node => {
    const text = node.textContent.trim();
    const value = /^[\d,]+$/.test(text) ? Number(text.replace(/,/g, '')) : NaN;
    if (!Number.isFinite(value)) return;
    if (!node.dataset.counted) { node.dataset.counted = '1'; node.dataset.val = String(value); if (value >= 2) mo.number(node, value, 0); return; }
    // Already on screen and the value changed (a filter moved): roll from the old number to the new one.
    if (!node._rolling && node.dataset.val !== String(value)) { const from = Number(node.dataset.val); node.dataset.val = String(value); mo.number(node, value, from); }
  });
}
function watchMain() {
  const main = document.querySelector('#main'); if (!main || main._watched) return;
  main._watched = true;
  new MutationObserver(() => { countUp(main); applyDefinitions(main); mo.charts(main); }).observe(main, {childList: true, subtree: true});
}

/* ─── Global handlers ─── */
document.addEventListener('click', event => {
  const target = event.target;
  const refresh = target.closest('[data-pop="refresh"]'); if (refresh) { openPop(refresh, refreshMenuHTML(), {width: 240, label: 'Refresh options'}); return; }
  const bell = target.closest('[data-pop="notes"]');
  if (bell) { const pop = openPop(bell, notesHTML(), {width: 360, label: 'Notifications', onClose: () => { NOTES.forEach(note => { note.read = true; }); saveNotes(); updateBell(); }}); return; }
  if (target.closest('[data-refresh-now]')) { closePop(); document.querySelector('[data-action="refresh"]')?.click(); return; }
  const auto = target.closest('[data-auto]'); if (auto) { closePop(); setAutoRefresh(Number(auto.dataset.auto)); return; }
  if (target.closest('[data-notes-clear]')) { NOTES.length = 0; saveNotes(); updateBell(); const pop = document.querySelector('#pop'); if (pop && !pop.hidden) pop.innerHTML = notesHTML(); }
});
document.addEventListener('keydown', event => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key === '/') { event.preventDefault(); openShortcuts(); return; }
  if (mod && event.key.toLowerCase() === 'j') { event.preventDefault(); document.querySelector('.nb-launcher')?.click(); return; }
  if (event.key === 'Escape') { if (document.querySelector('.flatpickr-calendar.open')) return; if (document.querySelector('#pop') && !document.querySelector('#pop').hidden) { closePop(); return; } if (document.querySelector('#drawer') && !document.querySelector('#drawer').hidden && !modal.open) closeDrawer(); }
});

/* ─── Connection lost: a banner that keeps the data on screen and refreshes by itself when back ─── */
function connectionBanner(show) {
  let banner = document.querySelector('#conn-banner');
  if (!show) { banner?.remove(); return; }
  if (banner) return;
  banner = document.createElement('div'); banner.id = 'conn-banner'; banner.className = 'conn-banner'; banner.setAttribute('role', 'alert');
  banner.innerHTML = `${uxIcon('shield', 15)}<span><b>You’re offline.</b> Showing data from ${new Date(lastUpdated).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}. It refreshes by itself when you’re back.</span>`;
  document.body.prepend(banner);
}
window.addEventListener('offline', () => connectionBanner(true));
window.addEventListener('online', () => { connectionBanner(false); document.querySelector('[data-action="refresh"]')?.click(); toast('Back online', null, 'info', 'The page is refreshing.'); });
if (!navigator.onLine) addEventListener('DOMContentLoaded', () => connectionBanner(true));
