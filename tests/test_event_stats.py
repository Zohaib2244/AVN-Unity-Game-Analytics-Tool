"""Kept all-time totals (event_stats.py) give exactly what counting every event gives."""

from parity import make_storage
from synthetic import generate
from synthetic_sdk import generate as generate_sdk

from avn_analytics import analytics, cleanup, event_stats, events, insights
from avn_analytics.models import Batch, EventDefinition, GameCreate

PARAMS = """SELECT name, p.key AS key, p.type AS type, count(*) AS count, min(p.value) AS low,
                   max(p.value) AS high
            FROM analytics_facts, json_each(analytics_facts.params) AS p
            WHERE (? = '' OR app_version = ?) GROUP BY name, p.key, p.type"""
NAMES = """SELECT name, count(*), min(client_ts), max(client_ts), min(server_ts), max(server_ts)
           FROM analytics_facts WHERE (? = '' OR app_version = ?) GROUP BY name"""
PLAYERS = "SELECT name, count(DISTINCT player) FROM analytics_facts GROUP BY name"


def _game(storage, name="stats"):
    return storage.register_game(
        GameCreate(name=name, bundle_id=f"com.avn.{name}", platform="android")
    )["id"]


def _ingest(storage, game_id, events=900, seed=3, sdk=False):
    source = generate_sdk if sdk else generate
    for country, batch in source(events, seed=seed, days=20, batch_size=100):
        storage.ingest(game_id, Batch.model_validate(batch), country=country)


def _refresh(storage, game_id, **limits):
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.isolation_level = None
        return event_stats.refresh(connection, **limits)


def _check(storage, game_id, version=""):
    """The kept totals (plus whatever is newer, counted live) equal a count of every fact."""
    with storage.connect(storage.game_path(game_id)) as connection:
        expected_params = sorted(tuple(row) for row in connection.execute(PARAMS, (version,) * 2))
        actual_params = sorted(tuple(row) for row in event_stats.param_totals(connection, version))
        assert actual_params == expected_params
        names = {
            row[0]: {
                "events": row[1],
                "first_seen": row[2],
                "last_seen": row[3],
                "first_server": row[4],
                "last_server": row[5],
            }
            for row in connection.execute(NAMES, (version,) * 2)
        }
        assert event_stats.name_totals(connection, version) == names
        if not version:
            players = dict(tuple(row) for row in connection.execute(PLAYERS))
            assert event_stats.name_players(connection) == players
        return len(expected_params)


def test_totals_match_counting_every_event_while_events_keep_arriving(tmp_path):
    storage = make_storage(tmp_path, analytics_read_mode="facts")
    game_id = _game(storage)
    _ingest(storage, game_id, sdk=True)
    # Nothing kept yet: everything is counted live.
    assert _check(storage, game_id) > 20
    # Part of it kept, the rest live.
    through = _refresh(storage, game_id, max_rows=500, chunk_rows=200)
    assert 0 < through < 1000
    _check(storage, game_id)
    _check(storage, game_id, "1.0.0")
    _refresh(storage, game_id)
    _check(storage, game_id)
    # New events after the totals: added live, then kept, never twice.
    _ingest(storage, game_id, events=400, seed=4, sdk=True)
    _check(storage, game_id)
    _refresh(storage, game_id, chunk_rows=97)
    _check(storage, game_id)
    _refresh(storage, game_id)
    _check(storage, game_id)


