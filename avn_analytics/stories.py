"""Turns raw events into readable stories: "Played levels 1–10, completed all".

An event gets a human label (from the game's dictionary, or a sensible automatic one), runs of
level events are folded into one line, noise is dropped, and sessions become chapters. Journeys
(many players at once) group players by the shape of their story.
"""

import re
from collections import Counter
from datetime import datetime
from statistics import median

LEVEL_VERBS = {
    "started": "started",
    "start": "started",
    "begin": "started",
    "completed": "completed",
    "complete": "completed",
    "finished": "completed",
    "won": "completed",
    "win": "completed",
    "passed": "completed",
    "failed": "failed",
    "fail": "failed",
    "lost": "failed",
    "lose": "failed",
    "restarted": "restarted",
    "restart": "restarted",
    "retried": "restarted",
    "retry": "restarted",
}
VERB_TEXT = {
    "started": "Started",
    "completed": "Completed",
    "failed": "Failed",
    "restarted": "Restarted",
}
LEVEL_KEY = re.compile(r"^level(_?(number|num|id|index))?$", re.I)
LEVELISH_KEY = re.compile(r"level", re.I)
NOISE_KEY = re.compile(r"(time|duration|second|score|timestamp|_ts$|^ts$|id$)", re.I)
HIDDEN_PARAMS = {"seq"}
BOUNDARY_EVENTS = {"session_start", "session_end"}
FRIENDLY_SDK = {
    "first_open": "First open",
    "session_start": "Session started",
    "session_end": "Session ended",
}
DUPLICATE_SECONDS = 3
BIG_GAP_SECONDS = 1800
MAX_SEGMENT_EVENTS = 400


def humanize(name):
    """MM_ANALYSIS -> "MM", POWERUP_CONSUMED -> "Powerup consumed", levelStart -> "Level start"."""
    if name in FRIENDLY_SDK:
        return FRIENDLY_SDK[name]
    text = re.sub(r"(?<=[a-z])(?=[A-Z])", "_", name)
    words = [word for word in text.split("_") if word]
    if len(words) > 1 and words[-1].upper() == "ANALYSIS":
        words = words[:-1]
    if not words:
        return name
    rendered = [word if (word.isupper() and len(word) <= 3) else word.lower() for word in words]
    first = rendered[0]
    rendered[0] = first if first.isupper() and len(first) <= 3 else first.capitalize()
    return " ".join(rendered)


