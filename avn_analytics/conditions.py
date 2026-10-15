"""Nested event predicates shared by timeline highlights and event activity queries."""

import math
import re


def numeric_value(value):
    """Finite decimal numbers, with identical syntax in the browser and SQLite compiler."""
    text = str(value).strip()
    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
        return None
    number = float(text)
    return number if math.isfinite(number) else None


def condition_sql(node):
    """Compile a validated condition tree using bound values, never SQL from user input."""
    if "conditions" in node:
        parts = [condition_sql(child) for child in node["conditions"]]
        join = " AND " if node["match"] == "all" else " OR "
        return "(" + join.join(sql for sql, _ in parts) + ")", [
            arg for _, args in parts for arg in args
        ]
    op, value = node["op"], node["value"]
    if node["field"] == "event":
        if op == "contains":
            return "instr(lower(name), lower(?)) > 0", [value]
        return f"name {'=' if op == 'eq' else '!='} ?", [value]
    # json_each binds the key as data, including punctuation, without constructing a JSON path.
    base = "SELECT 1 FROM json_each(events.payload, '$.params') AS test WHERE test.key=?"
    args = [node["param"]]
    if op in ("exists", "missing"):
        return f"{'NOT ' if op == 'missing' else ''}EXISTS ({base})", args
    expr = "test.value"
    if op == "contains":
        test = f"instr(lower(CAST({expr} AS TEXT)), lower(?)) > 0"
        args.append(value)
    elif op in ("eq", "ne"):
        test = f"CAST({expr} AS TEXT) = ?"
        args.append(value)
        numeric = numeric_value(value)
        if numeric is not None:
            test = f"({test} OR (test.type IN ('integer', 'real') AND {expr} = ?))"
            args.append(numeric)
        if op == "ne":
            test = f"NOT ({test})"
    else:
        symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
        # Only numbers and valid JSON numeric strings can participate in numeric comparisons.
        numeric_type = (
            "CASE WHEN test.type IN ('integer', 'real') THEN 1 "
            "WHEN test.type='text' AND json_valid(trim(test.value)) "
            "THEN json_type(trim(test.value)) IN ('integer', 'real') ELSE 0 END"
        )
        test = (
            f"({numeric_type}) AND abs(CAST({expr} AS REAL)) <= 1.7976931348623157e308"
            f" AND CAST({expr} AS REAL) {symbol} ?"
        )
        args.append(float(value))
    return f"EXISTS ({base} AND ({test}))", args
