import io
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