def _int(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if number == int(number) else None


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _lookup(params, key):
    if key in params:
        return params[key]
    lowered = key.lower()
    for name, value in params.items():
        if name.lower() == lowered:
            return value
    return None


def parse_rules(text):
    """Dictionary label lines, e.g. 'Started => Started level {Started}', '* => Opened menu'."""
    rules = []
    for line in (text or "").splitlines():
        if "=>" not in line:
            continue
        when, _, body = line.partition("=>")
        when, body = when.strip(), body.strip()
        if when and body:
            rules.append((when, body))
    return rules


def _canonical_match(rule, params):
    param = rule.get("param") or ""
    if not param:
        return True
    actual = _lookup(params, param)
    op = rule.get("op") or "eq"
    if op == "exists":
        return actual is not None
    if actual is None:
        return False
    wanted = rule.get("value", "")
    if op == "contains":
        return str(wanted).lower() in str(actual).lower()
    left, right = _number(actual), _number(wanted)
    if left is None or right is None:
        left, right = str(actual).lower(), str(wanted).lower()
    return {
        "eq": left == right,
        "ne": left != right,
        "gt": left > right,
        "gte": left >= right,
        "lt": left < right,
        "lte": left <= right,
    }.get(op, False)


class Labeler:
    """Names events for people. definitions is the game's event dictionary."""

    def __init__(self, definitions=None):
        self.definitions = definitions or {}

    def hidden(self, name):
        return bool((self.definitions.get(name) or {}).get("hidden"))

    def canonical(self, name, params):
        """Shared analytics concepts matched by this raw event and its parameters."""
        return [
            rule["action"]
            for rule in (self.definitions.get(name) or {}).get("canonical", [])
            if _canonical_match(rule, params)
        ]

    def level_info(self, name, params):
        """(verb, level number) when the event is a level start/complete/fail/restart."""
        canonical_verbs = {
            "level_started": "started",
            "level_completed": "completed",
            "level_failed": "failed",
            "level_restarted": "restarted",
        }
        mapped = next(
            (
                canonical_verbs[action]
                for action in self.canonical(name, params)
                if action in canonical_verbs
            ),
            None,
        )
        if mapped:
            number = next(
                (
                    _int(value)
                    for key, value in params.items()
                    if LEVEL_KEY.match(key) and _int(value) is not None
                ),
                None,
            )
            if number is not None:
                return mapped, number
        for key, value in params.items():
            verb = LEVEL_VERBS.get(key.lower())
            number = _int(value)
            if (
                verb
                and number is not None
                and (LEVELISH_KEY.search(name) or "level" in key.lower())
            ):
                return verb, number
        if LEVELISH_KEY.search(name):
            tokens = [
                token.lower() for token in re.split(r"[_\W]+|(?<=[a-z])(?=[A-Z])", name) if token
            ]
            verb = next((LEVEL_VERBS[token] for token in tokens if token in LEVEL_VERBS), None)
            number = next(
                (
                    _int(value)
                    for key, value in params.items()
                    if LEVEL_KEY.match(key) and _int(value) is not None
                ),
                None,
            )
            if verb and number is not None:
                return verb, number
        return None

    def label(self, name, params):
        """Short human text for one event."""
        params = {key: value for key, value in params.items() if key not in HIDDEN_PARAMS}
        for when, body in parse_rules((self.definitions.get(name) or {}).get("labels", "")):
            if when == "*" or _lookup(params, when) is not None:
                return re.sub(
                    r"\{([^{}]+)\}", lambda m: str(_lookup(params, m.group(1).strip()) or ""), body
                ).strip()
        info = self.level_info(name, params)
        if info:
            return f"{VERB_TEXT[info[0]]} level {info[1]}"
        if name in FRIENDLY_SDK:
            return FRIENDLY_SDK[name]
        parts = []
        for key, value in params.items():
            if NOISE_KEY.search(key) and not LEVELISH_KEY.search(key):
                continue
            if LEVELISH_KEY.search(key):
                parts.append(f"on level {value}" if _int(value) is not None else f"level {value}")
            elif isinstance(value, str) and len(value) <= 32 and _number(value) is None:
                parts.append(value)
            elif _number(value) is not None:
                parts.append(f"{key} {value}")
            if len(parts) >= 3:
                break
        text = humanize(name)
        return f"{text} · {' '.join(parts)}" if parts else text


ENUM_VALUE = re.compile(r"^[A-Za-z_]{1,14}$")


def shape_label(self, name, params):
    """A steadier name for grouping players: drops one-off values like device models."""
    params = {key: value for key, value in params.items() if key not in HIDDEN_PARAMS}
    definition = self.definitions.get(name) or {}
    if parse_rules(definition.get("labels", "")) or self.level_info(name, params):
        return self.label(name, params)
    if name in FRIENDLY_SDK:
        return FRIENDLY_SDK[name]
    parts = []
    for key, value in params.items():
        if NOISE_KEY.search(key) and not LEVELISH_KEY.search(key):
            continue
        if isinstance(value, str) and ENUM_VALUE.match(value) and _number(value) is None:
            parts.append(value)
        elif LEVELISH_KEY.search(key) and _int(value) is not None:
            parts.append(f"on level {value}")
        if len(parts) >= 3:
            break
    text = humanize(name)
    return f"{text} · {' '.join(parts)}" if parts else text


Labeler.shape = shape_label


def default_label_rules(observed):
    """Suggested dictionary label rules for an event, from the params it has been seen with."""
    lines = []
    for key in sorted(observed):
        verb = LEVEL_VERBS.get(key.lower())
        if verb:
            lines.append(f"{key} => {VERB_TEXT[verb]} level {{{key}}}")
    return "\n".join(lines)


def _seconds(left, right):
    return (datetime.fromisoformat(right) - datetime.fromisoformat(left)).total_seconds()


def clean_events(events, labeler, include_hidden=False):
    """Add labels, drop hidden events and fold same-label repeats within a few seconds."""
    cleaned = []
    for event in events[: MAX_SEGMENT_EVENTS * 50]:
        name, params = event["name"], event.get("params") or {}
        if not include_hidden and (labeler.hidden(name) or name in BOUNDARY_EVENTS):
            continue
        text = labeler.label(name, params)
        previous = cleaned[-1] if cleaned else None
        if (
            previous
            and previous["text"] == text
            and previous["session_id"] == event.get("session_id")
            and _seconds(previous["last_ts"], event["client_ts"]) <= DUPLICATE_SECONDS
        ):
            previous["count"] += 1
            previous["last_ts"] = event["client_ts"]
            continue
        cleaned.append(
            {
                "name": name,
                "text": text,
                "t": event["client_ts"],
                "last_ts": event["client_ts"],
                "session_id": event.get("session_id"),
                "params": params,
                "level": labeler.level_info(name, params),
                "shape": labeler.shape(name, params),
                "count": 1,
            }
        )
    return cleaned


def _level_run(items):
    """One folded run of level events -> a single readable segment."""
    levels = {}
    order = []
    extras = Counter()
    for item in items:
        if item["level"] is None:
            extras[item["text"]] += item["count"]
            continue
        verb, number = item["level"]
        if number not in levels:
            levels[number] = {
                "level": number,
                "started": 0,
                "completed": 0,
                "failed": 0,
                "restarted": 0,
                "seconds": None,
                "_start": None,
            }
            order.append(number)
        entry = levels[number]
        entry[verb] += item["count"]
        if verb in ("started", "restarted"):
            entry["_start"] = item["t"]
        elif verb == "completed" and entry["_start"]:
            entry["seconds"] = round(_seconds(entry["_start"], item["t"]), 1)
    rows = sorted(levels.values(), key=lambda row: row["level"])
    for row in rows:
        row.pop("_start")
    first, last = rows[0]["level"], rows[-1]["level"]
    completed = [row for row in rows if row["completed"]]
    failures = sum(row["failed"] for row in rows)
    restarts = sum(row["restarted"] for row in rows)
    left_on = next((row["level"] for row in reversed(rows) if not row["completed"]), None)
    last_event = next((item for item in reversed(items) if item["level"]), None)
    parts = [f"Played level {first}" if first == last else f"Played levels {first}–{last}"]
    if len(rows) == 1 and completed:
        parts.append("completed")
    elif len(completed) == len(rows) and len(rows) > 1:
        parts.append("completed all")
    elif completed:
        parts.append(f"completed {len(completed)} of {len(rows)}")
    elif rows:
        parts.append("didn't complete")
    if failures:
        parts.append(f"failed {failures}×")
    if restarts:
        parts.append(f"restarted {restarts}×")
    text = ", ".join(parts)
    if (
        left_on is not None
        and last_event
        and last_event["level"][0] in ("started", "restarted", "failed")
    ):
        text += f", left on level {left_on}"
    times = [row["seconds"] for row in rows if row["seconds"] is not None]
    slow = None
    if times:
        typical = median(times)
        worst = max(rows, key=lambda row: row["seconds"] or 0)
        if worst["seconds"] >= 90 and (len(times) == 1 or worst["seconds"] >= 3 * max(typical, 1)):
            slow = {"level": worst["level"], "seconds": worst["seconds"]}
    verb, number = last_event["level"] if last_event else (None, last)
    exit_text = {
        "started": f"Left during level {number}",
        "restarted": f"Left during level {number}",
        "failed": f"Left after failing level {number}",
        "completed": f"Left after completing level {number}",
    }.get(verb, f"Left after level {number}")
    return {
        "type": "levels",
        "exit": exit_text,
        "text": text,
        "t": items[0]["t"],
        "end": items[-1]["last_ts"],
        "first_level": first,
        "last_level": last,
        "levels": rows,
        "slowest": slow,
        "extras": [{"text": key, "count": count} for key, count in extras.most_common(8)],
        "shape": (f"Levels {first}–{last}" if first != last else f"Level {first}")
        + (" (all completed)" if len(completed) == len(rows) and not failures else ""),
    }


def compress(items):
    """Fold level runs (with the power-ups and the like used inside them) into single segments."""
    segments, run = [], []
    run_levels = set()

    def flush():
        nonlocal run, run_levels
        if run:
            segments.append(_level_run(run))
        run, run_levels = [], set()

    def attached(item):
        for key, value in item["params"].items():
            if LEVELISH_KEY.search(key) and _int(value) in run_levels:
                return True
        return False

    for item in items:
        if item["level"] is not None:
            run.append(item)
            run_levels.add(item["level"][1])
        elif run and attached(item):
            run.append(item)
        else:
            flush()
            segments.append(
                {
                    "type": "event",
                    "text": item["text"] + (f" ×{item['count']}" if item["count"] > 1 else ""),
                    "name": item["name"],
                    "t": item["t"],
                    "end": item["last_ts"],
                    "params": item["params"],
                    "exit": f"Left after: {item['text']}",
                    "shape": item["shape"],
                }
            )
    flush()
    return segments


def story(events, labeler, include_hidden=False):
    """Sessions as chapters: [{number, start, end, seconds, gap, segments}]."""
    sessions, order = {}, []
    for event in events:
        key = event.get("session_id")
        if key not in sessions:
            sessions[key] = []
            order.append(key)
        sessions[key].append(event)
    chapters, previous_end = [], None
    for index, key in enumerate(sorted(order, key=lambda k: sessions[k][0]["client_ts"]), start=1):
        raw = sessions[key]
        start, end = raw[0]["client_ts"], raw[-1]["client_ts"]
        reported = next(
            (
                e["params"].get("duration_seconds")
                for e in reversed(raw)
                if e["name"] == "session_end"
            ),
            None,
        )
        items = clean_events(raw, labeler, include_hidden)
        chapters.append(
            {
                "number": index,
                "session_id": key,
                "start": start,
                "end": end,
                "seconds": reported
                if isinstance(reported, (int, float))
                else round(_seconds(start, end), 1),
                "gap": round(_seconds(previous_end, start), 1) if previous_end else None,
                "events": len(raw),
                "segments": compress(items),
            }
        )
        previous_end = end
    return chapters


def story_signature(chapters, first_session_only):
    """The player's shape as a tuple of short texts (levels folded to their range)."""
    tokens = []
    for chapter in chapters[: 1 if first_session_only else len(chapters)]:
        if tokens:
            gap = chapter["gap"] or 0
            tokens.append("came back later" if gap >= BIG_GAP_SECONDS else "continued")
        tokens.extend(segment["shape"] for segment in chapter["segments"])
    return tuple(tokens)
