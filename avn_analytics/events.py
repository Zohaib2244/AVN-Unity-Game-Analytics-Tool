"""The Events page and the Mappings page: what a game sends, what each event means, and which of
the dashboards' shared moments (session start, level started...) each of its events stands for.

Everything is read live from the game's event database and its dictionary.
"""

import json
import re
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException

from . import stories
from .insights import (
    ENVIRONMENT,
    HIDDEN_PARAMS,
    PARAM_TYPES,
    PLAYER,
    SDK_EVENTS,
    SESSION,
    STALE_DAYS,
    day_expression,
    version_key,
    where,
)
from .models import CanonicalMapping, EventDefinition

TOP_VALUES = 8
SAMPLES = 5
MAPPING_SCAN = 150_000  # most recent events read to see what the dashboards understand
PREVIEW_SCAN = 20_000


def _kind(sql_type):
    return PARAM_TYPES.get(sql_type)


def _observed_params(connection):
    """name -> key -> {types, count} for every parameter ever sent."""
    seen = defaultdict(dict)
    for row in connection.execute(
        """SELECT name, p.key AS key, p.type AS type, count(*) AS count
           FROM events, json_each(events.payload, '$.params') AS p
           GROUP BY name, p.key, p.type"""
    ):
        kind = _kind(row["type"])
        if row["key"] in HIDDEN_PARAMS or kind is None:
            continue
        item = seen[row["name"]].setdefault(row["key"], {"types": [], "count": 0})
        item["count"] += row["count"]
        if kind not in item["types"]:
            item["types"].append(kind)
    return seen


def _days(start, end, offset_minutes):
    """The calendar days of [start, end) as seen in the viewer's time zone."""
    shift = timedelta(minutes=offset_minutes)
    first = (datetime.fromisoformat(start) + shift).date()
    last = (datetime.fromisoformat(end) - timedelta(microseconds=1) + shift).date()
    return [(first + timedelta(days=n)).isoformat() for n in range((last - first).days + 1)]


