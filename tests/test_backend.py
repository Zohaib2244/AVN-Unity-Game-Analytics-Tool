import gzip
import io
import json
import sqlite3
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
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


def test_registration_uniqueness_and_key_storage(backend):
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
        # Full keys are kept so the dashboard can copy them; auth still uses the hash.
        stored = connection.execute("SELECT key_hash, api_key FROM api_keys").fetchone()
        assert stored[0] != stored[1]
        assert stored[1] == game["key"]["api_key"]
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


def test_key_rotation_and_deletion(backend):
    admin, ingest, _ = backend
    game = register(admin)
    response = admin.post(f"/v1/games/{game['id']}/keys", headers=AUTH, json={"label": "v2"})
    assert response.status_code == 201
    new_key = response.json()
    assert (
        admin.delete(f"/v1/games/{game['id']}/keys/{game['key']['id']}", headers=AUTH).status_code
        == 204
    )
    assert (
        admin.delete(f"/v1/games/{game['id']}/keys/{game['key']['id']}", headers=AUTH).status_code
        == 404
    )
    remaining = admin.get(f"/v1/games/{game['id']}/keys", headers=AUTH).json()
    assert [key["id"] for key in remaining] == [new_key["id"]]
    assert send(ingest, game, [event()]).status_code == 401
    assert send(ingest, {**game, "key": new_key}, [event()]).status_code == 200
    listing = admin.get(f"/v1/games/{game['id']}/keys", headers=AUTH)
    assert "key_hash" not in listing.text
    assert listing.json()[0]["api_key"] == new_key["api_key"]


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
    gzip_headers = {**headers, "Content-Encoding": "gzip"}
    assert ingest.post("/v1/events", headers=gzip_headers, content=b"invalid").status_code == 400
    truncated = gzip.compress(json.dumps({"events": [event()]}).encode())[:-8]
    assert ingest.post("/v1/events", headers=gzip_headers, content=truncated).status_code == 400
    bomb = gzip.compress(b" " * 5_000_000)  # tiny on the wire, huge when inflated
    assert len(bomb) < 1_048_576
    assert ingest.post("/v1/events", headers=gzip_headers, content=bomb).status_code == 413
    brotli = {**headers, "Content-Encoding": "br"}
    assert ingest.post("/v1/events", headers=brotli, content=b"x").status_code == 415
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
    assert {
        "events.jsonl.gz",
        "events.parquet",
        "events.md",
        "manifest.json",
        "ANALYSIS.md",
    } <= names
    assert "| `level_complete` | 2 |" in guide and "| `mystery_event` | 1 |" in guide
    assert "`mystery_event`" in guide.split("Undocumented events")[1].split("\n")[0]
    assert "read_json_auto" in guide and not guide.lstrip().startswith("---")
    assert skill.startswith("---\nname: avn-game-analysis")


def test_export_parquet_flattens_params(backend):
    import pyarrow.parquet as pq

    admin, ingest, _ = backend
    game = register(admin)
    events = [
        event(params={"level": 1, "mode": "easy", "score": 1.5}),
        event(params={"level": 2, "mode": "hard"}),
        event(name="mixed", params={"value": 3}),
        event(name="mixed", params={"value": "three"}),
    ]
    assert send(ingest, game, events).status_code == 200
    response = export(admin, game, basis="server_ts", date=datetime.now(UTC).date().isoformat())
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        table = pq.read_table(io.BytesIO(archive.read("events.parquet")))
        manifest = json.loads(archive.read("manifest.json"))
    assert table.num_rows == 4
    assert str(table.schema.field("server_ts").type) == "timestamp[us, tz=UTC]"
    assert str(table.schema.field("param_level").type) == "int64"
    assert str(table.schema.field("param_score").type) == "double"
    assert str(table.schema.field("param_value").type) == "string"
    assert manifest["parquet"] == "events.parquet"
    assert set(manifest["parquet_param_columns"]) == {"level", "mode", "score", "value"}
    levels = sorted(v for v in table.column("param_level").to_pylist() if v is not None)
    assert levels == [1, 2]
    values = [v for v in table.column("param_value").to_pylist() if v is not None]
    assert sorted(values) == ["3", "three"]


def test_game_crud_archive_and_delete(backend):
    admin, ingest, settings = backend
    game = register(admin)
    other = register(admin, bundle="com.avn.other")
    assert send(ingest, game, [event()]).status_code == 200

    details = admin.get(f"/v1/games/{game['id']}").json()
    assert details["events"] == 1 and details["keys_active"] == 1 and details["storage_bytes"] > 0
    assert details["archived_at"] is None and details["notes"] == ""

    updated = admin.patch(
        f"/v1/games/{game['id']}",
        json={"name": "Renamed", "bundle_id": "com.avn.renamed", "notes": "Beta build"},
    ).json()
    assert (updated["name"], updated["bundle_id"], updated["notes"]) == (
        "Renamed",
        "com.avn.renamed",
        "Beta build",
    )
    clash = admin.patch(f"/v1/games/{game['id']}", json={"bundle_id": "com.avn.other"})
    assert clash.status_code == 409
    assert admin.patch(f"/v1/games/{game['id']}", json={"platform": "ios"}).status_code == 400

    assert admin.patch(f"/v1/games/{game['id']}", json={"archived": True}).json()["archived_at"]
    assert send(ingest, game, [event()]).status_code == 403
    assert (
        admin.patch(f"/v1/games/{game['id']}", json={"archived": False}).json()["archived_at"]
        is None
    )
    assert send(ingest, game, [event()]).status_code == 200

    path = f"/v1/games/{game['id']}"
    assert admin.delete(path, params={"confirm": "wrong"}).status_code == 400
    assert admin.delete(path, params={"confirm": "com.avn.renamed"}).status_code == 200
    assert admin.get(path).status_code == 404
    assert send(ingest, game, [event()]).status_code == 401
    assert [g["id"] for g in admin.get("/v1/games").json()] == [other["id"]]
    trashed = list((settings.data_dir / "deleted").iterdir())
    assert len(trashed) == 1 and trashed[0].name.endswith(f"{game['id']}.sqlite3")
    assert not list((settings.data_dir / "games").glob(f"{game['id']}*"))


def test_delete_dictionary_definition(backend):
    admin, _, _ = backend
    game = register(admin)
    url = f"/v1/games/{game['id']}/dictionary/level_complete"
    assert admin.put(url, json={"description": "Done", "params": {}}).status_code == 200
    assert admin.delete(url).status_code == 204
    assert admin.delete(url).status_code == 404
    assert admin.get(f"/v1/games/{game['id']}/dictionary").json() == {}


