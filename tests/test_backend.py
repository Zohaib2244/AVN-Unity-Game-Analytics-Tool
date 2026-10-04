import gzip
import io
import json
import sqlite3
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, date, datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from avn_analytics.api import BodyLimit, create_app
from avn_analytics.config import Settings
from avn_analytics.exports import period_bounds
from avn_analytics.models import Batch

TOKEN = "test-admin-token-" + "x" * 40
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def backend(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        with TestClient(create_app(settings)) as ingest:
            yield admin, ingest, settings


def register(admin, bundle="com.avn.test"):
    response = admin.post(
        "/v1/games",
        headers=AUTH,
        json={
            "name": "Test Game",
            "bundle_id": bundle,
            "platform": "android",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def event(**overrides):
    return {
        "event_id": str(uuid4()),
        "name": "level_complete",
        "params": {"level": 1, "mode": "easy"},
        "device_id": "anonymous-install-id",
        "session_id": "session-1",
        "app_version": "1.0",
        "build": "1",
        "platform": "android",
        "client_ts": "2026-10-04T09:00:00Z",
        **overrides,
    }


def send(ingest, game, events):
    return ingest.post(
        "/v1/events", headers={"X-API-Key": game["key"]["api_key"]}, json={"events": events}
    )


def export(admin, game, **params):
    return admin.get(
        f"/v1/games/{game['id']}/export",
        headers=AUTH,
        params={
            "date": "2026-10-04",
            "basis": "client_ts",
            **params,
        },
    )


def unpack(response):
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        rows = [
            json.loads(line)
            for line in gzip.decompress(archive.read("events.jsonl.gz")).splitlines()
        ]
        return rows, json.loads(archive.read("manifest.json")), archive.read("events.md").decode()


def test_admin_separation_and_no_login(backend):
    admin, ingest, _ = backend
    assert admin.get("/v1/games").status_code == 200
    assert admin.get("/healthz").status_code == 200
    assert admin.get("/v1/games", headers=AUTH).status_code == 200
    assert ingest.get("/v1/games", headers=AUTH).status_code == 404
    assert ingest.get("/openapi.json").status_code == 404
    assert ingest.get("/healthz").status_code == 200
    assert admin.post("/v1/events", headers=AUTH, json={}).status_code == 404


def test_admin_requires_strong_token(tmp_path):
    with pytest.raises(ValueError, match="AVN_ADMIN_TOKEN"):
        create_app(Settings(data_dir=tmp_path), admin=True)


def test_rejects_unpatched_sqlite(tmp_path, monkeypatch):
    monkeypatch.setattr("avn_analytics.storage.sqlite3.sqlite_version_info", (3, 51, 2))
    with pytest.raises(RuntimeError, match="WAL-reset"):
        with TestClient(create_app(Settings(data_dir=tmp_path))):
            pass


def test_registration_uniqueness_and_hashed_keys(backend):
    admin, _, settings = backend
    game = register(admin)
    response = admin.post(
        "/v1/games",
        headers=AUTH,
        json={
            "name": "Duplicate",
            "bundle_id": "com.avn.test",
            "platform": "android",
        },
    )
    assert response.status_code == 409
    assert len(list((settings.data_dir / "games").glob("*.sqlite3"))) == 1
    connection = sqlite3.connect(settings.data_dir / "registry.sqlite3")
    try:
        dump = "\n".join(connection.iterdump())
        assert game["key"]["api_key"] not in dump
    finally:
        connection.close()
    assert game["key"]["api_key"] not in admin.get("/v1/games", headers=AUTH).text


def test_deduplication_isolation_and_export(backend):
    admin, ingest, _ = backend
    first = register(admin)
    second = register(admin, "com.avn.second")
    payload = event()
    response = send(ingest, first, [payload, payload])
    assert response.status_code == 200
    assert response.json()["accepted"] == 1
    assert response.json()["duplicates"] == 1
    repeated = send(ingest, first, [payload]).json()
    assert repeated["accepted"] == 0
    assert repeated["duplicates"] == 1
    assert send(ingest, second, [payload]).json()["accepted"] == 1
    rows, manifest, dictionary = unpack(export(admin, first))
    assert len(rows) == manifest["event_count"] == 1
    assert rows[0]["server_ts"] == response.json()["server_ts"]
    assert "UNDOCUMENTED" in dictionary
    assert "level" in dictionary


def test_key_rotation_and_revocation(backend):
    admin, ingest, _ = backend
    game = register(admin)
    response = admin.post(f"/v1/games/{game['id']}/keys", headers=AUTH, json={"label": "v2"})
    assert response.status_code == 201
    new_key = response.json()
    assert (
        admin.delete(f"/v1/games/{game['id']}/keys/{game['key']['id']}", headers=AUTH).status_code
        == 204
    )
    assert send(ingest, game, [event()]).status_code == 401
    assert send(ingest, {**game, "key": new_key}, [event()]).status_code == 200
    listing = admin.get(f"/v1/games/{game['id']}/keys", headers=AUTH)
    assert "key_hash" not in listing.text and "api_key" not in listing.text


@pytest.mark.parametrize(
    "overrides",
    [
        {"params": {"bad": True}},
        {"params": {"bad": None}},
        {"params": {"bad": []}},
        {"params": {"bad": {"nested": 1}}},
        {"params": {"bad": "a" * 1025}},
        {"params": {"bad": 2**64}},
        {"params": {f"key{index}": index for index in range(51)}},
        {"client_ts": "2026-10-04T09:00:00"},
        {"client_ts": 1720000000},
        {"device_id": None, "user_id": None},
        {"event_id": "invalid"},
        {"server_ts": "2026-10-04T09:00:00Z"},
        {"name": "bad event name"},
    ],
)
def test_invalid_batches_are_atomic(backend, overrides):
    admin, ingest, _ = backend
    game = register(admin)
    response = send(ingest, game, [event(), event(**overrides)])
    assert response.status_code == 400, response.text
    rows, _, _ = unpack(export(admin, game))
    assert rows == []


def test_limits_and_invalid_json(backend):
    admin, ingest, _ = backend
    game = register(admin)
    headers = {"X-API-Key": game["key"]["api_key"], "Content-Type": "application/json"}
    assert send(ingest, game, []).status_code == 400
    assert send(ingest, game, [event()] * 501).status_code == 400
    assert ingest.post("/v1/events", headers=headers, content="{").status_code == 400
    assert ingest.post("/v1/events", headers=headers, content=" " * 1_048_577).status_code == 413
    assert (
        ingest.post(
            "/v1/events", headers={**headers, "Content-Encoding": "gzip"}, content=b"invalid"
        ).status_code
        == 415
    )
    assert ingest.post("/v1/events", json={"events": [event()]}).status_code == 401
    for bad_number in ["NaN", "Infinity", "-Infinity"]:
        content = json.dumps({"events": [event(params={"bad": "PLACEHOLDER"})]}).replace(
            '"PLACEHOLDER"', bad_number
        )
        assert ingest.post("/v1/events", headers=headers, content=content).status_code == 400


def test_rate_limit_shared_across_instances_and_restart(backend, monkeypatch):
    admin, _, settings = backend
    monkeypatch.setattr("avn_analytics.storage.time.time", lambda: 1800000010)
    game = register(admin)
    limited = replace(settings, requests_per_minute=1)
    with TestClient(create_app(limited)) as first:
        assert send(first, game, [event()]).status_code == 200
    with TestClient(create_app(limited)) as second:
        response = send(second, game, [event()])
        assert response.status_code == 429
        assert response.headers["Retry-After"] == "50"
        monkeypatch.setattr("avn_analytics.storage.time.time", lambda: 1800000061)
        assert send(second, game, [event()]).status_code == 200


def test_storage_failure_never_acknowledges(backend, monkeypatch):
    admin, ingest, _ = backend
    game = register(admin)

    def fail(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(ingest.app.state.storage, "ingest", fail)
    response = send(ingest, game, [event()])
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
    assert "locked" not in response.text


def test_failed_transaction_rolls_back_entire_batch(backend):
    admin, ingest, _ = backend
    game = register(admin)
    storage = admin.app.state.storage
    with storage.connect(storage.game_path(game["id"])) as connection:
        connection.execute("""
            CREATE TRIGGER fail_insert BEFORE INSERT ON events
            WHEN NEW.name='fail' BEGIN SELECT RAISE(ABORT, 'injected failure'); END
        """)
    response = send(ingest, game, [event(), event(name="fail")])
    assert response.status_code == 503
    assert unpack(export(admin, game))[0] == []


@pytest.mark.parametrize(
    ("period", "selected", "start", "end"),
    [
        ("day", "2026-10-04", "2026-10-04", "2026-10-05"),
        ("week", "2026-10-04", "2026-09-28", "2026-10-05"),
        ("month", "2024-02-29", "2024-02-01", "2024-03-01"),
        ("month", "2026-12-31", "2026-12-01", "2027-01-01"),
    ],
)
def test_period_bounds(period, selected, start, end):
    actual_start, actual_end = period_bounds(period, date.fromisoformat(selected))
    assert actual_start.startswith(start)
    assert actual_end.startswith(end)


def test_timezones_boundaries_dictionary_and_health(backend):
    admin, ingest, settings = backend
    game = register(admin)
    events = [
        event(client_ts=value)
        for value in [
            "2026-10-04T05:00:00+05:00",
            "2026-10-04T23:59:59.999999Z",
            "2026-10-05T00:00:00Z",
            "2026-10-03T23:59:59.999999Z",
        ]
    ]
    assert send(ingest, game, events).status_code == 200
    response = admin.put(
        f"/v1/games/{game['id']}/dictionary/level_complete",
        headers=AUTH,
        json={
            "description": "Player finished a level",
            "params": {"level": "One-based level number"},
        },
    )
    assert response.status_code == 200
    rows, manifest, dictionary = unpack(export(admin, game))
    assert len(rows) == 2
    assert rows[0]["client_ts"] == "2026-10-04T00:00:00.000000+00:00"
    assert "Player finished a level" in dictionary
    assert manifest["timezone"] == "UTC"
    assert not list((settings.data_dir / "exports").iterdir())
    health = admin.get(
        f"/v1/games/{game['id']}/health",
        headers=AUTH,
        params={"date": datetime.now(UTC).date().isoformat()},
    ).json()
    assert sum(day["events"] for day in health["days"]) == 4
    server_rows, _, _ = unpack(
        export(admin, game, basis="server_ts", date=datetime.now(UTC).date().isoformat())
    )
    assert len(server_rows) == 4


def test_export_size_limit_and_cleanup(backend):
    admin, ingest, settings = backend
    game = register(admin)
    send(ingest, game, [event()])
    with TestClient(create_app(replace(settings, max_export_bytes=1), admin=True)) as limited:
        assert export(limited, game).status_code == 413
    assert not list((settings.data_dir / "exports").iterdir())


def test_concurrent_retries_commit_once(backend):
    admin, _, _ = backend
    game = register(admin)
    batch = Batch.model_validate({"events": [event()]})
    storage = admin.app.state.storage
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: storage.ingest(game["id"], batch), range(20)))
    assert sum(result["accepted"] for result in results) == 1
    assert sum(result["duplicates"] for result in results) == 19


def test_chunked_body_limit_without_content_length():
    import asyncio

    messages = iter(
        [
            {"type": "http.request", "body": b"12345", "more_body": True},
            {"type": "http.request", "body": b"67890", "more_body": False},
        ]
    )
    sent = []

    async def receive():
        return next(messages)

    async def send_message(message):
        sent.append(message)

    async def downstream(scope, receive, send_message):
        pytest.fail("Oversized body reached application")

    asyncio.run(
        BodyLimit(downstream, 8)(
            {"type": "http", "method": "POST", "headers": []}, receive, send_message
        )
    )
    assert sent[0]["status"] == 413


def test_storage_can_be_moved(backend, tmp_path):
    import shutil

    admin, ingest, settings = backend
    game = register(admin)
    original = event()
    send(ingest, game, [original])
    destination = tmp_path / "different-drive" / "avn-data"
    shutil.copytree(
        settings.data_dir, destination, ignore=shutil.ignore_patterns("different-drive")
    )
    moved = replace(settings, data_dir=destination)
    with TestClient(create_app(moved, admin=True)) as moved_admin:
        with TestClient(create_app(moved)) as moved_ingest:
            assert send(moved_ingest, game, [original]).json()["duplicates"] == 1
            assert unpack(export(moved_admin, game))[1]["event_count"] == 1


def test_country_comes_from_cloudflare_header_only(backend):
    admin, ingest, _ = backend
    game = register(admin)
    key = {"X-API-Key": game["key"]["api_key"]}
    spoof = event(country="ZZ")
    assert ingest.post("/v1/events", headers=key, json={"events": [spoof]}).status_code == 400
    ok = event()
    headers = {**key, "CF-IPCountry": "pk"}
    assert ingest.post("/v1/events", headers=headers, json={"events": [ok]}).status_code == 200
    bad = event()
    headers = {**key, "CF-IPCountry": "<script>"}
    assert ingest.post("/v1/events", headers=headers, json={"events": [bad]}).status_code == 200
    rows, _, dictionary = unpack(export(admin, game))
    by_id = {row["event_id"]: row for row in rows}
    assert by_id[ok["event_id"]]["country"] == "PK"
    assert by_id[bad["event_id"]]["country"] is None
    assert "country" in dictionary


@pytest.mark.parametrize("platform", ["windows", "macos", "linux", "web", "Android", ""])
def test_only_android_and_ios_games(backend, platform):
    admin, _, _ = backend
    response = admin.post(
        "/v1/games", json={"name": "G", "bundle_id": "com.avn.g", "platform": platform}
    )
    assert response.status_code == 400
    ios = admin.post("/v1/games", json={"name": "G", "bundle_id": "com.avn.g", "platform": "ios"})
    assert ios.status_code == 201


def test_custom_date_range_health_and_export(backend):
    admin, ingest, _ = backend
    game = register(admin)
    stamps = [
        "2026-10-01T10:00:00Z",
        "2026-10-03T10:00:00Z",
        "2026-10-03T11:00:00Z",
        "2026-10-09T10:00:00Z",
    ]
    assert send(ingest, game, [event(client_ts=value) for value in stamps]).status_code == 200
    base = {"period": "custom", "basis": "client_ts"}
    health = admin.get(
        f"/v1/games/{game['id']}/health",
        params={**base, "date": "2026-10-02", "end_date": "2026-10-03"},
    ).json()
    assert health["total"] == 2 and health["days"] == [{"day": "2026-10-03", "events": 2}]
    rows, manifest, _ = unpack(
        export(admin, game, period="custom", date="2026-10-01", end_date="2026-10-03")
    )
    assert len(rows) == 3 and manifest["end_exclusive"].startswith("2026-10-04")
    bad = admin.get(
        f"/v1/games/{game['id']}/health",
        params={**base, "date": "2026-10-05", "end_date": "2026-10-01"},
    )
    assert bad.status_code == 400
    missing = admin.get(f"/v1/games/{game['id']}/health", params={**base, "date": "2026-10-05"})
    assert missing.status_code == 400
    too_long = admin.get(
        f"/v1/games/{game['id']}/health",
        params={**base, "date": "2025-01-01", "end_date": "2026-10-01"},
    )
    assert too_long.status_code == 400


def test_export_includes_ai_analysis_guide_and_skill(backend):
    admin, ingest, _ = backend
    game = register(admin)
    events = [event(), event(), event(name="mystery_event")]
    assert send(ingest, game, events).status_code == 200
    response = export(admin, game)
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = set(archive.namelist())
        guide = archive.read("ANALYSIS.md").decode()
        skill = archive.read("skill/avn-game-analysis/SKILL.md").decode()
    assert {"events.jsonl.gz", "events.md", "manifest.json", "ANALYSIS.md"} <= names
    assert "| `level_complete` | 2 |" in guide and "| `mystery_event` | 1 |" in guide
    assert "`mystery_event`" in guide.split("Undocumented events")[1].split("\n")[0]
    assert "read_json_auto" in guide and not guide.lstrip().startswith("---")
    assert skill.startswith("---\nname: avn-game-analysis")
