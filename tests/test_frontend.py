"""Exercise the browser request contract without a browser or a frontend build step."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_read_retries_are_bounded_and_writes_are_never_replayed():
    script = (Path(__file__).parents[1] / "avn_analytics/static/app.js").read_text()
    request = script[script.index("async function request(") : script.index("function skeleton(")]
    checks = """
import assert from 'node:assert/strict';
globalThis.setTimeout = callback => { callback(); return 0; };
const response = (status, body = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: {get: () => '5'}, json: async () => body,
});
let calls = [];
let replies = [];
globalThis.fetch = async (path, options) => {
  calls.push({path, options});
  return replies.shift();
};
replies = [response(503), response(200, {players: 3})];
assert.deepEqual(await request('/insights/players'), {players: 3});
assert.equal(calls.length, 2);

calls = [];
replies = [response(503, {detail: 'Storage temporarily unavailable'}), response(503)];
await assert.rejects(request('/insights/players'), error => error.status === 503);
assert.equal(calls.length, 2);

for (const method of ['POST', 'PUT', 'DELETE']) {
  calls = [];
  replies = [response(503, {detail: 'Storage temporarily unavailable'})];
  await assert.rejects(request('/dictionary', {method}), error => error.status === 503);
  assert.equal(calls.length, 1);
}
calls = [];
replies = [response(403, {detail: 'Forbidden'})];
await assert.rejects(request('/games'), error => error.status === 403);
assert.equal(calls.length, 1);

globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
await assert.rejects(request('/games'),
  error => error.status === 0 && error.message.includes('connection'));
globalThis.fetch = async () => {
  throw Object.assign(new Error('Cancelled'), {name:'AbortError'});
};
await assert.rejects(request('/games'), error => error.name === 'AbortError');
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=request + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_disclosures_survive_redraw_and_replace_old_listeners():
    script = (Path(__file__).parents[1] / "avn_analytics/static/insights.js").read_text()
    disclosure = script[
        script.index("const disclosureBindings =") : script.index("function downloadCSV(")
    ]
    checks = """
import assert from 'node:assert/strict';
const storage = new Map([['player', {'setup':false, 'session':false}]]);
function storeGet(key) { return structuredClone(storage.get(key)); }
function storeSet(key, value) { storage.set(key, structuredClone(value)); }
const section = (key, open = true) => ({
  dataset:{disclosure:key}, open, matches: selector => selector === 'details[data-disclosure]',
});
let sections = [section('setup'), section('session')];
const listeners = [];
const container = {
  querySelectorAll: () => sections,
  addEventListener: (type, callback, options) => listeners.push({type, callback, options}),
};
const toggle = target => listeners.filter(item => !item.options.signal.aborted)
  .forEach(item => item.callback({target}));
const disclosures = mountDisclosures(container, 'player');
assert.deepEqual(sections.map(item => item.open), [false, false]);
sections[0].open = true;
toggle(sections[0]);
assert.equal(storeGet('player').setup, true);
assert.equal(storeGet('player').session, false);
// Capture a user toggle even if rendering happens before the native toggle event is dispatched.
sections[0].open = false;
disclosures.remember();
sections = [section('setup'), section('session'), section('new-highlight')];
disclosures.refresh();
assert.deepEqual(sections.map(item => item.open), [false, false, true]);
// Match navigation opens a folded session; subsequent redraws keep it open.
sections[1].open = true;
disclosures.remember();
sections = [section('setup'), section('session')];
disclosures.refresh();
assert.deepEqual(sections.map(item => item.open), [false, true]);
// Remounting an event panel must not keep handlers for a previous storage scope.
mountDisclosures(container, 'another-event');
assert.equal(listeners[0].options.signal.aborted, true);
sections[1].open = false;
toggle(sections[1]);
assert.equal(storeGet('another-event').session, false);
assert.equal(storeGet('player').session, true);
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=disclosure + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_raw_timeline_navigation_visibility_and_session_gaps():
    assets = Path(__file__).parents[1] / "avn_analytics/static"
    script = (assets / "insights.js").read_text()
    raw_events = script[script.index("function timelineSessions(") : script.index("/* ─── Levels:")]
    formatting = script[script.index("const chipValue") : script.index("const paramChips")]
    checks = (
        formatting
        + """
