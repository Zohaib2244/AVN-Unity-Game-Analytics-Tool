import copy

import pytest
from fastapi.testclient import TestClient
from test_backend import TOKEN, event, export, register, send, unpack

from avn_analytics.api import create_app
from avn_analytics.config import Settings


@pytest.fixture
def backend(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        with TestClient(create_app(settings)) as ingest:
            yield admin, ingest, settings


def _game(backend):
    admin, ingest, _ = backend
    game = register(admin)
    send(
        ingest,
        game,
        [
            event(params={"level": 3, "mode": "easy"}),
            event(name="shop_open", params={"source": "menu"}),
            event(name="session_start", params={"environment": "production"}),
        ],
    )
    return admin, game, f"/v1/games/{game['id']}/dictionary"


def _prepare(admin, url, **options):
    response = admin.post(f"{url}/import/prepare", json={"options": options})
    assert response.status_code == 200, response.text
    return response.json()


def _fill(file, **by_event):
    """Set `proposed` fields for events: name=dict(description=..., params={...})."""
    file = copy.deepcopy(file)
    for name, proposed in by_event.items():
        entry = file["events"].setdefault(name, {"proposed": {}})
        entry["proposed"] = {
            **entry["proposed"],
            "confidence": "certain",
            "source": "Assets/Game.cs:10",
            **proposed,
        }
    return file


def _run(admin, url, file, **extra):
    return admin.post(f"{url}/import", json={"file": file, **extra})


def _apply(admin, url, file, **extra):
    preview = _run(admin, url, file, **extra)
    assert preview.status_code == 200, preview.text
    applied = _run(admin, url, file, preview=preview.json()["preview"], **extra)
    assert applied.status_code == 200, applied.text
    return applied.json()


def test_template_lists_what_needs_a_meaning_and_the_prompt_states_the_rules(backend):
    admin, game, url = _game(backend)
    admin.put(f"{url}/shop_open", json={"description": "Opened the shop", "params": {}})
    out = _prepare(admin, url, mode="fill_blanks", style={"max_description_chars": 120})
    file = out["file"]
    assert file["format"] == "avn-events/1" and file["game"] == game["id"]
    assert set(file["events"]) == {"level_complete", "shop_open"}  # session_start is SDK
    level = file["events"]["level_complete"]
    assert level["status"] == "undocumented"
    assert level["proposed"]["params"] == {"level": None, "mode": None}
    assert level["observed"]["params"]["level"]["types"] == ["number"]
    assert "examples" not in str(level["observed"])  # player values never go into the file
    shop = file["events"]["shop_open"]
    assert shop["status"] == "partial" and shop["proposed"]["params"] == {"source": None}
    assert "120 characters" in out["prompt"] and "avn-events.json" in out["prompt"]
    assert "AVNGameAnalytics.LogEvent(" in out["prompt"]
    assert "AvnSender.Send(" in out["prompt"]
    assert "http" not in out["prompt"]  # no hostnames in the shipped prompt


def test_template_scope_and_prompt_follow_the_options(backend):
    admin, _, url = _game(backend)
    listed = _prepare(admin, url, scope={"events": "listed", "prefixes": ["shop_"]})
    assert set(listed["file"]["events"]) == {"shop_open"}
    only_description = _prepare(admin, url, fields=["description"])
    proposed = only_description["file"]["events"]["level_complete"]["proposed"]
    assert "params" not in proposed and "description" in proposed
    assert "Fill only `description`" in only_description["prompt"]
    admin.put(f"{url}/level_complete", json={"description": "Done", "params": {"level": "n"}})
    admin.put(f"{url}/shop_open", json={"description": "Opened", "params": {"source": "s"}})
    blanks = _prepare(admin, url, mode="fill_blanks")
    assert set(blanks["file"]["events"]) == {"level_complete"}  # only `mode` is left blank
    assert blanks["file"]["events"]["level_complete"]["proposed"]["params"] == {"mode": None}
    everything = _prepare(admin, url, mode="overwrite_all", scope={"events": "all"})
    assert set(everything["file"]["events"]) == {"level_complete", "shop_open"}
    context = _prepare(admin, url, style={"game_context": "A match-3 puzzle game."})
    assert "A match-3 puzzle game." in context["prompt"]
    hidden = _prepare(admin, url, code={"exclude_paths": ["Plugins/"], "call_patterns": ["Track("]})
    assert "`Plugins/`" in hidden["prompt"] and "`Track(`" in hidden["prompt"]


def test_dry_run_writes_nothing_and_apply_needs_the_matching_preview(backend):
    admin, _, url = _game(backend)
    file = _fill(
        _prepare(admin, url)["file"],
        level_complete={"description": "Player finished a level", "params": {"level": "Level no."}},
    )
    preview = _run(admin, url, file)
    assert preview.status_code == 200
    body = preview.json()
    assert body["applied"] is False and body["summary"]["fields_changed"] == 2
    assert admin.get(url).json() == {}  # nothing stored by a dry run
    # a wrong preview token is refused and still writes nothing
    wrong = _run(admin, url, file, preview="0" * 64)
    assert wrong.status_code == 409 and admin.get(url).json() == {}
    # a changed file no longer matches its preview
    changed = _fill(file, level_complete={"description": "Something else"})
    assert _run(admin, url, changed, preview=body["preview"]).status_code == 409
    done = _run(admin, url, file, preview=body["preview"])
    assert done.status_code == 200 and done.json()["applied"] is True
    stored = admin.get(url).json()["level_complete"]
    assert stored["description"] == "Player finished a level"
    assert stored["params"] == {"level": "Level no."}
    # the same preview cannot be replayed once the dictionary has moved on
    assert _run(admin, url, file, preview=body["preview"]).status_code == 409


def test_import_keeps_everything_it_was_not_asked_to_touch(backend):
    admin, _, url = _game(backend)
    mapping = {"action": "level_completed", "param": "mode", "op": "eq", "value": "easy"}
    assert (
        admin.put(
            f"{url}/level_complete",
            json={"labels": "level => Done {level}", "hidden": True, "canonical": [mapping]},
        ).status_code
        == 200
    )
    file = _prepare(admin, url, scope={"events": "all", "include_hidden": True})["file"]
    _apply(admin, url, _fill(file, level_complete={"description": "Finished a level"}))
    stored = admin.get(url).json()["level_complete"]
    assert stored["description"] == "Finished a level"
    assert stored["labels"] == "level => Done {level}" and stored["hidden"] is True
    assert stored["canonical"][0]["action"] == "level_completed"


def test_fill_blanks_never_replaces_text_but_overwrite_modes_do(backend):
    admin, _, url = _game(backend)
    admin.put(
        f"{url}/level_complete",
        json={"description": "Written by a person", "params": {"level": "Human text"}},
    )
    scope = {"events": "all"}
    file = _fill(
        _prepare(admin, url, mode="overwrite_all", scope=scope)["file"],
        level_complete={"description": "Agent text", "params": {"level": "Agent", "mode": "Mode"}},
    )
    blanks = _run(admin, url, file, options={"mode": "fill_blanks", "scope": scope}).json()
    fields = {change["field"]: change["kind"] for change in blanks["changes"]}
    assert fields == {"param:mode": "fill"}
    reasons = {item["reason"] for e in blanks["events"] for item in e["skipped"]}
    assert "already_described" in reasons
    # AI drafts can be replaced, people's text cannot
    _apply(admin, url, file, options={"mode": "fill_blanks", "scope": scope})
    drafts = admin.get(f"{url}/drafts").json()
    assert drafts == {"level_complete": {"param:mode": drafts["level_complete"]["param:mode"]}}
    improved = _fill(
        file,
        level_complete={
            "description": "Agent text",
            "params": {"level": "Agent", "mode": "Better mode text"},
        },
    )
    drafted = _run(
        admin,
        url,
        improved,
        options={"mode": "overwrite_ai_drafts", "scope": scope},
    ).json()
    assert {c["field"]: c["kind"] for c in drafted["changes"]} == {"param:mode": "overwrite_draft"}
    assert drafted["summary"]["overwrites"] == 0
    kept = {
        item["field"]
        for e in drafted["events"]
        for item in e["skipped"]
        if item["reason"] == "written_by_a_person"
    }
    assert kept == {"description", "param:level"}
    everything = _run(admin, url, file, options={"mode": "overwrite_all", "scope": scope}).json()
    assert everything["summary"]["overwrites"] == 2


def test_max_overwrites_blocks_a_big_replacement(backend):
    admin, _, url = _game(backend)
    admin.put(f"{url}/level_complete", json={"description": "Old", "params": {}})
    admin.put(f"{url}/shop_open", json={"description": "Old", "params": {}})
    scope = {"events": "all"}
    file = _fill(
        _prepare(admin, url, mode="overwrite_all", scope=scope)["file"],
        level_complete={"description": "New one"},
        shop_open={"description": "New two"},
    )
    strict = {"mode": "overwrite_all", "scope": scope, "max_overwrites": 1}
    preview = _run(admin, url, file, options=strict).json()
    assert preview["blocked"] and preview["summary"]["overwrites"] == 2
    refused = _run(admin, url, file, options=strict, preview=preview["preview"])
    assert refused.status_code == 409
    assert admin.get(url).json()["level_complete"]["description"] == "Old"
    # excluding one event brings it back under the limit
    excluded = _run(admin, url, file, options=strict, exclude=["shop_open"]).json()
    assert excluded["blocked"] is None and excluded["summary"]["excluded"] == 1


def test_confidence_source_unknowns_and_limits_are_reported_not_written(backend):
    admin, _, url = _game(backend)
    file = _prepare(admin, url)["file"]
    file = _fill(
        file,
        level_complete={"description": "Guess", "confidence": "inferred"},
        shop_open={"description": "No place given", "source": None},
        brand_new={"description": "x" * 400},
        unknown_event={"description": "Maybe", "confidence": "unknown"},
        empty_event={"description": None},
    )
    result = _run(
        admin,
        url,
        file,
        options={"min_confidence": "certain", "style": {"max_description_chars": 200}},
    ).json()
    status = {e["name"]: e["status"] for e in result["events"]}
    assert status["level_complete"] == "skipped"
    assert status["shop_open"] == "skipped"
    assert status["unknown_event"] == "skipped" and status["empty_event"] == "skipped"
    reason = {e["name"]: (e["skipped"] or e["rejected"])[0]["reason"] for e in result["events"]}
    assert reason["level_complete"] == "low_confidence"
    assert reason["shop_open"] == "no_source"
    assert reason["unknown_event"] == "unknown_confidence"
    assert reason["empty_event"] == "no_proposal"
    assert reason["brand_new"] == "too_long"
    assert result["changes"] == []


def test_events_from_code_scope_near_duplicates_and_other_games(backend):
    admin, ingest, _ = backend
    admin_, game, url = _game(backend)
    file = _fill(
        _prepare(admin, url)["file"],
        not_sent_yet={"description": "Added in the next release"},
        LEVEL_COMPLETE={"description": "Looks like level_complete"},
    )
    result = _run(admin, url, file).json()
    by_name = {e["name"]: e for e in result["events"]}
    assert by_name["not_sent_yet"]["origin"] == "code" and by_name["not_sent_yet"]["changes"]
    flag = by_name["LEVEL_COMPLETE"]["flags"][0]
    assert flag["flag"] == "near_duplicate" and flag["similar"] == ["level_complete"]
    rejecting = _run(admin, url, file, options={"near_duplicates": "reject"}).json()
    rejected = {e["name"]: e for e in rejecting["events"]}["LEVEL_COMPLETE"]
    assert rejected["status"] == "rejected" and not rejected["changes"]
    closed = _run(admin, url, file, options={"scope": {"include_not_yet_received": False}}).json()
    assert {e["name"]: e for e in closed["events"]}["not_sent_yet"]["skipped"][0]["reason"] == (
        "not_yet_received"
    )
    # a file prepared for another game is refused outright
    other = register(admin, bundle="com.avn.other")
    assert _run(admin, f"/v1/games/{other['id']}/dictionary", file).status_code == 400


def test_type_flags_and_param_limits(backend):
    admin, ingest, _ = backend
    admin_, game, url = _game(backend)
    send(ingest, game, [event(params={"level": "three", "mode": "easy"})])
    file = _fill(
        _prepare(admin, url)["file"],
        shop_open={
            "params": {"source": "Where the shop was opened from"},
            "param_types": {"source": "number"},
        },
        level_complete={"params": {"level": "Level"}},
    )
    result = _run(admin, url, file).json()
    flags = {(e["name"], flag["flag"]) for e in result["events"] for flag in e["flags"]}
    assert ("level_complete", "type_conflict") in flags
    assert ("shop_open", "type_mismatch") in flags
    quiet = _run(admin, url, file, options={"type_conflicts": "ignore"}).json()
    assert not [flag for e in quiet["events"] for flag in e["flags"]]


def test_invalid_files_are_rejected_before_anything_is_read(backend):
    admin, _, url = _game(backend)
    assert admin.post(f"{url}/import", json={"file": {"format": "other"}}).status_code == 400
    assert (
        admin.post(
            f"{url}/import", json={"file": {"format": "avn-events/1", "events": {"bad name": {}}}}
        ).status_code
        == 400
    )
    assert (
        admin.post(
            f"{url}/import", json={"file": {"format": "avn-events/1", "surprise": True}}
        ).status_code
        == 400
    )


def test_drafts_are_marked_confirmed_by_edit_and_stay_out_of_confirmed_imports(backend):
    admin, game, url = _game(backend)
    file = _fill(
        _prepare(admin, url)["file"],
        level_complete={"description": "Level done", "params": {"level": "Level", "mode": "Mode"}},
    )
    done = _apply(admin, url, file)
    assert done["summary"]["fields_changed"] == 3
    drafts = admin.get(f"{url}/drafts").json()["level_complete"]
    assert set(drafts) == {"description", "param:level", "param:mode"}
    assert drafts["description"]["source"] == "Assets/Game.cs:10"
    assert drafts["description"]["batch_id"] == done["batch_id"]
    # export marks them for downstream analysis agents
    _, _, dictionary = unpack(export(admin, game))
    assert "unconfirmed_ai_draft" in dictionary and "AI agent" in dictionary
    # editing one text confirms only that text
    current = admin.get(url).json()["level_complete"]
    current["params"]["mode"] = "Easy or hard"
    assert admin.put(f"{url}/level_complete", json=current).status_code == 200
    assert set(admin.get(f"{url}/drafts").json()["level_complete"]) == {
        "description",
        "param:level",
    }
    # saving a labels-only change leaves the remaining drafts alone
    current["labels"] = "level => Done"
    admin.put(f"{url}/level_complete", json=current)
    assert len(admin.get(f"{url}/drafts").json()["level_complete"]) == 2
    # explicit confirmation clears the event
    assert admin.post(f"{url}/level_complete/confirm").json() == {"confirmed": 2}
    assert admin.get(f"{url}/drafts").json() == {}
    events = admin.get(
        f"/v1/games/{game['id']}/insights/events",
        params={"start": "2026-10-04", "end": "2026-10-04"},
    ).json()
    assert events["summary"]["drafts"] == 0

    confirmed = _fill(
        _prepare(admin, url, scope={"events": "all"}, status="confirmed")["file"],
        shop_open={"description": "Shop opened"},
    )
    _apply(admin, url, confirmed, options={"status": "confirmed", "scope": {"events": "all"}})
    assert admin.get(f"{url}/drafts").json() == {}
    assert admin.get(url).json()["shop_open"]["description"] == "Shop opened"


def test_events_page_lists_drafts(backend):
    admin, game, url = _game(backend)
    file = _fill(_prepare(admin, url)["file"], shop_open={"description": "Shop opened"})
    _apply(admin, url, file)
    params = {"start": "2026-10-04", "end": "2026-10-04"}
    base = f"/v1/games/{game['id']}/insights/events"
    rows = {row["name"]: row for row in admin.get(base, params=params).json()["events"]}
    assert rows["shop_open"]["drafts"] == ["description"] and rows["level_complete"]["drafts"] == []
    detail = admin.get(f"{base}/detail", params={**params, "name": "shop_open"}).json()
    assert detail["drafts"] == ["description"]


def test_undo_restores_the_dictionary_but_not_later_edits(backend):
    admin, _, url = _game(backend)
    admin.put(
        f"{url}/shop_open",
        json={"description": "", "labels": "source => Opened {source}", "params": {}},
    )
    file = _fill(
        _prepare(admin, url)["file"],
        level_complete={"description": "Level done", "params": {"level": "Level"}},
        shop_open={"description": "Shop opened", "params": {"source": "Where from"}},
    )
    done = _apply(admin, url, file)
    # a person improves one imported text afterwards
    current = admin.get(url).json()["shop_open"]
    current["description"] = "Opened the shop (edited)"
    admin.put(f"{url}/shop_open", json=current)
    history = admin.get(f"{url}/imports").json()
    assert history[0]["id"] == done["batch_id"] and history[0]["undone_at"] is None
    undone = admin.post(f"{url}/imports/{done['batch_id']}/undo")
    assert undone.status_code == 200
    body = undone.json()
    assert body["reverted"] == 3
    assert body["kept"] == [{"name": "shop_open", "field": "description", "reason": "edited_since"}]
    dictionary = admin.get(url).json()
    assert "level_complete" not in dictionary  # created by the import, empty again
    assert dictionary["shop_open"]["description"] == "Opened the shop (edited)"
    assert dictionary["shop_open"]["labels"] == "source => Opened {source}"
    assert dictionary["shop_open"]["params"] == {}
    assert admin.get(f"{url}/drafts").json() == {}
    assert admin.get(f"{url}/imports").json()[0]["undone_at"]
    assert admin.post(f"{url}/imports/{done['batch_id']}/undo").status_code == 409
    missing = "00000000-0000-0000-0000-000000000000"
    assert admin.post(f"{url}/imports/{missing}/undo").status_code == 404


def test_undo_of_an_overwritten_draft_brings_the_draft_back(backend):
    admin, _, url = _game(backend)
    scope = {"events": "all"}
    first = _fill(
        _prepare(admin, url, scope=scope)["file"], shop_open={"description": "First draft"}
    )
    _apply(admin, url, first)
    second = _fill(first, shop_open={"description": "Second draft"})
    options = {"mode": "overwrite_ai_drafts", "scope": scope}
    done = _apply(admin, url, second, options=options)
    assert admin.get(url).json()["shop_open"]["description"] == "Second draft"
    assert admin.post(f"{url}/imports/{done['batch_id']}/undo").status_code == 200
    assert admin.get(url).json()["shop_open"]["description"] == "First draft"
    assert "description" in admin.get(f"{url}/drafts").json()["shop_open"]


def test_deleting_a_definition_drops_its_drafts(backend):
    admin, _, url = _game(backend)
    _apply(admin, url, _fill(_prepare(admin, url)["file"], shop_open={"description": "Shop"}))
    assert admin.delete(f"{url}/shop_open").status_code == 204
    assert admin.get(f"{url}/drafts").json() == {}


def test_prepare_rejects_unknown_options(backend):
    admin, _, url = _game(backend)
    response = admin.post(f"{url}/import/prepare", json={"options": {"mode": "delete_everything"}})
    assert response.status_code == 400


def test_single_texts_can_be_left_out_and_stay_visible(backend):
    admin, _, url = _game(backend)
    file = _fill(
        _prepare(admin, url)["file"],
        level_complete={"description": "Level done", "params": {"level": "Level", "mode": "Mode"}},
        shop_open={"description": "Shop opened"},
    )
    preview = _run(admin, url, file, exclude=["level_complete/param:mode", "shop_open"]).json()
    by_name = {e["name"]: e for e in preview["events"]}
    # left-out texts are still listed, flagged, so the reviewer sees what is being skipped
    listed = {c["field"]: c["excluded"] for c in by_name["level_complete"]["changes"]}
    assert listed == {"description": False, "param:level": False, "param:mode": True}
    assert by_name["shop_open"]["status"] == "excluded"
    assert by_name["shop_open"]["changes"][0]["excluded"] is True
    assert {c["field"] for c in preview["changes"]} == {"description", "param:level"}
    assert preview["summary"]["fields_changed"] == 2 and preview["summary"]["excluded"] == 2
    # exactly that selection is what gets written
    _apply(admin, url, file, exclude=["level_complete/param:mode", "shop_open"])
    stored = admin.get(url).json()
    assert stored["level_complete"]["params"] == {"level": "Level"}
    assert "shop_open" not in stored
    # malformed exclusions are refused
    assert _run(admin, url, file, exclude=["level_complete/labels"]).status_code == 400
