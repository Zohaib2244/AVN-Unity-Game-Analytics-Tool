"""Prepared answers preserve live semantics and never expose unfinished generations."""

import json
from dataclasses import replace

import pytest
from parity import HIDE_TEST, build_fixture, make_storage, ranges

from avn_analytics import insights, journeys, materialize, views
from avn_analytics.models import EventDefinition


@pytest.fixture
def prepared(tmp_path):
    storage = make_storage(tmp_path, analytics_read_mode="prepared", read_cache_seconds=0)
    game = build_fixture(storage, events_target=600, seed=24)
    return storage, game, ranges()[0][1:]


def finish(storage, game, limit=100):
    worker = materialize.Worker(storage, identity="test")
    for _ in range(limit):
        worker.tick()
        with storage.connect(storage.game_path(game)) as db:
            rows = db.execute("SELECT answer, stage FROM analytics_views").fetchall()
        if rows and all(row["answer"] is not None and row["stage"] is None for row in rows):
            return worker
    pytest.fail(f"preparation did not finish: {materialize.describe(storage)}")


@pytest.mark.parametrize("scope", ["all", "first_session"])
def test_level_generation_equals_live_and_survives_api_restart(prepared, scope, monkeypatch):
    storage, game, days = prepared
    expected = journeys.level_progress(storage, game, *days, HIDE_TEST, scope)
    expected_players = journeys.level_players(storage, game, *days, HIDE_TEST, 1, scope=scope)
    finish(storage, game)
    again = make_storage(storage.root, analytics_read_mode="prepared", read_cache_seconds=0)
    monkeypatch.setattr(journeys, "_scan_levels", lambda *args: pytest.fail("unexpected live scan"))
    assert journeys.level_progress(again, game, *days, HIDE_TEST, scope) == expected
    assert journeys.level_players(again, game, *days, HIDE_TEST, 1, scope=scope) == expected_players


def test_summary_exact_and_stop_unavailable_and_expiry_use_live(prepared):
    storage, game, days = prepared
    parts = (days, HIDE_TEST, 345)

    def live():
        return insights.summary(storage, game, *days, HIDE_TEST, 345)

    expected = views.answer(storage, game, "summary", parts, live)
    worker = finish(storage, game)
    assert views.answer(storage, game, "summary", parts, lambda: "fallback") == expected
    materialize.set_desired(storage, "stopped", "admin")
    assert views.answer(storage, game, "summary", parts, lambda: "fallback") == "fallback"
    materialize.set_desired(storage, "running", "admin")
    worker.tick()
    worker._write_status(observed="exited", force=True)
    assert views.answer(storage, game, "summary", parts, lambda: "fallback") == "fallback"
    worker.tick()
    with storage.connect(storage.game_path(game)) as db:
        db.execute("UPDATE analytics_views SET source_at=0")
    assert views.answer(storage, game, "summary", parts, lambda: "fallback") == "fallback"


def test_changed_dictionary_invalidates_published_and_staging_answers(prepared):
    storage, game, days = prepared
    parts = (*days, HIDE_TEST, "all")
    journeys.level_progress(storage, game, *days, HIDE_TEST)
    worker = finish(storage, game)
    storage.set_definition(game, "level_start", EventDefinition(description="new definition"))
    assert views.answer(storage, game, "levels", parts, lambda: "fallback") == "fallback"
    with storage.connect(storage.game_path(game)) as db:
        db.execute("UPDATE analytics_views SET checked_at=0")
    worker.tick()
    with storage.connect(storage.game_path(game)) as db:
        row = db.execute("SELECT stage,answer FROM analytics_views").fetchone()
        assert row["stage"] and row["answer"]  # published old answer remains, but is ineligible
    storage.set_definition(game, "level_start", EventDefinition(description="changed again"))
    worker.tick()
    finish(storage, game)
    live = replace(storage.settings, analytics_read_mode="facts")
    from avn_analytics.storage import Storage

    assert journeys.level_progress(storage, game, *days, HIDE_TEST) == journeys.level_progress(
        Storage(live), game, *days, HIDE_TEST
    )


def test_stop_mid_build_never_publishes_partial_and_resume_reuses_staging(prepared):
    storage, game, days = prepared
    journeys.level_progress(storage, game, *days, HIDE_TEST)
    worker = materialize.Worker(storage, identity="test")
    worker.tick()
    with storage.connect(storage.game_path(game)) as db:
        stage = db.execute("SELECT stage FROM analytics_views").fetchone()[0]
        assert stage and json.loads(stage)["watermark"]
    materialize.set_desired(storage, "stopped", "admin")
    worker.tick()
    assert materialize.describe(storage)["state"] == "stopped"
    with storage.connect(storage.game_path(game)) as db:
        assert db.execute("SELECT answer FROM analytics_views").fetchone()[0] is None
        assert db.execute("SELECT stage FROM analytics_views").fetchone()[0] == stage
    materialize.set_desired(storage, "running", "admin")
    finish(storage, game)


