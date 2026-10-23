"""Analytics facts (analytics.py): copied once, exactly, and never at the events' cost."""

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager

import pytest
from parity import make_storage
from synthetic import generate

from avn_analytics import analytics
from avn_analytics.models import Batch, GameCreate


def _game(storage, name="facts"):
    return storage.register_game(
        GameCreate(name=name, bundle_id=f"com.avn.{name}", platform="android")
    )["id"]


def _ingest(storage, game_id, events=600, seed=3):
    for country, batch in generate(events, seed=seed, days=20, batch_size=100):
        storage.ingest(game_id, Batch.model_validate(batch), country=country)


def _without_facts(storage, game_id):
    """Make the game look like it was written before facts existed."""
    with storage.connect(storage.game_path(game_id)) as connection:
        for kind, name in analytics.DERIVED:
            connection.execute(f"DROP {kind} IF EXISTS {name}")


def _install(storage, game_id):
    with storage.connect(storage.game_path(game_id)) as connection:
        analytics.install(connection)


def _expected(payload):
    """What the facts should say about an event, worked out independently in Python."""
    environment = payload.get("environment")
    return {
        "user_id": payload.get("user_id"),
        "device_id": payload.get("device_id"),
        "player": payload.get("user_id")
        if payload.get("user_id") is not None
        else payload.get("device_id"),
        "session_id": payload.get("session_id"),
        "app_version": payload.get("app_version"),
        "build": payload.get("build"),
        "country": payload.get("country"),
        "platform": payload.get("platform"),
        "environment": environment.lower() if isinstance(environment, str) else environment,
        "params": payload.get("params"),
    }


def _check_facts(storage, game_id):
    """Every event has exactly one fact, and it says what the event's JSON says."""
    with storage.connect(storage.game_path(game_id)) as connection:
        events = {row["event_id"]: row for row in connection.execute("SELECT * FROM events")}
        facts = connection.execute("SELECT *, player FROM analytics_facts").fetchall()
    assert len(facts) == len(events) and {row["event_id"] for row in facts} == set(events)
    for fact in facts:
        event = events[fact["event_id"]]
        payload = json.loads(event["payload"])
        actual = {key: fact[key] for key in _expected(payload)}
        actual["params"] = json.loads(actual["params"]) if actual["params"] else None
        assert actual == _expected(payload), fact["event_id"]
        for column in ("name", "client_ts", "server_ts"):
            assert fact[column] == event[column]
    return len(facts)


def _events_digest(storage, game_id):
    with storage.connect(storage.game_path(game_id)) as connection:
        rows = connection.execute("SELECT * FROM events ORDER BY rowid").fetchall()
    return hashlib.sha256(json.dumps([tuple(row) for row in rows]).encode()).hexdigest()


def _finish(storage, game_id, **limits):
    for _ in range(10_000):
        with storage.connect(storage.game_path(game_id)) as connection:
            state = analytics.step(connection, **limits)
        if state["ready"]:
            return state
    raise AssertionError("backfill never finished")


@pytest.fixture
def storage(tmp_path):
    return make_storage(tmp_path)


def test_new_events_get_their_facts_as_they_are_stored(storage):
    game_id = _game(storage)
    with storage.connect(storage.game_path(game_id)) as connection:
        assert analytics.progress(connection)["ready"]  # nothing older to copy
    _ingest(storage, game_id)
    assert _check_facts(storage, game_id) > 500


def test_duplicate_events_are_counted_once_and_get_one_fact(storage):
    game_id = _game(storage)
    _, batch = next(generate(300, seed=5, batch_size=50))
    size = len(batch["events"])
    first = storage.ingest(game_id, Batch.model_validate(batch))
    again = storage.ingest(game_id, Batch.model_validate(batch))
    assert first["accepted"] == size and first["duplicates"] == 0
    assert again["accepted"] == 0 and again["duplicates"] == size
    assert _check_facts(storage, game_id) == size


