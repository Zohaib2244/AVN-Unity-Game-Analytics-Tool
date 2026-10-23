"""The analytics worker (materialize.py): starts, stops, resumes and reports truthfully."""

import json
import threading
import time
from datetime import UTC, datetime, timedelta

import pytest
from parity import make_storage
from synthetic import generate

from avn_analytics import analytics, materialize
from avn_analytics.models import Batch, GameCreate


def _game(storage, name):
    return storage.register_game(
        GameCreate(name=name, bundle_id=f"com.avn.{name}", platform="android")
    )["id"]


def _ingest(storage, game_id, events, seed):
    for country, batch in generate(events, seed=seed, days=10, batch_size=100):
        storage.ingest(game_id, Batch.model_validate(batch), country=country)


def _older_game(storage, name="older", events=2000, seed=1):
    """A game whose events were stored before facts existed: the worker has to copy them."""
    game_id = _game(storage, name)
    with storage.connect(storage.game_path(game_id)) as connection:
        for kind, table in analytics.DERIVED:
            connection.execute(f"DROP {kind} IF EXISTS {table}")
    _ingest(storage, game_id, events, seed)
    with storage.connect(storage.game_path(game_id)) as connection:
        analytics.install(connection)
    return game_id


def _progress(storage, game_id):
    with storage.connect(storage.game_path(game_id)) as connection:
        return analytics.progress(connection)


def _exact(storage, game_id):
    """Every event has exactly one fact."""
    with storage.connect(storage.game_path(game_id)) as connection:
        events = connection.execute("SELECT count(*) FROM events").fetchone()[0]
        facts = connection.execute(
            "SELECT count(*), count(DISTINCT event_id) FROM analytics_facts"
        ).fetchone()
        missing = connection.execute(
            "SELECT count(*) FROM events WHERE NOT EXISTS (SELECT 1 FROM analytics_facts AS f"
            " WHERE f.event_id = events.event_id)"
        ).fetchone()[0]
    return events == facts[0] == facts[1] and missing == 0