def test_view_count_is_bounded(prepared):
    storage, game, days = prepared
    storage.settings = replace(storage.settings, analytics_active_views=2)
    for offset in (0, 60, 120):
        views.answer(storage, game, "summary", (days, {}, offset), lambda: {})
    with storage.connect(storage.game_path(game)) as db:
        assert db.execute("SELECT count(*) FROM analytics_views").fetchone()[0] == 2


def test_late_event_replaces_only_the_affected_players_contribution(prepared, monkeypatch):
    from avn_analytics.models import Batch

    storage, game, days = prepared
    journeys.level_progress(storage, game, *days, HIDE_TEST)
    worker = finish(storage, game)
    with storage.connect(storage.game_path(game)) as db:
        event = json.loads(
            db.execute(
                "SELECT payload FROM events WHERE json_extract(payload,'$.device_id') IS NOT NULL "
                "ORDER BY client_ts LIMIT 1"
            ).fetchone()[0]
        )
    event["event_id"] = "00000000-0000-4000-8000-000000000901"
    # A late timestamp changes an already processed player's history, not the ingest order.
    event["name"] = "level_start"
    event["params"] = {"level": 1}
    from avn_analytics.models import EventIn

    country = event.get("country")
    event = {key: value for key, value in event.items() if key in EventIn.model_fields}
    storage.ingest(game, Batch.model_validate({"events": [event]}), country=country)
    with storage.connect(storage.game_path(game)) as db:
        db.execute("UPDATE analytics_views SET checked_at=0")
    seen = []
    original = journeys.player_levels

    def track(player, *args):
        seen.append(player)
        return original(player, *args)

    monkeypatch.setattr(journeys, "player_levels", track)
    worker.tick()  # create the incremental queue
    finish(storage, game)
    assert len(seen) <= 1
    from avn_analytics.storage import Storage

    live = Storage(replace(storage.settings, analytics_read_mode="facts"))
    assert journeys.level_progress(storage, game, *days, HIDE_TEST) == journeys.level_progress(
        live, game, *days, HIDE_TEST
    )


def test_session_environment_change_rebuilds_old_events(prepared):
    storage, game, days = prepared
    journeys.level_progress(storage, game, *days, HIDE_TEST)
    worker = finish(storage, game)
    with storage.connect(storage.game_path(game)) as db:
        db.execute("UPDATE sessions SET environment='editor' WHERE environment IS NOT 'editor'")
        db.execute("UPDATE analytics_views SET checked_at=0")
    assert (
        views.answer(storage, game, "levels", (*days, HIDE_TEST, "all"), lambda: "live") == "live"
    )
    worker.tick()
    finish(storage, game)
    from avn_analytics.storage import Storage

    live = Storage(replace(storage.settings, analytics_read_mode="facts"))
    assert journeys.level_progress(storage, game, *days, HIDE_TEST) == journeys.level_progress(
        live, game, *days, HIDE_TEST
    )


def test_threshold_edits_rerender_without_rebuilding_facts(prepared):
    storage, game, days = prepared
    parts = (days, HIDE_TEST, 0)
    views.answer(
        storage, game, "summary", parts, lambda: insights.summary(storage, game, *days, HIDE_TEST)
    )
    finish(storage, game)
    with storage.connect(storage.root / "registry.sqlite3") as db:
        db.execute("UPDATE games SET retention_min_users=9999 WHERE id=?", (game,))
    result = views.answer(storage, game, "summary", parts, lambda: pytest.fail("live fallback"))
    assert result["context"]["minimum_players"] == 9999
    assert result["context"]["low_sample"] is True


def test_failure_before_publication_preserves_the_previous_generation(prepared, monkeypatch):
    storage, game, days = prepared
    journeys.level_progress(storage, game, *days, HIDE_TEST)
    worker = finish(storage, game)
    with storage.connect(storage.game_path(game)) as db:
        before = tuple(
            db.execute("SELECT answer,watermark,source_at FROM analytics_views").fetchone()
        )
        db.execute("UPDATE analytics_views SET checked_at=0")
        # No source changes: the worker will validate and republish the generation's freshness.
        db.execute(
            "CREATE TRIGGER fail_publication BEFORE UPDATE OF answer ON analytics_views "
            "BEGIN SELECT RAISE(ABORT, 'publication failed'); END"
        )
    worker.tick()
    assert materialize.describe(storage)["error"]
    with storage.connect(storage.game_path(game)) as db:
        assert (
            tuple(db.execute("SELECT answer,watermark,source_at FROM analytics_views").fetchone())
            == before
        )
        db.execute("DROP TRIGGER fail_publication")
        db.execute("UPDATE analytics_views SET retry_at=0")
    worker._backoff.clear()
    worker.tick()
    assert materialize.describe(storage)["error"] is None