import assert from 'node:assert/strict';
const escapeHTML = value => String(value ?? '');
const icon = () => '';
const skeleton = () => '';
const number = String;
const setWidths = () => {};
const percent = value => `${value}%`;
const analysisDate = value => value;
const clock = value => value;
const duration = seconds => `${seconds}s`;
const gameURL = game => `/v1/games/${game.id}`;
const storeGet = () => null;
const storeSet = () => {};
const mountDisclosures = () => ({remember() {}, refresh() {}});
const HIGHLIGHT_PRESETS = [];
const toast = () => {};
const nodes = new Map();
function node(key) {
  if (!nodes.has(key)) nodes.set(key, {
    isConnected:true, hidden:false, disabled:false, value:'', textContent:'', dataset:{},
    classList:{toggle() {}}, handlers:{},
    addEventListener(type, callback) {this.handlers[type] = callback;},
    contains() {return false;},
    querySelector() {return null;},
    querySelectorAll() {return [];},
    set innerHTML(value) {
      this.html = value;
      this.options = [...value.matchAll(/<option value="([^"]*)"/g)]
        .map(match => ({value:match[1]}));
    },
    get innerHTML() {return this.html || '';},
  });
  return nodes.get(key);
}
const root = node('root');
root.querySelector = node;
root.querySelectorAll = () => [];
const container = {querySelector: () => root};
globalThis.document = {activeElement:null, addEventListener() {}, removeEventListener() {},
  querySelector() {return null;}};
const rows = [
  {name:'AD_ANALYSIS',session_id:'one',client_ts:'2026-10-04T09:00:00Z',params:{}},
  {name:'AD_ANALYSIS',session_id:'one',client_ts:'2026-10-04T09:01:00Z',params:{}},
  {name:'OTHER_EVENT',session_id:'two',client_ts:'2026-10-04T09:11:00Z',params:{seq:1,LEVEL_NUMBER:2,SECONDS:6.9673786}},
  {name:'session_start',session_id:'two',client_ts:'2026-10-04T09:11:00Z',
    params:{session_number:1,device_model:'Pixel',os_version:'Android OS 13 / API-33 (X)'}},
  {name:'LAST_EVENT',session_id:'three',client_ts:'2026-10-04T09:11:00Z',params:{}},
];
let api = async () => ({events:rows,truncated:false,snapshot:rows.length});
await renderRawEvents({id:'test'},'player',{from:'2026-10-04',to:'2026-10-04'},'utc',container);
assert.equal(node('.highlight-navigation').hidden, true, 'No highlights means no navigation');
assert.doesNotMatch(node('#journey').innerHTML, /data-hide-param="seq"/,
  'noise parameters are hidden by default');
assert.match(node('#journey').innerHTML, /data-hide-param="LEVEL_NUMBER"/);
assert.match(node('#journey').innerHTML, /chip-more[^>]*>\+1</,
  'a hidden parameter is counted');
assert.match(node('#journey').innerHTML, />6\.97</, 'long decimals are rounded');
assert.match(node('#journey').innerHTML, /<summary>Session 1 · Pixel · Android OS 13<\/summary>/,
  'session_start collapses into one line');
assert.equal((node('#journey').innerHTML.match(/role="separator"/g) || []).length, 2);
assert.match(node('#journey').innerHTML, /600s after previous session/);
assert.match(node('#journey').innerHTML, /0s after previous session/);
assert.equal((node('#journey').innerHTML.match(/after previous session/g) || []).length, 2,
  'The first session must not claim a gap from an unknown previous session');
const click = targets => root.handlers.click({target:{
  closest:selector => targets[selector] || null,
}});
click({'#highlight-add':{}});
assert.equal(node('.highlight-navigation').hidden, false);
assert.equal(node('#highlight-next').disabled, false);
const changeEnabled = enabled => node('#highlight-rules').handlers.change({target:{
  dataset:{highlightField:'enabled'}, checked:enabled,
  closest:() => ({dataset:{highlight:'0'}}),
}});
changeEnabled(false);
assert.equal(node('.highlight-navigation').hidden, true, 'Disabled highlights cannot navigate');
changeEnabled(true);
assert.equal(node('.highlight-navigation').hidden, false);
click({'[data-timeline-mode]':{dataset:{timelineMode:'filter'}}});
assert.equal(node('.highlight-navigation').hidden, true,
  'Filtering never shows highlight navigation');
