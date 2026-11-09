"""Count any event: the tool for questions no other tool answers.

One event name, up to six parameter tests (the same operators as everywhere else, from rules.py),
a metric (how many events, players or sessions; or the sum, average, minimum, maximum, median or
90th percentile of a numeric parameter) and up to two ways to split the answer (day, country,
platform, app version, build, or any parameter's value).

Names that end up in SQL (the parameter being measured, the parameters being grouped on) must be
plain names; the operators are a fixed list and every value is a bound argument.
"""

import re
from math import ceil
from statistics import median

from . import insights, rules

METRICS = ("count", "players", "sessions", "sum", "avg", "min", "max", "median", "p90")
NUMERIC_METRICS = ("sum", "avg", "min", "max", "median", "p90")
OPS = ("eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists")
GROUPS = ("day", "country", "platform", "app_version", "build")
ORDERS = ("value_desc", "value_asc", "group")
NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,79}$")
MAX_TESTS = 6
MAX_GROUPS = 2
MAX_LIMIT = 200
MAX_VALUES = 200_000  # numbers read to find a median or percentile
MAX_GROUP_ROWS = 50_000


def _name(value, what):
    value = str(value or "")
    if not NAME.match(value):
        raise ValueError(f"{what} must be a plain name such as LEVEL_NUMBER.")
    return value


def _tests(where):
    if where is None:
        return []
    if not isinstance(where, list) or len(where) > MAX_TESTS:
        raise ValueError(f"where is a list of at most {MAX_TESTS} tests.")
    tests = []
    for item in where:
        if not isinstance(item, dict):
            raise ValueError('Each test looks like {"param": "STATE", "op": "eq", "value": "x"}.')
        op = item.get("op") or "eq"
        if op not in OPS:
            raise ValueError(f"op is one of: {', '.join(OPS)}.")
        value = item.get("value")
        if op != "exists" and (value is None or isinstance(value, dict | list)):
            raise ValueError(f"The test on {item.get('param')} needs a value.")
        tests.append({"param": _name(item.get("param"), "param"), "op": op, "value": value})
    return tests


def _groups(group_by):
    if group_by is None:
        return []
    if isinstance(group_by, str):
        group_by = [group_by]
    if not isinstance(group_by, list) or len(group_by) > MAX_GROUPS:
        raise ValueError(f"group_by is a list of at most {MAX_GROUPS} items.")
    found = []
    for item in group_by:
        item = str(item)
        if item.startswith("param:"):
            _name(item[6:], "param:NAME")
        elif item not in GROUPS:
            raise ValueError(f"group_by items are {', '.join(GROUPS)} or param:NAME.")
        if item in found:
            raise ValueError("Each group_by item can be used once.")
        found.append(item)
    return found


def _group_sql(item, source):
    if item == "day":
        return "substr(client_ts, 1, 10)"
    if item.startswith("param:"):
        return source.param(item[6:])
    return source.dimensions[item]


def _number(value, digits=6):
    return round(value, digits) if isinstance(value, int | float) else value


def _percentile(values, share):
    ordered = sorted(values)
    return ordered[max(0, ceil(share * len(ordered)) - 1)]


def _statistic(metric, values):
    if not values:
        return None
    return median(values) if metric == "median" else _percentile(values, 0.9)