def test_publication_is_fenced_when_context_changes_during_the_build(prepared, monkeypatch):
    storage, game, days = prepared
    journeys.level_progress(storage, game, *days, HIDE_TEST)
    worker = materialize.Worker(storage, identity="test")
    original = views.pack
    changed = False

    def change(value):
        nonlocal changed
        if isinstance(value, dict) and "transitions" in value and not changed:
            changed = True
            with storage.connect(storage.game_path(game)) as db:
                db.execute("UPDATE sessions SET environment='editor'")
        return original(value)

    monkeypatch.setattr(views, "pack", change)
    for _ in range(20):
        worker.tick()
        if changed:
            break
    assert changed
    with storage.connect(storage.game_path(game)) as db:
        assert db.execute("SELECT answer FROM analytics_views").fetchone()[0] is None
    finish(storage, game)


def test_storage_budget_rejects_work_and_keeps_live_answers_available(prepared, monkeypatch):
    storage, game, days = prepared
    expected = journeys.level_progress(storage, game, *days, HIDE_TEST)
    worker = materialize.Worker(storage, identity="test")
    # Leave enough room for metadata, but no player contributions.
    monkeypatch.setattr(views, "_space", lambda _: storage.settings.analytics_storage_bytes - 1)
    worker.tick()
    assert "budget" in materialize.describe(storage)["error"]["message"]
    assert journeys.level_progress(storage, game, *days, HIDE_TEST) == expected


def test_a_batch_over_its_allowance_is_split_instead_of_failing_forever(prepared, monkeypatch):
    storage, game, days = prepared
    expected = journeys.level_progress(storage, game, *days, HIDE_TEST)
    # Any two players together exceed the batch allowance; each fits on their own.
    monkeypatch.setattr(views, "BATCH_ROWS", 1)
    finish(storage, game, limit=400)
    assert not views.has_errors(storage, game)
    assert journeys.level_progress(storage, game, *days, HIDE_TEST) == expected


def test_a_single_player_over_the_solo_allowance_reports_the_budget(prepared, monkeypatch):
    storage, game, days = prepared
    journeys.level_progress(storage, game, *days, HIDE_TEST)
    monkeypatch.setattr(views, "BATCH_ROWS", 1)
    monkeypatch.setattr(views, "SOLO_ROWS", 1)
    worker = materialize.Worker(storage, identity="test")
    for _ in range(10):
        worker.tick()
    assert "memory budget" in materialize.describe(storage)["error"]["message"]


def test_stopping_during_reduction_rolls_back_the_entire_batch(prepared, monkeypatch):
    storage, game, days = prepared
    journeys.level_progress(storage, game, *days, HIDE_TEST)
    worker = materialize.Worker(storage, identity="test")
    worker.tick()  # stage the queue
    original = journeys.player_levels
    stopped = False

    def stop_in_reducer(*args):
        nonlocal stopped
        if not stopped:
            stopped = True
            materialize.set_desired(storage, "stopped", "admin")
        return original(*args)

    monkeypatch.setattr(journeys, "player_levels", stop_in_reducer)
    worker.tick()
    worker.tick()
    assert materialize.describe(storage)["state"] == "stopped"
    with storage.connect(storage.game_path(game)) as db:
        assert db.execute("SELECT count(*) FROM analytics_parts").fetchone()[0] == 0
        assert db.execute("SELECT cursor FROM analytics_views").fetchone()[0] == 0
        assert db.execute("SELECT answer FROM analytics_views").fetchone()[0] is None
    materialize.set_desired(storage, "running", "admin")
    finish(storage, game)


