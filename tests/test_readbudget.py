"""A dashboard read stops once nobody is waiting for it, and never runs longer than its ceiling."""

import asyncio
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, register

from avn_analytics import insights, readbudget
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.readbudget import Budget, ReadBudget
from avn_analytics.storage import Storage

# Counts for far longer than any test waits, so only an interruption ends it in time.
FOREVER = (
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000000000) "
    "SELECT count(*) FROM n"
)


def run_forever(storage, path):
    with storage.connect(path) as connection:
        connection.execute(FOREVER).fetchone()


def make_storage(tmp_path):
    return Storage(Settings(data_dir=tmp_path, admin_token=TOKEN))


def test_a_statement_is_interrupted_when_the_budget_is_spent(tmp_path):
    storage = make_storage(tmp_path)
    token = readbudget._current.set(Budget(0.2))
    began = time.monotonic()
    try:
        with pytest.raises(Exception) as caught:
            run_forever(storage, tmp_path / "scratch.sqlite3")
    finally:
        readbudget._current.reset(token)
    assert getattr(caught.value, "status_code", None) == 504
    assert time.monotonic() - began < 10


def test_nothing_is_interrupted_outside_a_budgeted_read(tmp_path):
    storage = make_storage(tmp_path)
    with storage.connect(tmp_path / "scratch.sqlite3") as connection:
        assert (
            connection.execute("SELECT count(*) FROM (SELECT 1 UNION SELECT 2)").fetchone()[0] == 2
        )
    # a real database error is still a database error
    with pytest.raises(sqlite3.OperationalError):
        with storage.connect(tmp_path / "scratch.sqlite3") as connection:
            connection.execute("SELECT * FROM missing")


def test_a_read_stops_when_the_browser_goes_away(tmp_path):
    storage = make_storage(tmp_path)
    outcome = []

    async def app(scope, receive, send):
        try:
            await asyncio.to_thread(run_forever, storage, tmp_path / "scratch.sqlite3")
        except Exception as error:  # the interruption, reported the way the website gets it
            outcome.append(getattr(error, "status_code", repr(error)))

    async def browser():
        await asyncio.sleep(0.3)
        return {"type": "http.disconnect"}

    async def send(message):
        pass

    scope = {"type": "http", "method": "GET", "path": "/v1/games/x/insights/summary"}
    began = time.monotonic()
    asyncio.run(ReadBudget(app, seconds=0, max_body_bytes=1024)(scope, browser, send))
    assert outcome == [504]
    assert time.monotonic() - began < 10


def test_a_read_that_is_still_wanted_is_not_stopped_early(tmp_path):
    storage = make_storage(tmp_path)
    outcome = []

    async def app(scope, receive, send):
        def quick():
            with storage.connect(tmp_path / "scratch.sqlite3") as connection:
                return connection.execute("SELECT 41 + 1").fetchone()[0]

        outcome.append(await asyncio.to_thread(quick))

    async def browser():
        await asyncio.sleep(30)  # still connected for as long as the read runs

    async def send(message):
        pass

    scope = {"type": "http", "method": "GET", "path": "/v1/games/x/insights/summary"}
    asyncio.run(ReadBudget(app, seconds=0, max_body_bytes=1024)(scope, browser, send))
    assert outcome == [42]


def test_only_dashboard_reads_get_a_budget():
    def reads(method, path):
        return readbudget.is_read({"method": method, "path": path})

    game = "/v1/games/g"
    assert reads("GET", f"{game}/insights/summary")
    assert reads("GET", f"{game}/insights/levels/players")
    assert reads("GET", f"{game}/mappings/status")
    assert reads("GET", f"{game}/mappings")
    assert reads("POST", f"{game}/insights/funnel")
    assert reads("POST", f"{game}/insights/journeys/players")
    # changes, exports, NutBot and everything outside a game are never interrupted
    assert not reads("POST", f"{game}/insights/highlights")
    assert not reads("PUT", f"{game}/insights/funnels/f1")
    assert not reads("POST", f"{game}/insights/group-library")
    assert not reads("GET", f"{game}/export")
    assert not reads("POST", f"{game}/nutbot/chat")
    assert not reads("POST", f"{game}/mappings/preview")
    assert not reads("POST", "/v1/events")
    assert not reads("GET", "/v1/overview")


def test_a_read_over_its_ceiling_ends_with_a_clear_504(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path, admin_token=TOKEN, read_deadline_seconds=1)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)

        def slow_summary(storage, game_id, *args, **kwargs):
            run_forever(storage, storage.game_path(game_id))

        monkeypatch.setattr(insights, "summary", slow_summary)
        began = time.monotonic()
        response = admin.get(
            f"/v1/games/{game['id']}/insights/summary",
            headers=AUTH,
            params={"start": "2026-10-01", "end": "2026-10-02"},
        )
        assert response.status_code == 504, response.text
        assert "took too long" in response.json()["detail"]
        assert time.monotonic() - began < 15
        # the same server still answers normally afterwards
        assert admin.get(f"/v1/games/{game['id']}", headers=AUTH).status_code == 200