def _wait(condition, seconds=10.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return False


class _Running:
    """A worker running its loop in a thread, as the worker container does."""

    def __init__(self, storage, identity="test-worker"):
        self.worker = materialize.Worker(storage, identity=identity)
        self.thread = threading.Thread(target=self.worker.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self.worker

    def __exit__(self, *exc):
        self.worker.stop()
        self.thread.join(10)
        assert not self.thread.is_alive()


@pytest.fixture
def storage(tmp_path, monkeypatch):
    monkeypatch.setattr(materialize, "POLL_SECONDS", 0.05)
    monkeypatch.setattr(materialize, "HEARTBEAT_SECONDS", 0.1)
    monkeypatch.setattr(materialize, "PENDING_SECONDS", 0.1)
    return make_storage(tmp_path, analytics_batch_rows=100)


def test_a_new_installation_starts_as_configured_and_the_stored_choice_wins_afterwards(tmp_path):
    first = make_storage(tmp_path, analytics_worker_default_enabled=False)
    assert materialize.describe(first)["desired"] == "stopped"
    materialize.set_desired(first, "running", "boss@example.com")
    for default in (False, True):  # restarts, with either default, keep the admin's choice
        again = make_storage(tmp_path, analytics_worker_default_enabled=default)
        control = materialize.describe(again)
        assert (control["desired"], control["changed_by"]) == ("running", "boss@example.com")
    materialize.set_desired(first, "stopped", "boss@example.com")
    assert materialize.describe(make_storage(tmp_path))["desired"] == "stopped"


def test_the_worker_copies_older_facts_and_then_reports_running(storage):
    game_id = _older_game(storage)
    assert materialize.describe(storage)["state"] == "unavailable"  # never ran yet
    with _Running(storage):
        assert _wait(lambda: _progress(storage, game_id)["ready"])
        assert _wait(lambda: materialize.describe(storage)["state"] == "running")
    assert _exact(storage, game_id)
    status = materialize.describe(storage)
    assert status["state"] == "unavailable"  # the loop has exited
    assert status["last_success_at"] and status["error"] is None


def test_stop_mid_backfill_is_acknowledged_quickly_and_work_resumes_where_it_left_off(storage):
    game_id = _older_game(storage, events=6000, seed=4)
    with _Running(storage):
        assert _wait(lambda: 0 < _progress(storage, game_id)["done"])
        asked = time.monotonic()
        materialize.set_desired(storage, "stopped", "boss@example.com")
        assert materialize.describe(storage)["state"] in ("stopping", "stopped")
        assert _wait(lambda: materialize.describe(storage)["state"] == "stopped", 5)
        assert time.monotonic() - asked < 5
        paused = _progress(storage, game_id)
        assert not paused["ready"]
        # While stopped, nothing moves on, and events are still collected with their facts.
        _ingest(storage, game_id, 400, seed=5)
        time.sleep(0.5)
        assert _progress(storage, game_id) == paused
        assert materialize.describe(storage)["state"] == "stopped"
        materialize.set_desired(storage, "running", "boss@example.com")
        assert _wait(lambda: _progress(storage, game_id)["ready"], 30)
        assert _wait(lambda: materialize.describe(storage)["state"] == "running")
    assert _exact(storage, game_id)


def test_a_stopped_worker_stays_stopped_across_restarts(storage):
    game_id = _older_game(storage, events=1500, seed=6)
    materialize.set_desired(storage, "stopped", "boss@example.com")
    for identity in ("first", "second"):
        with _Running(storage, identity=identity):
            assert _wait(lambda: materialize.describe(storage)["state"] == "stopped")
            time.sleep(0.3)
        assert _progress(storage, game_id)["done"] == 0
    materialize.set_desired(storage, "running", "boss@example.com")
    with _Running(storage, identity="third"):
        assert _wait(lambda: _progress(storage, game_id)["ready"], 30)
    assert _exact(storage, game_id)


def test_rapid_start_and_stop_end_in_the_last_request(storage):
    _older_game(storage, events=3000, seed=7)
    revisions = [materialize.describe(storage)["revision"]]
    with _Running(storage):
        for desired in ("stopped", "running", "stopped", "stopped", "running"):
            revisions.append(materialize.set_desired(storage, desired, "a@example.com")["revision"])
        # Asking for what is already asked changes nothing; every real change counts up.
        assert revisions == [1, 2, 3, 4, 4, 5]
        assert _wait(
            lambda: (
                materialize.describe(storage)["state"] in ("running", "catching_up")
                and materialize.describe(storage)["worker"]["acknowledged_revision"] == 5
            )
        )
        materialize.set_desired(storage, "stopped", "a@example.com")
        assert _wait(lambda: materialize.describe(storage)["state"] == "stopped", 5)


def test_an_acknowledgement_of_an_older_request_never_counts_for_a_newer_one(storage):
    worker = materialize.Worker(storage, identity="slow")
    materialize.set_desired(storage, "stopped", "a@example.com")
    worker.tick()  # acknowledges the stop (revision 2)
    assert materialize.describe(storage)["state"] == "stopped"
    materialize.set_desired(storage, "running", "a@example.com")  # revision 3, not seen yet
    assert materialize.describe(storage)["state"] == "starting"
    materialize.set_desired(storage, "stopped", "a@example.com")  # revision 4
    # The worker's stop acknowledgement is for revision 2: this stop isn't acknowledged yet.
    assert materialize.describe(storage)["state"] == "stopping"
    worker.tick()
    assert materialize.describe(storage)["state"] == "stopped"


def test_a_worker_that_stops_reporting_is_unavailable_not_stopped(storage):
    later = datetime.now(UTC) + timedelta(seconds=materialize.UNAVAILABLE_SECONDS + 1)
    worker = materialize.Worker(storage, identity="gone")
    materialize.set_desired(storage, "stopped", "a@example.com")
    worker.tick()
    assert materialize.describe(storage)["state"] == "stopped"
    assert materialize.describe(storage, now=later)["state"] == "unavailable"
    assert materialize.check_health(storage) == 0
    assert materialize.check_health(storage, now=later) == 1


def test_only_one_worker_works_at_a_time(storage, monkeypatch):
    monkeypatch.setattr(materialize, "SLICE_SECONDS", 0)  # one step per tick
    game_id = _older_game(storage, events=1500, seed=8)
    first = materialize.Worker(storage, identity="first")
    second = materialize.Worker(storage, identity="second")
    assert first.tick() is True
    done = _progress(storage, game_id)["done"]
    assert second.tick() is False and _progress(storage, game_id)["done"] == done
    assert materialize.describe(storage)["worker"]["observed"] in ("catching_up", "running")
    # Once the first stops reporting, the second takes over.
    late = datetime.now(UTC) + timedelta(seconds=materialize.UNAVAILABLE_SECONDS + 1)
    second.clock = lambda: late
    assert second.tick() is True and _progress(storage, game_id)["done"] > done


def test_a_game_leased_by_another_worker_is_left_alone_until_the_lease_ends(storage, monkeypatch):
    monkeypatch.setattr(materialize, "SLICE_SECONDS", 0)
    game_id = _older_game(storage, events=800, seed=9)
    until = datetime.now(UTC) + timedelta(seconds=30)
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.executemany(
            "INSERT INTO analytics_meta (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [("lease_owner", "elsewhere"), ("lease_until", until.isoformat())],
        )
    worker = materialize.Worker(storage, identity="here")
    assert worker.tick() is False and _progress(storage, game_id)["done"] == 0
    worker.clock = lambda: until + timedelta(seconds=1)
    assert worker.tick() is True and _progress(storage, game_id)["done"] > 0
    with storage.connect(storage.game_path(game_id)) as connection:
        assert analytics.read_meta(connection)["lease_owner"] is None  # released after the step


def test_a_failing_game_is_reported_and_retried_while_the_others_carry_on(storage, monkeypatch):
    broken = _older_game(storage, name="broken", events=600, seed=10)
    fine = _older_game(storage, name="fine", events=600, seed=11)
    original = analytics.step

    def step(connection, **limits):
        path = connection.execute("PRAGMA database_list").fetchone()["file"]
        if broken in path:
            raise RuntimeError("disk I/O error")
        return original(connection, **limits)

    monkeypatch.setattr(analytics, "step", step)
    worker = materialize.Worker(storage, identity="w")
    for _ in range(40):
        worker.tick()
    assert _progress(storage, fine)["ready"] and not _progress(storage, broken)["ready"]
    error = materialize.describe(storage)["error"]
    assert error["game_id"] == broken and "disk I/O error" in error["message"]
    monkeypatch.setattr(analytics, "step", original)
    worker._backoff.clear()
    for _ in range(40):
        worker.tick()
    assert _progress(storage, broken)["ready"]
    assert materialize.describe(storage)["error"] is None  # a later success clears it
    assert json.loads(json.dumps(materialize.describe(storage)))  # plain JSON for the website


def test_the_container_health_check_follows_the_heartbeat(storage, monkeypatch):
    monkeypatch.setenv("AVN_DATA_DIR", str(storage.root))
    assert materialize.main(["health"]) == 1  # never ran
    materialize.Worker(storage, identity="w").tick()
    assert materialize.main(["health"]) == 0


def test_restart_keeps_errors_until_the_failing_game_succeeds(storage, monkeypatch):
    game_id = _older_game(storage, events=500)
    first = materialize.Worker(storage, identity="first")
    first._claim()
    first._failed(game_id, RuntimeError("test failure"))
    first._write_status(observed="exited", force=True)
    second = materialize.Worker(storage, identity="second")
    assert second._claim()
    assert materialize.describe(storage)["error"]["message"] == "RuntimeError: test failure"
    for _ in range(30):
        second.tick()
    assert materialize.describe(storage)["error"] is None


def test_busy_games_take_turns_and_stop_does_not_claim_the_next_game(storage, monkeypatch):
    games = [_older_game(storage, name=name) for name in ("one", "two")]
    worker = materialize.Worker(storage, identity="w")
    calls = []
    monkeypatch.setattr(worker, "_work_on", lambda game, revision: calls.append(game) or True)
    worker.tick()
    worker.tick()
    assert set(calls) == set(games)
    revision = worker._control()["revision"]
    materialize.set_desired(storage, "stopped", "admin")
    assert not worker._work(revision)
    assert len(calls) == 2