def test_older_events_are_copied_in_short_resumable_steps_without_touching_them(storage):
    game_id = _game(storage)
    _without_facts(storage, game_id)
    _ingest(storage, game_id, events=1500)
    before = _events_digest(storage, game_id)
    _install(storage, game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        assert not analytics.facts_ready(connection)
        state = analytics.step(connection, backfill_rows=400)
    assert state["phase"] == "backfill" and state["done"] == 400

    # A step that fails half way leaves nothing behind and the cursor where it was.
    original = analytics._set

    def broken(connection, **values):
        raise sqlite3.OperationalError("disk I/O error")

    analytics._set = broken
    try:
        with pytest.raises(sqlite3.OperationalError):
            with storage.connect(storage.game_path(game_id)) as connection:
                analytics.step(connection, backfill_rows=400)
    finally:
        analytics._set = original
    with storage.connect(storage.game_path(game_id)) as connection:
        assert analytics.progress(connection)["done"] == 400
        assert connection.execute("SELECT count(*) FROM analytics_facts").fetchone()[0] <= 400

    state = _finish(storage, game_id, backfill_rows=400, verify_rows=300)
    assert state["ready"] and state["repaired"] == 0
    assert _check_facts(storage, game_id) > 1400
    assert _events_digest(storage, game_id) == before


def test_backfill_and_ingest_can_run_at_the_same_time(storage):
    game_id = _game(storage)
    _without_facts(storage, game_id)
    _ingest(storage, game_id, events=1500, seed=11)
    _install(storage, game_id)
    batches = list(generate(1500, seed=12, days=5, batch_size=50))
    failures = []

    def keep_ingesting():
        try:
            for country, batch in batches:
                storage.ingest(game_id, Batch.model_validate(batch), country=country)
        except Exception as error:  # pragma: no cover - reported below
            failures.append(error)

    writer = threading.Thread(target=keep_ingesting)
    writer.start()
    _finish(storage, game_id, backfill_rows=50, verify_rows=200)
    writer.join()
    assert not failures
    assert _check_facts(storage, game_id) > 2900


def test_a_session_environment_is_recorded_as_a_change_only_when_it_changes(storage):
    game_id = _game(storage)

    def send(environment, event_id, session="s1", params=None):
        storage.ingest(
            game_id,
            Batch.model_validate(
                {
                    "context": {"environment": environment} if environment else None,
                    "events": [
                        {
                            "event_id": event_id,
                            "name": "session_start",
                            "params": params or {},
                            "client_ts": "2026-09-01T10:00:00Z",
                            "device_id": "d1",
                            "session_id": session,
                            "app_version": "1.0",
                            "build": "1",
                            "platform": "android",
                        }
                    ],
                }
            ),
        )

    def changes():
        with storage.connect(storage.game_path(game_id)) as connection:
            return [
                row["session_id"]
                for row in connection.execute("SELECT * FROM analytics_changes ORDER BY seq")
            ]

    send("development", "00000000-0000-4000-8000-000000000001")
    send("development", "00000000-0000-4000-8000-000000000002")  # same: no change
    assert changes() == ["s1"]
    send("production", "00000000-0000-4000-8000-000000000003")
    send("Production", "00000000-0000-4000-8000-000000000004")  # same once lowered
    send(None, "00000000-0000-4000-8000-000000000005", "s2")  # no environment: nothing to record
    send(None, "00000000-0000-4000-8000-000000000006", "s2", {"environment": "editor"})
    assert changes() == ["s1", "s1", "s2"]


def test_missing_or_wrong_facts_are_found_and_rewritten(storage):
    game_id = _game(storage)
    _ingest(storage, game_id, events=400)
    with storage.connect(storage.game_path(game_id)) as connection:
        ids = [row[0] for row in connection.execute("SELECT id FROM analytics_facts LIMIT 2")]
        connection.execute("DELETE FROM analytics_facts WHERE id=?", (ids[0],))
        connection.execute("UPDATE analytics_facts SET platform='wrong' WHERE id=?", (ids[1],))
    with storage.connect(storage.game_path(game_id)) as connection:
        assert analytics.audit(connection) is True
        assert not analytics.facts_ready(connection)
    state = _finish(storage, game_id, verify_rows=100)
    assert state["repaired"] == 2
    _check_facts(storage, game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        assert analytics.audit(connection) is False


def test_a_failed_facts_write_stores_nothing_and_the_retry_stores_everything_once(backend_app):
    client, storage, game = backend_app
    _, batch = next(generate(400, seed=8, batch_size=30))
    with storage.connect(storage.game_path(game["id"])) as connection:
        connection.execute(
            "CREATE TRIGGER fail BEFORE INSERT ON analytics_facts"
            " BEGIN SELECT RAISE(ABORT, 'no room'); END"
        )
    response = client.post("/v1/events", json=batch, headers={"X-API-Key": game["key"]["api_key"]})
    assert response.status_code == 503
    with storage.connect(storage.game_path(game["id"])) as connection:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 0
        connection.execute("DROP TRIGGER fail")
    response = client.post("/v1/events", json=batch, headers={"X-API-Key": game["key"]["api_key"]})
    assert response.json()["accepted"] == 30
    assert _check_facts(storage, game["id"]) == 30


def test_a_full_disk_stores_nothing_and_the_retry_stores_everything_once(backend_app):
    client, storage, game = backend_app
    original = storage.connect

    @contextmanager
    def full(path):
        with original(path) as connection:
            pages = connection.execute("PRAGMA page_count").fetchone()[0]
            connection.execute(f"PRAGMA max_page_count={pages}")
            yield connection

    _, batch = next(generate(3000, seed=9, batch_size=200))
    storage.connect = full
    try:
        response = client.post(
            "/v1/events", json=batch, headers={"X-API-Key": game["key"]["api_key"]}
        )
    finally:
        storage.connect = original
    assert response.status_code == 503
    with storage.connect(storage.game_path(game["id"])) as connection:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 0
    response = client.post("/v1/events", json=batch, headers={"X-API-Key": game["key"]["api_key"]})
    assert response.json() | {"server_ts": None} == {
        "accepted": 200,
        "duplicates": 0,
        "server_ts": None,
    }
    assert _check_facts(storage, game["id"]) == 200


def test_an_older_app_writing_raw_events_still_gets_facts(storage):
    game_id = _game(storage)
    payload = {"event_id": "old-1", "name": "level_start", "device_id": "d9", "params": {}}
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.execute(  # the statement older versions use: no column names
            "INSERT INTO events VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING",
            ("old-1", "level_start", "2026-09-01T00:00:00+00:00", "x", json.dumps(payload)),
        )
    assert _check_facts(storage, game_id) == 1


def test_facts_from_an_older_layout_are_rebuilt_from_the_events(storage):
    game_id = _game(storage)
    _ingest(storage, game_id, events=300)
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.execute("UPDATE analytics_meta SET value='0' WHERE key='schema_version'")
        connection.execute("UPDATE analytics_facts SET build='stale'")
    before = _events_digest(storage, game_id)
    _install(storage, game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        assert analytics.progress(connection)["phase"] == "backfill"
        assert connection.execute("SELECT count(*) FROM analytics_facts").fetchone()[0] == 0
    _finish(storage, game_id)
    _check_facts(storage, game_id)
    assert _events_digest(storage, game_id) == before


def test_the_command_line_reports_and_prepares_every_game(storage, monkeypatch, capsys):
    game_id = _game(storage)
    _without_facts(storage, game_id)
    _ingest(storage, game_id, events=200)
    _install(storage, game_id)
    monkeypatch.setenv("AVN_DATA_DIR", str(storage.root))
    assert analytics.main(["status"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["phase"] == "backfill" and report["events_without_facts"] > 150
    assert analytics.main(["prepare", "--game", game_id]) == 0
    assert json.loads(capsys.readouterr().out)["ready"] is True
    _check_facts(storage, game_id)


@pytest.fixture
def backend_app(tmp_path):
    from fastapi.testclient import TestClient

    from avn_analytics.api import create_app
    from avn_analytics.config import Settings

    settings = Settings(data_dir=tmp_path, admin_token="t" * 40)
    with TestClient(create_app(settings)) as client:
        storage = client.app.state.storage
        game = storage.register_game(
            GameCreate(name="Ingest", bundle_id="com.avn.ingest", platform="android")
        )
        yield client, storage, game


def test_cli_status_and_dry_run_do_not_install_or_modify_older_databases(
    tmp_path, monkeypatch, capsys
):
    import hashlib

    from parity import make_storage

    storage = make_storage(tmp_path)
    game = storage.register_game(
        GameCreate(name="Old", bundle_id="com.avn.old", platform="android")
    )["id"]
    with storage.connect(storage.game_path(game)) as db:
        for kind, name in analytics.DERIVED:
            db.execute(f"DROP {kind} IF EXISTS {name}")
    paths = [storage.root / "registry.sqlite3", storage.game_path(game)]
    before = {path: hashlib.sha256(path.read_bytes()).digest() for path in paths}
    monkeypatch.setenv("AVN_DATA_DIR", str(storage.root))
    for arguments in (["status"], ["prepare", "--dry-run"]):
        assert analytics.main(arguments) == 0
        assert '"phase": "not_installed"' in capsys.readouterr().out
        with storage.connect(storage.game_path(game)) as db:
            assert (
                db.execute("SELECT 1 FROM sqlite_master WHERE name='analytics_meta'").fetchone()
                is None
            )
        assert {path: hashlib.sha256(path.read_bytes()).digest() for path in paths} == before


def test_cli_dry_run_does_not_create_a_missing_data_directory(tmp_path, monkeypatch):
    path = tmp_path / "not-an-installation"
    monkeypatch.setenv("AVN_DATA_DIR", str(path))
    assert analytics.main(["prepare", "--dry-run"]) == 1
    assert not path.exists()