def test_dictionary_discovery(backend):
    admin, ingest, _ = backend
    game = register(admin)
    url = f"/v1/games/{game['id']}/dictionary"
    empty = admin.get(f"{url}/discovery").json()
    assert empty["missing"] == [] and empty["events_seen"] == 0
    send(
        ingest,
        game,
        [
            event(params={"level": 3, "mode": "easy", "won": 1, "seq": 1}),
            event(params={"level": 12, "mode": "hard", "won": "yes"}),
            event(name="shop_open", params={}),
            event(name="session_start", params={"environment": "production"}),
        ],
    )
    found = admin.get(f"{url}/discovery").json()
    assert found["events_seen"] == 3
    # SDK events are never reported; the busiest undocumented event comes first
    assert [item["name"] for item in found["missing"]] == ["level_complete", "shop_open"]
    level = found["missing"][0]
    assert level["count"] == 2 and not level["defined"] and level["description"] == ""
    params = {param["key"]: param for param in level["params"]}
    assert set(params) == {"level", "mode", "won"}  # seq is SDK bookkeeping
    assert params["level"]["types"] == ["number"] and params["level"]["examples"] == ["3", "12"]
    assert sorted(params["won"]["types"]) == ["number", "string"]  # a param that changed type
    assert sorted(params["won"]["examples"]) == ["1", "yes"]
    assert found["activity"] == {} and found["stale"] == []

    # Describing the event and some parameters leaves only the rest
    admin.put(
        f"{url}/level_complete",
        json={"description": "Done", "params": {"level": "One-based level number"}},
    )
    admin.put(f"{url}/shop_open", json={"description": "Opened the shop"})
    found = admin.get(f"{url}/discovery").json()
    assert [item["name"] for item in found["missing"]] == ["level_complete"]
    assert found["missing"][0]["defined"] and found["missing"][0]["description"] == "Done"
    assert {param["key"] for param in found["missing"][0]["params"]} == {"mode", "won"}
    assert found["activity"]["level_complete"]["count"] == 2

    # Once everything is described, only a defined event the game never sends is reported
    admin.put(
        f"{url}/level_complete",
        json={"description": "Done", "params": {"level": "l", "mode": "m", "won": "w"}},
    )
    admin.put(f"{url}/removed_event", json={"description": "Gone"})
    found = admin.get(f"{url}/discovery").json()
    assert found["missing"] == [] and found["stale"] == ["removed_event"]


def test_schema_migrates_v1_registry(tmp_path):
    import sqlite3

    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)):
        pass
    with sqlite3.connect(tmp_path / "registry.sqlite3") as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        columns = {row[1] for row in connection.execute("PRAGMA table_info(games)")}
    assert {"notes", "archived_at"} <= columns
    with TestClient(create_app(settings, admin=True)):  # second start must not re-migrate
        pass


def test_gzip_and_shared_context_batches(backend):
    admin, ingest, _ = backend
    game = register(admin)
    headers = {
        "X-API-Key": game["key"]["api_key"],
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
    }
    context_keys = ("user_id", "device_id", "session_id", "app_version", "build", "platform")
    full = [event(session_id="s-one"), event(session_id="s-one"), event(user_id="player-1")]
    compact = []
    for item in full:
        compact.append({k: v for k, v in item.items() if k not in context_keys})
    context = {k: full[0][k] for k in context_keys if k in full[0]}
    compact[2]["session_id"] = "s-two"  # per-event value overrides the batch context
    body = gzip.compress(json.dumps({"context": context, "events": compact}).encode())
    response = ingest.post("/v1/events", headers=headers, content=body)
    assert response.status_code == 200, response.text
    assert response.json()["accepted"] == 3
    # retrying the same compressed batch is idempotent
    assert ingest.post("/v1/events", headers=headers, content=body).json()["duplicates"] == 3
    rows, _, _ = unpack(export(admin, game))
    by_id = {row["event_id"]: row for row in rows}
    for item in compact:
        row = by_id[item["event_id"]]
        assert row["device_id"] == context["device_id"]
        assert row["app_version"] == context["app_version"]
        assert row["platform"] == context["platform"]
    assert by_id[compact[0]["event_id"]]["session_id"] == "s-one"
    assert by_id[compact[2]["event_id"]]["session_id"] == "s-two"
    # stored rows keep the same complete envelope as before
    assert set(context_keys) <= set(rows[0])


def test_context_cannot_fill_gaps_it_does_not_cover(backend):
    admin, ingest, _ = backend
    game = register(admin)
    key = {"X-API-Key": game["key"]["api_key"]}
    bare = {k: v for k, v in event().items() if k not in ("session_id", "device_id")}
    for context in (None, {"device_id": "d"}, {"session_id": "s"}):
        body = {"events": [bare]} if context is None else {"context": context, "events": [bare]}
        assert ingest.post("/v1/events", headers=key, json=body).status_code == 400
    ok = {"context": {"device_id": "d", "session_id": "s"}, "events": [bare]}
    assert ingest.post("/v1/events", headers=key, json=ok).status_code == 200
    unknown = {"context": {"device_id": "d", "country": "ZZ"}, "events": [bare]}
    assert ingest.post("/v1/events", headers=key, json=unknown).status_code == 400


def test_insights_funnel_players_and_journey(backend):
    admin, ingest, _ = backend
    game = register(admin)

    def level(device, status, number, minute, session="session-1", **extra):
        return event(
            name="LEVEL_ANALYSIS",
            device_id=device,
            session_id=session,
            params={status: number, **extra},
            client_ts=f"2026-10-04T09:{minute:02d}:00Z",
        )

    events = [
        level("a", "Started", 1, 0),
        level("a", "Completed", 1, 2, TIME=110),
        level("a", "Started", 2, 3),
        level("b", "Started", 1, 10, session="b-1"),
        level("b", "Completed", 1, 14, session="b-2"),  # completed in a later session
        level("c", "Completed", 1, 20),  # completed without a start: not in the funnel
        level("d", "Started", 2, 30),  # out of order: never started level 1
    ]
    assert send(ingest, game, events).status_code == 200
    base = f"/v1/games/{game['id']}/insights"
    days = {"start": "2026-10-04", "end": "2026-10-04"}

    catalog = admin.get(f"{base}/catalog", headers=AUTH, params=days).json()
    [level_event] = catalog["events"]
    assert level_event["name"] == "LEVEL_ANALYSIS" and level_event["count"] == 7
    keys = {param["key"]: param for param in level_event["params"]}
    assert set(keys) == {"Started", "Completed", "TIME"}
    assert set(keys["Started"]["values"]) == {"1", "2"}

    steps = [
        {"event": "LEVEL_ANALYSIS", "param": "Started", "value": "1"},
        {"event": "LEVEL_ANALYSIS", "param": "Completed", "value": "1"},
        {"event": "LEVEL_ANALYSIS", "param": "Started", "value": "2"},
    ]

    def run(**options):
        response = admin.post(
            f"{base}/funnel", headers=AUTH, json={**days, "steps": steps, **options}
        )
        assert response.status_code == 200, response.text
        return response.json()

    result = run()
    assert [step["players"] for step in result["steps"]] == [2, 2, 1]
    timing = result["steps"][1]["time_from_previous"]
    assert timing["median"] == 180.0 and timing["average"] == 180.0 and timing["count"] == 2
    assert result["steps"][2]["of_first"] == 50.0 and result["steps"][2]["of_previous"] == 50.0
    assert result["steps"][1]["dropped"] == 1
    assert result["steps"][1]["dropped_sample"][0]["player"] == "b"
    assert result["time_to_complete"]["median"] == 180.0

    assert [step["players"] for step in run(window_hours=0.04)["steps"]] == [2, 1, 0]
    assert [step["players"] for step in run(scope="session")["steps"]] == [2, 1, 1]
    numeric = [
        {"event": "LEVEL_ANALYSIS", "param": "Started", "op": "gte", "value": "1"},
        {"event": "LEVEL_ANALYSIS", "param": "TIME", "op": "lt", "value": "200"},
    ]
    response = admin.post(f"{base}/funnel", headers=AUTH, json={**days, "steps": numeric})
    assert [step["players"] for step in response.json()["steps"]] == [3, 1]
    broken = run(breakdown="environment")
    assert broken["segments"] == [{"value": "unknown", "players": [2, 2, 1]}]

    listing = admin.get(f"{base}/players", headers=AUTH, params=days).json()
    assert listing["total"] == 4 and listing["players"][0]["player"] == "d"
    assert (
        admin.get(f"{base}/players", headers=AUTH, params={**days, "search": "b"}).json()["total"]
        == 1
    )

    journey = admin.get(f"{base}/journey", headers=AUTH, params={**days, "player": "a"}).json()
    assert [item["params"] for item in journey["events"]] == [
        {"Started": 1},
        {"Completed": 1, "TIME": 110},
        {"Started": 2},
    ]
    other_day = {"start": "2026-10-05", "end": "2026-10-05", "player": "a"}
    assert admin.get(f"{base}/journey", headers=AUTH, params=other_day).json()["events"] == []

    saved = admin.post(f"{base}/funnels", headers=AUTH, json={"name": "Levels", "steps": steps})
    assert saved.status_code == 201, saved.text
    funnel_id = saved.json()["id"]
    renamed = {"name": "Level 1-2", "steps": steps, "scope": "session"}
    assert admin.put(f"{base}/funnels/{funnel_id}", headers=AUTH, json=renamed).status_code == 200
    [stored] = admin.get(f"{base}/funnels", headers=AUTH).json()
    assert (
        stored["name"] == "Level 1-2" and stored["scope"] == "session" and len(stored["steps"]) == 3
    )
    assert admin.delete(f"{base}/funnels/{funnel_id}", headers=AUTH).status_code == 204
    assert admin.get(f"{base}/funnels", headers=AUTH).json() == []


