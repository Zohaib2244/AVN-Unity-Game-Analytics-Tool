"""Shared player groups preserve rule semantics and scope every dashboard read."""

import json

import pytest
from test_backend import AUTH, register
from test_player_groups import backend as backend
from test_player_groups import record, seed, sequence

from avn_analytics import player_chips, segments
from avn_analytics.insights import FACTS

DAYS = {"start": "2026-10-04", "end": "2026-10-05"}


def get(client, game, endpoint, chips=(), **params):
    response = client.get(
        f"/v1/games/{game['id']}/insights/{endpoint}",
        headers=AUTH,
        params={**DAYS, "player_group": json.dumps(chips), **params},
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize(
    ("op", "value", "expected"),
    [
        ("gt", "4", {"b"}),
        ("gte", "4", {"a", "b"}),
        ("lt", "4", {"c"}),
        ("lte", "4", {"a", "c"}),
        ("eq", "4", {"a"}),
        ("ne", "4", {"b", "c"}),
        ("contains", "igh", {"b"}),
        ("exists", "", {"a", "b", "c"}),
    ],
)
def test_event_chips_use_the_shared_rule_operators(backend, op, value, expected):
    game = register(backend)
    field = "label" if op == "contains" else "amount"
    rows = [
        record(pid, 1, "reward", {"amount": number, "label": label})
        for pid, number, label in (("a", 4, "low"), ("b", 8, "high"), ("c", 1, "low"))
    ]
    rows += [record("missing", 1, "reward", {})]
    seed(backend, game, rows)
    chip = {"kind": "event", "event": "reward", "param": field, "op": op, "rule_value": value}
    assert {row["player"] for row in get(backend, game, "players", [chip])["players"]} == expected
    chip["never"] = True
    assert {row["player"] for row in get(backend, game, "players", [chip])["players"]} == (
        {"a", "b", "c", "missing"} - expected
    )


def test_occurrence_thresholds_and_old_multivalue_chips_survive(backend):
    game = register(backend)
    seed(
        backend,
        game,
        [record("a", i, "reward", {"amount": 4}) for i in (1, 2)]
        + [record("b", 1, "reward", {"amount": 8})],
    )
    chip = {
        "kind": "event",
        "event": "reward",
        "param": "amount",
        "op": "gt",
        "rule_value": "3",
        "min": 2,
    }
    assert [row["player"] for row in get(backend, game, "players", [chip])["players"]] == ["a"]
    old = {"kind": "event", "event": "reward", "param": "amount", "values": ["4", "8"]}
    assert get(backend, game, "players", [old])["total"] == 2


def test_group_membership_scopes_overview_levels_drills_and_sessions(backend):
    game = register(backend)
    rows = sequence("chosen") + sequence("other")
    rows += [
        record("chosen", -86400, "ATTRIBUTION_ANALYSIS", {"CAMPAIGN": "C1", "STATE": "Install"})
    ]
    seed(backend, game, rows)
    chips = [{"kind": "campaign", "values": ["C1"]}]
    summary = get(backend, game, "summary", chips)
    assert summary["players"] == 1
    sessions = get(backend, game, "sessions", chips)
    assert sessions["players"] == sessions["sessions"] == 1
    assert sessions["ingest_counts_available"] is False
    assert len(sessions["quality"]) == 1
    assert sessions["quality"][0]["rejected"] is None
    assert sessions["quality"][0]["duplicate_percent"] is None
    levels = get(backend, game, "levels", chips)
    # The membership event is outside the displayed days; follow-up remains present.
    assert levels["levels"]
    players = get(backend, game, "levels/players", chips, level=1)
    assert {row["player"] for row in players["players"]} == {"chosen"}
    features = get(backend, game, "levels/features", chips)
    assert features


def test_group_counts_follow_dates_builds_and_saved_edits(backend):
    game = register(backend)
    seed(backend, game, sequence("a") + sequence("b", version="0.1.2"))
    path = f"/v1/games/{game['id']}/insights/group-library"
    saved = backend.post(
        path,
        headers=AUTH,
        json={
            "name": "Completed",
            "kind": "players",
            "definition": {"chips": [{"kind": "event", "event": "level_complete"}]},
        },
    )
    assert saved.status_code == 201, saved.text
    item = saved.json()
    counts = get(backend, game, "player-group-counts")
    assert counts == {"all": 2, "counts": {item["id"]: 2}}
    assert get(backend, game, "player-group-counts", version="0.1.3")["counts"] == {item["id"]: 1}
    body = {
        "name": "Missing",
        "kind": "players",
        "definition": {"chips": [{"kind": "event", "event": "unknown"}]},
    }
    assert backend.put(f"{path}/{item['id']}", headers=AUTH, json=body).is_success
    assert get(backend, game, "player-group-counts")["counts"] == {item["id"]: 0}
    assert backend.delete(f"{path}/{item['id']}", headers=AUTH).status_code == 204
    assert get(backend, game, "player-group-counts")["counts"] == {}
    assert backend.post(f"{path}/{item['id']}/restore", headers=AUTH).is_success
    assert get(backend, game, "player-group-counts")["counts"] == {item["id"]: 0}


def test_cost_memberships_are_not_truncated_or_limited_by_sql_variables(tmp_path, monkeypatch):
    # The resolver previously silently discarded everyone after player 20,000.
    values = {f"p{i}": {"cost": 1, "paid_back": 100} for i in range(25_001)}
    monkeypatch.setattr(player_chips, "_cost_values", lambda *_: values)
    from avn_analytics.config import Settings
    from avn_analytics.models import GameCreate
    from avn_analytics.storage import Storage

    storage = Storage(Settings(data_dir=tmp_path, read_cache_seconds=0))
    storage.initialize()
    game = storage.register_game(
        GameCreate(name="Synthetic", bundle_id="com.example.synthetic", platform="android")
    )
    found = player_chips.resolve_costs(
        storage, game["id"], [{"cost": "paid_back", "min": 100, "max": None}]
    )
    assert len(found[0]["players"]) == 25_001
    sql, args = segments.clause(found[0], FACTS)
    assert len(args) == 1
    with storage.connect(storage.game_path(game["id"])) as connection:
        assert connection.execute("SELECT count(*) FROM json_each(?)", args).fetchone()[0] == 25_001
    assert "json_each" in sql


@pytest.mark.parametrize(
    "chip",
    [
        {"kind": "earned", "min": float("nan")},
        {"kind": "event", "event": "reward", "param": "amount", "op": "gt", "rule_value": "wrong"},
        {"kind": "event", "event": "reward", "param": "amount", "op": "wat"},
    ],
)
def test_invalid_chip_numbers_and_comparisons_cannot_be_saved(chip):
    with pytest.raises(ValueError):
        player_chips.conditions([chip])
