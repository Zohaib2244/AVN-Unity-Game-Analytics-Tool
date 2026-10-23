"""Player analysis counts and simple highlights retain precise event identity and scope."""

import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="Node exercises browser logic")
def test_player_event_counts_scopes_parameters_and_simple_highlight_semantics():
    web = Path(__file__).parents[1] / "web" / "src" / "lib"
    checks = """
import assert from 'node:assert/strict';
import {conditionGroup, eventCondition, paramCondition, eventMatchesCondition, simpleHighlightTree,
  describeHighlight} from './conditions.ts';
import {analysisValueKey, analysisMatchesFilters, analysisParameterValues, playerEventAnalysis}
  from './player-events.ts';
const rows = [
  {event_id:'a',name:'AD_ANALYSIS',session:0,level:null,
    params:{AD_TYPE:'interstitial',STAGE:'shown',LEVEL:1}},
  {event_id:'b',name:'AD_ANALYSIS',session:0,level:null,
    params:{AD_TYPE:'interstitial',STAGE:'loaded',LEVEL:'1'}},
  {event_id:'c',name:'AD_ANALYSIS',session:1,level:null,
    params:{AD_TYPE:'reward',STAGE:'shown',LEVEL:1}},
  {event_id:'d',name:'wheel_spin',session:1,level:null,params:{}},
  {event_id:'e',name:'level_start',session:1,level:3,params:{level:3}},
  {event_id:'f',name:'level_fail',session:1,level:3,params:{level:3}},
  {event_id:'g',name:'level_start',session:1,level:4,params:{level:4}},
];
const all = playerEventAnalysis(rows);
assert.equal(all.total, 7);
assert.equal(all.groups.length, 4);
assert.equal(all.levels, 2, 'Repeated level events are not distinct levels');
assert.equal(all.groups[0].name, 'AD_ANALYSIS');
assert.equal(all.groups[0].sessions.size, 2);
assert.equal(all.groups[0].params.get('AD_TYPE').get(analysisValueKey('interstitial')).count, 2);
assert.equal(all.groups[0].params.get('STAGE').get(analysisValueKey('shown')).count, 2);
assert.equal(all.groups[0].params.get('LEVEL').size, 2, 'String and number values remain distinct');
assert.equal(all.groups.reduce((sum, group) => sum + group.items.length, 0), all.total);
const session = playerEventAnalysis(rows, '1');
assert.equal(session.total, 5);
assert.deepEqual(session.groups.find(group => group.name === 'AD_ANALYSIS')
  .items.map(e => e.event_id),
  ['c']);
assert.equal(session.groups.find(group => group.name === 'AD_ANALYSIS').items[0].index, 2,
  'A scoped occurrence keeps its original raw-timeline index');
assert.equal(playerEventAnalysis(rows, 'missing').total, 0);
assert.equal(playerEventAnalysis([]).groups.length, 0);
const tree = conditionGroup([eventCondition('AD_ANALYSIS'),
  {...paramCondition('AD_TYPE'),value:'interstitial'}, {...paramCondition('STAGE'),value:'shown'}]);
assert.equal(simpleHighlightTree(tree), true);
assert.deepEqual(rows.filter(event => eventMatchesCondition(event, tree))
  .map(e => e.event_id), ['a']);
assert.match(describeHighlight(tree), /AD_TYPE equals “interstitial” AND STAGE equals “shown”/);
assert.equal(simpleHighlightTree({...tree, match:'any'}), false,
  'OR rules remain advanced; never silently change their meaning');
assert.equal(simpleHighlightTree(conditionGroup([tree])), false);
assert.equal(simpleHighlightTree(conditionGroup([{...eventCondition('ad'),op:'contains'}])), false);
const duplicateNames = playerEventAnalysis([...rows, {...rows[0],event_id:'h'}]);
assert.equal(duplicateNames.groups[0].items.length, 4,
  'Count individual calls, not distinct payloads');
assert.equal(rows[2].index, undefined, 'Analysis must not mutate the raw dataset');
const filters = new Map([['AD_TYPE',
  {value:'interstitial',token:analysisValueKey('interstitial')}] ]);
assert.equal(analysisParameterValues(rows.slice(0,3), filters, 'STAGE')
  .find(value => value.value === 'shown').count, 1);
filters.set('STAGE', {value:'shown',token:analysisValueKey('shown')});
assert.deepEqual(rows.filter(event => analysisMatchesFilters(event, filters))
  .map(event => event.event_id), ['a'], 'Combine ad type and stage without counting loads');
assert.equal(analysisMatchesFilters(rows[0], new Map([['missing',
  {value:'',token:analysisValueKey('')}]])), false);
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=checks,
        text=True,
        capture_output=True,
        timeout=30,
        cwd=web,
    )
    assert result.returncode == 0, result.stderr