def test_environment_filters(backend):
    admin, ingest, _ = backend
    game = register(admin)
    start = event(
        name="session_start",
        device_id="tester",
        session_id="editor-session",
        params={"environment": "Editor"},
    )
    later = event(name="level_complete", device_id="tester", session_id="editor-session")
    assert send(ingest, game, [start]).status_code == 200
    assert send(ingest, game, [later]).status_code == 200  # matched to its session later
    batch = {
        "context": {"environment": "production", "session_id": "real", "device_id": "player"},
        "events": [
            {key: value for key, value in event().items() if key not in ("session_id", "device_id")}
        ],
    }
    response = ingest.post("/v1/events", headers={"X-API-Key": game["key"]["api_key"]}, json=batch)
    assert response.status_code == 200, response.text

    base = f"/v1/games/{game['id']}/insights"
    days = {"start": "2026-10-04", "end": "2026-10-04"}
    facets = admin.get(f"{base}/facets", headers=AUTH, params=days).json()
    assert {item["value"]: item["events"] for item in facets["environment"]} == {
        "editor": 2,
        "production": 1,
    }
    real = admin.get(f"{base}/summary", headers=AUTH, params={**days, "not_env": "editor"}).json()
    assert real["events"] == 1 and real["players"] == 1
    everything = admin.get(f"{base}/summary", headers=AUTH, params=days).json()
    assert everything["events"] == 3 and everything["players"] == 2 and everything["sessions"] == 2
    assert {row["value"] for row in everything["breakdowns"]["environment"]} == {
        "editor",
        "production",
    }
    only_editor = admin.get(f"{base}/players", headers=AUTH, params={**days, "env": "editor"})
    assert [row["player"] for row in only_editor.json()["players"]] == ["tester"]


def test_summary_reports_daily_active_users(backend):
    admin, ingest, _ = backend
    game = register(admin)

    def seen(day, *players):
        return [
            event(
                device_id=player, session_id=f"{player}-{day}", client_ts=f"2026-10-{day}T09:00:00Z"
            )
            for player in players
        ]

    events = seen("01", "a", "b") + seen("02", "a") + seen("04", "a", "b", "c")
    events += seen("04", "a")  # the same player twice in a day counts once
    assert send(ingest, game, events).status_code == 200
    base = f"/v1/games/{game['id']}/insights"
    data = admin.get(
        f"{base}/summary", headers=AUTH, params={"start": "2026-10-02", "end": "2026-10-04"}
    ).json()
    active = data["active"]
    assert active["last_day"] == "2026-10-04"
    assert active["dau"] == 3 and active["dau_previous"] == 0  # 10-03 had nobody
    assert active["avg_dau"] == 1.3  # (1 + 0 + 3) over the 3 selected days
    assert active["peak_dau"] == {"players": 3, "day": "2026-10-04"}
    # WAU and MAU look back from the end of the range, beyond its first day
    assert active["wau"] == 3 and active["mau"] == 3
    assert active["avg_dau_7"] == 0.9  # (3 + 0 + 1 + 2) over 7 days
    assert active["avg_dau_30"] == 0.2  # (3 + 1 + 2) over 30 days
    assert active["stickiness"] == 6.7  # 0.2 average DAU / 3 MAU
    narrow = admin.get(
        f"{base}/summary", headers=AUTH, params={"start": "2026-10-04", "end": "2026-10-04"}
    ).json()
    assert narrow["active"]["dau"] == 3 and narrow["active"]["dau_previous"] == 0
    assert narrow["active"]["avg_dau"] == 3.0 and narrow["active"]["mau"] == 3
    empty = admin.get(
        f"{base}/summary", headers=AUTH, params={"start": "2026-09-01", "end": "2026-09-02"}
    ).json()
    assert empty["active"]["dau"] == 0 and empty["active"]["stickiness"] is None
    assert empty["active"]["peak_dau"] is None


def test_daily_active_users_leave_out_test_environments(backend):
    admin, ingest, _ = backend
    game = register(admin)
    for environment, players in (("production", ["real", "real-2"]), ("editor", ["tester"])):
        batch = {
            "context": {"environment": environment},
            "events": [event(device_id=player) for player in players],
        }
        response = ingest.post(
            "/v1/events", headers={"X-API-Key": game["key"]["api_key"]}, json=batch
        )
        assert response.status_code == 200, response.text
    base = f"/v1/games/{game['id']}/insights/summary"
    days = {"start": "2026-10-04", "end": "2026-10-04"}
    assert admin.get(base, headers=AUTH, params=days).json()["active"]["dau"] == 3
    real = admin.get(base, headers=AUTH, params={**days, "not_env": "editor"}).json()["active"]
    assert real["dau"] == 2 and real["mau"] == 2


def test_overview_counts_players_active_today_and_yesterday(backend):
    admin, ingest, _ = backend
    game = register(admin)
    now = datetime.now(UTC)
    yesterday = now.replace(hour=0, minute=0, second=1) - timedelta(days=1)
    events = [
        event(device_id="a", client_ts=now.isoformat()),
        event(device_id="a", client_ts=now.isoformat()),
        event(device_id="b", client_ts=now.isoformat()),
        event(device_id="a", client_ts=yesterday.isoformat()),
    ]
    assert send(ingest, game, events).status_code == 200
    data = admin.get("/v1/overview", headers=AUTH).json()
    (row,) = [item for item in data["games"] if item["id"] == game["id"]]
    assert row["dau_today"] == 2 and row["dau_yesterday"] == 1
    assert data["dau_today"] == 2


def _send_as(ingest, game, environment, events):
    response = ingest.post(
        "/v1/events",
        headers={"X-API-Key": game["key"]["api_key"]},
        json={"context": {"environment": environment}, "events": events},
    )
    assert response.status_code == 200, response.text


