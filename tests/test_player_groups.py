"""Cohort comparisons retain missing behaviors, censor recent players and respect time order."""

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, register

from avn_analytics import player_groups
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.insights import read_source
from avn_analytics.models import Batch

NOW = datetime(2026, 10, 6, 12, tzinfo=UTC)
BASE = datetime(2026, 10, 4, 10, tzinfo=UTC)


@pytest.fixture(params=["legacy", "facts", "prepared"])
def backend(tmp_path, monkeypatch, request):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

    monkeypatch.setattr(player_groups, "datetime", Clock)
    settings = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        lan_admin=False,
        access_team_domain="example.cloudflareaccess.com",
        access_audience="test-audience",
        analytics_read_mode=request.param,
        read_cache_seconds=0,
    )
    with TestClient(create_app(settings, admin=True, access_keys={})) as client:
        yield client


def record(player, seconds, name, params=None, *, base=BASE, version="0.1.3", **extra):
    return {
        "event_id": str(uuid4()),
        "name": name,
        "device_id": player,
        "session_id": f"session-{player}",
        "app_version": version,
        "build": "1",
        "platform": "android",
        "environment": "production",
        "client_ts": (base + timedelta(seconds=seconds)).isoformat(),
        "params": params or {},
        **extra,
    }


def sequence(player, seconds=60, reached=True, **extra):
    rows = [
        record(player, 0, "session_start", **extra),
        record(player, 10, "level_start", {"level": 1}, **extra),
    ]
    if seconds is not None:
        rows.append(record(player, 10 + seconds, "level_complete", {"level": 1}, **extra))
    if reached:
        rows.append(record(player, 1000, "level_start", {"level": 4}, **extra))
    return rows


def seed(client, game, records):
    client.app.state.storage.ingest(game["id"], Batch.model_validate({"events": records}))
    storage = client.app.state.storage
    with storage.connect(storage.game_path(game["id"])) as connection:
        assert read_source(storage, connection).facts == (
            storage.settings.analytics_read_mode != "legacy"
        )


def definition(**updates):
    return {
        "start": "2026-10-04",
        "end": "2026-10-05",
        "filters": {"app_versions": ["0.1.3"], "exclude_environments": ["editor"]},
        "behavior": {"kind": "level_duration", "level": 1, "split": 70},
        "outcome": {"kind": "level", "level": 4, "window_hours": 24},
        **updates,
    }


