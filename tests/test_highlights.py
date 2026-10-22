"""Saved highlights persist per game and use the shared validated condition vocabulary."""

from dataclasses import replace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from test_backend import ADMIN_EMAIL, AUTH, TOKEN, event, register
from test_backend import team as team

from avn_analytics import highlights
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


def rule(name="Shown interstitials"):
    return {
        "name": name,
        "color": "gold",
        "conditions": {
            "match": "all",
            "conditions": [
                {"field": "event", "op": "eq", "value": "AD_ANALYSIS"},
                {"field": "param", "param": "AD_TYPE", "op": "eq", "value": "interstitial"},
                {"field": "param", "param": "STAGE", "op": "eq", "value": "shown"},
            ],
        },
    }


def test_saved_highlights_persist_update_and_stay_with_their_game(backend):
    admin, settings = backend
    game = register(admin)
    other = register(admin, "com.avn.other")
    path = f"/v1/games/{game['id']}/insights/highlights"
    other_path = f"/v1/games/{other['id']}/insights/highlights"
    assert admin.get(path).status_code == 401
    assert admin.get(path, headers=AUTH).json() == []
    response = admin.post(path, headers=AUTH, json=rule())
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved["conditions"]["conditions"][2]["value"] == "shown"
    assert admin.get(other_path, headers=AUTH).json() == []
    assert admin.post(path, headers=AUTH, json=rule("SHOWN INTERSTITIALS")).status_code == 409
    item = f"{path}/{saved['id']}"
    assert admin.put(item, headers=AUTH, json={**rule(), "color": "cyan"}).status_code == 200
    with TestClient(create_app(replace(settings), admin=True, access_keys={})) as restarted:
        assert restarted.get(path, headers=AUTH).json()[0]["color"] == "cyan"
        assert restarted.get(path, headers=AUTH).json()[0]["id"] == saved["id"]
    assert admin.put(f"{other_path}/{saved['id']}", headers=AUTH, json=rule()).status_code == 404
    assert admin.delete(f"{other_path}/{saved['id']}", headers=AUTH).status_code == 404
    assert admin.delete(item, headers=AUTH).status_code == 204
    assert admin.delete(item, headers=AUTH).status_code == 404
    assert admin.put(item, headers=AUTH, json=rule()).status_code == 404
    assert admin.get(path, headers=AUTH).json() == []


@pytest.mark.parametrize(
    "changes",
    [
        {"name": " "},
        {"name": "a" * 81},
        {"color": "not-a-color"},
        {"conditions": {"match": "all", "conditions": []}},
        {"conditions": {"conditions": [{"field": "param", "param": "", "value": "x"}]}},
    ],
)
def test_saved_highlights_reject_incomplete_rules(backend, changes):
    admin, _ = backend
    game = register(admin)
    path = f"/v1/games/{game['id']}/insights/highlights"
    assert admin.post(path, headers=AUTH, json={**rule(), **changes}).status_code in (400, 422)
    assert admin.get(path, headers=AUTH).json() == []


def test_saved_highlights_are_bounded_and_unknown_games_are_refused(backend, monkeypatch):
    admin, _ = backend
    game = register(admin)
    path = f"/v1/games/{game['id']}/insights/highlights"
    monkeypatch.setattr(highlights, "MAX_SAVED_HIGHLIGHTS", 1)
    saved = admin.post(path, headers=AUTH, json=rule()).json()
    assert admin.post(path, headers=AUTH, json=rule("Another")).status_code == 400
    assert admin.put(f"{path}/{saved['id']}", headers=AUTH, json=rule("Renamed")).status_code == 200
    unknown = f"/v1/games/{uuid4()}/insights/highlights"
    assert admin.get(unknown, headers=AUTH).status_code == 404
    assert admin.post(unknown, headers=AUTH, json=rule()).status_code == 404


def test_adding_saved_highlights_to_an_existing_game_preserves_events(backend):
    admin, settings = backend
    game = register(admin)
    storage = admin.app.state.storage
    storage.ingest(game["id"], Batch.model_validate({"events": [event()]}))
    with storage.connect(storage.game_path(game["id"])) as connection:
        before = [tuple(row) for row in connection.execute("SELECT * FROM events")]
        connection.execute("DROP TABLE highlight_rules")  # simulate a game from the old schema
    with TestClient(create_app(settings, admin=True, access_keys={})) as upgraded:
        path = f"/v1/games/{game['id']}/insights/highlights"
        assert upgraded.get(path, headers=AUTH).json() == []
        assert upgraded.post(path, headers=AUTH, json=rule()).status_code == 201
        with storage.connect(storage.game_path(game["id"])) as connection:
            assert [tuple(row) for row in connection.execute("SELECT * FROM events")] == before


def test_saved_highlights_require_access_to_the_game(team):
    admin, as_user, _ = team
    boss = as_user(ADMIN_EMAIL)
    workspace = admin.get("/v1/me", headers=boss).json()["workspaces"][0]["id"]
    games = []
    for suffix in ("allowed", "private"):
        games.append(
            admin.post(
                "/v1/games",
                headers=boss,
                json={"name": suffix, "bundle_id": f"com.example.{suffix}", "platform": "android"},
            ).json()
        )
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
    path = f"/v1/games/{games[0]['id']}/insights/highlights"
    saved = admin.post(path, headers=member, json=rule())
    assert saved.status_code == 201, saved.text
    private = f"/v1/games/{games[1]['id']}/insights/highlights"
    assert admin.get(private, headers=member).status_code == 404
    assert admin.post(private, headers=member, json=rule()).status_code == 404
    assert (
        admin.put(f"{private}/{saved.json()['id']}", headers=member, json=rule()).status_code == 404
    )
    assert admin.delete(f"{private}/{saved.json()['id']}", headers=member).status_code == 404
