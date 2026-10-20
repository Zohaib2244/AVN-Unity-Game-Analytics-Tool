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
    raw_events = script[
        script.index("async function renderRawEvents(") : script.index("/* ─── Levels:")
    ]
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
const api = async () => ({events:rows,truncated:false,snapshot:rows.length});
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
def test_first_session_results_and_paths_render_what_the_server_sent():
    script = (Path(__file__).parents[1] / "avn_analytics/static/first-session.js").read_text()
    rendering = script[: script.index("function mountFirstSession(")]
    checks = """
import assert from 'node:assert/strict';
const escapeHTML = value => String(value).replace(/</g, '&lt;');
const number = value => String(value);
const percent = value => `${value}%`;
const data = {
  players: 4, minimum_players: 30, reached_end: 1, excluded: {started_at_other_level: 2},
  steps: [{level: 1, started: 4, completed: 3, percent: 75}],
  run_lengths: [{levels: 0, players: 1}, {levels: 3, players: 3}],
  ends: [{level: 1, stage: 'between', reason: 'Opened <settings>', players: 2}],
  flags: [{level: 1, stage: 'during', path: 'Failed the level', players: 1}],
};
let html = flowResultsHTML(data);
assert.match(html, /4 new players · small sample/);
assert.match(html, /2 started somewhere other than the first level/);
assert.match(html, /Opened &lt;settings>/);  // server text is escaped
assert.match(html, /Flagged detours/);
assert.doesNotMatch(flowResultsHTML({...data, flags: []}), /Flagged detours/);
assert.match(flowResultsHTML({...data, players: 0}), /No new players/);
const paths = flowPathsHTML([
  {key: 'between|Shop', stage: 'between', path: 'Shop', players: 3, allowed: true},
  {key: 'during|Failed the level', stage: 'during', path: 'Failed the level',
   players: 2, allowed: false},
]);
assert.match(paths, /data-flow-path="between\\|Shop" checked>/);
assert.match(paths, /data-flow-path="during\\|Failed the level" >/);
assert.match(flowPathsHTML([]), /No detours seen/);
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=rendering + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
