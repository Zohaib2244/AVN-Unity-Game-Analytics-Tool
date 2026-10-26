"""Event rules are evaluated in three places: funnel steps (insights.matches), player rules and
columns (rules.test_sql) and highlight/activity trees (conditions.condition_sql). The website offers
the same comparisons for all of them (lib/conditions.ts), so for ordinary values they must agree.

COMMON pins that. EDGE_CASES records where they differ today (odd number spellings, booleans, an
empty "equals" value); a change there moves dashboard numbers, so make it deliberately:
update the table with the change.
"""

import json
import sqlite3

import pytest

from avn_analytics import conditions, insights, rules

VALUES = [5, 12, "12", "abc", "ABC", 5.5, "", None, True, "007", "1e3", " 7"]
LABELS = [repr(value) for value in VALUES]


@pytest.fixture(scope="module")
def connection():
    connection = sqlite3.connect(":memory:")
    connection.execute("CREATE TABLE events(name TEXT, payload TEXT)")
    for value in VALUES:
        params = {"L": value} if value is not None else {"M": 1}
        connection.execute("INSERT INTO events VALUES ('e', ?)", (json.dumps({"params": params}),))
    return connection


def funnel(op, wanted):
    step = {"event": "e", "param": "L", "op": op, "value": wanted}
    return [
        insights.matches(step, "e", {"L": value} if value is not None else {"M": 1})
        for value in VALUES
    ]


def sql(connection, clause, args):
    return [
        bool(
            connection.execute(
                f"SELECT ({clause}) FROM events WHERE rowid=?", [*args, i]
            ).fetchone()[0]
        )
        for i in range(1, len(VALUES) + 1)
    ]


def players(connection, op, wanted):
    return sql(connection, *rules.test_sql("L", op, wanted))


def tree(connection, op, wanted):
    return sql(
        connection,
        *conditions.condition_sql({"field": "param", "param": "L", "op": op, "value": wanted}),
    )


COMMON = [
    ("eq", "12"),
    ("ne", "12"),
    ("eq", "abc"),
    ("ne", "abc"),
    ("contains", "ab"),
    ("gt", "6"),
    ("lt", "6"),
    ("exists", ""),
]
# Cases where the three differ today: (op, value) -> the rows (by VALUES index) that do not agree.
EDGE_CASES = {
    ("gt", "6"): {
        9,
        10,
        11,
    },  # odd number spellings ("007", "1e3", " 7") are numbers in some, text in others
    ("gte", "12"): {10},
    ("lt", "12"): {8, 9, 11},  # and true counts as a number in funnels and players only
    ("eq", ""): set(range(len(VALUES))) - {6, 7},  # an empty value means "any" for funnels only
}


@pytest.mark.parametrize(("op", "wanted"), COMMON)
def test_rules_agree_for_ordinary_values(connection, op, wanted):
    ordinary = [i for i, value in enumerate(VALUES) if value not in (True, "007", "1e3", " 7")]
    results = [funnel(op, wanted), players(connection, op, wanted), tree(connection, op, wanted)]
    for index in ordinary:
        assert len({tuple([r[index]]) for r in results}) == 1, (op, wanted, LABELS[index])


@pytest.mark.parametrize(("op", "wanted"), sorted(EDGE_CASES))
def test_known_differences_stay_where_they_are(connection, op, wanted):
    results = [funnel(op, wanted), players(connection, op, wanted), tree(connection, op, wanted)]
    differing = {i for i in range(len(VALUES)) if len({r[i] for r in results}) > 1}
    assert differing == EDGE_CASES[(op, wanted)], [LABELS[i] for i in sorted(differing)]