node('#journey-filter').value = 'OTHER_EVENT';
node('#journey-filter').handlers.input();
assert.equal((node('#journey').innerHTML.match(/role="separator"/g) || []).length, 0,
  'No orphan divider before the first visible session');
assert.match(node('#journey').innerHTML, /600s after previous session/,
  'Gaps come from the original timeline, even when the prior session is filtered out');
click({'[data-timeline-mode]':{dataset:{timelineMode:'highlight'}}});
assert.equal(node('.highlight-navigation').hidden, false);
click({'[data-highlight-remove]':{},'[data-highlight]':{dataset:{highlight:'0'}}});
assert.equal(node('.highlight-navigation').hidden, true,
  'Removing the last highlight hides navigation');

// One button per session; picking one shows only that session.
node('#journey-filter').value = '';
click({'[data-timeline-mode]':{dataset:{timelineMode:'highlight'}}});
assert.equal(node('#session-picker').hidden, false);
assert.match(node('#session-picker').innerHTML, /data-session-pick="all" aria-pressed="true"/);
assert.match(node('#session-picker').innerHTML, /data-session-pick="2" aria-pressed="false"/);
assert.match(node('#session-picker').innerHTML, /no levels/);
click({'[data-session-pick]':{dataset:{sessionPick:'1'}}});
assert.match(node('#journey').innerHTML, /<strong>Session 2<\/strong>/);
assert.doesNotMatch(node('#journey').innerHTML, /<strong>Session (1|3)<\/strong>/);
assert.equal((node('#journey').innerHTML.match(/role="separator"/g) || []).length, 0);
assert.match(node('#session-picker').innerHTML, /data-session-pick="1" aria-pressed="true"/);
click({'[data-session-pick]':{dataset:{sessionPick:'all'}}});
assert.match(node('#journey').innerHTML, /<strong>Session 3<\/strong>/);
assert.equal(node('#timeline-focus').hidden, true, 'No level, no exit event to point at');

// Opened from a level: the player's last event on it is marked and one click away.
const leveled = rows.map(
  (row, index) => ({...row, event_id:`e${index}`, level:index === 2 ? 2 : null}));
