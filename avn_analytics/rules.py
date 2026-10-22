"""Event rules as SQL: "an event, optionally with a parameter test", and what to do with it.

The same small vocabulary is used wherever the dashboard asks "players who did X": a condition
(did / didn't do an event, optionally with a parameter test) filters players, and a metric
(how many times, highest/lowest/total of a parameter, first/last time) adds a column and a sort
key. Everything works on one game's events: the raw events (payload holds the event as JSON,
parameters under $.params) or the analytics facts (params holds the parameters as JSON), picked
with `document`: PAYLOAD or PARAMS.
"""

NUMERIC_TYPES = "('integer', 'real')"
PAYLOAD = ("payload", "$.params")  # (column, JSON path of the parameters in it)
PARAMS = ("params", "$")


def param_path(param, document=PAYLOAD):
    if '"' in param or "\\" in param:
        raise ValueError("Parameter names can't contain quotes")
    return f'{document[1]}."{param}"'


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _is_number(expr):
    """SQL: the extracted value is a number, or text that is only a number."""
    return (
        f"({expr} IS NOT NULL AND (typeof({expr}) IN {NUMERIC_TYPES} OR "
        f"(typeof({expr}) = 'text' AND {expr} <> '' AND trim({expr}, '0123456789.-') = '')))"
    )


def test_sql(param, op, value, document=PAYLOAD):
    """SQL and arguments for one parameter test (op: eq ne gt gte lt lte contains exists)."""
    path = param_path(param, document)
    expr = f"json_extract({document[0]}, ?)"
    if op == "exists":
        return f"{expr} IS NOT NULL", [path]
    number = _number(value)
    if op in ("eq", "ne"):
        if number is not None:
            same = f"({expr} = ? OR CAST({expr} AS TEXT) = ?)"
            args = [path, number, path, str(value)]
        else:
            same = f"CAST({expr} AS TEXT) = ?"
            args = [path, str(value)]
        if op == "eq":
            return same, args
        return f"({expr} IS NOT NULL AND NOT {same})", [path, *args]
    if op == "contains":
        return f"instr(lower(CAST({expr} AS TEXT)), lower(?)) > 0", [path, str(value)]
    if op in ("gt", "gte", "lt", "lte"):
        if number is None:
            raise ValueError("Compare with a number")
        symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
        guard = _is_number(expr)
        return (
            f"({guard} AND CAST({expr} AS REAL) {symbol} ?)",
            [path] * (guard.count("?") + 1) + [number],
        )
    raise ValueError(f"Unknown operator {op}")


def condition_sql(rule, document=PAYLOAD):
    """SQL and arguments true for an event matching rule {event, param, op, value}."""
    clause, args = "name = ?", [rule["event"]]
    if rule.get("param"):
        test, test_args = test_sql(
            rule["param"], rule.get("op") or "eq", rule.get("value", ""), document
        )
        clause, args = f"{clause} AND {test}", [*args, *test_args]
    return f"({clause})", args


def count_sql(rule, document=PAYLOAD):
    condition, args = condition_sql(rule, document)
    return f"sum(CASE WHEN {condition} THEN 1 ELSE 0 END)", args


def metric_sql(metric, document=PAYLOAD):
    """SQL aggregate (per player) and arguments for a metric."""
    condition, args = condition_sql(metric, document)
    agg = metric.get("agg") or "count"
    if agg == "count":
        return f"sum(CASE WHEN {condition} THEN 1 ELSE 0 END)", args
    if agg in ("first", "last"):
        function = "min" if agg == "first" else "max"
        return f"{function}(CASE WHEN {condition} THEN client_ts END)", args
    of = metric.get("of") or metric.get("param")
    if agg not in ("max", "min", "sum") or not of:
        raise ValueError("Choose which parameter to total or compare")
    expr = f"json_extract({document[0]}, ?)"
    guard = _is_number(expr)
    return (
        f"{agg}(CASE WHEN {condition} AND {guard} THEN CAST({expr} AS REAL) END)",
        [*args, *([param_path(of, document)] * (guard.count("?") + 1))],
    )
