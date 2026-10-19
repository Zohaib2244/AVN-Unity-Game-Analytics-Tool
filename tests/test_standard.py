import io
import json
import re
import zipfile

import pytest
from fastapi.testclient import TestClient
from test_backend import AUDIENCE, AUTH, TEAM_DOMAIN, TOKEN

from avn_analytics import standard, stories
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.events import _suggestions


@pytest.fixture
def admin(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path, admin_token=TOKEN), admin=True)
    ) as client:
        yield client


def test_spec_is_complete_and_matches_the_guide():
    spec = standard.spec()
    guide = (standard.FOLDER / standard.GUIDE).read_text()
    assert spec["version"] == 3
    for name, entry in spec["events"].items():
        assert re.fullmatch(r"[A-Z]+(_[A-Z]+)*", name)
        assert entry["tier"] in standard.TIERS
        assert entry["states"], name
        assert f"### {name} ({entry['tier']})" in guide
        for state in entry["states"]:
            assert f"`{state}`" in guide, (name, state)
    for mapping in spec["website"]["mappings"]:
        assert mapping["concept"] in stories.CONCEPT_KEYS


def test_level_states_map_themselves_on_the_mappings_page():
    """The standard's LEVEL shape must keep matching what the Mappings page suggests."""
    level = standard.spec()["events"]["LEVEL"]
    examples = {
        "STATE": list(level["states"]),
        "ACTION": level["states"]["Choice"]["params"]["ACTION"]["enum"],
        "LEVEL_NUMBER": ["3"],
    }
    rules = _suggestions("LEVEL", dict.fromkeys(examples, 1), examples, "")
    assert {(rule["action"], rule["param"], rule["value"]) for rule in rules} == {
        ("level_started", "STATE", "Started"),
        ("level_completed", "STATE", "Completed"),
        ("level_failed", "STATE", "Failed"),
        ("level_restarted", "STATE", "Restarted"),
        ("level_restarted", "ACTION", "Restart"),
    }
    assert {rule["number_param"] for rule in rules} == {"LEVEL_NUMBER"}


def test_prompt_always_includes_core_and_fills_in_the_tiers():
    assert standard.tiers_for([]) == ["core"]
    assert standard.tiers_for(["extended", "standard"]) == ["core", "standard", "extended"]
    text = standard.prompt(["extended"])
    assert "Tiers to implement: **core, extended**." in text
    assert "change this line" not in text
    assert not text.startswith("# Prompt")  # only the prompt, not the page around it
    with pytest.raises(ValueError, match="Unknown tier: gold"):
        standard.tiers_for(["gold"])


def test_website_lists_events_and_serves_the_setup_files(admin):

    default = admin.get("/v1/events-standard", headers=AUTH).json()
    assert default["tiers"] == ["core", "standard"]
    names = [item["name"] for item in default["events"]]
    assert "LEVEL" in names and "SCREEN" in names and "DEVICE" not in names
    assert "Tiers to implement: **core, standard**." in default["prompt"]

    chosen = admin.get("/v1/events-standard?tiers=extended", headers=AUTH).json()
    assert [item["tier"] for item in chosen["events"]].count("standard") == 0
    assert "DEVICE" in [item["name"] for item in chosen["events"]]

    assert admin.get("/v1/events-standard?tiers=gold", headers=AUTH).status_code == 400

    response = admin.get("/v1/events-standard/download?tiers=standard", headers=AUTH)
    assert response.status_code == 200
    assert "avn-events-setup.zip" in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert sorted(archive.namelist()) == sorted(
            [standard.PROMPT, standard.SPEC, standard.GUIDE]
        )
        assert archive.read(standard.PROMPT).decode() == standard.prompt(["standard"])
        assert archive.read(standard.SPEC).decode() == (standard.FOLDER / standard.SPEC).read_text()


def test_setup_files_need_a_sign_in(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        access_team_domain=TEAM_DOMAIN,
        access_audience=AUDIENCE,
        lan_admin=False,
    )
    with TestClient(create_app(settings, admin=True, access_keys={})) as client:
        assert client.get("/v1/events-standard").status_code == 401
        assert client.get("/v1/events-standard/download").status_code == 401
        assert client.get("/v1/events-standard", headers=AUTH).status_code == 200


SHOP = {
    "purpose": "The player opens the shop.",
    "states": [
        {
            "name": "Opened",
            "trigger": "The shop screen appears.",
            "params": [
                {"key": "TAB", "type": "string", "required": True, "values": ["Coins", "Gems"]},
                {"key": "ITEMS_SHOWN", "type": "int", "note": "How many offers."},
            ],
        },
        {"name": "Closed", "trigger": "", "params": []},
    ],
}


def test_custom_events_join_the_standard_and_the_downloads(admin):
    assert admin.get("/v1/events-standard/custom", headers=AUTH).json() == []
    assert admin.put("/v1/events-standard/custom/SHOP", json=SHOP, headers=AUTH).is_success
    listed = admin.get("/v1/events-standard/custom", headers=AUTH).json()
    assert [item["name"] for item in listed] == ["SHOP"]

    chosen = admin.get("/v1/events-standard?tiers=custom", headers=AUTH).json()
    assert chosen["tiers"] == ["core", "custom"]
    assert {"name": "SHOP", "tier": "custom", "states": ["Opened", "Closed"]} in chosen["events"]
    assert "core, custom" in chosen["prompt"]

    bundle = admin.get("/v1/events-standard/download?tiers=custom", headers=AUTH).content
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        spec = json.loads(archive.read(standard.SPEC))
        guide = archive.read(standard.GUIDE).decode()
    tab = spec["events"]["SHOP"]["states"]["Opened"]["params"]["TAB"]
    assert tab == {"type": "string", "required": True, "enum": ["Coins", "Gems"]}
    assert spec["events"]["SHOP"]["tier"] == "custom" and spec["tiers"]["custom"].startswith("SHOP")
    assert (
        "### SHOP (custom)" in guide and "| `TAB` | string | yes | One of: Coins, Gems. |" in guide
    )
    assert "### LEVEL (core)" in guide  # the built-in guide is kept

    # without custom events the downloads are the files, unchanged
    assert admin.delete("/v1/events-standard/custom/SHOP", headers=AUTH).is_success
    assert admin.delete("/v1/events-standard/custom/SHOP", headers=AUTH).status_code == 404
    plain = admin.get("/v1/events-standard/download", headers=AUTH).content
    with zipfile.ZipFile(io.BytesIO(plain)) as archive:
        assert archive.read(standard.SPEC).decode() == (standard.FOLDER / standard.SPEC).read_text()


