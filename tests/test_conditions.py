"""Browser highlights and SQL activity must interpret the same condition trees."""

import json
import shutil
import sqlite3
import subprocess
from pathlib import Path

import pytest

from avn_analytics.conditions import condition_sql
from avn_analytics.models import EventConditionGroup


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_nested_conditions_agree_in_browser_and_sql():
    events = [
        {"name": "AD_ANALYSIS", "params": {"STAGE": "Shown", "LEVEL": 3, "placement.id": "r"}},
        {"name": "AD_ANALYSIS", "params": {"STAGE": "Clicked", "LEVEL": "3", "empty": ""}},
        {"name": "other", "params": {"STAGE": "shown", "LEVEL": "03"}},
        {"name": "AD_ANALYSIS", "params": {"LEVEL": "3e1", "weird'key": "x"}},
        {"name": "AD_ANALYSIS", "params": {"LEVEL": "invalid", "STAGE": "SHOWN"}},
        {"name": "AD_ANALYSIS", "params": {"LEVEL": ".", "STAGE": "Ä"}},
        {"name": "other", "params": {"LEVEL": "3.0"}},
        {"name": "AD_ANALYSIS", "params": {}},
        {"name": "AD_ANALYSIS", "params": {"LEVEL": "1e999", 'a"b\\c': "x"}},
    ]
    tests = [
        {"field": "event", "value": "AD_ANALYSIS"},
        {"field": "event", "op": "ne", "value": "AD_ANALYSIS"},
        {"field": "event", "op": "contains", "value": "analysis"},
        {"param": "STAGE", "value": "Shown"},
        {"param": "STAGE", "op": "ne", "value": "Shown"},
        {"param": "STAGE", "op": "contains", "value": "shown"},
        {"param": "STAGE", "op": "contains", "value": "ä"},
        {"param": "LEVEL", "value": "3"},
        {"param": "LEVEL", "op": "ne", "value": "3"},
        {"param": "LEVEL", "value": "3.0"},
        {"param": "LEVEL", "value": "0x3"},
        {"param": "LEVEL", "value": ""},
        {"param": "LEVEL", "op": "gt", "value": "2"},
        {"param": "LEVEL", "op": "gte", "value": "3"},
        {"param": "LEVEL", "op": "lt", "value": "4"},
        {"param": "LEVEL", "op": "lte", "value": "3"},
        {"param": "empty", "op": "exists"},
        {"param": "empty", "op": "missing"},
        {"param": "placement.id", "value": "r"},
        {"param": "weird'key", "value": "x"},
        {"param": "STAGE", "value": "' OR 1=1 --"},
        {"param": 'a"b\\c', "value": "x"},
    ]
    trees = [{"conditions": [test]} for test in tests]
    trees.append({"conditions": [tests[0], {"match": "any", "conditions": [tests[3], tests[12]]}]})
    trees.append({"match": "any", "conditions": [trees[-1], {"conditions": [tests[16]]}]})
    trees = [EventConditionGroup.model_validate(tree).model_dump() for tree in trees]
    expected = []
    with sqlite3.connect(":memory:") as connection:
        connection.execute("CREATE TABLE events (name TEXT, payload TEXT)")
        connection.executemany(
            "INSERT INTO events VALUES (?, ?)",
            [(event["name"], json.dumps(event)) for event in events],
        )
        for tree in trees:
            predicate, args = condition_sql(tree)
            expected.append(
                [
                    row[0] - 1
                    for row in connection.execute(
                        f"SELECT rowid FROM events WHERE {predicate} ORDER BY rowid", args
                    )
                ]
            )
    script = (Path(__file__).parents[1] / "avn_analytics/static/conditions.js").read_text()
    checks = f"""
import assert from 'node:assert/strict';
const events = {json.dumps(events)};
const trees = {json.dumps(trees)};
const expected = {json.dumps(expected)};
for (const [index, tree] of trees.entries()) {{
  assert.equal(conditionError(tree), '');
  assert.deepEqual(events.flatMap((event, index) =>
    eventMatchesCondition(event, tree) ? [index] : []), expected[index], JSON.stringify(tree));
}}
assert.deepEqual(matchingConditionParams(events[0], trees.at(-2)), ['STAGE', 'LEVEL']);
assert.deepEqual(matchingConditionParams(events[7], trees.at(-2)), []);
assert.match(conditionError(conditionGroup()), /Add a condition/);
assert.match(conditionError(conditionGroup([paramCondition('')])), /parameter/);
assert.match(conditionError(conditionGroup([{{field:'param',param:'x',op:'gt',value:'NaN'}}])),
  /finite number/);
const rules = [
  {{enabled:true,conditions:trees[0]}},
  {{enabled:true,conditions:trees[3]}},
  {{enabled:false,conditions:trees[1]}},
  {{enabled:true,conditions:conditionGroup([paramCondition('')])}},
];
const originalEvents = structuredClone(events);
const indices = highlightMatchIndices(events, rules);
assert.deepEqual(indices, [0, 1, 3, 4, 5, 7, 8]);
assert.deepEqual(highlightMatchIndices(events, rules, '1'), [0]);
assert.deepEqual(highlightMatchIndices(events, rules, '2'), []);
assert.equal(highlightNavigationIndex(indices, -1), 0);
assert.equal(highlightNavigationIndex(indices, 1), 3);
assert.equal(highlightNavigationIndex(indices, 8), 0);
assert.equal(highlightNavigationIndex(indices, 7, false), 5);
assert.equal(highlightNavigationIndex(indices, 0, false), 8);
assert.equal(highlightNavigationIndex([], 0), -1);
assert.deepEqual(events, originalEvents); // highlights never filter or mutate the timeline
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=script + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