def _simple(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def overview(storage, game_id, start, end, filters, timezone_offset_minutes=0):
    """Every event the game has sent or defined, with how often, by whom, and what it means."""
    storage.get_game(game_id)
    definitions = storage.get_dictionary(game_id)
    drafts = storage.get_drafts(game_id)
    condition, args = where(start, end, filters)
    day = day_expression(timezone_offset_minutes)
    with storage.connect(storage.game_path(game_id)) as connection:
        ever = {
            row["name"]: dict(row)
            for row in connection.execute(
                f"""SELECT name, count(*) AS events, count(DISTINCT {PLAYER}) AS players,
                           min(client_ts) AS first_seen, max(client_ts) AS last_seen
                    FROM events GROUP BY name"""
            )
        }
        ranged = {
            row["name"]: dict(row)
            for row in connection.execute(
                f"""SELECT name, count(*) AS events, count(DISTINCT {PLAYER}) AS players,
                           count(DISTINCT {SESSION}) AS sessions, max(client_ts) AS last_seen
                    FROM events WHERE {condition} GROUP BY name""",
                args,
            )
        }
        series = defaultdict(dict)
        for row in connection.execute(
            f"""SELECT name, {day} AS day, count(*) AS events
                FROM events WHERE {condition} GROUP BY name, day""",
            args,
        ):
            series[row["name"]][row["day"]] = row["events"]
        params = _observed_params(connection)
    days = _days(start, end, timezone_offset_minutes)
    now = datetime.now(UTC)
    similar = defaultdict(list)
    for name in {*ever, *definitions}:
        similar[_simple(name)].append(name)
    events = []
    for name in sorted({*ever, *definitions}):
        definition = definitions.get(name) or {}
        seen = params.get(name, {})
        described = {key for key in definition.get("params", {}) if definition["params"][key]}
        total = ever.get(name)
        recent = ranged.get(name)
        last = total["last_seen"] if total else None
        stale = bool(last) and now - datetime.fromisoformat(last) > timedelta(days=STALE_DAYS)
        events.append(
            {
                "name": name,
                "sdk": name in SDK_EVENTS,
                "defined": name in definitions,
                "described": bool((definition.get("description") or "").strip()),
                "definition": {
                    "description": definition.get("description", ""),
                    "params": definition.get("params", {}),
                    "labels": definition.get("labels", ""),
                    "hidden": bool(definition.get("hidden")),
                    "canonical": definition.get("canonical", []),
                },
                # fields an agent import wrote that nobody has confirmed yet
                "drafts": sorted(drafts.get(name, {})),
                "status": "never" if not total else "stale" if stale else "active",
                "ever": total
                and {key: total[key] for key in ("events", "players", "first_seen", "last_seen")},
                "range": {
                    "events": recent["events"] if recent else 0,
                    "players": recent["players"] if recent else 0,
                    "sessions": recent["sessions"] if recent else 0,
                    "last_seen": recent["last_seen"] if recent else None,
                },
                "series": [series[name].get(item, 0) for item in days],
                "params_seen": len(seen),
                "params_missing": sorted(key for key in seen if key not in described),
                "type_conflicts": sorted(
                    key for key, item in seen.items() if len(item["types"]) > 1
                ),
                "similar": sorted(other for other in similar[_simple(name)] if other != name),
            }
        )
    needing = [
        item for item in events if not item["described"] and not item["sdk"] and item["ever"]
    ]
    return {
        "days": days,
        "stale_days": STALE_DAYS,
        "events": events,
        "summary": {
            "events": len(events),
            "described": sum(1 for item in events if item["described"]),
            "needs_description": len(needing),
            "with_missing_params": sum(
                1 for item in events if item["params_missing"] and item["defined"]
            ),
            "never_received": sum(1 for item in events if item["status"] == "never"),
            "stale": sum(1 for item in events if item["status"] == "stale"),
            "mapped": sum(1 for item in events if item["definition"]["canonical"]),
            "hidden": sum(1 for item in events if item["definition"]["hidden"]),
            "drafts": sum(1 for item in events if item["drafts"]),
            # all time, whatever the days and filters: what the game has sent in total
            "received_total": sum(item["events"] for item in ever.values()),
            "event_types": len(ever),
            "database_bytes": sum(
                path.stat().st_size for path in storage.game_files(game_id) if path.exists()
            ),
        },
    }


def detail(storage, game_id, name, start, end, filters, timezone_offset_minutes=0):
    """One event's activity in the range: per day, by version, environment and country, its
    parameters with their values, and the latest raw examples."""
    storage.get_game(game_id)
    definition = storage.get_dictionary(game_id).get(name) or {}
    drafts = storage.get_drafts(game_id).get(name, {})
    condition, args = where(start, end, filters)
    day = day_expression(timezone_offset_minutes)
    scope = f"name=? AND {condition}"
    base = (name, *args)
    with storage.connect(storage.game_path(game_id)) as connection:
        if not connection.execute("SELECT 1 FROM events WHERE name=? LIMIT 1", (name,)).fetchone():
            if not definition:
                raise HTTPException(404, "No such event")
        series = {
            row["day"]: dict(row)
            for row in connection.execute(
                f"""SELECT {day} AS day, count(*) AS events, count(DISTINCT {PLAYER}) AS players
                    FROM events WHERE {scope} GROUP BY day""",
                base,
            )
        }
        versions = [
            dict(row)
            for row in connection.execute(
                f"""SELECT coalesce(json_extract(payload, '$.app_version'), 'unknown') AS version,
                           count(*) AS events, count(DISTINCT {PLAYER}) AS players,
                           max(client_ts) AS last_seen
                    FROM events WHERE name=? GROUP BY version""",
                (name,),
            )
        ]
        every_version = [
            row["version"]
            for row in connection.execute(
                """SELECT DISTINCT coalesce(json_extract(payload, '$.app_version'), 'unknown')
                          AS version FROM events"""
            )
        ]
        environments = [
            dict(row)
            for row in connection.execute(
                f"""SELECT {ENVIRONMENT} AS value, count(*) AS events,
                           count(DISTINCT {PLAYER}) AS players
                    FROM events WHERE {scope} GROUP BY value ORDER BY events DESC""",
                base,
            )
        ]
        countries = [
            dict(row)
            for row in connection.execute(
                f"""SELECT coalesce(json_extract(payload, '$.country'), 'unknown') AS value,
                           count(*) AS events, count(DISTINCT {PLAYER}) AS players
                    FROM events WHERE {scope} GROUP BY value ORDER BY events DESC LIMIT 8""",
                base,
            )
        ]
        params = {}
        for row in connection.execute(
            f"""SELECT p.key AS key, p.type AS type, count(*) AS count,
                       count(DISTINCT p.value) AS distinct_values
                FROM events, json_each(events.payload, '$.params') AS p
                WHERE {scope} GROUP BY p.key, p.type""",
            base,
        ):
            kind = _kind(row["type"])
            if row["key"] in HIDDEN_PARAMS or kind is None:
                continue
            item = params.setdefault(
                row["key"],
                {"key": row["key"], "types": [], "count": 0, "distinct": 0, "values": []},
            )
            item["count"] += row["count"]
            item["distinct"] = max(item["distinct"], row["distinct_values"])
            if kind not in item["types"]:
                item["types"].append(kind)
        values = defaultdict(list)
        for row in connection.execute(
            f"""SELECT p.key AS key, p.value AS value, count(*) AS count
                FROM events, json_each(events.payload, '$.params') AS p
                WHERE {scope} GROUP BY p.key, p.value ORDER BY count DESC LIMIT 600""",
            base,
        ):
            if row["key"] in params and len(values[row["key"]]) < TOP_VALUES:
                values[row["key"]].append({"value": str(row["value"])[:80], "count": row["count"]})
        for key, item in params.items():
            item["values"] = values[key]
            item["description"] = (definition.get("params") or {}).get(key, "")
        samples = [
            {
                "client_ts": row["client_ts"],
                "version": row["version"],
                "environment": row["environment"],
                "params": json.loads(row["params"] or "{}"),
            }
            for row in connection.execute(
                f"""SELECT client_ts, json_extract(payload, '$.app_version') AS version,
                           {ENVIRONMENT} AS environment,
                           json_extract(payload, '$.params') AS params
                    FROM events WHERE {scope} ORDER BY client_ts DESC, event_id LIMIT ?""",
                (*base, SAMPLES),
            )
        ]
    newest = max(every_version, key=version_key, default=None)
    sent_by = {item["version"] for item in versions}
    days = _days(start, end, timezone_offset_minutes)
    return {
        "name": name,
        "drafts": sorted(drafts),
        "days": [
            {
                "day": item,
                **{key: series.get(item, {}).get(key, 0) for key in ("events", "players")},
            }
            for item in days
        ],
        "versions": sorted(versions, key=lambda item: version_key(item["version"]), reverse=True),
        "newest_version": newest,
        "missing_in_newest": bool(newest and versions and newest not in sent_by),
        "environments": environments,
        "countries": countries,
        "params": sorted(params.values(), key=lambda item: -item["count"]),
        "samples": samples,
    }


def _bump(table, key, player, number=None):
    item = table.setdefault(key, {"events": 0, "players": set(), "levels": set()})
    item["events"] += 1
    if len(item["players"]) < 20000:
        item["players"].add(player)
    if number is not None and len(item["levels"]) < 5000:
        item["levels"].add(number)


def mappings(storage, game_id):
    """Which of the dashboards' shared moments each event of the game stands for: the mappings
    the team set, and what is understood on its own (session_start, level events with a level
    parameter such as `Started: 3`)."""
    storage.get_game(game_id)
    definitions = storage.get_dictionary(game_id)
    labeler = stories.Labeler(definitions)
    table = {}
    scanned = 0
    with storage.connect(storage.game_path(game_id)) as connection:
        observed = {
            row["name"]: dict(row)
            for row in connection.execute(
                "SELECT name, count(*) AS events, max(client_ts) AS last_seen "
                "FROM events GROUP BY name"
            )
        }
        params = _observed_params(connection)
        examples = defaultdict(lambda: defaultdict(list))
        for row in connection.execute(
            """SELECT name, p.key AS key, p.value AS value, count(*) AS count
               FROM events, json_each(events.payload, '$.params') AS p
               WHERE p.type IN ('text', 'integer', 'real')
               GROUP BY name, p.key, p.value ORDER BY count DESC LIMIT 4000"""
        ):
            if row["key"] not in HIDDEN_PARAMS and len(examples[row["name"]][row["key"]]) < 6:
                examples[row["name"]][row["key"]].append(str(row["value"])[:60])
        rows = connection.execute(
            f"""SELECT name, json_extract(payload, '$.params') AS params, {PLAYER} AS player
                FROM events ORDER BY client_ts DESC, event_id LIMIT {MAPPING_SCAN}"""
        )
        for row in rows:
            scanned += 1
            values = json.loads(row["params"] or "{}")
            name, player = row["name"], row["player"]
            info = labeler.level_info(name, values)
            explicit = set()
            for index, rule in enumerate((definitions.get(name) or {}).get("canonical", [])):
                if not stories._canonical_match(rule, values):
                    continue
                explicit.add(rule["action"])
                number = None
                if info and f"level_{info[0]}" == rule["action"]:
                    number = info[1]
                _bump(table, (rule["action"], name, "mapped", index), player, number)
            if name == "session_start" and "session_start" not in explicit:
                _bump(table, ("session_start", name, "auto", None), player)
            if info and f"level_{info[0]}" not in explicit:
                _bump(table, (f"level_{info[0]}", name, "auto", None), player, info[1])
    concepts = []
    for concept in stories.CONCEPTS:
        sources = []
        for (action, name, via, index), item in table.items():
            if action != concept["key"]:
                continue
            rule = definitions[name]["canonical"][index] if via == "mapped" else None
            levels = sorted(item["levels"])
            sources.append(
                {
                    "event": name,
                    "via": via,
                    "rule": rule,
                    "events": item["events"],
                    "players": len(item["players"]),
                    "levels": {"count": len(levels), "min": levels[0], "max": levels[-1]}
                    if levels
                    else None,
                }
            )
        sources.sort(key=lambda item: -item["events"])
        rules = [
            {"event": name, "index": index, "rule": rule}
            for name, definition in sorted(definitions.items())
            for index, rule in enumerate(definition.get("canonical", []))
            if rule["action"] == concept["key"]
        ]
        silent = [
            item
            for item in rules
            if not any(
                source["via"] == "mapped"
                and source["event"] == item["event"]
                and source["rule"] == item["rule"]
                for source in sources
            )
        ]
        concepts.append(
            {
                **concept,
                "status": "mapped"
                if any(source["via"] == "mapped" for source in sources)
                else "auto"
                if sources
                else "missing",
                "sources": sources,
                "rules": rules,
                "silent_rules": silent,
            }
        )
    known = set(stories.CONCEPT_KEYS)
    other = [
        {"event": name, "index": index, "rule": rule}
        for name, definition in sorted(definitions.items())
        for index, rule in enumerate(definition.get("canonical", []))
        if rule["action"] not in known
    ]
    return {
        "concepts": concepts,
        "other": other,
        "scanned": scanned,
        "capped": scanned >= MAPPING_SCAN,
        "events": [
            {
                "name": name,
                "events": item["events"],
                "defined": name in definitions,
                "params": [
                    {
                        "key": key,
                        "types": info["types"],
                        "examples": examples[name].get(key, []),
                    }
                    for key, info in sorted(
                        params.get(name, {}).items(), key=lambda kv: -kv[1]["count"]
                    )
                ][:30],
            }
            for name, item in sorted(
                {**{key: {"events": 0} for key in definitions}, **observed}.items(),
                key=lambda kv: -kv[1]["events"],
            )
        ],
    }


# Without these the Levels dashboard, player stories and journeys cannot read a game's levels.
# Failed and restarted are optional: plenty of games have no such moment.
REQUIRED_CONCEPTS = ("level_started", "level_completed")


def mapping_status(storage, game_id):
    """A short verdict on the mappings, for the Mappings button and the overview notice.

    Something needs attention when a level moment the dashboards depend on has no event behind
    it, or when a mapping rule the team set matches nothing the game has sent.
    """
    result = mappings(storage, game_id)
    issues = []
    if result["scanned"]:
        for concept in result["concepts"]:
            base = {
                "concept": concept["key"],
                "label": concept["label"],
                "used_by": concept["used_by"],
            }
            if concept["key"] in REQUIRED_CONCEPTS and concept["status"] == "missing":
                issues.append({"kind": "missing", **base})
            issues += [
                {"kind": "silent", **base, "event": item["event"]}
                for item in concept["silent_rules"]
            ]
    return {"ok": not issues, "has_events": bool(result["scanned"]), "issues": issues}


def preview(storage, game_id, event, rule):
    """What a mapping rule would catch among an event's most recent examples."""
    storage.get_game(game_id)
    rule = CanonicalMapping.model_validate(rule).model_dump()
    labeler = stories.Labeler({event: {"canonical": [rule]}})
    matched, players, levels, numbered = 0, set(), set(), 0
    sample = None
    scanned = 0
    with storage.connect(storage.game_path(game_id)) as connection:
        for row in connection.execute(
            f"""SELECT json_extract(payload, '$.params') AS params, {PLAYER} AS player
                FROM events WHERE name=? ORDER BY client_ts DESC, event_id LIMIT {PREVIEW_SCAN}""",
            (event,),
        ):
            scanned += 1
            values = json.loads(row["params"] or "{}")
            if not stories._canonical_match(rule, values):
                continue
            matched += 1
            if len(players) < 20000:
                players.add(row["player"])
            sample = sample or values
            if rule["action"].startswith("level_"):
                info = labeler.level_info(event, values)
                if info and f"level_{info[0]}" == rule["action"]:
                    numbered += 1
                    levels.add(info[1])
    ordered = sorted(levels)
    return {
        "scanned": scanned,
        "events": matched,
        "players": len(players),
        "with_level_number": numbered,
        "levels": {"count": len(ordered), "min": ordered[0], "max": ordered[-1]}
        if ordered
        else None,
        "sample": sample,
    }


def set_mappings(storage, game_id, event, canonical):
    """Replace one event's mapping rules, keeping everything else about its definition."""
    storage.get_game(game_id)
    existing = storage.get_dictionary(game_id).get(event) or {}
    definition = EventDefinition.model_validate(
        {
            **{key: value for key, value in existing.items() if key != "canonical"},
            "canonical": canonical,
        }
    )
    storage.set_definition(game_id, event, definition)
    return definition.model_dump()["canonical"]
