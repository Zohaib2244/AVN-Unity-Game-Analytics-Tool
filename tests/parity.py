"""Old and new answers, side by side: the parity harness for the analytics pipeline work.

snapshot() asks one implementation every dashboard question over a matrix of days, filters,
time zones and scopes, and returns the answers keyed by question. The frozen reference
(tests/reference) and the production code must give identical snapshots for the same database;
compare() lists the questions whose answers differ. The tests use a small edge-case fixture
(build_fixture); scripts/benchmark.py runs the same comparison over large synthetic games.
"""

import json
from datetime import timedelta
from types import SimpleNamespace

from reference import legacy_events, legacy_insights, legacy_journeys
from synthetic import ANCHOR, DICTIONARY, generate

from avn_analytics import events, insights, journeys
from avn_analytics.models import Batch, EventDefinition, GameCreate, timestamp

REFERENCE = SimpleNamespace(
    insights=legacy_insights, journeys=legacy_journeys, events=legacy_events
)
PRODUCTION = SimpleNamespace(insights=insights, journeys=journeys, events=events)

HIDE_TEST = {"exclude_environments": ["editor", "development", "test", "debug"]}
FILTERS = {
    "none": {},
    "hide_test": HIDE_TEST,
    "production": {"environments": ["production"]},
    "version": {"app_versions": ["1.1", "1.7"], **HIDE_TEST},
    "country": {"countries": ["US", "unknown"], "platforms": ["android"]},
    "builds": {"builds": ["101", "107"], "exclude_environments": ["editor"]},
}
# (window, filters) pairs whose level player lists are compared group by group.
LEVEL_PLAYER_CASES = {
    ("all", "none"),
    ("month", "hide_test"),
    ("odd", "version"),
    ("week", "country"),
}
PLAYER_RULES = [
    {
        "conditions": [{"event": "level_complete", "does": "did", "min_times": 2}],
        "metrics": [{"event": "level_start", "agg": "count"}],
    },
    {
        "conditions": [{"event": "ad_show", "does": "didnt"}],
        "metrics": [
            {"event": "level_start", "agg": "max", "of": "level"},
            {"event": "session_start", "agg": "first"},
        ],
    },
]


def stamp(moment):
    return timestamp(moment)


def make_storage(path, **options):
    """A Storage on an empty data directory, ready to use without the web app."""
    from avn_analytics.auth import Accounts
    from avn_analytics.config import Settings
    from avn_analytics.storage import Storage

    settings = Settings(data_dir=path, admin_token="x" * 40, **options)
    storage = Storage(settings)
    storage.initialize()
    Accounts(storage, settings).initialize()
    return storage


def ranges(days=40):
    """(name, start, end) windows: everything, a month, a week, and an odd window whose edges
    fall inside a busy day."""
    end = ANCHOR
    return [
        ("all", stamp(end - timedelta(days=days + 1)), stamp(end)),
        ("month", stamp(end - timedelta(days=30)), stamp(end)),
        ("week", stamp(end - timedelta(days=14)), stamp(end - timedelta(days=7))),
        (
            "odd",
            stamp(end - timedelta(days=9, hours=5, minutes=17)),
            stamp(end - timedelta(days=2, hours=3, minutes=1)),
        ),
    ]


def build_fixture(storage, events_target=2500, seed=7, days=40):
    """A registered game full of edge cases; returns its id."""
    game = storage.register_game(
        GameCreate(name="Parity", bundle_id=f"com.avn.parity{seed}", platform="android")
    )
    game_id = game["id"]
    with storage.connect(storage.game_path(game_id)) as connection:
        for name, definition in DICTIONARY.items():
            storage.write_definition(connection, name, EventDefinition.model_validate(definition))
        connection.execute(
            "INSERT INTO environment_fixes (from_environment, to_environment, app_version, build,"
            " note, created_at) VALUES ('development', 'production', NULL, '103', '', ?)",
            (timestamp(),),
        )
    batches = list(generate(events_target, seed=seed, days=days))
    for country, batch in batches:
        storage.ingest(game_id, Batch.model_validate(batch), country=country)
    _edge_cases(storage, game_id, batches)
    return game_id


