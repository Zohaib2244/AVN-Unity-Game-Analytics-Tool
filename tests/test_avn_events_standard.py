import io
import json
import re
import zipfile

import pytest
from fastapi.testclient import TestClient
from test_backend import AUDIENCE, AUTH, TEAM_DOMAIN, TOKEN

from avn_analytics import avn_events_standard, stories
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
    spec = avn_events_standard.spec()
    guide = (avn_events_standard.FOLDER / avn_events_standard.GUIDE).read_text()
    assert spec["version"] == 4
    for name, entry in spec["events"].items():
        assert re.fullmatch(r"[A-Z]+(_[A-Z]+)*", name)
        assert entry["tier"] in avn_events_standard.TIERS
        assert entry["states"], name
        assert f"### {name} ({entry['tier']})" in guide
        for state in entry["states"]:
            assert f"`{state}`" in guide, (name, state)
    for mapping in spec["website"]["mappings"]:
        assert mapping["concept"] in stories.CONCEPT_KEYS


def test_level_states_map_themselves_on_the_mappings_page():
    """The standard's LEVEL shape must keep matching what the Mappings page suggests."""
    level = avn_events_standard.spec()["events"]["LEVEL_ANALYSIS"]
    examples = {
        "STATE": list(level["states"]),
        "ACTION": level["states"]["Choice"]["params"]["ACTION"]["enum"],
        "LEVEL_NUMBER": ["3"],
    }
    rules = _suggestions("LEVEL_ANALYSIS", dict.fromkeys(examples, 1), examples, "")
    assert {(rule["action"], rule["param"], rule["value"]) for rule in rules} == {
        ("level_started", "STATE", "Started"),
        ("level_completed", "STATE", "Completed"),
        ("level_failed", "STATE", "Failed"),
        ("level_restarted", "STATE", "Restarted"),
        ("level_restarted", "ACTION", "Restart"),
    }
    assert {rule["number_param"] for rule in rules} == {"LEVEL_NUMBER"}


def test_prompt_always_includes_core_and_fills_in_the_tiers():
    assert avn_events_standard.tiers_for([]) == ["core"]
    assert avn_events_standard.tiers_for(["extended", "standard"]) == [
        "core",
        "standard",
        "extended",
    ]
    text = avn_events_standard.prompt(["extended"])
    assert "Tiers to implement: **core, extended**." in text
    assert "change this line" not in text
    assert not text.startswith("# Prompt")  # only the prompt, not the page around it
    with pytest.raises(ValueError, match="Unknown tier: gold"):
        avn_events_standard.tiers_for(["gold"])


def test_website_lists_events_and_serves_the_setup_files(admin):

    default = admin.get("/v1/events-standard", headers=AUTH).json()
    assert default["tiers"] == ["core", "standard"]
    names = [item["name"] for item in default["events"]]
    assert "LEVEL_ANALYSIS" in names and "SCREEN_ANALYSIS" in names
    assert "DEVICE_ANALYSIS" not in names
    assert "Tiers to implement: **core, standard**." in default["prompt"]

    chosen = admin.get("/v1/events-standard?tiers=extended", headers=AUTH).json()
    assert [item["tier"] for item in chosen["events"]].count("standard") == 0
    assert "DEVICE_ANALYSIS" in [item["name"] for item in chosen["events"]]

    assert admin.get("/v1/events-standard?tiers=gold", headers=AUTH).status_code == 400

    response = admin.get("/v1/events-standard/download?tiers=standard", headers=AUTH)
    assert response.status_code == 200
    assert "avn-events-setup.zip" in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert sorted(archive.namelist()) == sorted(
            [avn_events_standard.PROMPT, avn_events_standard.SPEC, avn_events_standard.GUIDE]
        )
        assert archive.read(avn_events_standard.PROMPT).decode() == avn_events_standard.prompt(
            ["standard"]
        )
        assert (
            archive.read(avn_events_standard.SPEC).decode()
            == (avn_events_standard.FOLDER / avn_events_standard.SPEC).read_text()
        )


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
        spec = json.loads(archive.read(avn_events_standard.SPEC))
        guide = archive.read(avn_events_standard.GUIDE).decode()
    tab = spec["events"]["SHOP"]["states"]["Opened"]["params"]["TAB"]
    assert tab == {"type": "string", "required": True, "enum": ["Coins", "Gems"]}
    assert spec["events"]["SHOP"]["tier"] == "custom" and spec["tiers"]["custom"].startswith("SHOP")
    assert (
        "### SHOP (custom)" in guide and "| `TAB` | string | yes | One of: Coins, Gems. |" in guide
    )
    assert "### LEVEL_ANALYSIS (core)" in guide  # the built-in guide is kept

    # without custom events the downloads are the files, unchanged
    assert admin.delete("/v1/events-standard/custom/SHOP", headers=AUTH).is_success
    assert admin.delete("/v1/events-standard/custom/SHOP", headers=AUTH).status_code == 404
    plain = admin.get("/v1/events-standard/download", headers=AUTH).content
    with zipfile.ZipFile(io.BytesIO(plain)) as archive:
        assert (
            archive.read(avn_events_standard.SPEC).decode()
            == (avn_events_standard.FOLDER / avn_events_standard.SPEC).read_text()
        )


