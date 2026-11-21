"""What events cost on disk: compact JSON, a bounded write-ahead log, and the storage report."""

import hashlib
import json

from parity import make_storage
from synthetic_sdk import generate

from avn_analytics import analytics, storage_report
from avn_analytics.models import Batch, GameCreate
from avn_analytics.storage import ENVELOPE_COLUMNS, WAL_SIZE_LIMIT, full_event


def _game(storage):
    game_id = storage.register_game(
        GameCreate(name="Size", bundle_id="com.avn.size", platform="android")
    )["id"]
    for country, batch in generate(600, seed=5, days=10, batch_size=100):
        storage.ingest(game_id, Batch.model_validate(batch), country=country)
    return game_id


def test_events_are_stored_as_compact_json_without_repeating_their_columns(tmp_path):
    storage = make_storage(tmp_path)
    game_id = _game(storage)
    with storage.connect(storage.game_path(game_id)) as connection:
        rows = connection.execute(
            "SELECT events.event_id, events.name, events.client_ts, events.server_ts, payload,"
            " json_extract(payload, '$.params') AS raw_params, analytics_facts.params AS fact"
            " FROM events JOIN analytics_facts ON analytics_facts.event_id = events.event_id"
        ).fetchall()
        limit = connection.execute("PRAGMA journal_size_limit").fetchone()[0]
    assert rows and limit == WAL_SIZE_LIMIT
    for row in rows:
        payload = json.loads(row["payload"])
        assert row["payload"] == json.dumps(payload, separators=(",", ":"))
        assert not set(payload) & set(ENVELOPE_COLUMNS)
        assert row["raw_params"] == row["fact"]
        # The whole event, as it used to be stored: same keys, same order, same values.
        whole = full_event(row)
        assert list(whole)[:4] == ["event_id", "name", "params", "client_ts"]
        assert list(whole)[-3:-1] == ["server_ts", "country"] or list(whole)[-2:] == [
            "server_ts",
            "country",
        ]
        assert {key: whole[key] for key in ENVELOPE_COLUMNS} == {
            key: row[key] for key in ENVELOPE_COLUMNS
        }


def test_full_event_rebuilds_what_was_stored_before(tmp_path):
    storage = make_storage(tmp_path)
    game_id = storage.register_game(
        GameCreate(name="Old", bundle_id="com.avn.old", platform="android")
    )["id"]
    batch = Batch.model_validate(
        {
            "events": [
                {
                    "event_id": "00000000-0000-4000-8000-0000000000a1",
                    "name": "LEVEL_ANALYSIS",
                    "params": {"STATE": "Started", "LEVEL_NUMBER": 3, "NOTE": "café ✓", "X": 1.5},
                    "client_ts": "2026-11-01T10:00:00.123456+02:00",
                    "device_id": "d1",
                    "session_id": "s1",
                    "app_version": "1.0.0",
                    "build": "1",
                    "platform": "android",
                }
            ]
        }
    )
    storage.ingest(game_id, batch, country="DE", delivery="live")
    event = batch.resolved[0]
    with storage.connect(storage.game_path(game_id)) as connection:
        row = connection.execute(
            "SELECT event_id, name, client_ts, server_ts, payload FROM events"
        ).fetchone()
    # What ingest stored before November 2026, built the old way.
    before = event.model_dump(mode="json")
    before["client_ts"] = row["client_ts"]
    before["server_ts"] = row["server_ts"]
    before["country"] = "DE"
    before["delivery"] = "live"
    assert json.dumps(full_event(row)) == json.dumps(before)