def _edge_cases(storage, game_id, batches):
    """What generated play doesn't cover: a session whose environment arrives (and changes) after
    its events, players sharing a session ID, events on the exact range edges, and rows written
    by older versions (no player at all, a numeric version, no platform, odd environment text)."""
    first_session = batches[0][1]["events"][0]
    edge = (ANCHOR - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"
    late = {
        "events": [
            {
                **{key: first_session[key] for key in ("device_id", "app_version", "build")},
                "platform": "android",
                "session_id": "late-session",
                "event_id": "00000000-0000-4000-8000-0000000000a1",
                "name": "level_start",
                "params": {"level": 1},
                "client_ts": edge,
            },
            {
                "device_id": "shared-a",
                "session_id": "shared-session",
                "app_version": "1.1",
                "build": "101",
                "platform": "ios",
                "event_id": "00000000-0000-4000-8000-0000000000a2",
                "name": "level_start",
                "params": {"level": 2},
                "client_ts": edge,
            },
            {
                "device_id": "shared-b",
                "session_id": "shared-session",
                "app_version": "1.1",
                "build": "101",
                "platform": "ios",
                "event_id": "00000000-0000-4000-8000-0000000000a3",
                "name": "level_fail",
                "params": {"level": 2},
                "client_ts": edge,
            },
        ]
    }
    storage.ingest(game_id, Batch.model_validate(late), country="DE")
    for environment in ("development", "production"):  # the session's environment, set twice
        storage.ingest(
            game_id,
            Batch.model_validate(
                {
                    "context": {"environment": environment},
                    "events": [
                        {
                            "device_id": "shared-a",
                            "session_id": "shared-session",
                            "app_version": "1.1",
                            "build": "101",
                            "platform": "ios",
                            "event_id": str(
                                f"00000000-0000-4000-8000-0000000000{10 + len(environment):02d}"
                            ),
                            "name": "session_start",
                            "params": {},
                            "client_ts": edge,
                        }
                    ],
                }
            ),
        )
    legacy = [
        ("legacy-1", "level_start", {"params": {"level": 1}, "session_id": "old"}),
        ("legacy-2", "level_complete", {"params": {"level": 1}, "device_id": "old-device"}),
        (
            "legacy-3",
            "session_start",
            {"device_id": "old-device", "app_version": 7, "environment": "Production"},
        ),
        ("legacy-4", "MM_ANALYSIS", {"user_id": "old-user", "platform": None, "params": {}}),
    ]
    moment = ANCHOR - timedelta(days=3)
    with storage.connect(storage.game_path(game_id)) as connection:
        for offset, (event_id, name, fields) in enumerate(legacy):
            client_ts = stamp(moment + timedelta(minutes=offset))
            payload = {"event_id": event_id, "name": name, "client_ts": client_ts, **fields}
            connection.execute(
                "INSERT INTO events (event_id, name, client_ts, server_ts, payload)"
                " VALUES (?, ?, ?, ?, ?)",
                (event_id, name, client_ts, client_ts, json.dumps(payload)),
            )


PLAYER_SORTS = [
    ("last_seen", "desc"),
    ("events", "asc"),
    ("sessions", "desc"),
    ("session_length", "desc"),
    ("playtime", "desc"),
    ("version", "asc"),
]


def _shown_levels(numbers):
    """The first levels, a middle one, the last one, and one past the end (an empty list)."""
    if not numbers:
        return [1]
    picked = {*numbers[:3], numbers[len(numbers) // 2], numbers[-1], numbers[-1] + 1}
    return sorted(picked)


def snapshot(storage, game_id, module, *, full=True):
    """Every answer, keyed by a readable question. full=False asks a smaller matrix."""
    answers = {}
    windows = ranges()
    filter_names = list(FILTERS) if full else ["none", "hide_test", "country"]

    def ask(key, function, *args, **kwargs):
        try:
            answers[key] = function(*args, **kwargs)
        except Exception as error:  # an error is an answer too: both sides must agree on it
            answers[key] = {"error": type(error).__name__, "detail": str(error)}
        if function is module.insights.journey and "snapshot" in answers[key]:
            # An opaque page token: raw events and facts number it differently (see
            # insights.FACTS_SNAPSHOT); what it does is tested on its own.
            answers[key] = {**answers[key], "snapshot": isinstance(answers[key]["snapshot"], int)}
        return answers[key]

    days = (storage, game_id)
    with _memoized_reference_scans(module):
        for name, start, end in windows:
            ask(f"facets {name}", module.insights.facets, *days, start, end)
            for label in filter_names:
                chosen = FILTERS[label]
                window = (*days, start, end, chosen)
                for zone in (0, 330, -480) if name == "odd" else (0,):
                    ask(f"summary {name} {label} tz{zone}", module.insights.summary, *window, zone)
                    ask(f"events {name} {label} tz{zone}", module.events.overview, *window, zone)
                ask(
                    f"detail {name} {label}",
                    module.events.detail,
                    *days,
                    "level_start",
                    start,
                    end,
                    chosen,
                    330,
                )
                sorts = PLAYER_SORTS if label in ("none", "hide_test") else PLAYER_SORTS[:2]
                for sort, order in sorts:
                    ask(
                        f"players {name} {label} {sort} {order}",
                        module.insights.players,
                        *window,
                        sort=sort,
                        order=order,
                        limit=25,
                    )
                for index, rules in enumerate(PLAYER_RULES):
                    ask(
                        f"players {name} {label} rules{index}",
                        module.insights.players,
                        *window,
                        sort="metric0",
                        conditions=rules["conditions"],
                        metrics=rules["metrics"],
                    )
                ask(
                    f"players {name} {label} search",
                    module.insights.players,
                    *window,
                    search="u00",
                    offset=2,
                )
                for scope in ("all", "first_session"):
                    progress = ask(
                        f"levels {name} {label} {scope}",
                        module.journeys.level_progress,
                        *window,
                        scope,
                    )
                    if "error" in progress or (name, label) not in LEVEL_PLAYER_CASES:
                        continue
                    numbers = [row["level"] for row in progress["levels"]]
                    for number in _shown_levels(numbers):
                        for group in module.journeys.LEVEL_GROUPS:
                            ask(
                                f"level {number} {group} {name} {label} {scope}",
                                module.journeys.level_players,
                                *window,
                                number,
                                group=group,
                                limit=2000,
                                scope=scope,
                            )
                    middle = _shown_levels(numbers)[len(_shown_levels(numbers)) // 2]
                    for sort in ("tries", "fails"):
                        ask(
                            f"level {middle} sort {sort} {name} {label} {scope}",
                            module.journeys.level_players,
                            *window,
                            middle,
                            sort=sort,
                            offset=1,
                            limit=3,
                            scope=scope,
                        )
                    first = module.journeys.level_players(*window, middle, scope=scope)
                    for item in first["last_actions"][:2]:
                        ask(
                            f"level {middle} last {item['text']} {name} {label} {scope}",
                            module.journeys.level_players,
                            *window,
                            middle,
                            scope=scope,
                            last_action=item["text"],
                        )
        ask("mappings", module.events.mappings, storage, game_id)
        ask("mappings 1.7", module.events.mappings, storage, game_id, "1.7")
        ask("mapping status", module.events.mapping_status, storage, game_id)
        name, start, end = windows[0]
        for player in _sample_players(storage, game_id):
            ask(f"journey {player}", module.insights.journey, storage, game_id, player, start, end)
            ask(
                f"journey {player} page",
                module.insights.journey,
                storage,
                game_id,
                player,
                start,
                end,
                offset=3,
            )
            ask(
                f"story {player}",
                module.journeys.player_story,
                storage,
                game_id,
                player,
                start,
                end,
            )
        if full:
            ask("catalog", module.insights.catalog, storage, game_id, start, end, HIDE_TEST)
            ask("retention", module.insights.retention, storage, game_id, start, end, HIDE_TEST, 60)
            funnel = {
                "steps": [{"event": "first_open"}, {"event": "level_start"}],
                "filters": HIDE_TEST,
            }
            ask("funnel", module.insights.funnel, storage, game_id, start, end, funnel)
    return _normalize(answers)


def _sample_players(storage, game_id, count=6):
    """Players with the most events, plus one with an account and the old-version rows."""
    with storage.connect(storage.game_path(game_id)) as connection:
        rows = connection.execute(
            f"""SELECT {insights.PLAYER} AS player FROM events WHERE {insights.IDENTIFIED}
                GROUP BY player ORDER BY count(*) DESC, player LIMIT ?""",
            (count,),
        ).fetchall()
    return [row["player"] for row in rows] + ["old-device", "shared-a"]


class _memoized_reference_scans:
    """The frozen Levels code rescans for every level's player list; within one snapshot the
    database doesn't change, so its transitions are remembered to keep the harness quick."""

    def __init__(self, module):
        self.module = module

    def __enter__(self):
        if self.module is not REFERENCE:
            return self
        original = self.original = legacy_journeys._scan_transitions
        remembered = {}

        def scan(storage, game_id, start, end, filters, scope, definitions):
            key = (game_id, start, end, json.dumps(filters, sort_keys=True), scope)
            if key not in remembered:
                remembered[key] = original(
                    storage, game_id, start, end, filters, scope, definitions
                )
            return remembered[key]

        legacy_journeys._scan_transitions = scan
        return self

    def __exit__(self, *exc):
        if self.module is REFERENCE:
            legacy_journeys._scan_transitions = self.original


def _normalize(value):
    """JSON round trip, so tuples and lists (and int/float keys) compare the same way."""
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def compare(expected, actual):
    """The questions whose answers differ, with a short description of the first difference."""
    problems = []
    for key in sorted(set(expected) | set(actual)):
        if key not in actual or key not in expected:
            problems.append(f"{key}: only on one side")
        elif expected[key] != actual[key]:
            problems.append(f"{key}: {_first_difference(expected[key], actual[key])}")
    return problems


def _first_difference(left, right, path=""):
    if type(left) is not type(right):
        return f"{path or '.'} {left!r:.80} != {right!r:.80}"
    if isinstance(left, dict):
        for key in sorted(set(left) | set(right)):
            if key not in left or key not in right:
                return f"{path}.{key} only on one side"
            if left[key] != right[key]:
                return _first_difference(left[key], right[key], f"{path}.{key}")
    if isinstance(left, list):
        if len(left) != len(right):
            return f"{path} has {len(left)} items, not {len(right)}"
        for index, (a, b) in enumerate(zip(left, right, strict=True)):
            if a != b:
                return _first_difference(a, b, f"{path}[{index}]")
    return f"{path or '.'} {left!r:.80} != {right!r:.80}"