@pytest.mark.parametrize(
    ("name", "change", "message"),
    [
        ("shop", {}, "must be UPPER_SNAKE"),
        ("LEVEL_ANALYSIS", {}, "already exists"),
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
                    event(name="LEVEL_ANALYSIS", params={"STATE": "Started", "LEVEL_NUMBER": 1}),
                    event(name="SHOP", params={"STATE": "Opened", "TAB": "Coins", "COUNT": 3}),
                    event(name="SHOP", params={"STATE": "Opened", "TAB": "Gems"}),
                    event(name="SHOP", params={"STATE": "Closed", "seq": 4, "ratio": 0.5}),
                    event(name="shop_open", params={"source": "menu"}),
                    event(name="session_start", params={}),
                ],
            )
            url = f"/v1/games/{game['id']}/standard"
            result = admin.get(url, headers=AUTH).json()
            assert list(result["sent"]) == ["LEVEL_ANALYSIS"]
            assert result["sent"]["LEVEL_ANALYSIS"]["events"] == 1
            by_name = {item["name"]: item for item in result["unlisted"]}
            assert set(by_name) == {
                "SHOP",
                "shop_open",
            }  # the SDK's session_start is not listed
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


def _versioned_game(tmp_path, extra=()):
    """A game whose 1.0, 1.1 and 1.2 builds sent different events, on different days."""
    from test_backend import event, register, send

    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    admin = TestClient(create_app(settings, admin=True))
    ingest = TestClient(create_app(settings))
    admin.__enter__(), ingest.__enter__()
    game = register(admin)

    def sent(version, day, device, *names, params=None):
        batch = [
            event(
                name=name,
                params=params or {"STATE": "Opened"},
                app_version=version,
                device_id=device,
                client_ts=f"2026-10-{day}T09:00:00Z",
            )
            for name in names
        ]
        assert send(ingest, game, batch).status_code == 200

    sent("1.0", "01", "old-a", "OLD_ONLY", "SHOP", params={"STATE": "Opened", "OLDKEY": "x"})
    sent("1.1", "10", "mid-a", "SHOP", "MID_NEW", params={"STATE": "Opened", "NEWKEY": 3})
    sent("1.2", "20", "new-a", "MID_NEW", "FRESH", "LEVEL_ANALYSIS")
    sent("1.2", "20", "new-b", "FRESH")
    for name, version, day in extra:
        sent(version, day, "extra", name)
    return admin, ingest, game, f"/v1/games/{game['id']}/standard"


def _close(*clients):
    for client in clients:
        client.__exit__(None, None, None)


