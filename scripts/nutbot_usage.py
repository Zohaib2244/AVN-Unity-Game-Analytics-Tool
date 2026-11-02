"""What NutBot's real answers fetched: which tools run, how long they take, what gets repeated.

Run it inside the running admin container (from the folder with compose.yaml):

    docker compose exec -T admin python - < scripts/nutbot_usage.py

Optional: DAYS=7 (default 30). The registry is opened read-only, so nothing can be written, and
only totals are printed: no questions, answers or player IDs.

Answers saved by a current build carry what the server measured: real time, result size, whether
a result was cut, and what errors said. Older answers only have the agent's own log, whose times
are not reliable and whose outputs stop at 2000 characters, so "large" means reaching that limit.
Error text is ours, but can repeat what the agent sent, so long IDs in it are masked.
"""

import json
import os
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from statistics import median

STORED_OUTPUT = 2000
LONG_ID = re.compile(r"\b[0-9a-fA-F-]{16,}\b")
UNSURE = re.compile(
    r"can(?:'|’)?t tell|cannot tell|can(?:'|’)?t say|don(?:'|’)?t know|too few|not enough|"
    r"output was cut|no way to|isn(?:'|’)?t (?:recorded|available)",
    re.I,
)


def percentile(values, share):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * share))] if ordered else None


def read_answers(registry, days):
    """Stored answers from the last `days` days, read without being able to write."""
    since = (datetime.now(UTC) - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
    connection = sqlite3.connect(f"file:{registry}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        return connection.execute(
            "SELECT text, tools, error, seconds, input_tokens, output_tokens, cache_read_tokens"
            " FROM nutbot_messages WHERE role='assistant' AND created_at>=?",
            (since,),
        ).fetchall()
    finally:
        connection.close()


def summarise(rows):
    tools = defaultdict(
        lambda: {
            "calls": 0,
            "ms": [],
            "chars": [],
            "failed": 0,
            "cut": 0,
            "large": 0,
            "errors": Counter(),
        }
    )
    repeats, per_answer, unsure, errors = 0, [], 0, 0
    orders = Counter()
    for row in rows:
        used = json.loads(row["tools"] or "[]")
        per_answer.append(len(used))
        unsure += bool(UNSURE.search(row["text"] or ""))
        errors += bool(row["error"])
        seen = set()
        for call in used:
            name = call.get("tool") or "unknown"
            item = tools[name]
            item["calls"] += 1
            if call.get("server_ms") is not None:
                item["ms"].append(call["server_ms"])
                item["chars"].append(call.get("chars") or 0)
            item["failed"] += bool(call.get("denied") or call.get("ok") is False)
            item["cut"] += bool(call.get("cut"))
            item["large"] += len(call.get("output") or "") >= STORED_OUTPUT
            if call.get("error"):
                item["errors"][LONG_ID.sub("<id>", call["error"])[:160]] += 1
            key = (name, call.get("input"))
            repeats += key in seen
            seen.add(key)
        if used:
            orders[" > ".join(call.get("tool") or "unknown" for call in used[:3])] += 1
    seconds = [row["seconds"] for row in rows if row["seconds"] is not None]
    return {
        "answers": len(rows),
        "errors": errors,
        "said_unsure": unsure,
        "seconds_median": round(median(seconds), 1) if seconds else None,
        "seconds_p90": percentile(seconds, 0.9),
        "tools_per_answer_median": median(per_answer) if per_answer else None,
        "tools_per_answer_most": max(per_answer, default=None),
        "repeated_calls": repeats,
        "input_tokens": sum(row["input_tokens"] or 0 for row in rows),
        "cached_input_tokens": sum(row["cache_read_tokens"] or 0 for row in rows),
        "output_tokens": sum(row["output_tokens"] or 0 for row in rows),
        "tools": {
            name: {
                "calls": item["calls"],
                "ms_median": int(median(item["ms"])) if item["ms"] else None,
                "ms_p90": percentile(item["ms"], 0.9),
                "chars_median": int(median(item["chars"])) if item["chars"] else None,
                "failed": item["failed"],
                "cut": item["cut"],
                "large": item["large"],
                "errors": item["errors"].most_common(3),
            }
            for name, item in sorted(tools.items(), key=lambda pair: -pair[1]["calls"])
        },
        "first_tools": orders.most_common(8),
    }


def _shown(value):
    return "-" if value is None else value


def show(report, days):
    print(f"NutBot, last {days} days")
    for key, value in report.items():
        if key not in ("tools", "first_tools"):
            print(f"  {key}: {value}")
    print(
        f"\n{'tool':28} {'calls':>6} {'ms med':>7} {'ms p90':>7} {'chars':>7} "
        f"{'failed':>6} {'cut':>4} {'large':>6}"
    )
    for name, item in report["tools"].items():
        print(
            f"{name:28} {item['calls']:>6} {_shown(item['ms_median']):>7} "
            f"{_shown(item['ms_p90']):>7} {_shown(item['chars_median']):>7} "
            f"{item['failed']:>6} {item['cut']:>4} {item['large']:>6}"
        )
    for name, item in report["tools"].items():
        for text, count in item["errors"]:
            print(f"  {name} failed {count}x: {text}")
    print("\nHow answers started (first three tools):")
    for order, count in report["first_tools"]:
        print(f"{count:>6}  {order}")


def main():
    from avn_analytics.config import Settings

    days = int(os.environ.get("DAYS", "30"))
    registry = Path(Settings.from_env().data_dir) / "registry.sqlite3"
    show(summarise(read_answers(registry, days)), days)


if __name__ == "__main__":
    main()