def ask(client, game, body=None):
    response = client.post(
        f"/v1/games/{game['id']}/insights/player-groups", headers=AUTH, json=body or definition()
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_comparable_population_pending_missing_and_updates(backend):
    game = register(backend)
    rows = []
    for player, seconds, reached in [
        ("fast-yes", 60, True),
        ("at-split", 70, False),
        ("slow-yes", 90, True),
        ("slow-no", 100, False),
        ("missing", None, True),
    ]:
        rows += sequence(player, seconds, reached)
    rows += sequence("pending", base=NOW - timedelta(hours=23))
    rows += [
        record("old", -3 * 86400, "session_start"),
        record("old", 0, "level_start", {"level": 1}),
    ]
    rows += [record("advanced", 0, "level_start", {"level": 10})]
    rows += sequence("emulator")
    rows[-4]["params"] = {"device_model": "sdk_gphone emulator"}
    rows += sequence("wrong-version", version="0.1.2")
    rows[-1]["app_version"] = "0.1.3"
    rows += sequence("upgraded")
    rows[-1]["app_version"] = "0.1.4"
    seed(backend, game, rows)
    body = definition(
        exclude_events=[
            {
                "event": "session_start",
                "param": "device_model",
                "op": "contains",
                "value": "emulator",
            }
        ]
    )
    data = ask(backend, game, body)
    assert data["counts"] == {
        "candidates": 11,
        "eligible": 6,
        "pending": 1,
        "excluded": 4,
        "outcome_before_group": 0,
    }
    a, b, missing = data["groups"]
    assert (a["players"], a["reached"]) == (3, 2)
    assert (b["players"], b["reached"]) == (2, 1)
    assert (missing["players"], missing["reached"]) == (1, 1)
    assert data["missing_reasons"] == {"no_recorded_completion": 1}
    assert {item["reason"] for item in data["exclusions"]} == {
        "earlier_history",
        "advanced_save",
        "excluded_event",
        "baseline_filters",
    }
    assert data["difference"]["percentage_points"] == 16.67
    assert data["difference"]["includes_zero"] is True
    assert a["interval"][0] < a["rate"] < a["interval"][1]
    assert data["definition"]["behavior"]["split"] == 70
    # The read creates no durable cohort tables or changes to raw events.
    storage = backend.app.state.storage
    with storage.connect(storage.game_path(game["id"])) as connection:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == len(rows)
        assert not connection.execute(
            "SELECT name FROM sqlite_master WHERE name LIKE 'group_%'"
        ).fetchall()


def test_followup_crosses_enrollment_end_and_counts_exact_deadline(backend):
    game = register(backend)
    base = BASE.replace(hour=23, minute=59)
    rows = sequence("a", base=base)
    rows[-1]["client_ts"] = (base + timedelta(hours=24)).isoformat()
    rows += sequence("b", 100, base=base)
    rows[-1]["client_ts"] = (base + timedelta(hours=24, microseconds=1)).isoformat()
    seed(backend, game, rows)
    data = ask(backend, game, definition(end="2026-10-04"))
    assert [(row["players"], row["reached"]) for row in data["groups"]] == [(1, 1), (1, 0), (0, 0)]


def test_duration_includes_retries_and_sessions_and_does_not_use_reported_duration(backend):
    game = register(backend)
    rows = sequence("a", 100)
    rows += [
        record("a", 40, "level_fail", {"level": 1}),
        record("a", 60, "level_restart", {"level": 1}, session_id="second"),
    ]
    rows[2]["params"]["duration_seconds"] = 5
    seed(backend, game, rows)
    data = ask(backend, game)
    assert data["groups"][1]["examples"] == [{"player": "a", "reached": True, "value": 100.0}]


def test_event_counts_use_fixed_early_window_and_separate_prior_outcomes(backend):
    game = register(backend)
    rows = sequence("zero") + sequence("shown") + sequence("early")
    rows += [
        record("shown", 100, "ad_show", {"type": "interstitial"}),
        record("shown", 200, "ad_show", {"type": "rewarded"}),
        record("zero", 601, "ad_show", {"type": "interstitial"}),
    ]
    rows += [record("early", 500, "level_start", {"level": 4})]
    seed(backend, game, rows)
    data = ask(
        backend,
        game,
        definition(
            behavior={
                "kind": "event_count",
                "event": {"event": "ad_show", "param": "type", "value": "interstitial"},
                "split": 0,
                "window_minutes": 10,
            }
        ),
    )
    assert data["counts"]["outcome_before_group"] == 1
    assert [(row["players"], row["reached"]) for row in data["groups"]] == [(1, 1), (1, 1), (0, 0)]
    assert data["groups"][1]["examples"][0]["value"] == 1


def test_parameter_groups_keep_absent_and_invalid_values_visible(backend):
    game = register(backend)
    rows = []
    for player, value in [("low", 1), ("high", "3"), ("invalid", "not-a-number"), ("absent", None)]:
        current = sequence(player)
        if value is not None:
            current[0]["params"] = {"tier": value}
        rows += current
    seed(backend, game, rows)
    behavior = {
        "kind": "parameter",
        "event": {"event": "session_start"},
        "parameter": "tier",
        "comparison": "number",
        "split": 2,
    }
    data = ask(backend, game, definition(behavior=behavior))
    assert [row["players"] for row in data["groups"]] == [1, 1, 2]
    assert data["missing_reasons"] == {"no_recorded_parameter": 1, "non_numeric_value": 1}
    behavior.update(comparison="equals", value="1", split=None)
    data = ask(backend, game, definition(behavior=behavior))
    assert [row["players"] for row in data["groups"]] == [1, 2, 1]


def test_event_outcome_and_excluded_ids_and_no_entry_requirement(backend):
    game = register(backend)
    rows = [
        record("a", 0, "session_start", {"campaign": "paid"}),
        record("a", 1000, "purchase"),
        record("b", 0, "session_start", {"campaign": "organic"}),
    ]
    seed(backend, game, rows)
    body = definition(
        entry_level=None,
        exclude_players=["b"],
        behavior={
            "kind": "parameter",
            "event": {"event": "session_start"},
            "parameter": "campaign",
            "comparison": "equals",
            "value": "paid",
        },
        outcome={"kind": "event", "event": {"event": "purchase"}, "window_hours": 24},
    )
    data = ask(backend, game, body)
    assert data["groups"][0]["reached"] == 1
    assert data["counts"]["excluded"] == 1
    assert data["difference"] is None


def test_empty_groups_timezone_game_isolation_and_future_events(backend):
    game = register(backend)
    other = register(backend, "com.avn.other")
    seed(backend, other, sequence("other"))
    seed(backend, game, sequence("future", base=NOW + timedelta(days=1)))
    assert ask(backend, game)["counts"]["candidates"] == 0
    assert ask(backend, game)["groups"][0]["interval"] is None
    # 23:30 UTC Oct 3 is Oct 4 in UTC+2.
    local = sequence("local", base=BASE.replace(day=3, hour=23, minute=30))
    local[-1]["client_ts"] = BASE.replace(day=4, hour=0, minute=30).isoformat()
    seed(backend, game, local)
    assert (
        ask(backend, game)["counts"]["candidates"] == 1
    )  # follow-up, but first seen outside dates
    data = ask(backend, game, definition(timezone_offset_minutes=120))
    assert data["groups"][0]["players"] == 1


def test_named_player_cap_and_history_cap_fail_explicitly(backend, monkeypatch):
    game = register(backend)
    seed(backend, game, sequence("a") + sequence("b"))
    path = f"/v1/games/{game['id']}/insights/player-groups"
    monkeypatch.setattr(player_groups, "MAX_PLAYERS", 1)
    response = backend.post(path, headers=AUTH, json=definition())
    assert response.status_code == 400 and "players" in response.json()["detail"]
    monkeypatch.setattr(player_groups, "MAX_PLAYERS", 100)
    monkeypatch.setattr(player_groups, "MAX_FUNNEL_EVENTS", 2)
    response = backend.post(path, headers=AUTH, json=definition())
    assert response.status_code == 400 and "history" in response.json()["detail"]


@pytest.mark.parametrize(
    "change",
    [
        {"behavior": {"kind": "level_duration"}},
        {"behavior": {"kind": "event_count", "split": 0}},
        {
            "behavior": {
                "kind": "event_count",
                "event": {"event": "ad_show"},
                "split": 0,
                "window_minutes": 1440,
            }
        },
        {
            "behavior": {
                "kind": "parameter",
                "event": {"event": "session_start"},
                "comparison": "equals",
                "value": "low",
            }
        },
        {"outcome": {"kind": "level", "level": 1}},
        {"outcome": {"kind": "event"}},
        {"start": "2026-10-06", "end": "2026-10-04"},
    ],
)
def test_incomplete_or_invalid_comparisons_are_refused(backend, change):
    game = register(backend)
    response = backend.post(
        f"/v1/games/{game['id']}/insights/player-groups",
        headers=AUTH,
        json={**definition(), **deepcopy(change)},
    )
    assert response.status_code in (400, 422), response.text


def test_intervals_and_difference_match_reference_values():
    assert player_groups.wilson(72, 115) == pytest.approx((0.5349263867, 0.7090961984))
    result = player_groups.difference(
        {"players": 115, "reached": 72}, {"players": 36, "reached": 17}
    )
    assert result["percentage_points"] == 15.39
    assert result["includes_zero"] is True
    assert player_groups.wilson(0, 0) is None
    assert player_groups.wilson(0, 1)[0] == 0
    assert player_groups.wilson(1, 1)[1] == 1


def test_comparisons_require_access_and_a_real_game(backend):
    game = register(backend)
    path = f"/v1/games/{game['id']}/insights/player-groups"
    assert backend.post(path, json=definition()).status_code == 401
    response = backend.post(
        f"/v1/games/{uuid4()}/insights/player-groups", headers=AUTH, json=definition()
    )
    assert response.status_code == 404


def test_recent_advanced_saves_are_excluded_before_followup_censoring(backend):
    game = register(backend)
    seed(
        backend,
        game,
        [record("advanced-recent", 0, "level_start", {"level": 20}, base=NOW - timedelta(hours=1))],
    )
    data = ask(backend, game, definition(end="2026-10-06"))
    assert data["counts"]["pending"] == 0
    assert data["exclusions"] == [
        {
            "reason": "advanced_save",
            "label": "First recorded progression is not a start of the entry level",
            "players": 1,
        }
    ]


def test_mapped_level_events_and_completions_without_starts(backend):
    game = register(backend)
    mapping = {
        "canonical": [
            {
                "action": "level_started",
                "param": "STATE",
                "op": "eq",
                "value": "start",
                "number_param": "LEVEL",
            },
            {
                "action": "level_completed",
                "param": "STATE",
                "op": "eq",
                "value": "done",
                "number_param": "LEVEL",
            },
        ]
    }
    response = backend.put(
        f"/v1/games/{game['id']}/dictionary/GAME_STATE", headers=AUTH, json=mapping
    )
    assert response.status_code == 200, response.text
    rows = [
        record("mapped", 0, "session_start"),
        record("mapped", 10, "GAME_STATE", {"STATE": "start", "LEVEL": 1}),
        record("mapped", 80, "GAME_STATE", {"STATE": "done", "LEVEL": 1}),
        record("mapped", 100, "GAME_STATE", {"STATE": "start", "LEVEL": 4}),
        record("no-start", 0, "session_start"),
        record("no-start", 80, "GAME_STATE", {"STATE": "done", "LEVEL": 1}),
    ]
    seed(backend, game, rows)
    data = ask(backend, game, definition(entry_level=None))
    assert (data["groups"][0]["players"], data["groups"][0]["reached"]) == (1, 1)
    assert data["missing_reasons"] == {"completion_without_start": 1}