def test_unlisted_events_can_be_limited_to_an_app_version(tmp_path):
    admin, ingest, game, url = _versioned_game(tmp_path)
    try:
        everything = admin.get(url, headers=AUTH).json()
        assert [item["version"] for item in everything["versions"]] == ["1.2", "1.1", "1.0"]
        assert everything["versions"][0]["players"] == 2
        assert everything["scope"] == [] and everything["older_only"] == []
        by_name = {item["name"]: item for item in everything["unlisted"]}
        assert by_name["SHOP"]["versions"] == ["1.1", "1.0"]  # newest first

        only = admin.get(url, headers=AUTH, params={"version": "1.1"}).json()
        assert only["scope"] == ["1.1"]
        assert {item["name"] for item in only["unlisted"]} == {"SHOP", "MID_NEW"}
        assert {item["name"]: item["events"] for item in only["unlisted"]}["SHOP"] == 1
        assert [item["name"] for item in only["older_only"]] == ["OLD_ONLY"]

        newer = admin.get(url, headers=AUTH, params={"version": "1.1", "newer": True}).json()
        assert newer["scope"] == ["1.2", "1.1"]
        assert {item["name"] for item in newer["unlisted"]} == {"SHOP", "MID_NEW", "FRESH"}
        assert {item["name"]: item["events"] for item in newer["unlisted"]}["MID_NEW"] == 2
        assert [item["name"] for item in newer["older_only"]] == ["OLD_ONLY"]
        assert newer["sent"]["LEVEL_ANALYSIS"]["events"] == 1
        assert (
            "LEVEL_ANALYSIS"
            not in admin.get(url, headers=AUTH, params={"version": "1.1"}).json()["sent"]
        )

        latest = admin.get(url, headers=AUTH, params={"version": "@latest"}).json()
        assert latest["scope"] == ["1.2"]
        assert {item["name"] for item in latest["unlisted"]} == {"MID_NEW", "FRESH"}
        assert {item["name"] for item in latest["older_only"]} == {"OLD_ONLY", "SHOP"}

        missing = admin.get(url, headers=AUTH, params={"version": "9.9"})
        assert missing.status_code == 404
    finally:
        _close(admin, ingest)


def test_the_editor_starts_from_the_chosen_versions_only(tmp_path):
    admin, ingest, game, url = _versioned_game(tmp_path)
    try:

        def shop_params(**query):
            shop = next(
                item
                for item in admin.get(url, headers=AUTH, params=query).json()["unlisted"]
                if item["name"] == "SHOP"
            )
            return {p["key"] for state in shop["states"] for p in state["params"]}

        assert shop_params() == {"OLDKEY", "NEWKEY"}
        assert shop_params(version="1.1") == {"NEWKEY"}
        assert shop_params(version="1.0") == {"OLDKEY"}
    finally:
        _close(admin, ingest)


def test_the_list_cap_applies_after_the_version_filter(tmp_path):
    old = [(f"OLD_{number}", "1.0", "02") for number in range(55)]
    admin, ingest, game, url = _versioned_game(tmp_path, old)
    try:
        everything = admin.get(url, headers=AUTH).json()
        assert len(everything["unlisted"]) == 50 and everything["total_unlisted"] == 59
        latest = admin.get(url, headers=AUTH, params={"version": "@latest"}).json()
        assert latest["total_unlisted"] == 2 and len(latest["unlisted"]) == 2
        assert len(latest["older_only"]) == 57
    finally:
        _close(admin, ingest)


def test_events_without_a_version_group_as_unknown(tmp_path):
    import sqlite3

    from test_backend import event, send

    admin, ingest, game, url = _versioned_game(tmp_path)
    try:
        assert send(ingest, game, [event(name="LOOSE")]).status_code == 200
        (path,) = (tmp_path / "games").glob("*.sqlite3")  # old data can lack the version
        with sqlite3.connect(path) as connection:
            connection.execute(
                "UPDATE events SET payload=json_remove(payload, '$.app_version') WHERE name='LOOSE'"
            )
        result = admin.get(url, headers=AUTH).json()
        assert "unknown" in [item["version"] for item in result["versions"]]
        only = admin.get(url, headers=AUTH, params={"version": "unknown"}).json()
        assert [item["name"] for item in only["unlisted"]] == ["LOOSE"]
    finally:
        _close(admin, ingest)