@pytest.mark.parametrize(
    ("name", "change", "message"),
    [
        ("shop", {}, "must be UPPER_SNAKE"),
        ("LEVEL", {}, "already exists"),
        ("SHOP", {"states": [{"name": "opened", "params": []}]}, "must be PascalCase"),
        (
            "SHOP",
            {"states": [{"name": "Opened", "params": []}, {"name": "Opened", "params": []}]},
            "state Opened twice",
        ),
        (
            "SHOP",
            {"states": [{"name": "Opened", "params": [{"key": "tab", "type": "int"}]}]},
            "must be UPPER_SNAKE",
        ),
        (
            "SHOP",
            {"states": [{"name": "Opened", "params": [{"key": "STATE", "type": "int"}]}]},
            "added to every event",
        ),
        (
            "SHOP",
            {
                "states": [
                    {"name": "Opened", "params": [{"key": "A", "type": "int", "values": ["x"]}]}
                ]
            },
            "type must be string",
        ),
        (
            "SHOP",
            {
                "states": [
                    {
                        "name": "Opened",
                        "params": [{"key": "A", "type": "string", "values": ["x", "x"]}],
                    }
                ]
            },
            "unique and not empty",
        ),
    ],
)
def test_custom_events_follow_the_standards_naming_rules(admin, name, change, message):
    response = admin.put(
        f"/v1/events-standard/custom/{name}", json={**SHOP, **change}, headers=AUTH
    )
    assert response.status_code == 422
    assert message in str(response.json())
    assert admin.get("/v1/events-standard/custom", headers=AUTH).json() == []


def test_only_the_admin_changes_the_standard(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        access_team_domain=TEAM_DOMAIN,
        access_audience=AUDIENCE,
        lan_admin=False,
    )
    with TestClient(create_app(settings, admin=True, access_keys={})) as client:
        assert client.put("/v1/events-standard/custom/SHOP", json=SHOP).status_code == 401
        assert client.delete("/v1/events-standard/custom/SHOP").status_code == 401


def test_events_a_game_sends_outside_the_standard_can_be_added_or_ignored(tmp_path):
    from test_backend import event, register, send

    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        with TestClient(create_app(settings)) as ingest:
            game = register(admin)
            send(
                ingest,
                game,
                [
                    event(name="LEVEL", params={"STATE": "Started", "LEVEL_NUMBER": 1}),
                    event(name="SHOP", params={"STATE": "Opened", "TAB": "Coins", "COUNT": 3}),
                    event(name="SHOP", params={"STATE": "Opened", "TAB": "Gems"}),
                    event(name="SHOP", params={"STATE": "Closed", "seq": 4, "ratio": 0.5}),
                    event(name="shop_open", params={"source": "menu"}),
                    event(name="session_start", params={}),
                ],
            )
            url = f"/v1/games/{game['id']}/standard"
            result = admin.get(url, headers=AUTH).json()
            assert list(result["sent"]) == ["LEVEL"]
            assert result["sent"]["LEVEL"]["events"] == 1
            by_name = {item["name"]: item for item in result["unlisted"]}
            assert set(by_name) == {"SHOP", "shop_open"}  # the SDK's session_start is not listed
            assert (
                by_name["shop_open"]["valid_name"] is False and by_name["shop_open"]["states"] == []
            )
            shop = by_name["SHOP"]
            assert shop["valid_name"] and shop["events"] == 3 and shop["players"] == 1
            states = {state["name"]: state for state in shop["states"]}
            assert states["Opened"]["params"] == [
                {"key": "COUNT", "type": "int", "required": False},
                {"key": "TAB", "type": "string", "required": True},
            ]
            assert shop["skipped"] == ["ratio"]  # lowercase keys can't join the standard

            # ignoring is per game and can be undone
            assert admin.put(f"{url}/ignored/SHOP", headers=AUTH).status_code == 204
            result = admin.get(url, headers=AUTH).json()
            assert [item["name"] for item in result["unlisted"]] == ["shop_open"]
            assert result["ignored"] == [{"name": "SHOP", "events": 3}]
            assert admin.delete(f"{url}/ignored/SHOP", headers=AUTH).status_code == 204
            assert len(admin.get(url, headers=AUTH).json()["unlisted"]) == 2

            # adding it to the standard moves it from "not in the standard" to "sent"
            body = {
                "purpose": "Shop screen",
                "states": [{"name": "Opened", "trigger": "", "params": []}],
            }
            assert admin.put("/v1/events-standard/custom/SHOP", json=body, headers=AUTH).is_success
            result = admin.get(url, headers=AUTH).json()
            assert result["sent"]["SHOP"]["events"] == 3
            assert [item["name"] for item in result["unlisted"]] == ["shop_open"]