def test_environment_fix_recounts_a_build_shipped_in_the_wrong_mode(backend):
    admin, ingest, _ = backend
    game = register(admin)
    # 1.0 was published still in development mode; 2.0 went out properly; one editor session
    _send_as(
        ingest,
        game,
        "development",
        [event(device_id=f"real-{n}", app_version="1.0", build="7") for n in range(3)],
    )
    _send_as(ingest, game, "development", [event(device_id="qa", app_version="2.0", build="8")])
    _send_as(ingest, game, "production", [event(device_id="fan", app_version="2.0", build="8")])
    _send_as(ingest, game, "editor", [event(device_id="dev", app_version="1.0", build="7")])
    base = f"/v1/games/{game['id']}"
    days = {"start": "2026-10-04", "end": "2026-10-04"}
    real = {**days, "not_env": ["editor", "development"]}
    assert admin.get(f"{base}/insights/summary", headers=AUTH, params=real).json()["players"] == 1

    seen = admin.get(f"{base}/environment-fixes", headers=AUTH).json()["seen"]
    wrong = [
        row
        for row in seen
        if (row["environment"], row["app_version"], row["build"]) == ("development", "1.0", "7")
    ]
    assert [(row["players"], row["events"], row["fix"]) for row in wrong] == [(3, 3, None)]

    response = admin.post(
        f"{base}/environment-fixes",
        headers=AUTH,
        json={
            "from_environment": "Development",
            "to_environment": "production",
            "app_version": "1.0",
            "build": " ",
        },
    )
    assert response.status_code == 201, response.text
    fix = response.json()
    assert (fix["players"], fix["events"], fix["build"]) == (3, 3, None)  # blank build = any build
    # the 3 players now count as production; the 2.0 development tester and the editor do not
    after = admin.get(f"{base}/insights/summary", headers=AUTH, params=real).json()
    assert after["players"] == 4
    assert {row["value"]: row["players"] for row in after["breakdowns"]["environment"]} == {
        "production": 4
    }
    everything = admin.get(f"{base}/insights/summary", headers=AUTH, params=days).json()
    assert {row["value"]: row["players"] for row in everything["breakdowns"]["environment"]} == {
        "production": 4,
        "development": 1,
        "editor": 1,
    }
    only_fixed = admin.get(
        f"{base}/insights/players", headers=AUTH, params={**days, "env": "production"}
    ).json()
    assert sorted(row["player"] for row in only_fixed["players"]) == [
        "fan",
        "real-0",
        "real-1",
        "real-2",
    ]
    fixed_row = admin.get(f"{base}/environment-fixes", headers=AUTH).json()
    assert [row["fix"] for row in fixed_row["seen"] if row["app_version"] == "1.0"].count(
        fix["id"]
    ) == 1  # only the development rows of 1.0 are marked as fixed, not its editor row

    # the stored events keep what they reported; the export says how they are re-counted
    rows, manifest, notes = unpack(export(admin, game))
    assert {row["device_id"] for row in rows if row.get("environment") == "development"} == {
        "real-0",
        "real-1",
        "real-2",
        "qa",
    }
    assert manifest["environment_fixes"] == [
        {
            "from_environment": "development",
            "to_environment": "production",
            "app_version": "1.0",
            "build": None,
            "note": "",
        }
    ]
    assert "environment_fixes" in notes
    filtered = unpack(export(admin, game, env="production"))[0]
    assert sorted(row["device_id"] for row in filtered) == ["fan", "real-0", "real-1", "real-2"]

    # the same fix again retargets it instead of adding a second one
    again = {**fix, "to_environment": "staging"}
    for key in ("id", "events", "players"):
        again.pop(key)
    retargeted = admin.post(f"{base}/environment-fixes", headers=AUTH, json=again).json()
    assert retargeted["id"] == fix["id"]
    assert len(admin.get(f"{base}/environment-fixes", headers=AUTH).json()["fixes"]) == 1
    # undo
    assert admin.delete(f"{base}/environment-fixes/{fix['id']}", headers=AUTH).status_code == 204
    assert admin.delete(f"{base}/environment-fixes/{fix['id']}", headers=AUTH).status_code == 404
    assert admin.get(f"{base}/insights/summary", headers=AUTH, params=real).json()["players"] == 1


def test_environment_fix_must_change_something(backend):
    admin, _, _ = backend
    game = register(admin)
    url = f"/v1/games/{game['id']}/environment-fixes"
    same = {"from_environment": "development", "to_environment": "Development"}
    assert admin.post(url, headers=AUTH, json=same).status_code == 400
    assert admin.post(url, headers=AUTH, json={"from_environment": "x y"}).status_code == 400


def test_environment_fixes_need_a_lead(team):
    client, as_user, _ = team
    boss = as_user(ADMIN_EMAIL)
    work = client.get("/v1/workspaces", headers=boss).json()[0]
    game = client.post("/v1/games", headers=boss, json={**GAME, "workspace_id": work["id"]}).json()
    for person in (
        {"email": "lead@example.com", "role": "lead"},
        {"email": "dev@example.com", "role": "member", "game_ids": [game["id"]]},
    ):
        body = {**person, "workspace_id": work["id"]}
        assert client.post("/v1/team", headers=boss, json=body).status_code == 201
    url = f"/v1/games/{game['id']}/environment-fixes"
    fix = {"from_environment": "development", "to_environment": "production", "app_version": "1"}
    dev, lead = as_user("dev@example.com"), as_user("lead@example.com")
    assert client.get(url, headers=dev).status_code == 200  # members may look
    assert client.post(url, headers=dev, json=fix).status_code == 403
    created = client.post(url, headers=lead, json=fix)
    assert created.status_code == 201
    assert client.delete(f"{url}/{created.json()['id']}", headers=dev).status_code == 403
    assert client.delete(f"{url}/{created.json()['id']}", headers=lead).status_code == 204


def test_export_and_health_filters(backend):
    admin, ingest, _ = backend
    game = register(admin)
    start = event(
        name="session_start", device_id="tester", session_id="e1", params={"environment": "editor"}
    )
    real = [event(), event(name="level_start", device_id="tester", session_id="e1")]
    assert send(ingest, game, [start, *real]).status_code == 200
    params = {"date": "2026-10-04", "period": "day", "basis": "client_ts"}
    everything = admin.get(f"/v1/games/{game['id']}/health", headers=AUTH, params=params)
    assert everything.json()["total"] == 3
    real_only = admin.get(
        f"/v1/games/{game['id']}/health", headers=AUTH, params={**params, "not_env": "editor"}
    )
    assert real_only.json()["total"] == 1
    full = export(admin, game)
    filtered = admin.get(
        f"/v1/games/{game['id']}/export", headers=AUTH, params={**params, "not_env": "editor"}
    )
    assert filtered.status_code == 200, filtered.text
    with zipfile.ZipFile(io.BytesIO(filtered.content)) as archive:
        lines = gzip.decompress(archive.read("events.jsonl.gz")).decode().splitlines()
        manifest = json.loads(archive.read("manifest.json"))
    assert len(lines) == 1 and manifest["event_count"] == 1
    assert manifest["filters"] == {"exclude_environments": ["editor"]}
    assert full.status_code == 200


def png(width=64, height=64):
    import struct
    import zlib

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    pixels = zlib.compress(b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height)))
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")
    )