def test_deleting_events_or_rebuilding_facts_starts_the_totals_again(tmp_path):
    storage = make_storage(tmp_path, analytics_read_mode="facts")
    game_id = _game(storage)
    _ingest(storage, game_id)
    _refresh(storage, game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        versions = [
            row[0] for row in connection.execute("SELECT DISTINCT app_version FROM analytics_facts")
        ]
    cleanup.delete(storage, game_id, versions[:1])
    with storage.connect(storage.game_path(game_id)) as connection:
        assert event_stats.current(connection) is None  # stale: not read until rebuilt
    _refresh(storage, game_id)
    _check(storage, game_id)
    # A facts schema change drops and rebuilds the facts; the totals follow.
    with storage.connect(storage.game_path(game_id)) as connection:
        for kind, name in analytics.DERIVED:
            connection.execute(f"DROP {kind} IF EXISTS {name}")
        analytics.install(connection)
        connection.commit()
        while not analytics.facts_ready(connection):
            analytics.step(connection)
            connection.commit()
    assert _refresh(storage, game_id) > 0
    _check(storage, game_id)


def test_pages_read_the_same_with_and_without_kept_totals(tmp_path):
    facts = make_storage(tmp_path, analytics_read_mode="facts", read_cache_seconds=0)
    game_id = _game(facts)
    _ingest(facts, game_id, sdk=True)
    legacy = make_storage(tmp_path, analytics_read_mode="legacy", read_cache_seconds=0)
    start, end = "2026-08-01T00:00:00+00:00", "2026-10-01T00:00:00+00:00"
    filters = {"exclude_environments": insights.TEST_ENVIRONMENTS}

    def without_size(answer):
        return {**answer, "summary": {**answer["summary"], "database_bytes": None}}

    raw = {
        "discovery": insights.discovery(legacy, game_id),
        "events": without_size(events.overview(legacy, game_id, start, end, filters)),
        "mappings": events.mappings(legacy, game_id),
        "mappings_version": events.mappings(legacy, game_id, "1.2.0"),
    }
    for _ in range(2):  # first with nothing kept (refreshed on the way), then from the totals
        assert insights.discovery(facts, game_id) == raw["discovery"]
        assert without_size(events.overview(facts, game_id, start, end, filters)) == raw["events"]
        assert events.mappings(facts, game_id) == raw["mappings"]
        assert events.mappings(facts, game_id, "1.2.0") == raw["mappings_version"]
    with facts.connect(facts.game_path(game_id)) as connection:
        assert event_stats.current(connection) > 0


def test_mapping_verdict_stops_early_with_the_same_answer(tmp_path, monkeypatch):
    storage = make_storage(tmp_path, analytics_read_mode="facts", read_cache_seconds=0)
    game_id = _game(storage)
    _ingest(storage, game_id, events=1500, sdk=True)
    original = events.mappings
    reads = []

    def counted(*args, verdict=False, **kwargs):
        result = original(*args, verdict=verdict, **kwargs)
        reads.append(result["scanned"])
        return result

    def verdicts():
        reads.clear()
        monkeypatch.setattr(events, "mappings", counted)
        fast = events.mapping_status(storage, game_id)
        monkeypatch.setattr(
            events, "mappings", lambda *a, **k: counted(*a, **{**k, "verdict": False})
        )
        slow = events.mapping_status(storage, game_id)
        monkeypatch.setattr(events, "mappings", original)
        assert fast == slow
        return fast, reads[0], reads[1]

    # The SDK game never sends Restarted: those rules are silent, read to the end either way.
    status, fast_reads, slow_reads = verdicts()
    assert {issue["concept"] for issue in status["issues"]} == {"level_restarted"}
    # A rule nothing matches is reported as before.
    with storage.connect(storage.game_path(game_id)) as connection:
        definition = EventDefinition.model_validate(
            {
                "description": "never sent like this",
                "canonical": [
                    {"action": "level_completed", "param": "STATE", "op": "eq", "value": "Nope"}
                ],
            }
        )
        storage.write_definition(connection, "LEVEL_ANALYSIS_OLD", definition)
    status, _, _ = verdicts()
    assert {issue.get("event") for issue in status["issues"]} >= {"LEVEL_ANALYSIS_OLD"}
    # With every rule met, the verdict stops after the first events instead of reading them all.
    definitions = storage.get_dictionary(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.execute("DELETE FROM dictionary WHERE name='LEVEL_ANALYSIS_OLD'")
        level = definitions["LEVEL_ANALYSIS"]
        level["canonical"] = [
            rule for rule in level["canonical"] if rule["action"] != "level_restarted"
        ]
        storage.write_definition(
            connection, "LEVEL_ANALYSIS", EventDefinition.model_validate(level)
        )
    status, fast_reads, slow_reads = verdicts()
    assert status == {"ok": True, "has_events": True, "issues": []}
    assert fast_reads < 200 < slow_reads