def test_slimming_older_events_keeps_every_value(tmp_path, monkeypatch, capsys):
    storage = make_storage(tmp_path, analytics_read_mode="facts")
    game_id = _game(storage)
    path = storage.game_path(game_id)
    with storage.connect(path) as connection:
        # Rewrite the rows the way older versions stored them (the whole envelope, spaced).
        rows = connection.execute(
            "SELECT rowid, event_id, name, client_ts, server_ts, payload FROM events"
        ).fetchall()
        wholes = {row["event_id"]: full_event(row) for row in rows}
        for row in rows:
            connection.execute(
                "UPDATE events SET payload=? WHERE rowid=?",
                (json.dumps(wholes[row["event_id"]], ensure_ascii=True), row["rowid"]),
            )
        # One whose JSON disagrees with its column keeps its key.
        odd = rows[0]["event_id"]
        connection.execute(
            "UPDATE events SET payload=json_set(payload, '$.name', 'other') WHERE event_id=?",
            (odd,),
        )
        wholes[odd]["name"] = "other"
    monkeypatch.setenv("AVN_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AVN_ADMIN_TOKEN", "x" * 40)
    assert storage_report.main(["--game", game_id, "--slim"]) == 2  # needs --yes
    assert storage_report.main(["--game", game_id, "--slim", "--compact", "--yes"]) == 0
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["slimmed_events"] == len(rows) - 1
    with storage.connect(path) as connection:
        after = connection.execute(
            "SELECT event_id, name, client_ts, server_ts, payload FROM events"
        ).fetchall()
        assert {row["event_id"]: full_event(row) for row in after if row["event_id"] != odd} == {
            key: value for key, value in wholes.items() if key != odd
        }
        assert json.loads(next(r for r in after if r["event_id"] == odd)["payload"])["name"] == (
            "other"
        )
    # The facts still say exactly what the events say.
    with storage.connect(path) as connection:
        end = connection.execute("SELECT max(id) FROM analytics_facts").fetchone()[0]
        analytics._set(connection, phase="values", verify_cursor=0, verify_until=end, ready=0)
    with storage.connect(path) as connection:
        while not analytics.facts_ready(connection):
            analytics.step(connection)
            connection.commit()
        assert analytics.read_meta(connection)["repaired"] == "0"


def _digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_storage_report_reads_only_and_compact_keeps_every_row(tmp_path, monkeypatch, capsys):
    storage = make_storage(tmp_path)
    game_id = _game(storage)
    path = storage.game_path(game_id)
    with storage.connect(path) as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        before = connection.execute(
            "SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM analytics_facts)"
        ).fetchone()
        # Rows deleted from a derived table leave free pages behind.
        connection.execute("CREATE TABLE scratch_rows (value TEXT)")
        connection.executemany("INSERT INTO scratch_rows VALUES (?)", [("x" * 2000,)] * 500)
    with storage.connect(path) as connection:
        connection.execute("DROP TABLE scratch_rows")
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    monkeypatch.setenv("AVN_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AVN_ADMIN_TOKEN", "x" * 40)
    digest = _digest(path)
    assert storage_report.main([]) == 0
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert _digest(path) == digest  # the report changes nothing
    assert line["events"] == before[0] and line["free_bytes"] > 500_000
    # Compacting needs a game and a confirmation.
    assert storage_report.main(["--compact"]) == 2
    assert storage_report.main(["--game", game_id, "--compact"]) == 2
    assert storage_report.main(["--game", game_id, "--compact", "--yes"]) == 0
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["compacted"]["after_bytes"] < line["compacted"]["before_bytes"] - 500_000
    with storage.connect(path) as connection:
        after = connection.execute(
            "SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM analytics_facts)"
        ).fetchone()
        assert tuple(after) == tuple(before)
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_starting_up_does_not_rebuild_a_games_facts(tmp_path):
    """Every service upgrades every game at startup; a rebuild there starves the others of the
    write lock (a live deploy failed on it), so the facts layout must not change by release."""
    storage = make_storage(tmp_path)
    game_id = _game(storage)
    path = storage.game_path(game_id)
    with storage.connect(path) as connection:
        meta = analytics.read_meta(connection)
        facts = connection.execute("SELECT count(*) FROM analytics_facts").fetchone()[0]
    assert meta["schema_version"] == "1" and analytics.SCHEMA_VERSION == 1
    storage.initialize()
    with storage.connect(path) as connection:
        assert analytics.read_meta(connection) == meta
        assert connection.execute("SELECT count(*) FROM analytics_facts").fetchone()[0] == facts
