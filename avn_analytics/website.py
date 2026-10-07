from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import insights

ASSETS = Path(__file__).parent / "static"


def _players(connection, start, end, filters):
    """Distinct players with an event in [start, end) by game time, like the dashboard's DAU."""
    condition, args = insights.where(start, end, filters)
    return connection.execute(
        f"SELECT count(DISTINCT {insights.PLAYER}) FROM events WHERE {condition}", args
    ).fetchone()[0]


def overview(storage, allowed=None, timezone_offset_minutes=0):
    """Workspace totals; `allowed` limits them to the games a team member can see."""
    games = [game for game in storage.list_games() if allowed is None or game["id"] in allowed]
    offset = timedelta(minutes=timezone_offset_minutes)
    local_now = datetime.now(UTC) + offset
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_moment = (local_midnight - offset).replace(tzinfo=UTC)
    today = today_moment.isoformat(timespec="microseconds")
    yesterday = (today_moment - timedelta(days=1)).isoformat(timespec="microseconds")
    tomorrow = (today_moment + timedelta(days=1)).isoformat(timespec="microseconds")
    real_players = {"exclude_environments": insights.TEST_ENVIRONMENTS}
    with storage.connect(storage.root / "registry.sqlite3") as registry:
        active_keys = registry.execute(
            "SELECT count(*) FROM api_keys WHERE revoked_at IS NULL"
        ).fetchone()[0]
    for game in games:
        with storage.connect(storage.game_path(game["id"])) as connection:
            game["events"] = connection.execute("SELECT count(*) FROM events").fetchone()[0]
            game["last_event"] = connection.execute("SELECT max(server_ts) FROM events").fetchone()[
                0
            ]
            game["today"] = connection.execute(
                "SELECT count(*) FROM events WHERE server_ts>=?", (today,)
            ).fetchone()[0]
            game["dau_today"] = _players(connection, today, tomorrow, real_players)
            game["dau_yesterday"] = _players(connection, yesterday, today, real_players)
            game["anonymous_today"] = connection.execute(
                f"SELECT count(*) FROM events WHERE client_ts>=? AND client_ts<? "
                f"AND NOT ({insights.IDENTIFIED})",
                (today, tomorrow),
            ).fetchone()[0]
    return {
        "games": games,
        "events": sum(game["events"] for game in games),
        "today": sum(game["today"] for game in games),
        "dau_today": sum(game["dau_today"] for game in games),
        "anonymous_today": sum(game["anonymous_today"] for game in games),
        "timezone_offset_minutes": timezone_offset_minutes,
        "active_keys": active_keys,
        "ingest_url": (storage.settings.public_ingest_url or "http://127.0.0.1:8100")
        + "/v1/events",
    }


def add_website(app):
    app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")

    @app.middleware("http")
    async def browser_headers(request, call_next):
        response = await call_next(request)
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
            "object-src 'none'; base-uri 'none'; form-action 'self'"
        )
        return response

    def page():
        return FileResponse(ASSETS / "index.html", media_type="text/html")

    for route in (
        "/",
        "/games",
        "/games/new",
        "/games/{game_id}",
        "/games/{game_id}/{section}",
        "/keys",
        "/exports",
        "/dictionary",
        "/funnels",
        "/players",
        "/status",
        "/settings",
        "/team",
        "/workspaces",
    ):
        app.add_api_route(route, page, methods=["GET"], include_in_schema=False)