def count_events(
    storage,
    game_id,
    start,
    end,
    filters,
    event,
    where=None,
    metric=None,
    param=None,
    group_by=None,
    limit=50,
    order=None,
):
    metric = metric or "count"
    if metric not in METRICS:
        raise ValueError(f"metric is one of: {', '.join(METRICS)}.")
    order = order or "value_desc"
    if order not in ORDERS:
        raise ValueError(f"order is one of: {', '.join(ORDERS)}.")
    event = str(event or "").strip()
    if not event or len(event) > 128:
        raise ValueError("event is the exact event name (1 to 128 characters).")
    limit = max(1, min(int(limit or 50), MAX_LIMIT))
    tests = _tests(where)
    groups = _groups(group_by)
    numeric = metric in NUMERIC_METRICS
    if numeric:
        if not param:
            raise ValueError(f"metric {metric} needs param, the numeric parameter to measure.")
        param = _name(param, "param")
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        condition, args = insights.where(start, end, filters, source=source)
        document = rules.PARAMS if source.facts else rules.PAYLOAD
        clauses = [f"name=? AND {condition}"]
        args = [event, *args]
        for test in tests:
            sql, test_args = rules.test_sql(test["param"], test["op"], test["value"], document)
            clauses.append(sql)
            args += test_args
        measured = source.param(param) if numeric else None
        number = (
            f"CASE WHEN {rules._is_number(measured)} THEN CAST({measured} AS REAL) END"
            if numeric
            else "NULL"
        )
        columns = ", ".join(f"{_group_sql(item, source)} AS g{i}" for i, item in enumerate(groups))
        connection.execute("DROP TABLE IF EXISTS temp.hits")
        connection.execute(
            f"""CREATE TEMP TABLE hits AS
                SELECT client_ts, {source.player} AS player, {source.session} AS session_id,
                       {number} AS num{", " + columns if columns else ""}
                FROM {source.table} WHERE {" AND ".join(clauses)}""",
            args,
        )
        names = [f"g{i}" for i in range(len(groups))]
        by = f" GROUP BY {', '.join(names)}" if names else ""
        in_sql = metric in ("count", "players", "sessions", "sum", "avg", "min", "max")
        value_sql = {
            "count": "count(*)",
            "players": "count(DISTINCT player)",
            "sessions": "count(DISTINCT session_id)",
            "sum": "sum(num)",
            "avg": "avg(num)",
            "min": "min(num)",
            "max": "max(num)",
        }.get(metric, "NULL")
        shape = f"""count(*) AS events, count(DISTINCT player) AS players,
                    count(*) FILTER (WHERE num IS NULL) AS ignored, {value_sql} AS value"""
        total = dict(connection.execute(f"SELECT {shape} FROM hits").fetchone())
        if not total["events"]:
            return {
                "available": False,
                "note": f"No {event} events match in this range with these tests and filters. "
                "Check the event name (list_events), the parameter names and the dates.",
            }
        groups_total = (
            connection.execute(f"SELECT count(*) FROM (SELECT 1 FROM hits{by})").fetchone()[0]
            if names
            else 1
        )
        capped = False
        values = {}
        if in_sql:
            ordering = {
                "value_desc": "value DESC, events DESC, ",
                "value_asc": "value IS NULL, value ASC, events DESC, ",
                "group": "",
            }[order]
            rows = connection.execute(
                f"""SELECT {", ".join(names + [""])}{shape} FROM hits{by}
                    ORDER BY {ordering}{", ".join(names) or "1"} LIMIT ?""",
                (limit,),
            ).fetchall()
        else:
            rows = connection.execute(
                f"SELECT {', '.join(names + [''])}{shape} FROM hits{by} "
                f"ORDER BY {', '.join(names) or '1'} LIMIT {MAX_GROUP_ROWS}"
            ).fetchall()
            keys = ", ".join(names + [""])
            numbers = connection.execute(
                f"SELECT {keys}num FROM hits WHERE num IS NOT NULL LIMIT {MAX_VALUES + 1}"
            ).fetchall()
            capped = len(numbers) > MAX_VALUES
            for row in numbers[:MAX_VALUES]:
                values.setdefault(tuple(row[name] for name in names), []).append(row["num"])
            total["value"] = _statistic(metric, [v for items in values.values() for v in items])
    results = []
    for row in rows:
        key = tuple(row[name] for name in names)
        value = row["value"] if in_sql else _statistic(metric, values.get(key, []))
        item = {
            "group": dict(zip(groups, key, strict=True)),
            "value": _number(value),
            "events": row["events"],
            "players": row["players"],
        }
        if numeric:
            item["ignored"] = row["ignored"]
        results.append(item)
    if not in_sql:
        results.sort(key=lambda item: tuple((v is None, str(v)) for v in item["group"].values()))
        if order != "group":
            present = [item for item in results if item["value"] is not None]
            present.sort(key=lambda item: item["value"], reverse=order == "value_desc")
            results = present + [item for item in results if item["value"] is None]
        results = results[:limit]
    note = []
    if capped:
        note.append(
            f"Only the first {MAX_VALUES} values were read, so the median or percentile is "
            "approximate."
        )
    if groups_total > len(results):
        note.append(f"{groups_total} groups matched; showing {len(results)}.")
    summary = {
        "available": True,
        "event": event,
        "metric": metric,
        "means": _means(metric, param, tests, groups),
        "total": {
            "value": _number(total["value"]),
            "events": total["events"],
            "players": total["players"],
            **({"ignored": total["ignored"]} if numeric else {}),
        },
        "groups": groups_total if groups else None,
        "rows": results,
    }
    if note:
        summary["note"] = " ".join(note)
    return summary


def _means(metric, param, tests, groups):
    what = {
        "count": "the number of events",
        "players": "the number of distinct players who sent one",
        "sessions": "the number of distinct sessions with one",
        "sum": f"the sum of {param}",
        "avg": f"the average of {param}",
        "min": f"the smallest {param}",
        "max": f"the largest {param}",
        "median": f"the median of {param}",
        "p90": f"the 90th percentile of {param} (90% of values are at or below it)",
    }[metric]
    text = f"value is {what} among the matching events"
    if groups:
        text += ", for each " + " and ".join(groups)
    text += ". events and players are how many events and distinct players each row rests on."
    if metric in NUMERIC_METRICS:
        text += f" ignored counts matching events with no numeric {param}, left out of the value."
    if tests:
        text += " Only events that pass every test in where are counted."
    return text