def test_game_icons(backend):
    admin, _, settings = backend
    game = register(admin)
    url = f"/v1/games/{game['id']}/icon"
    assert admin.get(url, headers=AUTH).status_code == 404
    assert admin.get("/v1/games", headers=AUTH).json()[0]["icon_updated_at"] is None
    image = png()
    saved = admin.put(url, headers=AUTH, content=image)
    assert saved.status_code == 200, saved.text
    fetched = admin.get(url, headers=AUTH)
    assert fetched.status_code == 200 and fetched.content == image
    assert fetched.headers["content-type"] == "image/png"
    assert "max-age" in fetched.headers["cache-control"]
    assert (
        admin.get("/v1/games", headers=AUTH).json()[0]["icon_updated_at"]
        == saved.json()["icon_updated_at"]
    )
    assert admin.put(url, headers=AUTH, content=b"GIF89a not a png").status_code == 415
    assert admin.put(url, headers=AUTH, content=png(8, 8)).status_code == 400
    assert admin.put(url, headers=AUTH, content=image + b"0" * 600_000).status_code in (413, 400)
    assert admin.delete(url, headers=AUTH).status_code == 204
    assert admin.get(url, headers=AUTH).status_code == 404
    admin.put(url, headers=AUTH, content=image)
    assert (settings.data_dir / "icons" / f"{game['id']}.png").exists()
    deleted = admin.delete(
        f"/v1/games/{game['id']}", headers=AUTH, params={"confirm": "com.avn.test"}
    )
    assert deleted.status_code == 200
    assert not (settings.data_dir / "icons" / f"{game['id']}.png").exists()


# ---- team access: Cloudflare Access sign-in, workspaces, roles, per-game access, LAN rule

TEAM_DOMAIN = "example.cloudflareaccess.com"
AUDIENCE = "test-audience-tag"
ADMIN_EMAIL = "boss@example.com"
GAME = {"name": "Test Game", "bundle_id": "com.avn.test", "platform": "android"}


@pytest.fixture
def team(tmp_path):
    from cryptography.hazmat.primitives.asymmetric import rsa

    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        access_team_domain=TEAM_DOMAIN,
        access_audience=AUDIENCE,
        admin_email=ADMIN_EMAIL,
    )
    app = create_app(settings, admin=True, access_keys={"k1": private.public_key()})

    def token(email, audience=AUDIENCE, key=private, expires=3600):
        import time

        import jwt

        now = int(time.time())
        claims = {
            "email": email,
            "aud": [audience],
            "iss": f"https://{TEAM_DOMAIN}",
            "iat": now,
            "exp": now + expires,
        }
        return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "k1"})

    def as_user(email, **options):
        return {"Cf-Access-Jwt-Assertion": token(email, **options), "Cf-Ray": "abc-LHR"}

    with TestClient(app, client=("203.0.113.9", 5000)) as client:
        yield client, as_user, private


def test_sign_in_rules(team):
    client, as_user, _ = team
    boss = as_user(ADMIN_EMAIL)
    me = client.get("/v1/me", headers=boss).json()
    assert me["is_admin"] and [w["name"] for w in me["workspaces"]] == ["Default"]
    assert client.get("/v1/me").status_code == 401
    stranger = client.get("/v1/me", headers=as_user("stranger@example.com"))
    assert stranger.status_code == 403
    assert ADMIN_EMAIL in stranger.json()["detail"]  # tells them whom to contact
    assert client.get("/v1/me", headers=as_user(ADMIN_EMAIL, audience="other")).status_code == 401
    assert client.get("/v1/me", headers=as_user(ADMIN_EMAIL, expires=-60)).status_code == 401
    from cryptography.hazmat.primitives.asymmetric import rsa

    forged = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert client.get("/v1/me", headers=as_user(ADMIN_EMAIL, key=forged)).status_code == 401
    spoof = {"Cf-Access-Authenticated-User-Email": ADMIN_EMAIL, "Cf-Ray": "x"}
    assert client.get("/v1/me", headers=spoof).status_code == 401
    # listed by the admin but in no workspace: still no access
    person = {"email": "idle@example.com", "role": "admin"}
    assert client.post("/v1/team", headers=boss, json=person).status_code == 201
    assert (
        client.patch("/v1/team/idle@example.com", headers=boss, json={"admin": False}).status_code
        == 200
    )
    assert client.get("/v1/me", headers=as_user("idle@example.com")).status_code == 403


