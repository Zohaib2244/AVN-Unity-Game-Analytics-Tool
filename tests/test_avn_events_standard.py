import io
import zipfile

import pytest
from fastapi.testclient import TestClient
from test_backend import AUDIENCE, AUTH, TEAM_DOMAIN, TOKEN, event, register, send

from avn_analytics import avn_events_standard, stories
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.events import _suggestions


@pytest.fixture
def apps(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        with TestClient(create_app(settings)) as ingest:
            yield admin, ingest


def workspace(admin):
    return admin.get("/v1/me", headers=AUTH).json()["workspaces"][0]["id"]


def level(state, number=1, **params):
    return event(name="LEVEL_ANALYSIS", params={"STATE": state, "LEVEL_NUMBER": number, **params})


def test_the_builtin_standard_reads_as_ten_events():
    text = avn_events_standard.builtin()
    assert avn_events_standard.version_of(text) == 5
    events = avn_events_standard.events_of(text)
    assert len(events) == 10
    assert sum(len(item["states"]) for item in events) == 29
    found = {item["name"]: item["states"] for item in events}
    assert found["ECONOMY_ANALYSIS"] == ["Earned", "Spent"]
    assert "Rules" not in found["LEVEL_ANALYSIS"]
    assert "FTUE_ANALYSIS" not in found
    assert all(
        rule["action"] in stories.CONCEPT_KEYS for rule in avn_events_standard.LEVEL_MAPPINGS
    )


def test_the_automatic_level_mappings_match_the_mappings_page_suggestions():
    examples = {
        "STATE": ["Started", "Completed", "Failed", "Restarted", "Choice"],
        "ACTION": ["Next", "Restart", "Home"],
        "LEVEL_NUMBER": ["3"],
    }
    suggested = _suggestions("LEVEL_ANALYSIS", dict.fromkeys(examples, 1), examples, "")
    pick = ("action", "param", "op", "value", "number_param")
    assert {tuple(rule[key] for key in pick) for rule in suggested} == {
        tuple(rule[key] for key in pick) for rule in avn_events_standard.LEVEL_MAPPINGS
    }


def test_the_prompt_is_for_the_markdown_standard():
    text = avn_events_standard.prompt()
    assert "avn_events_standard.md" in text
    assert ".json" not in text.split("avn-events-profile.json")[0]
    assert "FTUE" not in text and "Tiers to implement" not in text


def test_a_workspace_downloads_uploads_and_resets_its_standard(apps):
    admin, _ = apps
    base = f"/v1/workspaces/{workspace(admin)}/standard"
    builtin = admin.get(base, headers=AUTH).json()
    assert (builtin["version"], builtin["source"]) == (5, "builtin")
    assert len(builtin["events"]) == 10

    response = admin.get(f"{base}/download", headers=AUTH)
    assert "avn-events-setup.zip" in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert sorted(archive.namelist()) == ["AGENT_PROMPT.md", "avn_events_standard.md"]
        assert archive.read("avn_events_standard.md").decode() == avn_events_standard.builtin()

    mine = (
        "# AVN events standard — version 6\n\n# LEVEL_ANALYSIS\n\n### Started\n\n# SHOP_ANALYSIS\n"
    )
    saved = admin.put(base, headers=AUTH, content=mine.encode()).json()
    assert (saved["version"], saved["source"]) == (6, "uploaded")
    assert [item["name"] for item in saved["events"]] == ["LEVEL_ANALYSIS", "SHOP_ANALYSIS"]
    with zipfile.ZipFile(io.BytesIO(admin.get(f"{base}/download", headers=AUTH).content)) as zf:
        assert zf.read("avn_events_standard.md").decode() == mine

    for bad, message in (
        (b"no heading at all", "version"),
        (b"# AVN events standard version 7\n\nnothing here", "No events"),
        (b"\xff\xfe# x", "UTF-8"),
    ):
        refused = admin.put(base, headers=AUTH, content=bad)
        assert refused.status_code == 422 and message in refused.json()["detail"]
    assert admin.get(base, headers=AUTH).json()["version"] == 6  # a refused file changes nothing

    assert admin.delete(base, headers=AUTH).json()["source"] == "builtin"
    actions = [row["action"] for row in admin.get("/v1/audit", headers=AUTH).json()]
    assert "standard.upload" in actions and "standard.reset" in actions


def test_a_game_on_an_older_standard_is_told_to_update(apps):
    admin, ingest = apps
    game = register(admin)
    path = f"/v1/games/{game['id']}/standard"
    assert admin.get(path, headers=AUTH).json() == {
        "game_version": None,
        "workspace_version": 5,
        "outdated": False,
    }
    batch = {"context": {"standard": "avn-events", "standard_version": 4}, "events": [event()]}
    ingest.post("/v1/events", headers={"X-API-Key": game["key"]["api_key"]}, json=batch)
    assert admin.get(path, headers=AUTH).json()["outdated"] is True
    batch["context"]["standard_version"] = 5
    batch["events"] = [event()]
    ingest.post("/v1/events", headers={"X-API-Key": game["key"]["api_key"]}, json=batch)
    assert admin.get(path, headers=AUTH).json()["outdated"] is False


def test_a_standard_game_gets_its_level_mappings_by_itself(apps):
    admin, ingest = apps
    game = register(admin)
    assert send(ingest, game, [level("Started"), level("Completed")]).status_code == 200
    dictionary = admin.get(f"/v1/games/{game['id']}/dictionary", headers=AUTH).json()
    rules = dictionary["LEVEL_ANALYSIS"]["canonical"]
    assert [(rule["action"], rule["value"]) for rule in rules] == [
        ("level_started", "Started"),
        ("level_completed", "Completed"),
        ("level_failed", "Failed"),
        ("level_restarted", "Restarted"),
        ("level_restarted", "Restart"),
    ]
    days = {"start": "2026-10-04", "end": "2026-10-04"}
    levels = admin.get(f"/v1/games/{game['id']}/insights/levels", headers=AUTH, params=days)
    first = levels.json()["levels"][0]
    assert (first["level"], first["started"], first["completed"]) == (1, 1, 1)


def test_level_mappings_the_team_made_or_removed_are_left_alone(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        with TestClient(create_app(settings)) as ingest:
            mapped = register(admin, "com.avn.mapped")
            rule = {"action": "level_started", "param": "", "number_param": "lvl"}
            admin.put(
                f"/v1/games/{mapped['id']}/dictionary/level_go",
                headers=AUTH,
                json={"canonical": [rule]},
            )
            send(ingest, mapped, [level("Started")])
            fresh = register(admin, "com.avn.fresh")
            send(ingest, fresh, [level("Started")])
            admin.delete(f"/v1/games/{fresh['id']}/dictionary/LEVEL_ANALYSIS", headers=AUTH)
    with TestClient(create_app(settings, admin=True)) as admin:  # a restarted server
        with TestClient(create_app(settings)) as ingest:
            send(ingest, fresh, [level("Completed")])
            for game in (mapped, fresh):
                dictionary = admin.get(f"/v1/games/{game['id']}/dictionary", headers=AUTH).json()
                assert "LEVEL_ANALYSIS" not in dictionary, game["bundle_id"]


def test_the_standard_needs_a_sign_in_and_a_lead_to_change(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        access_team_domain=TEAM_DOMAIN,
        access_audience=AUDIENCE,
        lan_admin=False,
    )
    with TestClient(create_app(settings, admin=True, access_keys={})) as client:
        work = workspace(client)
        assert client.get(f"/v1/workspaces/{work}/standard").status_code == 401
        assert client.get(f"/v1/workspaces/{work}/standard/download").status_code == 401
        assert client.put(f"/v1/workspaces/{work}/standard", content=b"x").status_code == 401
        assert client.get(f"/v1/workspaces/{work}/standard", headers=AUTH).status_code == 200