def test_expired_worker_cannot_write_staging_after_lease_takeover(prepared, monkeypatch):
    storage, game, days = prepared
    journeys.level_progress(storage, game, *days, HIDE_TEST)
    worker = materialize.Worker(storage, identity="test")
    worker.tick()
    original = journeys.player_levels
    stolen = False

    def steal(*args):
        nonlocal stolen
        if not stolen:
            stolen = True
            with storage.connect(storage.game_path(game)) as db:
                db.execute("UPDATE analytics_meta SET value='new-worker' WHERE key='lease_owner'")
        return original(*args)

    monkeypatch.setattr(journeys, "player_levels", steal)
    worker.tick()
    with storage.connect(storage.game_path(game)) as db:
        assert db.execute("SELECT cursor FROM analytics_views").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM analytics_parts").fetchone()[0] == 0
        assert (
            db.execute("SELECT value FROM analytics_meta WHERE key='lease_owner'").fetchone()[0]
            == "new-worker"
        )


def test_rollback_and_restore_preserve_raw_events_and_the_stored_stop(prepared, tmp_path):
    import shutil

    from avn_analytics.storage import Storage

    storage, game, days = prepared
    expected = journeys.level_progress(storage, game, *days, HIDE_TEST)
    finish(storage, game)
    materialize.set_desired(storage, "stopped", "admin")
    with storage.connect(storage.game_path(game)) as db:
        raw = [tuple(row) for row in db.execute("SELECT * FROM events ORDER BY event_id")]
    for mode in ("legacy", "facts", "prepared"):
        version = Storage(replace(storage.settings, analytics_read_mode=mode))
        assert journeys.level_progress(version, game, *days, HIDE_TEST) == expected
    # This test's services are stopped and all connections closed. Copy every file, including
    # any WAL, as the documented whole-directory backup procedure requires.
    restored_path = tmp_path.parent / (tmp_path.name + "-restore")
    shutil.copytree(storage.root, restored_path)
    restored = make_storage(restored_path, analytics_read_mode="prepared")
    assert materialize.describe(restored)["desired"] == "stopped"
    assert journeys.level_progress(restored, game, *days, HIDE_TEST) == expected
    with restored.connect(restored.game_path(game)) as db:
        assert [tuple(row) for row in db.execute("SELECT * FROM events ORDER BY event_id")] == raw


def test_new_sessions_after_the_watermark_do_not_expire_prepared_history(prepared):
    from avn_analytics.models import Batch, EventIn

    storage, game, days = prepared
    expected = journeys.level_progress(storage, game, *days, HIDE_TEST)
    finish(storage, game)
    with storage.connect(storage.game_path(game)) as db:
        event = json.loads(db.execute("SELECT payload FROM events LIMIT 1").fetchone()[0])
    event.update(
        event_id="00000000-0000-4000-8000-000000000902",
        name="session_start",
        client_ts="2026-10-01T00:00:00+00:00",
        session_id="brand-new-session",
        params={},
        environment="production",
    )
    event = {key: value for key, value in event.items() if key in EventIn.model_fields}
    storage.ingest(game, Batch.model_validate({"events": [event]}))
    actual = views.answer(
        storage,
        game,
        "levels",
        (*days, HIDE_TEST, "all"),
        lambda: pytest.fail("unrelated new session invalidated history"),
    )
    assert (
        journeys.render_levels(
            actual, storage.analytics_thresholds(game)["levels_min_players"], "all"
        )
        == expected
    )


def test_semantically_equal_filters_share_one_specification(prepared):
    storage, game, days = prepared
    for filters in ({"countries": ["US", "GB", "US"]}, {"countries": ["GB", "US"], "builds": []}):
        views.answer(storage, game, "summary", (days, filters, 0), lambda: {})
    with storage.connect(storage.game_path(game)) as db:
        assert db.execute("SELECT count(*) FROM analytics_views").fetchone()[0] == 1


def test_prepared_read_logs_fallback_and_hit(prepared, caplog):
    storage, game, days = prepared
    parts = (days, HIDE_TEST, 345)
    with caplog.at_level("INFO", logger="avn_analytics.views"):
        views.answer(storage, game, "summary", parts, lambda: "live")
        assert "fallback=missing" in caplog.text
        finish(storage, game)
        caplog.clear()
        views.answer(storage, game, "summary", parts, lambda: "live")
        assert "source=prepared" in caplog.text
        caplog.clear()
        with storage.connect(storage.game_path(game)) as db:
            db.execute("UPDATE analytics_views SET source_at=0")
        assert views.answer(storage, game, "summary", parts, lambda: "live") == "live"
        assert "fallback=expired" in caplog.text


def test_default_read_mode_is_facts(monkeypatch, tmp_path):
    from avn_analytics.config import Settings

    monkeypatch.delenv("AVN_ANALYTICS_READ_MODE", raising=False)
    assert Settings(data_dir=tmp_path).analytics_read_mode == "facts"
    assert Settings.from_env().analytics_read_mode == "facts"