api = async () => ({events:leveled,truncated:false,snapshot:leveled.length});
const focus = {event:'e2', label:'Last on level 2'};
const dates = {from:'2026-10-04',to:'2026-10-04'};
await renderRawEvents({id:'test'},'player',dates,'utc',container,focus);
assert.match(node('#journey').innerHTML, /class="[^"]*timeline-focus[^"]*"/);
assert.match(node('#journey').innerHTML, /focus-tag">Last on level 2</);
assert.equal((node('#journey').innerHTML.match(/timeline-focus/g) || []).length, 1);
assert.equal(node('#timeline-focus').hidden, false);
assert.match(node('#timeline-focus').innerHTML, /data-timeline-jump="2"/);
assert.match(node('#session-picker').innerHTML, /Session 2 <span class="pill">Last on level 2</);
assert.match(node('#session-picker').innerHTML, /· level 2<\/span>/);
await renderRawEvents({id:'test'},'player',dates,'utc',container,
  {event:'gone', label:'Last on level 9'});
assert.match(node('#timeline-focus').innerHTML, /Last on level 9 is not in these dates/);
assert.doesNotMatch(node('#journey').innerHTML, /timeline-focus/);
"""
    )
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=(assets / "conditions.js").read_text() + raw_events + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_accessibility_markup_and_text_safe_colour_tokens():
    static = Path(__file__).parents[1] / "avn_analytics/static"
    scripts = {path.name: path.read_text() for path in static.glob("*.js")}
    css = (static / "style.css").read_text()
    # aria-pressed is not valid on links; the platform switch marks the current page instead.
    assert 'aria-current="page" ' in scripts["app.js"]
    assert "variant-switch a[aria-pressed" not in css
    # Every column header needs text, even icon-only action columns.
    assert all("<th></th>" not in text for text in scripts.values())
    # The visible brand text is the link's accessible name.
    assert 'class="brand" aria-label' not in scripts["app.js"]
    # Raw status colours miss 4.5:1 as small text; text uses the -text variants.
    assert not re.search(r"(?<![-\w])color:var\(--status-(up|down)\)", css)
    # Deleting a saved Levels view asks first, like every other destructive action.
    levels = scripts["levels.js"]
    assert (
        "confirmDialog("
        in levels[levels.index("querySelector('#levels-delete-view').addEventListener") :][:500]
    )
    # A funnel gap shows the lost share in the warning colour, plus a text flag for the worst step.
    assert 'class="lost">' in scripts["insights.js"] and "Biggest drop" in scripts["insights.js"]
    assert "font-size:.78rem" not in css  # text sizes come from the --fs-* scale


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_version_filter_follows_the_newest_build_and_flags_older_events():
    script = (Path(__file__).parents[1] / "avn_analytics/static/custom-events.js").read_text()
    filtering = script[
        script.index("// Which app versions the event counts are for.") : script.index(
            "function bindUnlistedEvents("
        )
    ]
    checks = """
import assert from 'node:assert/strict';
const escapeHTML = value => String(value);
const number = value => String(value);
const agoText = () => 'now';
const icon = () => '';
const me = {can_manage_team: true};
const versions = [
  {version: '1.2', players: 0, last_seen: ''},
  {version: '1.1', players: 4, last_seen: ''},
  {version: '1.0', players: 9, last_seen: ''},
];
// The newest version with players is the default; a build nobody plays does not count.
let html = versionFilterHTML(versions, {version: '@latest', newer: true});
assert.match(html, /value="1\\.1" selected/);
assert.match(html, /id="version-filter-newer" checked >/);
html = versionFilterHTML(versions, {version: '', newer: true});
assert.match(html, /<option value="" >|<option value="">All versions/);
assert.match(html, /disabled>/);  // "and newer" means nothing for all versions

let chosen = null;
let handler = null;
const box = {
  addEventListener: (type, callback) => { handler = callback; },
  querySelector: () => ({checked: true}),
};
bindVersionFilter(
  box, () => ({versions}), () => ({version: '1.0', newer: true}), value => { chosen = value; });
handler({target: {id: 'version-filter-select', value: '1.1'}});
assert.deepEqual(chosen, {version: '@latest', newer: true});  // follows new builds
handler({target: {id: 'version-filter-select', value: '1.0'}});
assert.deepEqual(chosen, {version: '1.0', newer: true});
handler({target: {id: 'version-filter-select', value: ''}});
assert.deepEqual(chosen, {version: '', newer: true});
handler({target: {id: 'version-filter-newer'}});
assert.deepEqual(chosen, {version: '1.0', newer: true});

const item = (name, versions) => (
  {name, events: 1, players: 1, last_seen: '', valid_name: true, versions});
let list = unlistedEventsHTML({
  unlisted: [item('SHOP', ['1.1', '1.0', '0.9', '0.8'])], total_unlisted: 7, ignored: [],
  older_only: [{name: 'OLD', events: 3}, {name: 'OLDER', events: 2}],
});
assert.match(list, /1\\.1, 1\\.0, 0\\.9 \\+1/);  // the first three versions, then a count
assert.match(list, /showing 1/);
assert.match(list, /2 more events are only sent by older versions/);
assert.match(list, /data-unlisted-older/);
list = unlistedEventsHTML({unlisted: [], total_unlisted: 0, ignored: [], older_only: []});
assert.doesNotMatch(list, /data-unlisted-older/);
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=filtering + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_level_drill_opens_on_the_bigger_drop_and_lists_what_players_did_last():
    script = (Path(__file__).parents[1] / "avn_analytics/static/insights.js").read_text()
    helpers = script[
        script.index("const LEVEL_SCOPES") : script.index("async function renderLevels(")
    ]
    checks = """
import assert from 'node:assert/strict';
const escapeHTML = value => String(value).replace(/</g, '&lt;');
const number = String;
assert.deepEqual(
  LEVEL_DRILL_GROUPS.map(([key]) => key), ['left', 'finished_stopped', 'kept_going']);
const row = transition => ({level: 5, transition});
assert.equal(
  levelDrillGroup(row({left: 2, finished_stopped: 5, kept_going: 9})), 'finished_stopped');
assert.equal(levelDrillGroup(row({left: 4, finished_stopped: 4, kept_going: 9})), 'left');
assert.equal(levelDrillGroup(row({left: 0, finished_stopped: 0, kept_going: 3})), 'kept_going');
assert.equal(levelDrillGroup(row(null)), 'left');
const lastActions = [{text: 'Failed level 5', players: 6}, {text: 'Opened <shop>', players: 2}];
let html = lastActionsHTML(5, {group: 'left', lastActions, lastAction: 'Opened <shop>'});
assert.match(html, /aria-label="What players did last on level 5"/);
assert.match(html,
  /data-last-action="0" aria-pressed="false">Failed level 5<span class="drill-count">6/);
assert.match(html, /data-last-action="1" aria-pressed="true">Opened &lt;shop>/);
assert.equal(lastActionsHTML(5, {group: 'kept_going', lastActions, lastAction: null}), '',
  'Players who carried on did not leave');
assert.equal(lastActionsHTML(5, {group: 'left', lastActions: [], lastAction: null}), '');
// One short label per player; the popover holds the exact last event and where it sits.
const duration = seconds => `${Math.round(seconds)}s`;
assert.match(lastDidHTML({last_action: 'Rewarded <ad>'}, 3),
  /class="last-did" data-last-did="3" aria-haspopup="dialog"/);
assert.match(lastDidHTML({last_action: 'Rewarded <ad>'}, 3),
  /aria-expanded="false">Rewarded &lt;ad>/);
assert.match(lastDidHTML({last_action: null}, 0), />—<\\/button>/);
const shop = {
  last_action: 'Rewarded ad', next_action: 'Opened shop',
  last_event: {
    text: 'AD_ANALYSIS · Closed (Rewarded)', gap: 0.4,
    after: 'APP_ANALYSIS · Foreground <Ad>', after_level: 1024,
  },
};
html = lastDidDetailsHTML(shop, 1);
assert.match(html, /<h3>Rewarded ad<\\/h3>/);
assert.match(html, /Last event in that session<\\/dt>/);
assert.match(html, /<span class="mono">AD_ANALYSIS · Closed \\(Rewarded\\)<\\/span>/);
assert.match(html,
  /<span class="muted">0s after APP_ANALYSIS · Foreground &lt;Ad><\\/span>/);
assert.match(html, /1024s after their last event on level 1/);
assert.match(html, /Right after level 1<\\/dt><dd>Opened shop/);
html = lastDidDetailsHTML({last_action: 'Completed level 1', next_action: null,
  last_event: {text: 'LEVEL_ANALYSIS · Completed', gap: null, after: null, after_level: null}}, 1);
assert.doesNotMatch(html, /Right after/, 'nothing came after the level');
assert.doesNotMatch(html, /muted/, 'the first event they sent has nothing before it');
assert.match(html, /It was their last event on level 1/);
html = lastDidDetailsHTML({...shop, next_action: 'Rewarded ad'}, 1);
assert.doesNotMatch(html, /Right after/, 'the same thing twice is said once');
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=helpers + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_level_by_level_keeps_one_level_open_and_counts_new_players_on_request():
    script = (Path(__file__).parents[1] / "avn_analytics/static/insights.js").read_text()
    levels = script[script.index("async function renderLevels(") :]
    # Opening a level closes the one open before it.
    assert "open.clear();\n      open.add(level);" in levels
    # The "Which players" switch reloads the table and the player lists with the scope.
    assert 'aria-label="Which players"' in levels
    assert "if (firstSession()) query.set('scope', 'first_session');" in levels
    assert "const query = levelsQuery(chosen);" in levels
    # A player opens at their last event on the level, also when browsing to the next one.
    assert "focus: focusOf, load:" in levels
    assert "label: `Last on level ${level}`" in levels
    for gone in ("Missing progress", "Returning entrants", "History unavailable", "Stuck"):
        assert gone not in levels


def test_levels_page_shows_one_sub_page_at_a_time():
    script = (Path(__file__).parents[1] / "avn_analytics/static/insights.js").read_text()
    levels = script[script.index("async function renderLevels(") :]
    assert 'data-levels-view="table">Level by level' in levels
    assert 'data-levels-view="compare">Compare releases' in levels
    # The comparison only queries while its sub page is open (old links say "explore"), and a
    # level link from it switches back to the table.
    assert "['compare', 'explore'].includes(" in levels
    assert "if (levelsView === 'compare') { toolsPanel.update(chosen); return; }" in levels
    assert "await chooseView('table'); jumpTo(event.detail);" in levels
    assert 'id="levels-csv"' not in levels
    tools = (Path(__file__).parents[1] / "avn_analytics/static/levels.js").read_text()
    for gone in ("First session", "Level funnel", "levels/funnel", "first-session"):
        assert gone not in tools


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_query_cache_deduplicates_reads_and_invalidates_saved_analytics():
    script = (Path(__file__).parents[1] / "avn_analytics/static/app.js").read_text()
    source = script[script.index("function analyticsRead(") : script.index("function spinner(")]
    checks = """
import assert from 'node:assert/strict';
const cache = new Map(); const CACHE_MS = 30000; let overviewStale = false;
const cacheable = () => true;
let count = 0; let finish; let fail = false;
const request = () => { count++; return fail ? Promise.reject(new Error('offline')) :
  new Promise(resolve => { finish = resolve; }); };
const flow = '/v1/games/g/insights/journeys';
const options = {method: 'POST', body: JSON.stringify({route_from: 1})};
const first = api(flow, options); const duplicate = api(flow, options);
assert.equal(first, duplicate); assert.equal(count, 1);
finish({players: 4}); await first;
assert.equal(await api(flow, options), await first); assert.equal(count, 1);
const different = api(flow, {...options, body: '{}'}); finish({players: 2}); await different;
assert.equal(count, 2);
for (const path of ['/insights/funnels', '/insights/funnels/id', '/dictionary/LEVEL']) {
  const write = api('/v1/games/g' + path, {method: 'POST', body: '{}'});
  finish({}); await write; assert.equal(cache.size, 0); assert.equal(overviewStale, true);
}
fail = true;
await assert.rejects(api(flow, options)); assert.equal(cache.size, 0);
fail = false;
const retry = api(flow, options); finish({players: 3}); await retry;
assert.equal((await api(flow, options)).players, 3);
for (let i=0; i<65; i++) { const result = api('/read/' + i); finish({}); await result; }
assert.equal(cache.size, 60);
// Signals belong to one consumer and must not cancel another consumer's shared promise.
const a = api('/read/signaled', {signal: new AbortController().signal});
const b = api('/read/signaled', {signal: new AbortController().signal});
assert.notEqual(a, b);
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=source + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_request_errors_are_actionable_and_malformed_success_is_not_cached():
    script = (Path(__file__).parents[1] / "avn_analytics/static/app.js").read_text()
    source = script[script.index("async function request(") : script.index("function skeleton(")]
    checks = """
import assert from 'node:assert/strict';
const statuses = [[401, /sign in/], [403, /permission/], [429, /Wait/], [500, /server/]];
for (const [status, expected] of statuses) {
  globalThis.fetch = async () => ({ok:false, status, json: async () => ({})});
  await assert.rejects(request('/read'),
    error => error.status === status && expected.test(error.message));
}
globalThis.fetch = async () => ({ok:false, status:400, json: async () => ({
  detail:'Invalid request', errors:[{loc:['body','last_level'], msg:'Must be at least 1'}],
})});
await assert.rejects(request('/read'), /last_level: Must be at least 1/);
globalThis.fetch = async () => ({ok:true, status:200,
  json: async () => {throw new SyntaxError('HTML')},
});
await assert.rejects(request('/read'), /unreadable response/);
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=source + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_loading_regions_do_not_flash_or_clear_newer_request_state():
    script = (Path(__file__).parents[1] / "avn_analytics/static/app.js").read_text()
    source = script[script.index("const regionLoads =") : script.index("function empty(")]
    checks = """
import assert from 'node:assert/strict';
const pending = new Map(); let next = 0;
globalThis.setTimeout = callback => {pending.set(++next, callback); return next;};
globalThis.clearTimeout = id => pending.delete(id);
const spinner = label => label;
const notices = [];
globalThis.document = {createElement: () => ({remove(){this.removed=true}})};
const element = {isConnected:true, textContent:'Previous results', innerHTML:'rows',
  attributes:new Map(), querySelector:()=>null, prepend:item=>notices.push(item),
  setAttribute(key,value){this.attributes.set(key,value)},
  removeAttribute(key){this.attributes.delete(key)},
};
let finish = beginLoading(element, 'skeleton');
finish();
assert.equal(pending.size,0); assert.equal(element.innerHTML,'rows');
const old = beginLoading(element, 'skeleton');
for (const callback of [...pending.values()]) callback();
assert.match(notices[0].innerHTML,/Updating.*previous results/);
const current = beginLoading(element, 'skeleton');
old();
assert.equal(element.attributes.get('aria-busy'),'true');
current();
assert.equal(element.attributes.has('aria-busy'),false);
assert.equal(notices[0].removed,true);
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=source + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