def test_workspaces_and_roles(team):
    client, as_user, _ = team
    boss = as_user(ADMIN_EMAIL)
    work = client.get("/v1/workspaces", headers=boss).json()[0]
    home = client.post("/v1/workspaces", headers=boss, json={"name": "Home"}).json()
    assert client.post("/v1/workspaces", headers=boss, json={"name": "home"}).status_code == 409

    def register(workspace, **game):
        body = {**GAME, **game, "workspace_id": workspace["id"]}
        response = client.post("/v1/games", headers=boss, json=body)
        assert response.status_code == 201, response.text
        return response.json()

    work_game = register(work)
    home_game = register(home, name="Pets", bundle_id="com.avn.pets")
    add = lambda **body: client.post("/v1/team", headers=boss, json=body)  # noqa: E731
    assert add(email="lead@example.com", role="lead", workspace_id=work["id"]).status_code == 201
    assert (
        add(
            email="dev@example.com",
            role="member",
            workspace_id=work["id"],
            game_ids=[work_game["id"]],
        ).status_code
        == 201
    )
    assert add(email="dev@example.com", role="member", workspace_id=work["id"]).status_code == 409
    # the same person can also be in the other workspace with another role
    assert add(email="dev@example.com", role="lead", workspace_id=home["id"]).status_code == 201
    assert add(email="friend@gmail.com", role="member", workspace_id=home["id"]).status_code == 201

    lead, dev, friend = (as_user(f"{n}@example.com") for n in ("lead", "dev", "friend"))
    friend = as_user("friend@gmail.com")

    def games(headers, workspace):
        response = client.get("/v1/games", headers=headers, params={"workspace": workspace["id"]})
        return response

    # workspaces are invisible to people who aren't in them
    assert [w["name"] for w in client.get("/v1/me", headers=lead).json()["workspaces"]] == [
        "Default"
    ]
    assert games(lead, home).status_code == 404
    assert client.get(f"/v1/games/{home_game['id']}", headers=lead).status_code == 404
    assert client.get(f"/v1/games/{home_game['id']}/keys", headers=lead).status_code == 404
    assert [g["id"] for g in games(lead, work).json()] == [work_game["id"]]
    assert client.get("/v1/workspaces", headers=lead).json()[0]["role"] == "lead"
    # dev: a member at work, a lead at home
    assert client.get(f"/v1/games/{work_game['id']}/keys", headers=dev).status_code == 200
    assert (
        client.post(
            f"/v1/games/{work_game['id']}/keys", headers=dev, json={"label": "k"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/v1/games/{home_game['id']}/keys", headers=dev, json={"label": "k"}
        ).status_code
        == 201
    )
    # a member sees only granted games; a lead only manages their own workspace
    assert friend and games(friend, home).json() == []
    assert client.get(f"/v1/games/{home_game['id']}", headers=friend).status_code == 404
    other = {**GAME, "name": "Other", "bundle_id": "com.avn.other", "workspace_id": work["id"]}
    assert client.post("/v1/games", headers=lead, json=other).status_code == 201
    assert (
        client.post(
            "/v1/games",
            headers=lead,
            json={**other, "bundle_id": "com.avn.o2", "workspace_id": home["id"]},
        ).status_code
        == 404
    )
    assert client.post(
        "/v1/games", headers=dev, json={**other, "bundle_id": "com.avn.o3"}
    ).status_code in (403, 404)
    granted = client.put(
        f"/v1/games/{home_game['id']}/access", headers=dev, json={"emails": ["friend@gmail.com"]}
    )
    assert granted.status_code == 200
    assert [g["id"] for g in games(friend, home).json()] == [home_game["id"]]
    # only the admin manages workspaces, people and moves
    for call in (
        client.post("/v1/workspaces", headers=lead, json={"name": "X"}),
        client.get("/v1/team", headers=lead),
        client.post(
            f"/v1/games/{work_game['id']}/move", headers=lead, json={"workspace_id": home["id"]}
        ),
        client.delete(f"/v1/workspaces/{home['id']}", headers=lead),
    ):
        assert call.status_code == 403
    # removing someone from a workspace keeps their other workspace
    assert (
        client.delete(
            f"/v1/team/dev@example.com?workspace_id={home['id']}", headers=boss
        ).status_code
        == 204
    )
    assert [w["name"] for w in client.get("/v1/me", headers=dev).json()["workspaces"]] == [
        "Default"
    ]
    assert client.delete("/v1/team/dev@example.com", headers=boss).status_code == 204
    assert client.get("/v1/me", headers=dev).status_code == 403
    assert client.delete(f"/v1/team/{ADMIN_EMAIL}", headers=boss).status_code == 400
    actions = {row["action"] for row in client.get("/v1/audit", headers=boss).json()}
    assert {
        "workspace.create",
        "game.register",
        "user.add",
        "access.game",
        "user.remove",
    } <= actions


def test_move_and_delete_workspaces(team, tmp_path):
    client, as_user, _ = team
    boss = as_user(ADMIN_EMAIL)
    first = client.get("/v1/workspaces", headers=boss).json()[0]
    second = client.post("/v1/workspaces", headers=boss, json={"name": "Home"}).json()

    def register(workspace, platform="android", **game):
        body = {**GAME, "platform": platform, "workspace_id": workspace["id"], **game}
        return client.post("/v1/games", headers=boss, json=body).json()

    android = register(first, bundle_id="com.avn.a")
    ios = register(first, platform="ios", bundle_id="com.avn.i")
    other = register(first, name="Solo", bundle_id="com.avn.solo")
    client.post(
        "/v1/team",
        headers=boss,
        json={
            "email": "m@example.com",
            "role": "member",
            "workspace_id": first["id"],
            "game_ids": [android["id"]],
        },
    )
    member = as_user("m@example.com")
    assert [g["id"] for g in client.get("/v1/games", headers=member).json()] == [android["id"]]

    # moving takes both platform versions along, and clears member grants
    moved = client.post(
        f"/v1/games/{android['id']}/move", headers=boss, json={"workspace_id": second["id"]}
    )
    assert moved.status_code == 200 and set(moved.json()["moved"]) == {android["id"], ios["id"]}
    assert moved.json()["grants_cleared"] == 1
    listing = client.get("/v1/games", headers=boss, params={"workspace": second["id"]}).json()
    assert {g["id"] for g in listing} == {android["id"], ios["id"]}
    assert (
        client.get("/v1/games", headers=boss, params={"workspace": first["id"]}).json()[0]["id"]
        == other["id"]
    )
    assert client.get(f"/v1/games/{android['id']}", headers=member).status_code == 404
    assert (
        client.post(
            f"/v1/games/{android['id']}/move", headers=boss, json={"workspace_id": second["id"]}
        ).status_code
        == 400
    )
    # a game with the same name and platform in the destination blocks the move
    clash = register(first, bundle_id="com.avn.clash")
    blocked = client.post(
        f"/v1/games/{clash['id']}/move", headers=boss, json={"workspace_id": second["id"]}
    )
    assert blocked.status_code == 409 and "Rename" in blocked.json()["detail"]

    # deleting a workspace needs the name, and a decision about its games
    url = f"/v1/workspaces/{second['id']}"
    assert client.delete(url, headers=boss, params={"confirm": "wrong"}).status_code == 400
    assert client.delete(url, headers=boss, params={"confirm": "Home"}).status_code == 409
    assert (
        client.delete(
            url, headers=boss, params={"confirm": "Home", "move_to": second["id"]}
        ).status_code
        == 400
    )
    clash_blocked = client.delete(
        url, headers=boss, params={"confirm": "Home", "move_to": first["id"]}
    )
    assert clash_blocked.status_code == 409  # the "clash" game already holds that name and platform
    client.delete(f"/v1/games/{clash['id']}", headers=boss, params={"confirm": "com.avn.clash"})
    done = client.delete(url, headers=boss, params={"confirm": "Home", "move_to": first["id"]})
    assert done.status_code == 200 and done.json()["games"] == 2
    ids = {
        g["id"]
        for g in client.get("/v1/games", headers=boss, params={"workspace": first["id"]}).json()
    }
    assert {android["id"], ios["id"], other["id"]} <= ids
    # the last workspace can't go
    last = client.delete(
        f"/v1/workspaces/{first['id']}",
        headers=boss,
        params={"confirm": first["name"], "delete_games": "true"},
    )
    assert last.status_code == 400 and "at least one" in last.json()["detail"]
    # deleting with "delete the games" moves their files to data/deleted
    third = client.post("/v1/workspaces", headers=boss, json={"name": "Scratch"}).json()
    doomed = register(third, bundle_id="com.avn.doomed", name="Doomed")
    gone = client.delete(
        f"/v1/workspaces/{third['id']}",
        headers=boss,
        params={"confirm": "Scratch", "delete_games": "true"},
    )
    assert gone.status_code == 200
    assert client.get(f"/v1/games/{doomed['id']}", headers=boss).status_code == 404
    assert list((tmp_path / "deleted").glob("*com.avn.doomed*"))
    renamed = client.patch(f"/v1/workspaces/{first['id']}", headers=boss, json={"name": "Work"})
    assert renamed.status_code == 200
    assert client.get("/v1/workspaces", headers=boss).json()[0]["name"] == "Work"


def test_existing_data_moves_into_default_workspace(tmp_path):
    import sqlite3

    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
    registry = sqlite3.connect(tmp_path / "registry.sqlite3")
    registry.executescript(
        """
        UPDATE games SET workspace_id=NULL;
        DELETE FROM workspace_members; DELETE FROM workspaces;
        INSERT INTO team_users VALUES ('old-lead@example.com','','lead','x','2026-01-01',NULL);
        INSERT INTO team_users VALUES ('old-dev@example.com','','member','x','2026-01-01',NULL);
        """
    )
    registry.commit()
    registry.close()
    with TestClient(create_app(settings, admin=True)) as admin:
        workspaces = admin.get("/v1/workspaces", headers=AUTH).json()
        assert [w["name"] for w in workspaces] == ["Default"] and workspaces[0]["games"] == 1
        people = {p["email"]: p for p in admin.get("/v1/team", headers=AUTH).json()}
        assert people["old-lead@example.com"]["memberships"] == {workspaces[0]["id"]: "lead"}
        assert people["old-dev@example.com"]["memberships"] == {workspaces[0]["id"]: "member"}
        assert admin.get(f"/v1/games/{game['id']}", headers=AUTH).status_code == 200


def test_lan_and_token_access(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        access_team_domain=TEAM_DOMAIN,
        access_audience=AUDIENCE,
        admin_email=ADMIN_EMAIL,
    )
    app = create_app(settings, admin=True, access_keys={})
    with TestClient(app, client=("192.168.1.50", 5000)) as lan:
        assert lan.get("/v1/me").json()["is_admin"]  # home network = the admin
        assert lan.get("/v1/me").json()["source"] == "lan"
        cloudflare = {"Cf-Connecting-Ip": "198.51.100.7"}
        assert lan.get("/v1/me", headers=cloudflare).status_code == 401
        bearer = {"Authorization": f"Bearer {TOKEN}"}
        assert lan.get("/v1/me", headers=bearer).json()["source"] == "token"
        assert lan.get("/v1/me", headers={"Authorization": "Bearer wrong"}).status_code == 401
        public = {"X-Forwarded-For": "203.0.113.9"}
        assert lan.get("/v1/me", headers=public).status_code == 401
        assert lan.get("/v1/me", headers={"X-Forwarded-For": "192.168.1.7"}).status_code == 200
    with TestClient(app, client=("203.0.113.9", 5000)) as outside:
        assert outside.get("/v1/me").status_code == 401
        assert outside.get("/v1/me", headers={"X-Forwarded-For": "192.168.1.7"}).status_code == 401
    off = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        access_team_domain=TEAM_DOMAIN,
        access_audience=AUDIENCE,
        lan_admin=False,
    )
    with TestClient(create_app(off, admin=True, access_keys={}), client=("192.168.1.50", 1)) as lan:
        assert lan.get("/v1/me").status_code == 401


