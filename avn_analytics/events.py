"""The Events page and the Mappings page: what a game sends, what each event means, and which of
the dashboards' shared moments (session start, level started...) each of its events stands for.

Everything is read live from the game's event database and its dictionary.
"""

import json
import re
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException

from . import conditions, stories
from .insights import (
    ENVIRONMENT,
    HIDDEN_PARAMS,
    PARAM_TYPES,
    PLAYER,
    SDK_EVENTS,
    STALE_DAYS,
    day_expression,
    scope_events,
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


def _observed_params(connection, app_version=""):
    """name -> key -> {types, count} for every parameter ever sent."""
    seen = defaultdict(dict)
    for row in connection.execute(
        """SELECT name, p.key AS key, p.type AS type, count(*) AS count
           FROM events, json_each(events.payload, '$.params') AS p
           WHERE (? = '' OR json_extract(payload, '$.app_version') = ?)
           GROUP BY name, p.key, p.type""",
        (app_version, app_version),
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
        scoped = scope_events(connection, start, end, filters)
        ranged = {
            row["name"]: dict(row)
            for row in connection.execute(
                f"""SELECT name, count(*) AS events, count(DISTINCT player) AS players,
                           count(DISTINCT session_id) AS sessions, max(client_ts) AS last_seen
                    FROM {scoped} GROUP BY name"""
            )
        }
        series = defaultdict(dict)
        for row in connection.execute(
            f"SELECT name, {day} AS day, count(*) AS events FROM {scoped} GROUP BY name, day"
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


def activity(storage, game_id, name, start, end, filters, tree=None, timezone_offset_minutes=0):
    """Exact conditional counts; anonymous events never enter a per-player numerator."""
    storage.get_game(game_id)
    scope, args = where(start, end, filters)
    predicate, values = conditions.condition_sql(tree) if tree else ("1", [])
    day = day_expression(timezone_offset_minutes)
    with storage.connect(storage.game_path(game_id)) as connection:
        active_players = connection.execute(
            f"SELECT count(DISTINCT {PLAYER}) FROM events WHERE {scope}", args
        ).fetchone()[0]
        matching = f"{scope} AND name=? AND ({predicate})"
        bound = [*args, name, *values]
        totals = dict(
            connection.execute(
                f"""SELECT count(*) AS events, count(DISTINCT {PLAYER}) AS players,
                           count({PLAYER}) AS identified_events
                    FROM events WHERE {matching}""",
                bound,
            ).fetchone()
        )
        days = {
            row["day"]: dict(row)
            for row in connection.execute(
                f"""SELECT {day} AS day, count(*) AS events, count(DISTINCT {PLAYER}) AS players
                    FROM events WHERE {matching} GROUP BY day""",
                bound,
            )
        }
    return {
        **totals,
        "active_players": active_players,
        "anonymous_events": totals["events"] - totals["identified_events"],
        "per_matching_player": totals["identified_events"] / totals["players"]
        if totals["players"]
        else 0,
        "per_active_player": totals["identified_events"] / active_players if active_players else 0,
        "days": [
            {
                "day": item,
                "events": days.get(item, {}).get("events", 0),
                "players": days.get(item, {}).get("players", 0),
            }
            for item in _days(start, end, timezone_offset_minutes)
        ],
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
        scoped = scope_events(connection, start, end, filters, only=name)
        series = {
            row["day"]: dict(row)
            for row in connection.execute(
                f"""SELECT {day} AS day, count(*) AS events, count(DISTINCT player) AS players
                    FROM {scoped} GROUP BY day"""
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
                f"""SELECT environment AS value, count(*) AS events,
                           count(DISTINCT player) AS players
                    FROM {scoped} GROUP BY value ORDER BY events DESC"""
            )
        ]
        countries = [
            dict(row)
            for row in connection.execute(
                f"""SELECT country AS value, count(*) AS events,
                           count(DISTINCT player) AS players
                    FROM {scoped} GROUP BY value ORDER BY events DESC LIMIT 8"""
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


def _suggestions(name, params, examples, app_version):
    """Reviewable mappings for known shapes; never infer game-specific status codes."""
    rules = []
    if not stories.LEVELISH_KEY.search(name):
        return rules
    number_param = next((key for key in params if stories.LEVEL_KEY.match(key)), "")
    for key in params:
        verb = stories.LEVEL_VERBS.get(key.lower())
        if verb and any(stories._int(value) is not None for value in examples.get(key, [])):
            rules.append(
                CanonicalMapping(
                    action=f"level_{verb}",
                    param=key,
                    op="exists",
                    number_param=key,
                    app_version=app_version,
                ).model_dump()
            )
        if number_param and key.lower() in ("action", "status", "state"):
            for value in examples.get(key, []):
                if verb := stories.LEVEL_VERBS.get(value.lower()):
                    rules.append(
                        CanonicalMapping(
                            action=f"level_{verb}",
                            param=key,
                            value=value,
                            number_param=number_param,
                            app_version=app_version,
                        ).model_dump()
                    )
    return rules


def mappings(storage, game_id, app_version=""):
    """Which of the dashboards' shared moments each event of the game stands for: the mappings
    the team set, and what is understood on its own (session_start, level events with a level
    parameter such as `Started: 3`)."""
    storage.get_game(game_id)
    definitions = storage.get_dictionary(game_id)
    labeler = stories.Labeler(definitions)
    table = {}
    conflicts = defaultdict(int)
    scanned = 0
    scope = "(? = '' OR json_extract(payload, '$.app_version') = ?)"
    scope_args = (app_version, app_version)
    with storage.connect(storage.game_path(game_id)) as connection:
        versions = [
            row[0]
            for row in connection.execute(
                "SELECT DISTINCT json_extract(payload, '$.app_version') FROM events "
                "WHERE json_extract(payload, '$.app_version') IS NOT NULL"
            )
        ]
        observed = {
            row["name"]: dict(row)
            for row in connection.execute(
                "SELECT name, count(*) AS events, max(client_ts) AS last_seen "
                f"FROM events WHERE {scope} GROUP BY name",
                scope_args,
            )
        }
        params = _observed_params(connection, app_version)
        examples = defaultdict(lambda: defaultdict(list))
        for row in connection.execute(
            f"""SELECT name, p.key AS key, p.value AS value, count(*) AS count
               FROM events, json_each(events.payload, '$.params') AS p
               WHERE {scope} AND p.type IN ('text', 'integer', 'real')
               GROUP BY name, p.key, p.value ORDER BY count DESC LIMIT 4000""",
            scope_args,
        ):
            if row["key"] not in HIDDEN_PARAMS and len(examples[row["name"]][row["key"]]) < 6:
                examples[row["name"]][row["key"]].append(str(row["value"])[:60])
        rows = connection.execute(
            f"""SELECT name, json_extract(payload, '$.params') AS params, {PLAYER} AS player,
                       json_extract(payload, '$.app_version') AS app_version
                FROM events WHERE {scope}
                ORDER BY client_ts DESC, event_id LIMIT {MAPPING_SCAN}""",
            scope_args,
        )
        # What an event means depends only on its name, parameters and version, and most events
        # repeat those, so it is worked out once per kind and only the player is counted per event.
        meanings = {}

        def meaning(name, raw_params, version):
            values = json.loads(raw_params or "{}")
            info = labeler.level_info(name, values, version)
            matched = []
            for index, rule in stories.active_mappings(definitions.get(name), version):
                if stories._canonical_match(rule, values, version):
                    number = info[1] if info and f"level_{info[0]}" == rule["action"] else None
                    matched.append((index, rule["action"], number))
            explicit = {action for _, action, _ in matched}
            return {
                "info": info,
                "matched": matched,
                "conflict": len({action for action in explicit if action.startswith("level_")}) > 1,
                "session_start": name == "session_start" and "session_start" not in explicit,
                "auto_level": info if info and f"level_{info[0]}" not in explicit else None,
            }

        for row in rows:
            scanned += 1
            name, player = row["name"], row["player"]
            kind = (name, row["params"], row["app_version"])
            found = meanings.get(kind)
            if found is None:
                found = meanings[kind] = meaning(*kind)
            for index, action, number in found["matched"]:
                _bump(table, (action, name, "mapped", index), player, number)
            if found["conflict"]:
                conflicts[name] += 1
            if found["session_start"]:
                _bump(table, ("session_start", name, "auto", None), player)
            if found["auto_level"]:
                verb, number = found["auto_level"]
                _bump(table, (f"level_{verb}", name, "auto", None), player, number)
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
            for index, rule in (
                stories.active_mappings(definition, app_version)
                if app_version
                else enumerate(definition.get("canonical", []))
            )
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
        "app_version": app_version,
        "versions": sorted(versions, key=version_key, reverse=True),
        # Include every rule, so editing one version preserves rules for other versions.
        "definitions": {name: item.get("canonical", []) for name, item in definitions.items()},
        "conflicts": [
            {"event": name, "events": count} for name, count in sorted(conflicts.items())
        ],
        "concepts": concepts,
        "other": other,
        "scanned": scanned,
        "capped": scanned >= MAPPING_SCAN,
        "events": [
            {
                "name": name,
                "events": item["events"],
                "defined": name in definitions,
                "suggestions": _suggestions(
                    name, params.get(name, {}), examples[name], app_version
                ),
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
    existing = storage.get_dictionary(game_id).get(event) or {}
    combined = {"canonical": [*existing.get("canonical", []), rule]}
    conflicting = 0
    matched, players, levels, numbered = 0, set(), set(), 0
    sample = None
    scanned = 0
    with storage.connect(storage.game_path(game_id)) as connection:
        for row in connection.execute(
            f"""SELECT json_extract(payload, '$.params') AS params, {PLAYER} AS player,
                       json_extract(payload, '$.app_version') AS app_version
                FROM events WHERE name=?
                  AND (? = '' OR json_extract(payload, '$.app_version') = ?)
                ORDER BY client_ts DESC, event_id LIMIT {PREVIEW_SCAN}""",
            (event, rule["app_version"], rule["app_version"]),
        ):
            scanned += 1
            values = json.loads(row["params"] or "{}")
            if not stories._canonical_match(rule, values, row["app_version"]):
                continue
            matched += 1
            actions = {
                item["action"]
                for _, item in stories.active_mappings(combined, row["app_version"])
                if item["action"].startswith("level_")
                and stories._canonical_match(item, values, row["app_version"])
            }
            if len(actions) > 1:
                conflicting += 1
            if len(players) < 20000:
                players.add(row["player"])
            sample = sample or values
            if rule["action"].startswith("level_"):
                info = labeler.level_info(event, values, row["app_version"])
                if info and f"level_{info[0]}" == rule["action"]:
                    numbered += 1
                    levels.add(info[1])
    ordered = sorted(levels)
    return {
        "scanned": scanned,
        "events": matched,
        "players": len(players),
        "with_level_number": numbered,
        "conflicting_events": conflicting,
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