def test_events_only_older_versions_sent_can_be_ignored_together(tmp_path):
    admin, ingest, game, url = _versioned_game(tmp_path)
    try:
        body = {"version": "1.1", "newer": True}
        assert admin.post(f"{url}/ignore-older", json=body, headers=AUTH).json() == {"ignored": 1}
        result = admin.get(url, headers=AUTH).json()
        assert "OLD_ONLY" not in {item["name"] for item in result["unlisted"]}
        # the Ignored list is not filtered, so it can always be undone
        scoped = admin.get(url, headers=AUTH, params={"version": "1.2"}).json()
        assert [item["name"] for item in scoped["ignored"]] == ["OLD_ONLY"]
        assert admin.delete(f"{url}/ignored/OLD_ONLY", headers=AUTH).status_code == 204
        assert admin.post(f"{url}/ignore-older", json=body, headers=AUTH).json() == {"ignored": 1}
        # nothing to ignore, and an unknown version is refused
        assert admin.post(f"{url}/ignore-older", json=body, headers=AUTH).json() == {"ignored": 0}
        unknown = admin.post(f"{url}/ignore-older", json={"version": "9.9"}, headers=AUTH)
        assert unknown.status_code == 404
    finally:
        _close(admin, ingest)


def test_a_custom_event_can_be_promoted_to_core_and_demoted(admin):
    tier = "/v1/events-standard/custom/SHOP/tier"
    assert admin.put(tier, json={"tier": "core"}, headers=AUTH).status_code == 404
    assert admin.put("/v1/events-standard/custom/SHOP", json=SHOP, headers=AUTH).is_success

    def shown(*tiers):
        query = "&".join(f"tiers={name}" for name in tiers)
        events = admin.get(f"/v1/events-standard?{query}", headers=AUTH).json()["events"]
        return {item["name"]: item["tier"] for item in events}

    assert "SHOP" not in shown("core")  # custom only appears with the custom tier
    assert shown("core", "custom")["SHOP"] == "custom"

    assert admin.put(tier, json={"tier": "core"}, headers=AUTH).json() == {
        "name": "SHOP",
        "tier": "core",
    }
    assert shown("core")["SHOP"] == "core"  # no custom tier needed any more
    listed = admin.get("/v1/events-standard/custom", headers=AUTH).json()
    assert listed[0]["tier"] == "core"
    # the downloads carry it as a core event
    plain = admin.get("/v1/events-standard/download", headers=AUTH).content
    with zipfile.ZipFile(io.BytesIO(plain)) as archive:
        spec = json.loads(archive.read(avn_events_standard.SPEC))
        guide = archive.read(avn_events_standard.GUIDE).decode()
    assert spec["events"]["SHOP"]["tier"] == "core"
    assert "SHOP" in spec["tiers"]["core"] and "custom" not in spec["tiers"]
    assert "### SHOP (core)" in guide

    # editing a promoted event keeps it core
    edited = {**SHOP, "purpose": "Changed"}
    assert admin.put("/v1/events-standard/custom/SHOP", json=edited, headers=AUTH).is_success
    assert shown("core")["SHOP"] == "core"

    assert admin.put(tier, json={"tier": "custom"}, headers=AUTH).is_success
    assert "SHOP" not in shown("core")
    assert admin.put(tier, json={"tier": "extended"}, headers=AUTH).status_code == 400

    # promoted or not, it can still be removed
    assert admin.put(tier, json={"tier": "core"}, headers=AUTH).is_success
    assert admin.delete("/v1/events-standard/custom/SHOP", headers=AUTH).is_success
    assert "SHOP" not in shown("core", "custom")


def test_promoting_needs_an_admin(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        access_team_domain=TEAM_DOMAIN,
        access_audience=AUDIENCE,
        lan_admin=False,
    )
    with TestClient(create_app(settings, admin=True, access_keys={})) as client:
        assert (
            client.put("/v1/events-standard/custom/SHOP/tier", json={"tier": "core"}).status_code
            == 401
        )