def _level_player(device, session, base_minute, plan):
    """Events for one player. plan: list of (name, params, seconds_after_start)."""
    return [
        event(
            name=name,
            device_id=device,
            session_id=session,
            client_ts=f"2026-10-04T10:{base_minute + seconds // 60:02d}:{seconds % 60:02d}Z",
            params=params,
        )
        for name, params, seconds in plan
    ]


def _journey_game(backend):
    admin, ingest, _ = backend
    game = register(admin)
    events = []
    # p1: menu, levels 1-3 all completed, quits
    events += _level_player(
        "p1",
        "s-p1",
        0,
        [
            ("first_open", {}, 0),
            ("MM_ANALYSIS", {"STATUS": "OPENED"}, 5),
            ("MM_ANALYSIS", {"STATUS": "OPENED"}, 5),
            ("LEVEL_ANALYSIS", {"Started": "1"}, 10),
            ("LEVEL_ANALYSIS", {"Completed": "1"}, 30),
            ("LEVEL_ANALYSIS", {"Started": "2"}, 31),
            ("POWERUP_CONSUMED", {"POWERUP_TYPE": "Bomb", "LEVEL_NUMBER": "2"}, 40),
            ("LEVEL_ANALYSIS", {"Completed": "2"}, 50),
            ("LEVEL_ANALYSIS", {"Started": "3"}, 51),
            ("LEVEL_ANALYSIS", {"Completed": "3"}, 70),
            ("level_gate", {}, 80),
        ],
    )
    # p2: same journey as p1 (should group with it)
    events += _level_player(
        "p2",
        "s-p2",
        5,
        [
            ("first_open", {}, 0),
            ("MM_ANALYSIS", {"STATUS": "OPENED"}, 5),
            ("LEVEL_ANALYSIS", {"Started": "1"}, 10),
            ("LEVEL_ANALYSIS", {"Completed": "1"}, 30),
            ("LEVEL_ANALYSIS", {"Started": "2"}, 31),
            ("LEVEL_ANALYSIS", {"Completed": "2"}, 50),
            ("LEVEL_ANALYSIS", {"Started": "3"}, 51),
            ("LEVEL_ANALYSIS", {"Completed": "3"}, 70),
            ("level_gate", {}, 80),
        ],
    )
    # p3: menu, starts level 1, fails twice, leaves on level 1
    events += _level_player(
        "p3",
        "s-p3",
        10,
        [
            ("first_open", {}, 0),
            ("MM_ANALYSIS", {"STATUS": "OPENED"}, 5),
            ("LEVEL_ANALYSIS", {"Started": "1"}, 10),
            ("LEVEL_ANALYSIS", {"Failed": "1"}, 40),
            ("LEVEL_ANALYSIS", {"Restarted": "1"}, 41),
            ("LEVEL_ANALYSIS", {"Failed": "1"}, 70),
        ],
    )
    # p4: only opens the game
    events += _level_player("p4", "s-p4", 15, [("first_open", {}, 0)])
    assert send(ingest, game, events).status_code == 200
    return admin, game


def _journey_query(**extra):
    return {
        "steps": [{"event": "first_open"}, {"event": "level_gate"}],
        "start": "2026-10-04",
        "end": "2026-10-04",
        **extra,
    }


def test_player_story_reads_in_plain_words(backend):
    admin, game = _journey_game(backend)
    data = admin.get(
        f"/v1/games/{game['id']}/insights/story",
        params={"player": "p1", "start": "2026-10-04", "end": "2026-10-04"},
    ).json()
    (chapter,) = data["chapters"]
    texts = [segment["text"] for segment in chapter["segments"]]
    assert texts[0] == "First open"
    assert texts[1].startswith("MM") and texts[1].endswith("×2")  # same-second repeats folded
    assert texts[2] == "Played levels 1–3, completed all"
    assert texts[3].lower().startswith("level gate")
    run = chapter["segments"][2]
    assert [row["level"] for row in run["levels"]] == [1, 2, 3]
    assert run["extras"] == [{"text": "Powerup consumed · Bomb on level 2", "count": 1}]
    assert data["highest_level"] == 3
    p3 = admin.get(
        f"/v1/games/{game['id']}/insights/story",
        params={"player": "p3", "start": "2026-10-04", "end": "2026-10-04"},
    ).json()
    last = p3["chapters"][0]["segments"][-1]
    assert (
        last["text"] == "Played level 1, didn't complete, failed 2×, restarted 1×, left on level 1"
    )
    assert last["exit"] == "Left after failing level 1"


def test_dictionary_labels_and_hidden_events(backend):
    admin, game = _journey_game(backend)
    url = f"/v1/games/{game['id']}/dictionary"
    admin.put(
        f"{url}/MM_ANALYSIS",
        json={"description": "Main menu", "params": {}, "labels": "STATUS => Main menu {STATUS}"},
    )
    admin.put(f"{url}/level_gate", json={"description": "x", "params": {}, "hidden": True})
    data = admin.get(
        f"/v1/games/{game['id']}/insights/story",
        params={"player": "p2", "start": "2026-10-04", "end": "2026-10-04"},
    ).json()
    texts = [segment["text"] for segment in data["chapters"][0]["segments"]]
    assert texts == ["First open", "Main menu OPENED", "Played levels 1–3, completed all"]
    shown = admin.get(
        f"/v1/games/{game['id']}/insights/story",
        params={"player": "p2", "start": "2026-10-04", "end": "2026-10-04", "hidden": True},
    ).json()
    assert shown["chapters"][0]["segments"][-1]["name"] == "level_gate"


