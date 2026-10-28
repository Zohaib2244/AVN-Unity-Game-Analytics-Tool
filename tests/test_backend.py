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

from avn_analytics import device_specs
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


def test_storage_failure_never_acknowledges(backend, monkeypatch, caplog):
    admin, ingest, _ = backend
    game = register(admin)

    def fail(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(ingest.app.state.storage, "ingest", fail)
    response = send(ingest, game, [event()])
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
    assert "locked" not in response.text
    assert "database is locked" in caplog.text


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
    bare = {k: v for k, v in event().items() if k not in ("session_id", "device_id", "user_id")}
    for context in (None, {"device_id": "d"}, {"session_id": "s"}):
        body = {"events": [bare]} if context is None else {"context": context, "events": [bare]}
        assert ingest.post("/v1/events", headers=key, json=body).status_code == 400
    ok = {"context": {"device_id": "d", "session_id": "s"}, "events": [bare]}
    assert ingest.post("/v1/events", headers=key, json=ok).status_code == 200
    # an event itself stays strict: an unknown field there is still refused
    stray = {
        "context": {"device_id": "d", "session_id": "s"},
        "events": [{**bare, "country": "ZZ"}],
    }
    assert ingest.post("/v1/events", headers=key, json=stray).status_code == 400


def test_new_context_fields_are_accepted_and_the_standard_stamp_is_stored(backend):
    admin, ingest, settings = backend
    game = register(admin)
    key = {"X-API-Key": game["key"]["api_key"]}
    bare = {k: v for k, v in event().items() if k not in ("session_id", "device_id", "user_id")}
    base = {"device_id": "d", "session_id": "s"}

    def post(context, name="level_complete"):
        body = {
            "context": {**base, **context},
            "events": [{**bare, "event_id": str(uuid4()), "name": name}],
        }
        return ingest.post("/v1/events", headers=key, json=body)

    assert post({"standard": "avn-events", "standard_version": 3}, "LEVEL").status_code == 200
    assert post({}, "OLD").status_code == 200  # older SDKs send neither field
    # a field this server has never heard of is ignored, and a client cannot set the country
    assert post({"future_field": "x", "country": "ZZ"}, "FUTURE").status_code == 200
    # a malformed stamp only describes the batch, so it is dropped, not a 400
    assert post({"standard": "avn-events", "standard_version": "three"}, "ODD").status_code == 200

    with sqlite3.connect(settings.data_dir / "games" / f"{game['id']}.sqlite3") as db:
        rows = {
            name: json.loads(payload)
            for name, payload in db.execute("SELECT name, payload FROM events")
        }
    assert (rows["LEVEL"]["standard"], rows["LEVEL"]["standard_version"]) == ("avn-events", 3)
    assert (rows["OLD"]["standard"], rows["OLD"]["standard_version"]) == (None, None)
    assert rows["FUTURE"]["country"] is None and "future_field" not in rows["FUTURE"]
    assert (rows["ODD"]["standard"], rows["ODD"]["standard_version"]) == ("avn-events", None)


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
    # the filter menu shows players, not events: the tester sent two events but is one player
    assert {item["value"]: item["players"] for item in facets["environment"]} == {
        "editor": 1,
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


def test_everything_except_filters(backend):
    admin, ingest, _ = backend
    game = register(admin)
    key = {"X-API-Key": game["key"]["api_key"]}
    for player, country in (("a", "PK"), ("b", "IN"), ("c", "US")):
        sent = ingest.post(
            "/v1/events",
            headers={**key, "CF-IPCountry": country},
            json={"events": [event(device_id=player, session_id=f"s-{player}")]},
        )
        assert sent.status_code == 200, sent.text
    base = f"/v1/games/{game['id']}/insights/summary"
    days = {"start": "2026-10-04", "end": "2026-10-04"}

    def players(**params):
        return admin.get(base, headers=AUTH, params={**days, **params}).json()["players"]

    assert players() == 3
    assert players(country="PK") == 1
    assert players(not_country="PK") == 2
    assert players(not_country=["PK", "IN"]) == 1
    assert players(country=["PK", "IN"], not_country="PK") == 1  # only and except combine
    assert players(not_platform="no-such-platform") == 3
    assert players(not_version="no-such-version", not_build="no-such-build") == 3


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


def test_player_story_includes_latest_player_information_and_play_stats(backend):
    admin, ingest, _ = backend
    game = register(admin)
    common = {"device_id": "install-1", "user_id": "account-1"}
    events = [
        event(
            **common,
            name="session_start",
            session_id="session-1",
            app_version="1.2",
            build="12",
            client_ts="2026-10-04T09:00:00Z",
            params={
                "session_number": 1,
                "device_model": "Old Phone",
                "os_version": "Android OS 14 / API-34 (old-build)",
            },
        ),
        event(
            **common,
            session_id="session-1",
            client_ts="2026-10-04T09:01:00Z",
        ),
        event(
            **common,
            name="session_start",
            session_id="session-2",
            app_version="1.3",
            build="13",
            client_ts="2026-10-04T10:10:00Z",
            params={
                "session_number": 2,
                "device_model": "Google Pixel 8",
                "device_type": "Handheld",
                "os_version": "Android OS 15 / API-35 (new-build)",
                "language": "English",
                "timezone_offset_minutes": 300,
                "screen_width": 1080,
                "screen_height": 2400,
                "gpu_tier": "high",
            },
        ),
        event(
            **common,
            session_id="session-2",
            app_version="1.3",
            build="13",
            client_ts="2026-10-04T10:12:00Z",
        ),
    ]
    assert send(ingest, game, events).status_code == 200

    data = admin.get(
        f"/v1/games/{game['id']}/insights/story",
        params={"player": "account-1", "start": "2026-10-04", "end": "2026-10-04"},
    ).json()
    assert data["total_play_seconds"] == 180.0
    assert data["average_session_seconds"] == 90.0
    assert data["info"] == {
        "user_id": "account-1",
        "device_id": "install-1",
        "app_version": "1.3",
        "build": "13",
        "platform": "android",
        "environment": "unknown",
        "country": None,
        "updated_at": "2026-10-04T10:12:00.000000+00:00",
        "profile_updated_at": "2026-10-04T10:10:00.000000+00:00",
        "properties": {
            "session_number": 2,
            "device_model": "Google Pixel 8",
            "device_type": "Handheld",
            "os_version": "Android OS 15 / API-35 (new-build)",
            "language": "English",
            "timezone_offset_minutes": 300,
            "screen_width": 1080,
            "screen_height": 2400,
            "gpu_tier": "high",
        },
    }


def test_device_specs_lookup_is_explicit_and_uses_the_collected_model(backend, monkeypatch):
    admin, ingest, _ = backend
    game = register(admin)
    assert (
        send(
            ingest,
            game,
            [
                event(
                    name="session_start",
                    device_id="device-info-player",
                    params={"device_model": "Example Phone X"},
                )
            ],
        ).status_code
        == 200
    )
    seen = []

    def lookup(model):
        seen.append(model)
        return {
            "provider": "Wikipedia",
            "matched_device": "Example Phone X",
            "source_url": "https://en.wikipedia.org/wiki/Example_Phone_X",
            "specs": {"cpu": "Eight cores", "gpu": "Example GPU", "ram": "8 GB"},
            "note": "Catalog values.",
        }

    monkeypatch.setattr(device_specs, "lookup", lookup)
    response = admin.get(
        f"/v1/games/{game['id']}/insights/device-specs",
        params={"player": "device-info-player"},
    )
    assert response.status_code == 200
    assert response.json()["specs"]["gpu"] == "Example GPU"
    assert seen == ["Example Phone X"]


def test_device_specs_infobox_parser_extracts_game_hardware():
    html = """
      <table class="infobox vevent"><tbody>
        <tr><th class="infobox-above">Example Phone</th></tr>
        <tr><th class="infobox-label">System on chip</th><td>Example SoC</td></tr>
        <tr><th class="infobox-label">CPU</th><td>8-core CPU<sup>[1]</sup></td></tr>
        <tr><th class="infobox-label">GPU</th><td>Fast GPU</td></tr>
        <tr><th class="infobox-label">Memory</th><td>8 GB<br>12 GB</td></tr>
        <tr><th class="infobox-label">Storage</th><td>128 GB or 256 GB</td></tr>
      </tbody></table>
    """
    assert device_specs._specs_from_html(html) == {
        "chipset": "Example SoC",
        "cpu": "8-core CPU",
        "gpu": "Fast GPU",
        "ram": "8 GB · 12 GB",
        "storage": "128 GB or 256 GB",
    }


def test_device_specs_resolves_vivo_model_code_to_retail_name(monkeypatch):
    html = """
      <table class="infobox"><tbody>
        <tr><th>System on chip</th><td>MediaTek Dimensity 9500</td></tr>
        <tr><th>CPU</th><td>Octa-core</td></tr>
        <tr><th>GPU</th><td>Arm G1-Ultra</td></tr>
        <tr><th>Memory</th><td>12 or 16 GB</td></tr>
        <tr><th>Storage</th><td>256 GB, 512 GB or 1 TB</td></tr>
      </tbody></table>
    """
    requests = []

    def request_json(params):
        requests.append(params)
        return {"parse": {"text": html}}

    monkeypatch.setattr(device_specs, "_request_json", request_json)
    device_specs.lookup.cache_clear()
    try:
        result = device_specs.lookup("vivo V2514")
    finally:
        device_specs.lookup.cache_clear()

    assert requests == [
        {
            "action": "parse",
            "page": "Vivo X300 Pro",
            "prop": "text",
            "format": "json",
            "formatversion": 2,
        }
    ]
    assert result["matched_device"] == "Vivo X300 Pro"
    assert result["specs"]["chipset"] == "MediaTek Dimensity 9500"


def _level_players(admin, game, level, group, **params):
    return admin.get(
        f"/v1/games/{game['id']}/insights/levels/players",
        params={
            "start": "2026-10-04",
            "end": "2026-10-05",
            "level": level,
            "group": group,
            **params,
        },
    ).json()


def test_failing_and_leaving_is_told_apart_from_failing_and_playing_on(backend):
    admin, game = _journey_game(backend)
    _, ingest, _ = backend
    # p7 fails level 1 twice, then passes it and starts level 2: failing, but still playing
    extra = _level_player(
        "p7",
        "s-p7",
        30,
        [
            ("first_open", {}, 0),
            ("LEVEL_ANALYSIS", {"Started": "1"}, 10),
            ("LEVEL_ANALYSIS", {"Failed": "1"}, 30),
            ("LEVEL_ANALYSIS", {"Restarted": "1"}, 31),
            ("LEVEL_ANALYSIS", {"Failed": "1"}, 50),
            ("LEVEL_ANALYSIS", {"Restarted": "1"}, 51),
            ("LEVEL_ANALYSIS", {"Completed": "1"}, 90),
            ("LEVEL_ANALYSIS", {"Started": "2"}, 100),
        ],
    )
    assert send(ingest, game, extra).status_code == 200
    ids = lambda data: sorted(row["player"] for row in data["players"])  # noqa: E731

    failed = _level_players(admin, game, 1, "failed")
    assert ids(failed) == ["p3", "p7"]
    assert ids(_level_players(admin, game, 1, "failed_left")) == ["p3"]  # failed and stopped
    assert ids(_level_players(admin, game, 1, "failed_kept_playing")) == ["p7"]
    assert (
        failed["counts"]["failed_left"] + failed["counts"]["failed_kept_playing"]
        == (failed["counts"]["failed"])
    )
    levels = admin.get(
        f"/v1/games/{game['id']}/insights/levels",
        params={"start": "2026-10-04", "end": "2026-10-05"},
    ).json()["levels"]
    summary = next(row for row in levels if row["level"] == 1)["transition"]
    assert (summary["failed"], summary["failed_left"], summary["fail_drop_percent"]) == (2, 1, 50.0)
    # a level nobody failed has no share to report
    quiet = next(row for row in levels if row["level"] == 3)["transition"]
    assert quiet is None or quiet["failed"] or quiet["fail_drop_percent"] is None


def test_level_players_group_who_left_who_finished_and_who_kept_going(backend):
    admin, game = _journey_game(backend)
    _, ingest, _ = backend
    ids = lambda data: sorted(p["player"] for p in data["players"])  # noqa: E731
    # p5 tries level 2 three times and leaves in the middle of it; p6 leaves level 1 on day 1
    # and opens the game again the next day without playing another level
    extra = _level_player(
        "p5",
        "s-p5",
        20,
        [
            ("first_open", {}, 0),
            ("LEVEL_ANALYSIS", {"Started": "2"}, 10),
            ("LEVEL_ANALYSIS", {"Failed": "2"}, 30),
            ("LEVEL_ANALYSIS", {"Restarted": "2"}, 31),
            ("LEVEL_ANALYSIS", {"Failed": "2"}, 50),
            ("LEVEL_ANALYSIS", {"Restarted": "2"}, 51),
        ],
    )
    extra += _level_player(
        "p6", "s-p6", 25, [("first_open", {}, 0), ("LEVEL_ANALYSIS", {"Started": "1"}, 10)]
    )
    extra.append(
        event(
            name="MM_ANALYSIS",
            device_id="p6",
            session_id="s-p6-2",
            client_ts="2026-10-05T09:00:00Z",
            params={"STATUS": "OPENED"},
        )
    )
    assert send(ingest, game, extra).status_code == 200

    left = _level_players(admin, game, 1, "left")
    assert ids(left) == ["p3", "p6"]  # the table's "Left here" count for level 1
    assert left["counts"] == {
        "total_drop": 2,
        "left": 2,
        "finished_stopped": 0,
        "kept_going": 2,
        "stuck": 0,
        "failed": 1,
        "failed_left": 1,
        "failed_kept_playing": 0,
        "started": 4,
        "unknown_progress": 0,
        "returning": 0,
        "missing_history": 1,
    }
    by_player = {row["player"]: row for row in left["players"]}
    assert (by_player["p3"]["tries"], by_player["p3"]["fails"]) == (2, 2)
    assert by_player["p3"]["came_back"] is False
    assert by_player["p6"]["came_back"] is True  # opened the game the next day
    assert by_player["p6"]["app_version"] == "1.0"
    levels = admin.get(
        f"/v1/games/{game['id']}/insights/levels",
        params={"start": "2026-10-04", "end": "2026-10-05"},
    ).json()["levels"]
    assert {row["level"]: row["quit"] for row in levels}[1] == left["total"]
    assert {row["level"]: row["started"] for row in levels}[1] == left["counts"]["started"]

    assert ids(_level_players(admin, game, 1, "kept_going")) == ["p1", "p2"]
    assert ids(_level_players(admin, game, 3, "finished_stopped")) == ["p1", "p2"]
    assert ids(_level_players(admin, game, 2, "stuck")) == ["p5"]  # 3 tries, never finished
    assert ids(_level_players(admin, game, 2, "left")) == ["p5"]
    # sorting and paging
    by_tries = _level_players(admin, game, 1, "started", sort="tries", limit=2)
    assert by_tries["players"][0]["player"] == "p3" and len(by_tries["players"]) == 2
    assert by_tries["total"] == 4
    second = _level_players(admin, game, 1, "started", sort="tries", limit=2, offset=2)
    assert len(second["players"]) == 2
    assert not set(ids(by_tries)) & set(ids(second))
    url = f"/v1/games/{game['id']}/insights/levels/players"
    base = {"start": "2026-10-04", "end": "2026-10-05", "level": 1}
    assert admin.get(url, params={**base, "group": "bogus"}).status_code == 400
    assert admin.get(url, params={**base, "sort": "bogus"}).status_code == 400
    nobody = _level_players(admin, game, 99, "left")
    assert nobody["total"] == 0 and nobody["counts"]["started"] == 0


@pytest.mark.parametrize(("reported", "expected"), [(375.5, 375.5), (None, 360.0), (-10, 360.0)])
def test_level_players_show_the_last_level_session_duration(backend, reported, expected):
    admin, ingest, _ = backend
    game = register(admin)

    def record(name, moment, params=None, session="level-session", player="player"):
        return event(
            name=name,
            device_id=player,
            session_id=session,
            client_ts=moment,
            params=params or {},
        )

    records = [
        record("session_start", "2026-10-03T23:59:00Z"),
        record("level_started", "2026-10-04T00:01:00Z", {"level": 1}),
        record("level_failed", "2026-10-04T00:02:00Z", {"level": 1}),
        record("menu_opened", "2026-10-04T00:05:00Z"),
        # A later session, another player reusing the ID, and out-of-range events must not leak in.
        record("session_start", "2026-10-05T10:00:00Z", session="return-session"),
        record("menu_opened", "2026-10-05T11:00:00Z", session="return-session"),
        record("session_start", "2026-10-04T00:00:00Z", player="other-player"),
        record("menu_opened", "2026-10-04T12:00:00Z", player="other-player"),
        record("menu_opened", "2026-10-06T12:00:00Z"),
    ]
    if reported is not None:
        records.append(
            record("session_end", "2026-10-04T00:05:00Z", {"duration_seconds": reported})
        )
    assert send(ingest, game, records).is_success
    data = _level_players(admin, game, 1, "left")
    assert data["total"] == 1
    assert data["players"][0]["session_seconds"] == expected
    assert data["players"][0]["came_back"] is True


def _played(player, session, moment, name, params=None, **extra):
    return event(
        name=name,
        device_id=player,
        session_id=session,
        client_ts=f"2026-10-{moment}Z",
        params=params or {},
        **extra,
    )


def test_levels_nobody_started_are_not_rows(backend):
    admin, ingest, _ = backend
    game = register(admin)
    records = [
        # A menu ad sent with LEVEL=0 and a finish without any start: neither is a played level.
        _played("p1", "s1", "04T09:00:00", "AD_ANALYSIS", {"FORMAT": "Banner", "LEVEL": 0}),
        _played("p1", "s1", "04T09:01:00", "level_started", {"level": 1}),
        _played("p1", "s1", "04T09:02:00", "level_completed", {"level": 1}),
        _played("p1", "s1", "04T09:03:00", "level_completed", {"level": 7}),
    ]
    assert send(ingest, game, records).is_success
    levels = admin.get(
        f"/v1/games/{game['id']}/insights/levels",
        params={"start": "2026-10-04", "end": "2026-10-04"},
    ).json()["levels"]
    assert [row["level"] for row in levels] == [1]


def test_level_players_came_back_counts_a_later_session_the_same_day(backend):
    admin, ingest, _ = backend
    game = register(admin)
    records = [
        _played("again", "a1", "04T09:00:00", "level_started", {"level": 1}),
        _played("again", "a2", "04T11:00:00", "MM_ANALYSIS", {"STATUS": "OPENED"}),
        _played("stayed", "b1", "04T09:00:00", "level_started", {"level": 1}),
        _played("stayed", "b1", "04T09:20:00", "MM_ANALYSIS", {"STATUS": "OPENED"}),
    ]
    assert send(ingest, game, records).is_success
    rows = {row["player"]: row for row in _level_players(admin, game, 1, "left")["players"]}
    assert rows["again"]["came_back"] is True  # reopened two hours later, same day
    assert rows["stayed"]["came_back"] is False  # still the same session


def test_level_players_say_what_players_did_last_on_the_level(backend):
    admin, ingest, _ = backend
    game = register(admin)
    records = [
        _played("ad", "s-ad", "04T09:00:00", "level_started", {"level": 1}),
        _played("ad", "s-ad", "04T09:01:00", "level_failed", {"level": 1}),
        _played("ad", "s-ad", "04T09:02:00", "AD_ANALYSIS", {"FORMAT": "Interstitial"}),
        _played("ad", "s-ad", "04T09:03:00", "APP_ANALYSIS", {"STATE": "Background"}),
        _played("ad", "s-ad", "04T09:03:00", "session_end", {"duration_seconds": 180}),
        _played("menu", "s-menu", "04T09:00:00", "level_started", {"level": 1}),
        _played(
            "menu",
            "s-menu",
            "04T09:01:00",
            "SCREEN_ANALYSIS",
            {"SCREEN": "settings_menu", "STATE": "Opened"},
        ),
        # A later session is not what they did on the level.
        _played("menu", "s-menu-2", "05T09:00:00", "MM_ANALYSIS", {"STATUS": "OPENED"}),
    ]
    for player in ("fail-1", "fail-2"):
        records += [
            _played(player, f"s-{player}", "04T09:00:00", "level_started", {"level": 1}),
            _played(player, f"s-{player}", "04T09:01:00", "level_failed", {"level": 1}),
        ]
    assert send(ingest, game, records).is_success
    data = _level_players(admin, game, 1, "left")
    assert data["last_actions"] == [
        {"text": "Failed level 1", "players": 2},
        {"text": "Interstitial ad", "players": 1},
        {"text": "Opened settings menu", "players": 1},
    ]
    rows = {row["player"]: row for row in data["players"]}
    assert rows["ad"]["last_action"] == "Interstitial ad"
    assert rows["menu"]["last_action"] == "Opened settings menu"
    assert rows["fail-1"]["last_action"] == "Failed level 1"
    # The player's last event on the level, for jumping to it in their timeline.
    assert rows["menu"]["exit_event"] == records[5]["event_id"]
    assert rows["ad"]["exit_event"] == records[1]["event_id"]
    failed = _level_players(admin, game, 1, "left", last_action="Failed level 1")
    assert sorted(row["player"] for row in failed["players"]) == ["fail-1", "fail-2"]
    assert failed["total"] == 2 and failed["counts"]["left"] == 4
    assert failed["last_actions"] == data["last_actions"]


def test_level_players_blame_the_ad_that_sent_the_app_to_the_background(backend):
    admin, ingest, _ = backend
    game = register(admin)

    def level(player, moment, state, number):
        return _played(
            player,
            f"s-{player}",
            moment,
            "LEVEL_ANALYSIS",
            {"STATE": state, "LEVEL_NUMBER": number},
        )

    def ad(player, moment, kind, placement):
        return _played(
            player,
            f"s-{player}",
            moment,
            "AD_ANALYSIS",
            {"FORMAT": kind, "PLACEMENT": placement, "STATE": "Show", "LEVEL_NUMBER": 2},
        )

    def app(player, moment, state, **params):
        return _played(player, f"s-{player}", moment, "APP_ANALYSIS", {"STATE": state, **params})

    records = []
    for player in ("inter", "reward", "player", "returned"):
        records.append(level(player, "04T09:00:00", "Started", 1))
        records.append(level(player, "04T09:00:40", "Completed", 1))
    # The interstitial is logged just before the level start; the ad then backgrounds the app.
    records += [
        ad("inter", "04T09:01:02", "Interstitial", "level_interstitial"),
        level("inter", "04T09:01:03", "Started", 2),
        app("inter", "04T09:01:04", "Background", CAUSE="Ad"),
        _played("inter", "s-inter", "04T09:01:05", "session_end", {"duration_seconds": 65}),
    ]
    # A power-up, then a rewarded ad after the level start.
    records += [
        level("reward", "04T09:01:03", "Started", 2),
        _played("reward", "s-reward", "04T09:01:25", "POWERUP_ANALYSIS", {"POWERUP": "two_x"}),
        ad("reward", "04T09:01:28", "Rewarded", "level_skip"),
        app("reward", "04T09:01:29", "Background", CAUSE="Ad"),
    ]
    # The player left the app themselves: not an ad.
    records += [
        level("player", "04T09:01:03", "Started", 2),
        ad("player", "04T09:01:01", "Interstitial", "level_interstitial"),
        app("player", "04T09:01:10", "Background", CAUSE="Player"),
    ]
    # Backgrounded by an ad, but they came back and kept playing: the last thing they did counts.
    records += [
        ad("returned", "04T09:01:02", "Interstitial", "level_interstitial"),
        level("returned", "04T09:01:03", "Started", 2),
        app("returned", "04T09:01:04", "Background", CAUSE="Ad"),
        app("returned", "04T09:01:09", "Foreground", AWAY_SECONDS=5),
        level("returned", "04T09:01:20", "Failed", 2),
    ]
    assert send(ingest, game, records).is_success
    rows = {
        row["player"]: row["last_action"]
        for row in _level_players(admin, game, 2, "left")["players"]
    }
    assert rows == {
        "inter": "Interstitial ad",
        "reward": "Rewarded ad",
        "player": "Started level 2",
        "returned": "Failed level 2",
    }


def test_level_players_show_the_last_event_sent_and_how_long_after_the_one_before(backend):
    admin, ingest, _ = backend
    game = register(admin)

    def level(player, moment, state, number):
        params = {"STATE": state, "LEVEL_NUMBER": number}
        return _played(player, f"s-{player}", moment, "LEVEL_ANALYSIS", params)

    records = [
        # The interstitial, then the level start, then nothing: the session end is not an event.
        level("ad", "04T09:00:40", "Completed", 1),
        _played(
            "ad",
            "s-ad",
            "04T09:00:44",
            "AD_ANALYSIS",
            {"FORMAT": "Interstitial", "STATE": "Show", "LEVEL_NUMBER": 2},
        ),
        level("ad", "04T09:00:45", "Started", 2),
        _played("ad", "s-ad", "04T09:00:50", "session_end", {"duration_seconds": 50}),
        # An ad took the app to the background after the level start.
        level("away", "04T09:00:45", "Started", 2),
        _played(
            "away",
            "s-away",
            "04T09:00:46",
            "APP_ANALYSIS",
            {"STATE": "Background", "CAUSE": "Ad", "LEVEL_NUMBER": 2},
        ),
        # The level start is the very first event they sent, and a later session is not counted.
        level("first", "04T09:00:45", "Started", 2),
        _played("first", "s-first-2", "05T09:00:00", "MM_ANALYSIS", {"STATUS": "OPENED"}),
        # An event without a state or details is shown by its name.
        level("plain", "04T09:00:45", "Started", 2),
        _played("plain", "s-plain", "04T09:02:00", "level_gate"),
    ]
    assert send(ingest, game, records).is_success
    rows = {row["player"]: row for row in _level_players(admin, game, 2, "left")["players"]}
    assert rows["ad"]["last_event"] == {
        "text": "LEVEL_ANALYSIS · Started",
        "gap": 1.0,
        "after": "AD_ANALYSIS · Show (Interstitial)",
        "after_level": None,
    }
    assert rows["away"]["last_event"] == {
        "text": "APP_ANALYSIS · Background (Ad)",
        "gap": 1.0,
        "after": "LEVEL_ANALYSIS · Started",
        "after_level": 1.0,
    }
    assert rows["first"]["last_event"] == {
        "text": "LEVEL_ANALYSIS · Started",
        "gap": None,
        "after": None,
        "after_level": None,
    }
    assert rows["plain"]["last_event"] == {
        "text": "level_gate",
        "gap": 75.0,
        "after": "LEVEL_ANALYSIS · Started",
        "after_level": 75.0,
    }
    # The same for new players within their first session.
    first = _level_players(admin, game, 2, "left", scope="first_session")
    assert {row["player"]: row["last_event"]["text"] for row in first["players"]}["ad"] == (
        "LEVEL_ANALYSIS · Started"
    )


def test_level_players_tell_the_last_event_apart_from_what_came_right_after_the_level(backend):
    admin, ingest, _ = backend
    game = register(admin)
    shop = {"SCREEN": "shop", "STATE": "Opened"}
    reward = {"FORMAT": "Rewarded", "STATE": "Closed"}
    records = [
        _played(
            "shop",
            "s-shop",
            "04T09:00:00",
            "LEVEL_ANALYSIS",
            {"STATE": "Started", "LEVEL_NUMBER": 1},
        ),
        _played(
            "shop",
            "s-shop",
            "04T09:00:40",
            "LEVEL_ANALYSIS",
            {"STATE": "Completed", "LEVEL_NUMBER": 1},
        ),
        # They open the shop right after the level, and watch a rewarded ad 17 minutes later.
        _played("shop", "s-shop", "04T09:00:50", "SCREEN_ANALYSIS", shop),
        _played(
            "shop", "s-shop", "04T09:17:44", "APP_ANALYSIS", {"STATE": "Foreground", "CAUSE": "Ad"}
        ),
        _played("shop", "s-shop", "04T09:17:44", "AD_ANALYSIS", reward),
        _played("shop", "s-shop", "04T09:20:00", "session_end", {"duration_seconds": 1200}),
        # Nothing at all after the level.
        _played(
            "quiet",
            "s-quiet",
            "04T09:00:00",
            "LEVEL_ANALYSIS",
            {"STATE": "Started", "LEVEL_NUMBER": 1},
        ),
        _played(
            "quiet",
            "s-quiet",
            "04T09:00:40",
            "LEVEL_ANALYSIS",
            {"STATE": "Completed", "LEVEL_NUMBER": 1},
        ),
    ]
    assert send(ingest, game, records).is_success
    rows = {
        row["player"]: row for row in _level_players(admin, game, 1, "finished_stopped")["players"]
    }
    assert rows["shop"]["last_action"] == "Rewarded ad"
    assert rows["shop"]["next_action"] == "Opened shop"
    assert rows["shop"]["last_event"]["after_level"] == 1024.0
    assert rows["quiet"]["last_action"] == "Completed level 1"
    assert rows["quiet"]["next_action"] is None
    assert rows["quiet"]["last_event"]["after_level"] is None


DAY = {"start": "2026-10-04", "end": "2026-10-05"}


def _scan_counter(monkeypatch, delay=0.0):
    """Count how often the level scans read the events (they are the slow part)."""
    import time

    from avn_analytics import journeys

    calls = {"levels": 0}
    scan = journeys._scan_levels

    def counted(*args, **kwargs):
        calls["levels"] += 1
        time.sleep(delay)
        return scan(*args, **kwargs)

    monkeypatch.setattr(journeys, "_scan_levels", counted)
    return calls


def _two_level_game(backend):
    admin, ingest, _ = backend
    game = register(admin)
    records = [
        _played("a", "s-a", "04T09:00:00", "level_started", {"level": 1}),
        _played("a", "s-a", "04T09:01:00", "level_completed", {"level": 1}),
        _played("a", "s-a", "04T09:02:00", "level_started", {"level": 2}),
        _played("b", "s-b", "04T09:00:00", "level_started", {"level": 1}),
    ]
    assert send(ingest, game, records).is_success
    return admin, game


def test_level_scans_are_shared_by_the_table_and_every_levels_players(backend, monkeypatch):
    admin, game = _two_level_game(backend)
    calls = _scan_counter(monkeypatch)
    table = admin.get(f"/v1/games/{game['id']}/insights/levels", params=DAY)
    assert table.status_code == 200
    for level in (1, 2, 1):
        assert _level_players(admin, game, level, "started").get("players") is not None
    assert admin.get(f"/v1/games/{game['id']}/insights/levels", params=DAY).json() == table.json()
    # One read of the events for the table and the players of all levels, however often the
    # page is opened or the level changes.
    assert calls == {"levels": 1}
    other = admin.get(
        f"/v1/games/{game['id']}/insights/levels", params={**DAY, "scope": "first_session"}
    )
    assert other.status_code == 200 and calls == {"levels": 2}


def test_level_scans_start_over_when_the_dictionary_or_an_environment_fix_changes(
    backend, monkeypatch
):
    admin, game = _two_level_game(backend)
    calls = _scan_counter(monkeypatch)
    url = f"/v1/games/{game['id']}/insights/levels"
    assert admin.get(url, params=DAY).status_code == 200
    assert admin.get(url, params=DAY).status_code == 200 and calls["levels"] == 1
    definition = {"description": "Done", "params": {}}
    assert (
        admin.put(f"/v1/games/{game['id']}/dictionary/level_x", json=definition).status_code == 200
    )
    assert admin.get(url, params=DAY).status_code == 200 and calls["levels"] == 2
    fix = {"from_environment": "development", "to_environment": "production", "note": "wrong mode"}
    assert admin.post(f"/v1/games/{game['id']}/environment-fixes", json=fix).status_code == 201
    assert admin.get(url, params=DAY).status_code == 200 and calls["levels"] == 3


def test_simultaneous_level_requests_wait_for_one_scan(backend, monkeypatch):
    admin, game = _two_level_game(backend)
    calls = _scan_counter(monkeypatch, delay=0.3)
    url = f"/v1/games/{game['id']}/insights/levels"
    with ThreadPoolExecutor(max_workers=4) as executor:
        responses = list(executor.map(lambda _: admin.get(url, params=DAY), range(4)))
    assert all(response.status_code == 200 for response in responses)
    assert calls == {"levels": 1}


def test_slow_dashboard_reads_are_kept_briefly_and_start_over_when_what_they_use_changes(
    backend, monkeypatch
):
    from avn_analytics import insights

    admin, game = _two_level_game(backend)
    calls = {"summary": 0}
    real = insights.summary

    def counting(*args, **kwargs):
        calls["summary"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(insights, "summary", counting)
    url = f"/v1/games/{game['id']}/insights/summary"
    first = admin.get(url, params=DAY)
    assert first.status_code == 200
    assert admin.get(url, params=DAY).json() == first.json() and calls["summary"] == 1
    # Another range or filter is another answer.
    assert admin.get(url, params={**DAY, "end": "2026-10-06"}).status_code == 200
    assert admin.get(url, params={**DAY, "not_env": "editor"}).status_code == 200
    assert calls["summary"] == 3
    # A dictionary change starts over at once, without waiting for the time to pass.
    definition = {"description": "Done", "params": {}}
    assert (
        admin.put(f"/v1/games/{game['id']}/dictionary/level_x", json=definition).status_code == 200
    )
    assert admin.get(url, params=DAY).status_code == 200 and calls["summary"] == 4


def test_a_game_that_does_not_exist_is_refused_even_when_reads_are_cached(backend):
    admin, _ = _two_level_game(backend)
    missing = "00000000-0000-4000-8000-000000000000"
    for path in ("insights/summary", "insights/facets", "insights/players"):
        assert admin.get(f"/v1/games/{missing}/{path}", params=DAY).status_code == 404


def test_the_read_cache_can_be_turned_off(backend, monkeypatch):
    from avn_analytics import insights

    _, ingest, settings = backend
    with TestClient(create_app(replace(settings, read_cache_seconds=0), admin=True)) as admin:
        game = register(admin, "com.avn.cache-off")
        calls = []
        real = insights.summary
        monkeypatch.setattr(insights, "summary", lambda *a, **k: calls.append(1) or real(*a, **k))
        for _ in range(2):
            assert (
                admin.get(f"/v1/games/{game['id']}/insights/summary", params=DAY).status_code == 200
            )
        assert len(calls) == 2
    with pytest.raises(ValueError, match="AVN_READ_CACHE_SECONDS"):
        replace(settings, read_cache_seconds=-1)


def test_scope_events_copies_the_days_and_filters_into_a_temporary_table(backend):
    from avn_analytics import insights

    admin, ingest, _ = backend
    game = register(admin)
    records = [
        event(
            device_id="a", name="level_started", session_id="s1", client_ts="2026-10-04T09:00:00Z"
        ),
        event(
            device_id="a", name="level_started", session_id="s1", client_ts="2026-10-04T09:05:00Z"
        ),
        event(device_id="b", name="shop_open", session_id="s2", client_ts="2026-10-04T10:00:00Z"),
        event(
            device_id="c", name="level_started", session_id="s3", client_ts="2026-10-09T10:00:00Z"
        ),
    ]
    assert send(ingest, game, records).is_success
    storage = admin.app.state.storage
    start, end = "2026-10-04T00:00:00.000000+00:00", "2026-10-05T00:00:00.000000+00:00"
    with storage.connect(storage.game_path(game["id"])) as connection:
        scoped = insights.scope_events(connection, start, end)
        rows = connection.execute(f"SELECT * FROM {scoped} ORDER BY client_ts").fetchall()
        assert [row["player"] for row in rows] == ["a", "a", "b"]  # c is another day
        assert {"client_ts", "name", "player", "session_id", "environment", "app_version"} <= set(
            rows[0].keys()
        )
        only = insights.scope_events(connection, start, end, only="shop_open", table="shop")
        assert [row["player"] for row in connection.execute(f"SELECT * FROM {only}")] == ["b"]
        filtered = insights.scope_events(connection, start, end, {"app_versions": ["9.9"]})
        assert connection.execute(f"SELECT count(*) FROM {filtered}").fetchone()[0] == 0
        # Asking again starts the table over rather than adding to it.
        again = insights.scope_events(connection, start, end)
        assert connection.execute(f"SELECT count(*) FROM {again}").fetchone()[0] == 3
    # Nothing is written to the game's database: the table lived with the connection.
    with storage.connect(storage.game_path(game["id"])) as connection:
        names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master")}
    assert not names & {"scoped", "shop"}


def test_levels_for_new_players_count_only_their_first_session(backend):
    admin, ingest, _ = backend
    game = register(admin)
    records = [
        # new-1 quits level 2 in their first session and plays on in a second one.
        _played("new-1", "n1-a", "04T09:00:00", "session_start"),
        _played("new-1", "n1-a", "04T09:01:00", "level_started", {"level": 1}),
        _played("new-1", "n1-a", "04T09:02:00", "level_completed", {"level": 1}),
        _played("new-1", "n1-a", "04T09:03:00", "level_started", {"level": 2}),
        _played("new-1", "n1-a", "04T09:04:00", "level_failed", {"level": 2}),
        _played("new-1", "n1-b", "04T15:00:00", "level_started", {"level": 2}),
        _played("new-1", "n1-b", "04T15:01:00", "level_completed", {"level": 2}),
        _played("new-1", "n1-b", "04T15:02:00", "level_started", {"level": 3}),
        # new-2 wins level 1 and their first session ends.
        _played("new-2", "n2-a", "04T10:00:00", "level_started", {"level": 1}),
        _played("new-2", "n2-a", "04T10:01:00", "level_completed", {"level": 1}),
        # A returning player and a new player outside the filters are not counted.
        _played("old", "o-a", "01T10:00:00", "MM_ANALYSIS", {"STATUS": "OPENED"}),
        _played("old", "o-b", "04T10:00:00", "level_started", {"level": 1}),
        _played("other", "x-a", "04T10:00:00", "level_started", {"level": 1}, app_version="2.0"),
    ]
    assert send(ingest, game, records).is_success
    url = f"/v1/games/{game['id']}/insights/levels"
    params = {"start": "2026-10-04", "end": "2026-10-04", "version": "1.0"}
    everyone = {row["level"]: row for row in admin.get(url, params=params).json()["levels"]}
    assert everyone[1]["started"] == 3 and everyone[2]["transition"]["total_drop"] == 0
    data = admin.get(url, params={**params, "scope": "first_session"}).json()
    assert data["context"]["scope"] == "first_session"
    rows = {row["level"]: row for row in data["levels"]}
    assert sorted(rows) == [1, 2]
    assert (rows[1]["started"], rows[1]["completed"]) == (2, 2)
    assert rows[1]["transition"]["kept_going"] == 1
    assert rows[1]["transition"]["finished_stopped"] == 1
    assert (rows[2]["started"], rows[2]["completed"], rows[2]["fails"]) == (1, 0, 1)
    assert rows[2]["transition"]["left"] == 1 and rows[2]["quit"] == 1
    scoped = {**params, "scope": "first_session"}
    quit_level_2 = _level_players(admin, game, 2, "left", **scoped)
    (row,) = quit_level_2["players"]
    assert row["player"] == "new-1" and row["came_back"] is True
    assert row["session_seconds"] == 240 and row["last_action"] == "Failed level 2"
    after_win = _level_players(admin, game, 1, "finished_stopped", **scoped)
    assert [row["player"] for row in after_win["players"]] == ["new-2"]
    assert after_win["players"][0]["came_back"] is False
    assert admin.get(url, params={**params, "scope": "bogus"}).status_code == 400
    players_url = f"/v1/games/{game['id']}/insights/levels/players"
    bogus = admin.get(players_url, params={**params, "level": 1, "scope": "bogus"})
    assert bogus.status_code == 400


def test_journey_events_carry_their_id_and_level_number(backend):
    admin, ingest, _ = backend
    game = register(admin)
    records = [
        _played("p1", "s1", "04T09:00:00", "level_started", {"level": 4}),
        _played("p1", "s1", "04T09:01:00", "MM_ANALYSIS", {"STATUS": "OPENED"}),
    ]
    assert send(ingest, game, records).is_success
    events = admin.get(
        f"/v1/games/{game['id']}/insights/journey",
        params={"player": "p1", "start": "2026-10-04", "end": "2026-10-04"},
    ).json()["events"]
    assert [(item["event_id"], item["level"]) for item in events] == [
        (records[0]["event_id"], 4),
        (records[1]["event_id"], None),
    ]


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


def test_level_transitions_match_players_across_updates_and_missing_history(backend):
    admin, ingest, _ = backend
    game = register(admin)

    def progress(player, level, verb, moment, version="0.3", **extra):
        return event(
            device_id=player,
            name=f"level_{verb}",
            params={"level": level},
            session_id=f"{player}-{version}-{moment}",
            client_ts=f"2026-10-{moment}Z",
            app_version=version,
            **extra,
        )

    records = [
        progress("during", 1, "start", "04T09:00:00"),
        progress("after", 1, "start", "04T09:00:00"),
        progress("after", 1, "complete", "04T09:01:00"),
        progress("update", 1, "start", "04T09:00:00", "0.2"),
        progress("update", 1, "complete", "04T09:01:00"),
        progress("update", 2, "start", "04T09:02:00"),
        progress("missing-finish", 1, "start", "04T09:00:00"),
        progress("missing-finish", 2, "start", "04T09:02:00"),
        progress("missing-next", 1, "start", "04T09:00:00"),
        progress("missing-next", 3, "start", "04T09:02:00"),
        progress("returning", 1, "start", "03T09:00:00", "0.2"),
        progress("returning", 1, "complete", "03T09:01:00", "0.2"),
        progress("returning", 2, "start", "04T09:02:00"),
        progress("untracked-upgrade", 2, "start", "04T09:02:00"),
        progress("finish-only", 1, "complete", "04T09:01:00"),
        progress("during", 2, "start", "05T09:00:00"),
        progress("reverse", 2, "start", "04T08:00:00"),
        progress("reverse", 1, "start", "04T09:00:00"),
        progress("during", 2, "start", "04T10:00:00", environment="editor"),
    ]
    assert send(ingest, game, records).status_code == 200
    url = f"/v1/games/{game['id']}/insights/levels"
    selected = {
        "start": "2026-10-04",
        "end": "2026-10-04",
        "not_env": "editor",
    }
    response = admin.get(url, params=selected)
    assert response.status_code == 200, response.text
    rows = {row["level"]: row for row in response.json()["levels"]}
    summary = rows[1]["transition"]
    assert rows[1]["started"] == 6
    assert rows[1]["completed"] == 2
    assert rows[1]["observed_completed"] == 3
    assert summary["kept_going"] == 2
    assert summary["total_drop"] == 4
    assert summary["left"] == 2
    assert summary["finished_stopped"] == 1
    assert summary["unknown_progress"] == 1
    assert summary["drop_percent"] == 66.7
    assert summary["returning"] == 1
    assert summary["missing_history"] == 2
    assert summary["net_change"] == -1
    assert rows[2]["transition"]["starters_returning"] == 1
    assert rows[2]["transition"]["starters_missing_history"] == 2
    assert rows[3]["transition"]["available"] is False
    assert rows[3]["transition"]["drop_percent"] is None
    for group in ("total_drop", "left", "finished_stopped", "unknown_progress", "kept_going"):
        details = _level_players(admin, game, 1, group, **selected)
        assert details["total"] == summary[group]
    filtered = admin.get(url, params={**selected, "version": "0.2"}).json()["levels"]
    earlier = next(row for row in filtered if row["level"] == 1)
    assert earlier["started"] == 1
    assert earlier["completed"] == 1
    assert earlier["transition"]["total_drop"] == 0
    assert earlier["transition"]["kept_going"] == 1
    later = admin.get(url, params={**selected, "version": "0.3"}).json()["levels"]
    assert next(row for row in later if row["level"] == 1)["transition"]["returning"] == 2
    extended = admin.get(url, params={**selected, "end": "2026-10-05"}).json()["levels"]
    assert next(row for row in extended if row["level"] == 1)["transition"]["total_drop"] == 3


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


def test_players_sort_by_average_session_length_using_last_event_as_end(backend):
    admin, ingest, _ = backend
    game = register(admin)
    events = [
        event(
            device_id="long",
            session_id="long-1",
            name="session_end",
            params={"duration_seconds": 100},
            client_ts="2026-10-04T09:00:00Z",
        ),
        event(
            device_id="long",
            session_id="long-2",
            name="session_end",
            params={"duration_seconds": 300},
            client_ts="2026-10-04T10:00:00Z",
        ),
        event(
            device_id="short",
            session_id="short-1",
            name="session_end",
            params={"duration_seconds": 30},
            client_ts="2026-10-04T11:00:00Z",
        ),
        event(
            device_id="short",
            session_id="short-2",
            name="session_end",
            params={"duration_seconds": 60},
            client_ts="2026-10-04T12:00:00Z",
        ),
        event(device_id="inferred", session_id="inferred-1", client_ts="2026-10-04T13:00:00Z"),
        event(device_id="inferred", session_id="inferred-1", client_ts="2026-10-04T13:01:30Z"),
        event(device_id="single", session_id="single-1", client_ts="2026-10-04T14:00:00Z"),
    ]
    assert send(ingest, game, events).status_code == 200

    longest = _players(admin, game, sort="session_length", order="desc")["players"]
    assert [player["player"] for player in longest] == ["long", "inferred", "short", "single"]
    assert [player["avg_session_seconds"] for player in longest] == [200.0, 90.0, 45.0, 0.0]
    assert [player["total_play_seconds"] for player in longest] == [400.0, 90.0, 90.0, 0.0]

    shortest = _players(admin, game, sort="session_length", order="asc")["players"]
    assert [player["player"] for player in shortest] == ["single", "short", "inferred", "long"]


def test_players_total_playtime_sums_sessions_before_rounding_and_respects_filters(backend):
    admin, ingest, _ = backend
    game = register(admin)
    events = [
        event(
            device_id="many-short",
            session_id=f"short-{index}",
            name="session_end",
            params={"duration_seconds": 10.04},
        )
        for index in range(3)
    ]
    events += [
        event(device_id="one-long", session_id="one", name="session_start", params={}),
        event(
            device_id="one-long",
            session_id="one",
            name="session_end",
            params={"duration_seconds": 20},
            client_ts="2026-10-04T09:05:00Z",
        ),
        event(
            device_id="one-long",
            session_id="one",
            name="session_end",
            params={"duration_seconds": 15},
            client_ts="2026-10-04T09:06:00Z",
        ),
        event(
            device_id="many-short",
            session_id="outside-range",
            name="session_end",
            params={"duration_seconds": 1000},
            client_ts="2026-10-05T09:00:00Z",
        ),
    ]
    assert send(ingest, game, events).status_code == 200
    _send_as(
        ingest,
        game,
        "editor",
        [
            event(
                device_id="many-short",
                session_id="editor",
                name="session_end",
                params={"duration_seconds": 500},
            )
        ],
    )
    query = {"sort": "playtime", "not_env": "editor"}
    longest = _players(admin, game, **query, order="desc")["players"]
    assert [player["player"] for player in longest] == ["many-short", "one-long"]
    assert [player["total_play_seconds"] for player in longest] == [30.1, 20.0]
    assert [player["avg_session_seconds"] for player in longest] == [10.0, 20.0]
    shortest = _players(admin, game, **query, order="asc")["players"]
    assert [player["player"] for player in shortest] == ["one-long", "many-short"]
    assert _players(admin, game, **query, offset=1)["players"][0]["player"] == "one-long"


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


def test_player_metrics_prefer_user_id_and_fall_back_to_device_id(backend):
    admin, ingest, _ = backend
    game = register(admin)
    identified = event(device_id="install-a", user_id="user-a")
    install_only = event(device_id="install-b", user_id=None)
    assert send(ingest, game, [identified, install_only]).status_code == 200
    base = f"/v1/games/{game['id']}/insights"
    days = {"start": "2026-10-04", "end": "2026-10-04"}
    summary = admin.get(f"{base}/summary", params=days).json()
    assert summary["events"] == 2 and summary["players"] == 2
    assert summary["context"]["identified_events"] == 2
    assert summary["context"]["anonymous_events"] == 0
    players = admin.get(f"{base}/players", params=days).json()
    assert {item["player"] for item in players["players"]} == {"user-a", "install-b"}
    assert {item["player"]: item["has_user_id"] for item in players["players"]} == {
        "user-a": 1,
        "install-b": 0,
    }
    assert players["context"]["anonymous_events"] == 0


def test_analytics_threshold_defaults_and_game_overrides(backend):
    admin, _, _ = backend
    game = register(admin)
    workspace = admin.get("/v1/overview").json()["workspace"]
    defaults = {
        "retention_min_users": 40,
        "levels_min_players": 12,
        "funnels_min_players": 15,
    }
    response = admin.patch(f"/v1/workspaces/{workspace}/analytics-thresholds", json=defaults)
    assert response.status_code == 200 and response.json() == defaults
    details = admin.get(f"/v1/games/{game['id']}").json()["analytics_thresholds"]
    assert details["levels_min_players"] == 12 and details["levels_override"] is None
    response = admin.patch(
        f"/v1/games/{game['id']}/analytics-thresholds",
        json={
            "retention_min_users": None,
            "levels_min_players": 5,
            "funnels_min_players": None,
        },
    )
    assert response.status_code == 200
    assert response.json()["levels_min_players"] == 5
    assert response.json()["retention_min_users"] == 40


def test_parameter_condition_can_map_a_canonical_level_event(backend):
    admin, ingest, _ = backend
    game = register(admin)
    dictionary = f"/v1/games/{game['id']}/dictionary/GAME_STATE"
    definition = {
        "description": "A shared state event",
        "params": {"STATE": "State", "LEVEL": "Level number"},
        "canonical": [
            {"action": "level_started", "param": "STATE", "op": "eq", "value": "Started"},
            {
                "action": "level_completed",
                "param": "STATE",
                "op": "eq",
                "value": "Completed",
            },
        ],
    }
    assert admin.put(dictionary, json=definition).status_code == 200
    events = [
        event(name="GAME_STATE", params={"STATE": "Started", "LEVEL": 4}),
        event(name="GAME_STATE", params={"STATE": "Completed", "LEVEL": 4}),
    ]
    assert send(ingest, game, events).status_code == 200
    levels = admin.get(
        f"/v1/games/{game['id']}/insights/levels",
        params={"start": "2026-10-04", "end": "2026-10-04"},
    ).json()["levels"]
    assert levels[0]["level"] == 4
    assert levels[0]["started"] == 1 and levels[0]["completed"] == 1


def test_retention_uses_identified_session_starts_and_exact_days(backend):
    admin, ingest, _ = backend
    game = register(admin)

    def session(player, day, user=True):
        return event(
            name="session_start",
            device_id=f"install-{player}",
            user_id=player if user else None,
            session_id=f"{player}-{day}",
            client_ts=f"2026-09-{day}T09:00:00Z",
        )

    events = [
        session("p1", "01"),
        session("p1", "02"),
        session("p1", "04"),
        session("p2", "01"),
        session("p2", "02"),
        session("p3", "02"),
        session("install-only", "01", user=False),
    ]
    assert send(ingest, game, events).status_code == 200
    data = admin.get(
        f"/v1/games/{game['id']}/insights/retention",
        params={"start": "2026-09-01", "end": "2026-09-01"},
    ).json()
    assert data["context"]["qualifying_event"] == "session_start"
    assert data["context"]["anonymous_events"] == 0
    assert data["context"]["identified_players"] == 3
    assert len(data["cohorts"]) == 1
    cohort = data["cohorts"][0]
    assert cohort["players"] == 3
    assert cohort["retained"]["1"] == {"players": 2, "percent": 66.7}
    assert cohort["retained"]["3"] == {"players": 1, "percent": 33.3}


def test_retention_honors_canonical_mapping_and_local_day(backend):
    admin, ingest, _ = backend
    game = register(admin)
    definition = {
        "description": "The game opened a playable session",
        "params": {"STATUS": "Session state"},
        "canonical": [{"action": "session_start", "param": "STATUS", "op": "eq", "value": "Open"}],
    }
    assert (
        admin.put(f"/v1/games/{game['id']}/dictionary/GAME_SESSION", json=definition).status_code
        == 200
    )
    events = [
        event(
            name="GAME_SESSION",
            device_id="install-a",
            user_id="user-a",
            session_id="session-a1",
            params={"STATUS": "Open"},
            client_ts="2026-09-01T23:30:00Z",
        ),
        event(
            name="GAME_SESSION",
            device_id="install-a",
            user_id="user-a",
            session_id="session-a2",
            params={"STATUS": "Open"},
            client_ts="2026-09-02T23:30:00Z",
        ),
    ]
    assert send(ingest, game, events).status_code == 200
    data = admin.get(
        f"/v1/games/{game['id']}/insights/retention",
        params={"start": "2026-09-02", "end": "2026-09-02", "tz_offset": 120},
    ).json()
    assert data["context"]["mapped_event_names"] == ["GAME_SESSION"]
    assert data["cohorts"][0]["day"] == "2026-09-02"
    assert data["cohorts"][0]["retained"]["1"]["percent"] == 100.0


def _insights(admin, game, path, **params):
    response = admin.get(
        f"/v1/games/{game['id']}/{path}",
        params={"start": "2026-10-04", "end": "2026-10-04", **params},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_events_overview_lists_every_event_with_counts_and_meaning(backend):
    admin, game = _journey_game(backend)
    url = f"/v1/games/{game['id']}/dictionary"
    assert (
        admin.put(
            f"{url}/MM_ANALYSIS",
            json={"description": "Main menu", "params": {"STATUS": "OPENED or CLOSED"}},
        ).status_code
        == 200
    )
    admin.put(f"{url}/ghost_event", json={"description": "Never sent", "params": {}})
    data = _insights(admin, game, "insights/events")
    rows = {row["name"]: row for row in data["events"]}
    assert set(rows) == {
        "first_open",
        "MM_ANALYSIS",
        "LEVEL_ANALYSIS",
        "POWERUP_CONSUMED",
        "level_gate",
        "ghost_event",
    }
    assert rows["LEVEL_ANALYSIS"]["range"]["events"] == 16
    assert rows["LEVEL_ANALYSIS"]["range"]["players"] == 3
    assert rows["first_open"]["range"]["players"] == 4 and rows["first_open"]["sdk"]
    assert rows["MM_ANALYSIS"]["described"] and rows["MM_ANALYSIS"]["params_missing"] == []
    assert rows["LEVEL_ANALYSIS"]["described"] is False
    assert sorted(rows["LEVEL_ANALYSIS"]["params_missing"]) == [
        "Completed",
        "Failed",
        "Restarted",
        "Started",
    ]
    assert rows["ghost_event"]["status"] == "never" and rows["ghost_event"]["ever"] is None
    assert rows["MM_ANALYSIS"]["status"] == "active"  # sent within the last 30 days
    assert data["days"] == ["2026-10-04"] and rows["LEVEL_ANALYSIS"]["series"] == [16]
    assert data["summary"]["needs_description"] == 3  # level events, power-up, level_gate
    assert data["summary"]["never_received"] == 1
    # totals are all time and not narrowed by the days: every event ever received, the stored size
    assert data["summary"]["received_total"] == sum(
        row["ever"]["events"] for row in rows.values() if row["ever"]
    )
    assert data["summary"]["event_types"] == 5 and data["summary"]["database_bytes"] > 0
    # outside the range the events keep their all-time numbers but show nothing in range
    empty = _insights(admin, game, "insights/events", start="2026-09-01", end="2026-09-02")
    level = next(row for row in empty["events"] if row["name"] == "LEVEL_ANALYSIS")
    assert level["range"]["events"] == 0 and level["ever"]["events"] == 16
    assert empty["summary"]["received_total"] == data["summary"]["received_total"]


def test_event_detail_shows_activity_parameters_and_examples(backend):
    admin, game = _journey_game(backend)
    detail = _insights(admin, game, "insights/events/detail", name="LEVEL_ANALYSIS")
    assert detail["days"] == [{"day": "2026-10-04", "events": 16, "players": 3}]
    assert [item["version"] for item in detail["versions"]] == ["1.0"]
    assert detail["missing_in_newest"] is False
    by_key = {item["key"]: item for item in detail["params"]}
    assert set(by_key) == {"Started", "Completed", "Failed", "Restarted"}
    assert by_key["Started"]["count"] == 7 and by_key["Started"]["types"] == ["string"]
    assert (
        by_key["Started"]["values"][0]["value"] == "1"
        and by_key["Started"]["values"][0]["count"] == 3
    )
    assert len(detail["samples"]) == 5
    assert all(sample["version"] == "1.0" for sample in detail["samples"])
    missing = admin.get(
        f"/v1/games/{game['id']}/insights/events/detail",
        params={"start": "2026-10-04", "end": "2026-10-04", "name": "nothing_like_it"},
    )
    assert missing.status_code == 404


def test_event_detail_flags_an_event_missing_from_the_newest_version(backend):
    admin, ingest, _ = backend
    game = register(admin)
    send(
        ingest,
        game,
        [
            event(name="old_feature", app_version="1.0", device_id="a"),
            event(name="other", app_version="1.0", device_id="a"),
            event(name="other", app_version="1.10", device_id="b"),
        ],
    )
    detail = _insights(admin, game, "insights/events/detail", name="old_feature")
    assert detail["newest_version"] == "1.10" and detail["missing_in_newest"] is True
    fine = _insights(admin, game, "insights/events/detail", name="other")
    assert fine["missing_in_newest"] is False


def test_mappings_show_what_is_understood_and_let_any_event_be_mapped(backend):
    admin, game = _journey_game(backend)
    _, ingest, _ = backend
    data = _insights(admin, game, "mappings")
    concepts = {item["key"]: item for item in data["concepts"]}
    assert list(concepts) == [
        "session_start",
        "level_started",
        "level_completed",
        "level_failed",
        "level_restarted",
    ]
    assert concepts["session_start"]["status"] == "missing"  # this game sends no session_start
    started = concepts["level_started"]
    assert started["status"] == "auto"
    assert [(s["event"], s["via"]) for s in started["sources"]] == [("LEVEL_ANALYSIS", "auto")]
    assert started["sources"][0]["levels"] == {"count": 3, "min": 1, "max": 3}
    assert any(item["name"] == "MM_ANALYSIS" for item in data["events"])

    # an event that is not defined yet can be mapped; it then counts as a session start
    url = f"/v1/games/{game['id']}/dictionary/MM_ANALYSIS/mappings"
    rule = {"action": "session_start", "param": "STATUS", "op": "eq", "value": "OPENED"}
    assert admin.put(url, json={"canonical": [rule]}).status_code == 200
    mapped = {item["key"]: item for item in _insights(admin, game, "mappings")["concepts"]}
    source = mapped["session_start"]["sources"][0]
    assert mapped["session_start"]["status"] == "mapped"
    assert (source["event"], source["via"], source["events"], source["players"]) == (
        "MM_ANALYSIS",
        "mapped",
        4,
        3,
    )
    definition = admin.get(f"/v1/games/{game['id']}/dictionary").json()["MM_ANALYSIS"]
    assert definition["description"] == "" and definition["canonical"][0]["value"] == "OPENED"
    # still listed as needing a description, with its mapping kept when it is described later
    found = admin.get(f"/v1/games/{game['id']}/dictionary/discovery").json()["missing"]
    assert any(item["name"] == "MM_ANALYSIS" and item["defined"] is False for item in found)
    full = {**definition, "description": "Main menu"}
    assert admin.put(f"/v1/games/{game['id']}/dictionary/MM_ANALYSIS", json=full).status_code == 200
    kept = admin.get(f"/v1/games/{game['id']}/dictionary").json()["MM_ANALYSIS"]
    assert kept["canonical"] == definition["canonical"] and kept["description"] == "Main menu"

    # a level event whose number sits in a parameter the dashboards would not guess
    events = [
        event(
            name="StageBegin",
            device_id="q1",
            session_id="s-q1",
            client_ts="2026-10-04T11:00:00Z",
            params={"Stage": 7},
        )
    ]
    assert send(ingest, game, events).status_code == 200
    stage = {"action": "level_started", "number_param": "Stage"}
    preview = admin.post(
        f"/v1/games/{game['id']}/mappings/preview", json={"event": "StageBegin", "rule": stage}
    ).json()
    assert preview["events"] == 1 and preview["with_level_number"] == 1
    assert preview["levels"] == {"count": 1, "min": 7, "max": 7}
    blind = admin.post(
        f"/v1/games/{game['id']}/mappings/preview",
        json={"event": "StageBegin", "rule": {"action": "level_started"}},
    ).json()
    assert blind["events"] == 1 and blind["with_level_number"] == 0  # no "level" parameter
    levels = lambda: {  # noqa: E731
        row["level"]
        for row in admin.get(
            f"/v1/games/{game['id']}/insights/levels",
            params={"start": "2026-10-04", "end": "2026-10-04"},
        ).json()["levels"]
    }
    assert 7 not in levels()
    admin.put(f"/v1/games/{game['id']}/dictionary/StageBegin/mappings", json={"canonical": [stage]})
    assert 7 in levels()
    # removing every rule leaves a plain definition behind
    assert (
        admin.put(
            f"/v1/games/{game['id']}/dictionary/StageBegin/mappings", json={"canonical": []}
        ).json()["canonical"]
        == []
    )
    assert 7 not in levels()
    assert admin.put(url, json={"canonical": [{"action": "bad action"}]}).status_code == 400


def test_version_mappings_are_shared_by_dashboards_and_previewed_in_scope(backend):
    admin, ingest, _ = backend
    game = register(admin)
    base = f"/v1/games/{game['id']}"
    records = [
        event(
            name="STAGE_FLOW",
            params={"Stage": 7},
            app_version=version,
            device_id=version,
            session_id=version,
        )
        for version in ("0.1.1", "0.1.2")
    ]
    assert send(ingest, game, records).status_code == 200
    rules = [
        {"action": "level_started", "number_param": "Stage", "app_version": "0.1.1"},
        {"action": "level_completed", "number_param": "Stage", "app_version": "0.1.2"},
    ]
    assert admin.put(f"{base}/dictionary/STAGE_FLOW/mappings", json={"canonical": rules}).is_success
    preview = admin.post(
        f"{base}/mappings/preview", json={"event": "STAGE_FLOW", "rule": rules[0]}
    ).json()
    assert preview["scanned"] == preview["events"] == preview["with_level_number"] == 1
    scoped = admin.get(f"{base}/mappings", params={"version": "0.1.1"}).json()
    concepts = {item["key"]: item for item in scoped["concepts"]}
    assert scoped["versions"] == ["0.1.2", "0.1.1"]
    assert scoped["events"][0]["events"] == 1
    assert concepts["level_started"]["sources"][0]["events"] == 1
    assert concepts["level_completed"]["rules"] == []
    assert len(scoped["definitions"]["STAGE_FLOW"]) == 2  # preserves the other release on edits
    date_range = {"start": "2026-10-04", "end": "2026-10-04"}
    levels = admin.get(f"{base}/insights/levels", params=date_range).json()["levels"]
    assert levels[0]["started"] == levels[0]["observed_completed"] == 1
    for version, verb in (("0.1.1", "started"), ("0.1.2", "completed")):
        story = admin.get(f"{base}/insights/story", params={**date_range, "player": version}).json()
        assert story["highest_level"] == 7
        assert story["chapters"][0]["segments"][0]["levels"][0][verb] == 1


@pytest.mark.parametrize(
    ("params", "action", "condition", "number_param"),
    [
        ({"Started": 3}, "level_started", {"param": "Started", "op": "exists"}, "Started"),
        (
            {"Completed": "3"},
            "level_completed",
            {"param": "Completed", "op": "exists"},
            "Completed",
        ),
        (
            {"action": "failed", "level": 3},
            "level_failed",
            {"param": "action", "value": "failed"},
            "level",
        ),
        (
            {"STATE": "Started", "NUMBER": 3},
            "level_started",
            {"param": "STATE", "value": "Started"},
            "NUMBER",
        ),
    ],
)
def test_level_analysis_suggestions_separate_parameter_actions(
    backend, params, action, condition, number_param
):
    admin, ingest, _ = backend
    game = register(admin)
    assert send(ingest, game, [event(name="LEVEL_ANALYSIS", params=params)]).is_success
    base = f"/v1/games/{game['id']}"
    mappings = admin.get(f"{base}/mappings", params={"version": "1.0"}).json()
    concept = next(item for item in mappings["concepts"] if item["key"] == action)
    assert concept["status"] == "auto"
    assert concept["sources"][0]["levels"] == {"count": 1, "min": 3, "max": 3}
    suggestion = next(
        item for item in mappings["events"][0]["suggestions"] if item["action"] == action
    )
    assert suggestion["app_version"] == "1.0" and suggestion["number_param"] == number_param
    assert all(suggestion[key] == value for key, value in condition.items())
    preview = admin.post(
        f"{base}/mappings/preview", json={"event": "LEVEL_ANALYSIS", "rule": suggestion}
    ).json()
    assert preview["events"] == preview["with_level_number"] == 1


def test_version_rules_override_broad_shared_rules_for_level_analysis(backend):
    admin, ingest, _ = backend
    game = register(admin)
    base = f"/v1/games/{game['id']}"
    records = [
        event(
            name="LEVEL_ANALYSIS",
            app_version="0.1.1",
            params={"STATE": state, "NUMBER": 3},
            client_ts=f"2026-10-04T09:0{index}:00Z",
        )
        for index, state in enumerate(("Started", "Failed", "Completed"))
    ]
    assert send(ingest, game, records).is_success
    broad = [
        {"action": action, "number_param": "NUMBER"}
        for action in ("level_completed", "level_failed")
    ]
    url = f"{base}/dictionary/LEVEL_ANALYSIS/mappings"
    assert admin.put(url, json={"canonical": broad}).is_success
    before = admin.get(f"{base}/mappings", params={"version": "0.1.1"}).json()
    assert before["conflicts"] == [{"event": "LEVEL_ANALYSIS", "events": 3}]
    scoped = [
        {
            "action": f"level_{action}",
            "param": "STATE",
            "value": state,
            "number_param": "NUMBER",
            "app_version": "0.1.1",
        }
        for action, state in (
            ("started", "Started"),
            ("completed", "Completed"),
            ("failed", "Failed"),
        )
    ]
    preview = admin.post(
        f"{base}/mappings/preview", json={"event": "LEVEL_ANALYSIS", "rule": scoped[0]}
    ).json()
    assert preview["events"] == 1 and preview["conflicting_events"] == 0
    assert admin.put(url, json={"canonical": [*broad, *scoped]}).is_success
    after = admin.get(f"{base}/mappings", params={"version": "0.1.1"}).json()
    assert after["conflicts"] == []
    for concept in after["concepts"]:
        if concept["key"] in ("level_started", "level_completed", "level_failed"):
            assert len(concept["rules"]) == 1
            assert concept["sources"][0]["events"] == 1
    date_range = {"start": "2026-10-04", "end": "2026-10-04"}
    level = admin.get(f"{base}/insights/levels", params=date_range).json()["levels"][0]
    assert level["attempts"] == level["fails"] == level["completed"] == 1
    story = admin.get(
        f"{base}/insights/story", params={**date_range, "player": "anonymous-install-id"}
    ).json()
    row = story["chapters"][0]["segments"][0]["levels"][0]
    assert row["started"] == row["completed"] == row["failed"] == 1


def test_retention_respects_mapping_version(backend):
    admin, ingest, _ = backend
    game = register(admin)
    base = f"/v1/games/{game['id']}"
    assert send(
        ingest,
        game,
        [
            event(name="OPEN", params={}, device_id=version, app_version=version)
            for version in ("1.0", "2.0")
        ],
    ).is_success
    assert admin.put(
        f"{base}/dictionary/OPEN/mappings",
        json={"canonical": [{"action": "session_start", "app_version": "1.0"}]},
    ).is_success
    result = admin.get(
        f"{base}/insights/retention", params={"start": "2026-10-04", "end": "2026-10-04"}
    ).json()
    assert result["cohorts"][0]["players"] == 1


def test_mapping_status_flags_missing_level_moments_and_silent_rules(backend):
    admin, ingest, _ = backend
    game = register(admin)
    base = f"/v1/games/{game['id']}"
    # nothing received yet: nothing to map, nothing to nag about
    assert admin.get(f"{base}/mappings/status").json() == {
        "ok": True,
        "has_events": False,
        "issues": [],
    }
    send(
        ingest,
        game,
        [
            event(name="StageBegin", params={"stage": 1}),
            event(name="StageEnd", params={"stage": 1}),
            event(name="session_start", params={"environment": "production"}),
        ],
    )
    status = admin.get(f"{base}/mappings/status").json()
    assert status["ok"] is False and status["has_events"] is True
    missing = {item["concept"] for item in status["issues"] if item["kind"] == "missing"}
    assert missing == {"level_started", "level_completed"}  # failed/restarted are optional
    assert "Levels" in status["issues"][0]["used_by"]

    def mapping(event_name, canonical):
        response = admin.put(
            f"{base}/dictionary/{event_name}/mappings", json={"canonical": canonical}
        )
        assert response.status_code == 200

    mapping("StageBegin", [{"action": "level_started", "number_param": "stage"}])
    mapping("StageEnd", [{"action": "level_completed", "number_param": "stage"}])
    assert admin.get(f"{base}/mappings/status").json()["ok"] is True
    # a rule that matches nothing the game sent is reported, with the event it sits on
    mapping(
        "StageEnd",
        [
            {"action": "level_completed", "number_param": "stage"},
            {"action": "level_failed", "param": "stage", "op": "eq", "value": "999"},
        ],
    )
    status = admin.get(f"{base}/mappings/status").json()
    assert status["ok"] is False
    assert [(i["kind"], i["concept"], i["event"]) for i in status["issues"]] == [
        ("silent", "level_failed", "StageEnd")
    ]


def _conditional_activity(admin, game, conditions=None, **overrides):
    return admin.post(
        f"/v1/games/{game['id']}/insights/events/activity",
        headers=AUTH,
        json={
            "name": "AD_ANALYSIS",
            "start": "2026-10-04",
            "end": "2026-10-04",
            "conditions": conditions,
            **overrides,
        },
    )


def test_conditional_activity_counts_nested_groups_and_labels_average_denominators(backend):
    admin, ingest, _ = backend
    game = register(admin)
    shown = {"STAGE": "Shown", "PLACEMENT": "Rewarded", "LEVEL": 5}
    legacy = event(name="AD_ANALYSIS", device_id="legacy", params=shown)
    assert (
        send(
            ingest,
            game,
            [
                event(name="AD_ANALYSIS", device_id="p1", user_id="account", params=shown),
                event(name="AD_ANALYSIS", device_id="p2", user_id="account", params=shown),
                event(
                    name="AD_ANALYSIS",
                    device_id="p3",
                    params={**shown, "PLACEMENT": "Interstitial"},
                ),
                legacy,
                event(name="AD_ANALYSIS", device_id="p4", params={**shown, "STAGE": "Clicked"}),
                event(name="other_event", device_id="p5", params=shown),
                event(name="AD_ANALYSIS", device_id="p6", params=shown, app_version="2.0"),
            ],
        ).status_code
        == 200
    )
    # Older databases may contain events with no player identity.
    storage = admin.app.state.storage
    with storage.connect(storage.game_path(game["id"])) as connection:
        connection.execute(
            "UPDATE events SET payload=json_remove(payload, '$.device_id') WHERE event_id=?",
            (legacy["event_id"],),
        )
    tree = {
        "match": "all",
        "conditions": [
            {"field": "event", "value": "AD_ANALYSIS"},
            {"param": "STAGE", "value": "Shown"},
            {"param": "LEVEL", "op": "gte", "value": "5"},
            {
                "match": "any",
                "conditions": [
                    {"param": "PLACEMENT", "value": "Rewarded"},
                    {"param": "PLACEMENT", "value": "Interstitial"},
                ],
            },
        ],
    }
    response = _conditional_activity(admin, game, tree, filters={"app_versions": ["1.0"]})
    assert response.status_code == 200, response.text
    result = response.json()
    assert (result["events"], result["players"], result["active_players"]) == (4, 2, 4)
    assert result["identified_events"] == 3 and result["anonymous_events"] == 1
    assert result["per_matching_player"] == 1.5
    assert result["per_active_player"] == 0.75
    assert result["days"] == [{"day": "2026-10-04", "events": 4, "players": 2}]
    assert _conditional_activity(admin, game).json()["events"] == 6
    empty = _conditional_activity(admin, game, tree, filters={"app_versions": ["missing"]}).json()
    assert empty["per_matching_player"] == empty["per_active_player"] == 0
    assert empty["days"] == [{"day": "2026-10-04", "events": 0, "players": 0}]


def test_conditional_activity_respects_timezone_days_and_environment_fixes(backend):
    admin, ingest, _ = backend
    game = register(admin)
    _send_as(
        ingest,
        game,
        "test",
        [event(name="AD_ANALYSIS", client_ts="2026-10-03T23:30:00Z", params={"STAGE": "Shown"})],
    )
    assert (
        admin.post(
            f"/v1/games/{game['id']}/environment-fixes",
            headers=AUTH,
            json={"from_environment": "test", "to_environment": "production"},
        ).status_code
        == 201
    )
    result = _conditional_activity(
        admin,
        game,
        {"conditions": [{"param": "STAGE", "value": "Shown"}]},
        timezone_offset_minutes=60,
        filters={"environments": ["production"]},
    ).json()
    assert result["events"] == 1
    assert result["days"] == [{"day": "2026-10-04", "events": 1, "players": 1}]
    assert _conditional_activity(admin, game).json()["events"] == 0


@pytest.mark.parametrize(
    "tree",
    [
        {"conditions": []},
        {"conditions": [{"param": "", "value": "x"}]},
        {"conditions": [{"param": "STAGE", "op": "unknown"}]},
        {"conditions": [{"param": "LEVEL", "op": "gte", "value": "NaN"}]},
        {"conditions": [{"param": "LEVEL", "op": "gte", "value": "1e999"}]},
        {"conditions": [{"param": "LEVEL", "op": "gte", "value": "no"}]},
        {"conditions": [{"field": "event", "op": "exists"}]},
        {"conditions": [{"param": "STAGE", "value": "x"}] * 51},
    ],
)
def test_conditional_activity_rejects_invalid_conditions(backend, tree):
    admin, _, _ = backend
    game = register(admin)
    assert _conditional_activity(admin, game, tree).status_code == 400


def test_conditional_activity_bounds_nested_complexity(backend):
    admin, _, _ = backend
    game = register(admin)
    tree = {"conditions": [{"param": "STAGE", "value": "Shown"}]}
    for _ in range(6):
        tree = {"conditions": [tree]}
    assert _conditional_activity(admin, game, tree).status_code == 400
    broad = {"conditions": [{"conditions": [{"param": "STAGE", "value": "Shown"}] * 25}] * 4}
    assert _conditional_activity(admin, game, broad).status_code == 400


@pytest.mark.parametrize("mode", ["legacy", "facts"])
def test_raw_event_paging_covers_entire_timeline_with_stable_ties(backend, monkeypatch, mode):
    from avn_analytics import insights

    monkeypatch.setattr(insights, "MAX_JOURNEY_EVENTS", 2)
    admin, ingest, settings = backend
    storage = admin.app.state.storage
    monkeypatch.setattr(storage, "settings", replace(settings, analytics_read_mode=mode))
    game = register(admin)
    rows = [event(name="AD_ANALYSIS", params={"index": index}) for index in range(5)]
    assert send(ingest, game, rows).status_code == 200
    received = []
    snapshot = None
    for offset in (0, 2, 4):
        response = admin.get(
            f"/v1/games/{game['id']}/insights/journey",
            params={
                "player": "anonymous-install-id",
                "start": "2026-10-04",
                "end": "2026-10-04",
                "offset": offset,
                **({"snapshot": snapshot} if snapshot is not None else {}),
            },
        )
        assert response.status_code == 200, response.text
        page = response.json()
        snapshot = page["snapshot"]
        assert page["truncated"] is (offset < 4)
        received.extend(item["params"]["index"] for item in page["events"])
        if offset == 0:
            # A late offline event must not shift the already-started timeline's pages.
            assert (
                send(
                    ingest,
                    game,
                    [
                        event(
                            name="AD_ANALYSIS",
                            client_ts="2026-10-04T08:00:00Z",
                            params={"index": 99},
                        )
                    ],
                ).status_code
                == 200
            )
    assert received == [
        row["params"]["index"] for row in sorted(rows, key=lambda row: row["event_id"])
    ]
    # A page token from the other way of reading starts a fresh, complete timeline.
    other = 2**62 + 1 if mode == "legacy" else 1
    page = admin.get(
        f"/v1/games/{game['id']}/insights/journey",
        params={
            "player": "anonymous-install-id",
            "start": "2026-10-04",
            "end": "2026-10-04",
            "offset": 0,
            "snapshot": other,
        },
    ).json()
    assert page["snapshot"] != other and len(page["events"]) == 2


def test_the_analytics_read_mode_must_be_known(tmp_path, monkeypatch):
    monkeypatch.setenv("AVN_ANALYTICS_READ_MODE", "Facts")
    assert Settings.from_env().analytics_read_mode == "facts"
    with pytest.raises(ValueError, match="AVN_ANALYTICS_READ_MODE"):
        Settings(data_dir=tmp_path, analytics_read_mode="fast")


def test_player_actions_have_readable_names():
    from avn_analytics.stories import Labeler, action_text, standard_text

    assert standard_text("SCREEN_ANALYSIS", {"STATE": "Opened", "SCREEN": "daily_reward"}) == (
        "Opened daily reward"
    )
    assert standard_text("AD_ANALYSIS", {"STATE": "Show", "FORMAT": "Interstitial"}) == (
        "Interstitial ad"
    )
    assert standard_text("AD_ANALYSIS", {"STATE": "Failed", "FORMAT": "Rewarded"}) == (
        "Rewarded ad failed"
    )
    assert standard_text("LEVEL_ANALYSIS", {"STATE": "Choice", "ACTION": "DoubleReward"}) == (
        "Chose double reward"
    )
    assert standard_text("LEVEL_ANALYSIS", {"STATE": "Left", "REASON": "Home"}) == (
        "Left the level (home)"
    )
    assert standard_text("MY_EVENT", {}) is None
    plain = Labeler()
    assert action_text(plain, "level_failed", {"level": 3}) == "Failed level 3"
    assert action_text(plain, "POWERUP_CONSUMED", {"POWERUP_TYPE": "Bomb"}) == (
        "Powerup consumed · Bomb"
    )
    # A story label from the event dictionary wins over the standard's wording.
    labeled = Labeler({"AD_ANALYSIS": {"labels": "* => Watched an ad"}})
    assert action_text(labeled, "AD_ANALYSIS", {"FORMAT": "Interstitial"}) == "Watched an ad"


def test_only_global_admins_see_and_change_analytics_processing(team):
    client, as_user, _ = team
    boss = as_user(ADMIN_EMAIL)
    workspace = client.get("/v1/workspaces", headers=boss).json()[0]
    for email, role in (("lead@example.com", "lead"), ("dev@example.com", "member")):
        body = {"email": email, "role": role, "workspace_id": workspace["id"]}
        assert client.post("/v1/team", headers=boss, json=body).status_code == 201
    url = "/v1/admin/analytics-worker"
    for email in ("lead@example.com", "dev@example.com"):
        assert client.get(url, headers=as_user(email)).status_code == 403
        stop = client.put(url, headers=as_user(email), json={"desired": "stopped"})
        assert stop.status_code == 403
    status = client.get(url, headers=boss)
    assert status.status_code == 200 and status.headers["Cache-Control"] == "no-store"
    assert status.json()["desired"] == "running" and status.json()["state"] == "unavailable"
    assert client.put(url, headers=boss, json={"desired": "paused"}).status_code == 400
    stopped = client.put(url, headers=boss, json={"desired": "stopped"}).json()
    assert (stopped["desired"], stopped["changed_by"]) == ("stopped", ADMIN_EMAIL)
    again = client.put(url, headers=boss, json={"desired": "stopped"}).json()
    assert again["revision"] == stopped["revision"]  # the same request twice is one change
    assert client.put(url, headers=boss, json={"desired": "running"}).json()["desired"] == "running"
    actions = [item["action"] for item in client.get("/v1/audit", headers=boss).json()]
    assert actions[:2] == ["analytics.start", "analytics.stop"]
    assert actions.count("analytics.stop") == 1


def test_processing_hint_is_game_scoped_and_contains_no_global_details(team):
    client, as_user, _ = team
    boss = as_user(ADMIN_EMAIL)
    workspace = client.get("/v1/workspaces", headers=boss).json()[0]
    game = client.post(
        "/v1/games", headers=boss, json={**GAME, "workspace_id": workspace["id"]}
    ).json()["id"]
    client.post(
        "/v1/team",
        headers=boss,
        json={
            "email": "reader@example.com",
            "role": "member",
            "workspace_id": workspace["id"],
            "game_ids": [game],
        },
    )
    reader = as_user("reader@example.com")
    path = f"/v1/games/{game}/insights/processing"
    assert client.get(path, headers=reader).json() == {"paused": False}
    client.put("/v1/admin/analytics-worker", headers=boss, json={"desired": "stopped"})
    assert client.get(path, headers=reader).json() == {"paused": True}
    assert client.get("/v1/admin/analytics-worker", headers=reader).status_code == 403
    other = client.post("/v1/workspaces", headers=boss, json={"name": "Other"}).json()
    hidden = client.post(
        "/v1/games",
        headers=boss,
        json={**GAME, "bundle_id": "com.avn.hidden", "workspace_id": other["id"]},
    ).json()["id"]
    assert client.get(f"/v1/games/{hidden}/insights/processing", headers=reader).status_code == 404


@pytest.mark.parametrize("kind,expected_calls", [("summary", 2), ("players", 1), ("facets", 1)])
def test_prepared_mode_keeps_the_cache_for_other_dashboard_families(
    backend, monkeypatch, kind, expected_calls
):
    from avn_analytics import insights

    _, _, settings = backend
    with TestClient(
        create_app(replace(settings, analytics_read_mode="prepared"), admin=True)
    ) as admin:
        game = register(admin, "com.avn.prepared-cache")
        calls = []
        original = getattr(insights, kind)
        monkeypatch.setattr(
            insights, kind, lambda *args, **kw: calls.append(1) or original(*args, **kw)
        )
        for _ in range(2):
            assert (
                admin.get(f"/v1/games/{game['id']}/insights/{kind}", params=DAY).status_code == 200
            )
        assert len(calls) == expected_calls


def test_latest_build_is_the_newest_published_version_not_a_test_build(backend):
    admin, ingest, _ = backend
    game = register(admin)
    # 1.9 and 1.10 are live (1.10 is newer, though "1.9" sorts later as text); 2.0 is editor-only
    _send_as(ingest, game, "production", [event(device_id="a", app_version="1.9")])
    _send_as(ingest, game, "production", [event(device_id="b", app_version="1.10")])
    _send_as(ingest, game, "editor", [event(device_id="dev", app_version="2.0")])
    base = f"/v1/games/{game['id']}/insights/facets"
    days = {"start": "2026-10-04", "end": "2026-10-04"}
    facets = admin.get(base, headers=AUTH, params=days).json()
    assert facets["latest_app_version"] == "1.10"
    # "the build before" is the next published one: never the editor-only 2.0, and 1.9 before 1.10
    assert facets["previous_app_version"] == "1.9"
    # a range with no events has no latest build, and the dashboards then show every version
    empty = {"start": "2026-10-10", "end": "2026-10-10"}
    assert admin.get(base, headers=AUTH, params=empty).json()["latest_app_version"] is None
    assert admin.get(base, headers=AUTH, params=empty).json()["previous_app_version"] is None
