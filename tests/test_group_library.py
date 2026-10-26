"""Saved groups are reusable definitions, not frozen player lists or browser preferences."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from test_backend import ADMIN_EMAIL, AUTH, TOKEN, event, register
from test_backend import team as team

from avn_analytics import group_library
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.models import Batch


@pytest.fixture
def backend(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        lan_admin=False,
        access_team_domain="example.cloudflareaccess.com",
        access_audience="test-audience",
    )
    with TestClient(create_app(settings, admin=True, access_keys={})) as admin:
        yield admin, settings


def saved(name="First level speed", kind="groups"):
    definition = {
        "start": "2026-10-01",
        "end": "2026-10-26",
        "behavior": {"kind": "level_duration", "level": 1, "split": 70},
        "window_hours": 24,
        "range_preset": "30",
        "version_mode": "latest",
    }
    if kind == "check":
        definition["outcome"] = {"kind": "level", "level": 4, "window_hours": 24}
    return {"name": name, "kind": kind, "definition": definition}


def test_library_persists_isolates_games_and_restores_the_same_id(backend):
    admin, settings = backend
    game, other = register(admin), register(admin, "com.avn.other")
    path = f"/v1/games/{game['id']}/insights/group-library"
    other_path = f"/v1/games/{other['id']}/insights/group-library"
    assert admin.get(path).status_code == 401
    assert admin.get(path, headers=AUTH).json() == []
    response = admin.post(path, headers=AUTH, json=saved("  First level speed  "))
    assert response.status_code == 201, response.text
    item = response.json()
    assert item["name"] == "First level speed"
    assert item["definition"]["outcome"] is None
    assert admin.post(path, headers=AUTH, json=saved("FIRST LEVEL SPEED")).status_code == 409
    # A shortcut may have the same name as a group; its outcome is its own copy.
    check = admin.post(path, headers=AUTH, json=saved(kind="check"))
    assert check.status_code == 201
    item_path = f"{path}/{item['id']}"
    assert admin.put(item_path, headers=AUTH, json=saved("Renamed")).status_code == 200
    with TestClient(create_app(replace(settings), admin=True, access_keys={})) as restarted:
        assert len(restarted.get(path, headers=AUTH).json()) == 2
    assert admin.get(other_path, headers=AUTH).json() == []
    for method in ("put", "delete"):
        kwargs = {"json": saved()} if method == "put" else {}
        assert (
            getattr(admin, method)(f"{other_path}/{item['id']}", headers=AUTH, **kwargs).status_code
            == 404
        )
    assert admin.post(f"{other_path}/{item['id']}/restore", headers=AUTH).status_code == 404
    assert admin.delete(item_path, headers=AUTH).status_code == 204
    assert admin.delete(item_path, headers=AUTH).status_code == 404
    assert admin.put(item_path, headers=AUTH, json=saved()).status_code == 404
    restored = admin.post(f"{item_path}/restore", headers=AUTH)
    assert restored.status_code == 200
    assert restored.json()["id"] == item["id"]
    assert restored.json()["name"] == "Renamed"
    assert admin.post(f"{item_path}/restore", headers=AUTH).status_code == 200
    assert admin.get(path, headers=AUTH).json()[0]["definition"] == check.json()["definition"]


@pytest.mark.parametrize(
    "change",
    [
        {"name": " "},
        {"name": "a" * 81},
        {"kind": "preset"},
        {"kind": "check"},
        {"definition": {"start": "2026-10-01", "end": "2026-10-26", "behavior": {"split": -1}}},
    ],
)
def test_invalid_saved_items_are_rejected(backend, change):
    admin, _ = backend
    game = register(admin)
    path = f"/v1/games/{game['id']}/insights/group-library"
    assert admin.post(path, headers=AUTH, json={**saved(), **change}).status_code == 400


def test_definition_validation_cap_and_restore_conflicts(backend, monkeypatch):
    admin, _ = backend
    game = register(admin)
    path = f"/v1/games/{game['id']}/insights/group-library"
    for patch in (
        {"end": "2026-09-01"},
        {"start": "2024-01-01"},
        {"window_hours": 0},
        {"range_preset": "forever"},
        {"outcome": {"level": 4}},
        {
            "behavior": {
                "kind": "event_count",
                "event": {"event": "ad_show"},
                "split": 0,
                "window_minutes": 1440,
            }
        },
    ):
        body = saved()
        body["definition"].update(patch)
        assert admin.post(path, headers=AUTH, json=body).status_code == 400
    body = saved(kind="check")
    body["definition"]["outcome"]["level"] = 1
    assert admin.post(path, headers=AUTH, json=body).status_code == 400
    monkeypatch.setattr(group_library, "MAX_SAVED_ITEMS", 1)
    item = admin.post(path, headers=AUTH, json=saved()).json()
    item_path = f"{path}/{item['id']}"
    assert admin.post(path, headers=AUTH, json=saved("Other")).status_code == 400
    assert admin.put(item_path, headers=AUTH, json=saved("Renamed")).status_code == 200
    assert admin.put(item_path, headers=AUTH, json=saved(kind="check")).status_code == 422
    assert admin.delete(item_path, headers=AUTH).status_code == 204
    admin.post(path, headers=AUTH, json=saved("Renamed"))
    assert admin.post(f"{item_path}/restore", headers=AUTH).status_code == 400
    monkeypatch.setattr(group_library, "MAX_SAVED_ITEMS", 2)
    assert admin.post(f"{item_path}/restore", headers=AUTH).status_code == 409
    assert len(admin.get(path, headers=AUTH).json()) == 1


def test_library_migration_and_writes_preserve_raw_events(backend):
    admin, settings = backend
    game = register(admin)
    storage = admin.app.state.storage
    storage.ingest(game["id"], Batch.model_validate({"events": [event()]}))
    with storage.connect(storage.game_path(game["id"])) as connection:
        before = [tuple(row) for row in connection.execute("SELECT * FROM events")]
        connection.execute("DROP TABLE player_group_library")
    with TestClient(create_app(settings, admin=True, access_keys={})) as upgraded:
        path = f"/v1/games/{game['id']}/insights/group-library"
        assert upgraded.get(path, headers=AUTH).json() == []
        item = upgraded.post(path, headers=AUTH, json=saved()).json()
        upgraded.delete(f"{path}/{item['id']}", headers=AUTH)
        upgraded.post(f"{path}/{item['id']}/restore", headers=AUTH)
        with storage.connect(storage.game_path(game["id"])) as connection:
            assert [tuple(row) for row in connection.execute("SELECT * FROM events")] == before


def test_library_members_need_access_to_the_game(team):
    admin, as_user, _ = team
    boss = as_user(ADMIN_EMAIL)
    workspace = admin.get("/v1/me", headers=boss).json()["workspaces"][0]["id"]
    games = [
        admin.post(
            "/v1/games",
            headers=boss,
            json={"name": name, "bundle_id": f"com.example.{name}", "platform": "android"},
        ).json()
        for name in ("allowed", "private")
    ]
    assert (
        admin.post(
            "/v1/team",
            headers=boss,
            json={
                "email": "reviewer@example.com",
                "role": "member",
                "workspace_id": workspace,
                "game_ids": [games[0]["id"]],
            },
        ).status_code
        == 201
    )
    member = as_user("reviewer@example.com")
    path = f"/v1/games/{games[0]['id']}/insights/group-library"
    item = admin.post(path, headers=member, json=saved()).json()
    assert admin.get(path, headers=member).status_code == 200
    private = f"/v1/games/{games[1]['id']}/insights/group-library"
    assert admin.get(private, headers=member).status_code == 404
    assert admin.post(private, headers=member, json=saved()).status_code == 404
    assert admin.put(f"{private}/{item['id']}", headers=member, json=saved()).status_code == 404
    assert admin.delete(f"{private}/{item['id']}", headers=member).status_code == 404
    assert admin.post(f"{private}/{item['id']}/restore", headers=member).status_code == 404