def test_journeys_group_players_by_story_shape(backend):
    admin, game = _journey_game(backend)
    base = f"/v1/games/{game['id']}/insights/journeys"
    data = admin.post(base, json=_journey_query()).json()
    assert (data["started"], data["reached"], data["stopped"]) == (4, 2, 2)
    top = data["journeys"][0]
    assert top["players"] == 2 and top["status"] == "reached"
    assert top["steps"][-1] == "Levels 1–3 (all completed)"
    exits = {item["label"]: item["players"] for item in data["exits"]}
    assert exits == {"Left after failing level 1": 1, "__start__": 1}
    who = admin.post(
        f"{base}/players",
        json={**_journey_query(), "target": {"steps": top["steps"], "status": "reached"}},
    ).json()
    assert sorted(p["player"] for p in who["players"]) == ["p1", "p2"]
    gone = admin.post(
        f"{base}/players", json={**_journey_query(), "target": {"exit": "__start__"}}
    ).json()
    assert [p["player"] for p in gone["players"]] == ["p4"]
    ignored = admin.post(base, json=_journey_query(ignore=["MM_ANALYSIS"])).json()
    assert all(not any("MM" in step for step in j["steps"]) for j in ignored["journeys"])
    bad = admin.post(base, json=_journey_query(route_from=2, route_to=2))
    assert bad.status_code in (400, 422)


def test_level_progress_table(backend):
    admin, game = _journey_game(backend)
    data = admin.get(
        f"/v1/games/{game['id']}/insights/levels",
        params={"start": "2026-10-04", "end": "2026-10-04"},
    ).json()
    rows = {row["level"]: row for row in data["levels"]}
    assert rows[1]["started"] == 3 and rows[1]["completed"] == 2
    assert rows[1]["completion"] == 66.7 and rows[1]["fails"] == 2 and rows[1]["restarts"] == 1
    assert rows[1]["attempts"] == 4 and rows[1]["quit"] == 1  # p3 never got past level 1
    assert rows[2]["powerups"] == 1 and rows[2]["top_powerups"][0]["text"].startswith(
        "Powerup consumed"
    )
    assert rows[3]["completed"] == 2 and rows[3]["median_seconds"] == 19.0


def test_funnels_allow_up_to_100_steps(backend):
    admin, game = _journey_game(backend)
    steps = [{"event": "first_open"}] + [{"event": "MM_ANALYSIS"}] * 99
    url = f"/v1/games/{game['id']}/insights/funnel"
    body = {"steps": steps, "start": "2026-10-04", "end": "2026-10-04"}
    assert admin.post(url, json=body).status_code == 200
    body["steps"] = steps + [{"event": "MM_ANALYSIS"}]
    assert admin.post(url, json=body).status_code == 400


def _players(admin, game, **params):
    return admin.get(
        f"/v1/games/{game['id']}/insights/players",
        params={"start": "2026-10-04", "end": "2026-10-04", **params},
    ).json()


def test_players_sort_by_app_version_in_number_order(backend):
    admin, ingest, _ = backend
    game = register(admin)
    events = [
        event(device_id="pa", app_version="1.9"),
        event(device_id="pb", app_version="1.10"),
        event(device_id="pc", app_version="1.2.1"),
        event(device_id="pd", app_version="2.0"),
        event(device_id="pe", app_version="1.5", client_ts="2026-10-04T08:00:00Z"),
        event(device_id="pe", app_version="1.12", client_ts="2026-10-04T10:00:00Z"),
        event(device_id="pe", app_version="1.7", client_ts="2026-10-04T11:00:00Z"),
        event(device_id="pf", app_version="nightly"),
    ]
    assert send(ingest, game, events).status_code == 200
    newest = _players(admin, game, sort="version", order="desc")["players"]
    # 1.10 comes after 1.9 (not before it, as plain text order would put it)
    assert [(p["player"], p["app_version"]) for p in newest] == [
        ("pd", "2.0"),
        ("pe", "1.12"),  # the newest version the player has used, not the last or text-max one
        ("pb", "1.10"),
        ("pa", "1.9"),
        ("pc", "1.2.1"),
        ("pf", "nightly"),
    ]
    oldest = _players(admin, game, sort="version", order="asc")["players"]
    assert [p["player"] for p in oldest] == ["pf", "pc", "pa", "pb", "pe", "pd"]
    first_page = _players(admin, game, sort="version", order="desc", offset=4)["players"]
    assert [p["player"] for p in first_page] == ["pc", "pf"]


def test_players_sorting_and_event_rules(backend):
    admin, game = _journey_game(backend)
    order = lambda data: [p["player"] for p in data["players"]]  # noqa: E731
    assert order(_players(admin, game, sort="events", order="desc"))[0] == "p1"
    assert order(_players(admin, game, sort="events", order="asc"))[0] == "p4"
    assert order(_players(admin, game, sort="last_seen", order="desc"))[0] == "p4"  # started last
    assert order(_players(admin, game, sort="first_seen", order="asc"))[0] == "p1"
    assert _players(admin, game, sort="sessions")["players"][0]["sessions"] == 1
    assert (
        admin.get(
            f"/v1/games/{game['id']}/insights/players",
            params={"start": "2026-10-04", "end": "2026-10-04", "sort": "bogus"},
        ).status_code
        == 400
    )

    def rules(**value):
        return json.dumps(value)

    # only players who completed level 3 (a parameter test), then who never failed
    did = _players(
        admin,
        game,
        rules=rules(
            conditions=[
                {"event": "LEVEL_ANALYSIS", "param": "Completed", "op": "gte", "value": "3"}
            ]
        ),
    )
    assert sorted(order(did)) == ["p1", "p2"] and did["total"] == 2
    never = _players(
        admin,
        game,
        rules=rules(
            conditions=[
                {"event": "LEVEL_ANALYSIS", "param": "Failed", "op": "exists", "does": "didnt"}
            ]
        ),
    )
    assert sorted(order(never)) == ["p1", "p2", "p4"]
    twice = _players(
        admin,
        game,
        rules=rules(
            conditions=[
                {"event": "LEVEL_ANALYSIS", "param": "Failed", "op": "exists", "min_times": 2}
            ]
        ),
    )
    assert order(twice) == ["p3"]
    # a metric: highest level started, used as the sort key
    metric = {"event": "LEVEL_ANALYSIS", "param": "Started", "op": "exists", "agg": "max"}
    by_level = _players(admin, game, sort="metric0", order="desc", rules=rules(metrics=[metric]))
    assert sorted(order(by_level)[:2]) == ["p1", "p2"]  # tie: latest first
    assert by_level["players"][0]["metrics"] == [3.0]
    assert by_level["players"][-1]["metrics"] == [None]  # p4 never started a level: sorted last
    count = {"event": "LEVEL_ANALYSIS", "param": "Failed", "op": "exists", "agg": "count"}
    counted = _players(admin, game, sort="metric0", order="desc", rules=rules(metrics=[count]))
    assert order(counted)[0] == "p3" and counted["players"][0]["metrics"] == [2]
    last = {"event": "level_gate", "agg": "last"}
    stamped = _players(admin, game, rules=rules(metrics=[last]))
    assert next(p for p in stamped["players"] if p["player"] == "p1")["metrics"][0].startswith(
        "2026-10-04"
    )
    broken = admin.get(
        f"/v1/games/{game['id']}/insights/players",
        params={
            "start": "2026-10-04",
            "end": "2026-10-04",
            "rules": rules(metrics=[{"event": "x", "agg": "max"}]),
        },
    )
    assert broken.status_code == 400  # max needs a parameter
    bad = admin.get(
        f"/v1/games/{game['id']}/insights/players",
        params={"start": "2026-10-04", "end": "2026-10-04", "rules": "{nope"},
    )
    assert bad.status_code == 400
