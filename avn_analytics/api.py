import asyncio
import json
import logging
import sqlite3
import zlib
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta, timezone
from threading import BoundedSemaphore
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import Field
from starlette.background import BackgroundTask

from . import device_specs, insights, journeys
from .auth import AccessVerifier, Accounts, Principal
from .config import Settings
from .exports import build_export, period_bounds
from .models import (
    AccessUpdate,
    AnalyticsThresholdOverrides,
    AnalyticsThresholds,
    Batch,
    EnvironmentFix,
    EventDefinition,
    Filters,
    FunnelQuery,
    GameCreate,
    GameUpdate,
    JourneyPlayersQuery,
    JourneyQuery,
    KeyCreate,
    Name,
    NutBotChat,
    PlayerRules,
    SavedFunnel,
    TeamAdd,
    TeamUpdate,
    WorkspaceCreate,
    WorkspaceMove,
    WorkspaceNutBot,
    normalize_country,
    timestamp,
)
from .nutbot import NutBot
from .storage import Storage
from .website import add_website
from .website import overview as website_overview

logger = logging.getLogger(__name__)


class BodyLimit:
    """Caps request size; inflates gzip bodies transparently (also capped, against zip bombs)."""

    def __init__(self, app, max_bytes):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        encoding = headers.get(b"content-encoding", b"identity").strip().lower()
        if encoding not in (b"identity", b"gzip"):
            await JSONResponse({"detail": "Unsupported Content-Encoding"}, 415)(
                scope, receive, send
            )
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                await JSONResponse({"detail": "Request body too large"}, 413)(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        data = bytes(body)
        if encoding == b"gzip":
            inflater = zlib.decompressobj(wbits=31)  # gzip container only
            try:
                data = inflater.decompress(data, self.max_bytes + 1)
                if not inflater.eof and not inflater.unconsumed_tail and not data:
                    raise zlib.error("incomplete gzip stream")
            except zlib.error:
                await JSONResponse({"detail": "Invalid gzip body"}, 400)(scope, receive, send)
                return
            if len(data) > self.max_bytes or inflater.unconsumed_tail:
                await JSONResponse({"detail": "Request body too large"}, 413)(scope, receive, send)
                return
            if not inflater.eof:
                await JSONResponse({"detail": "Invalid gzip body"}, 400)(scope, receive, send)
                return
            scope = dict(scope)
            scope["headers"] = [
                (name, value)
                for name, value in scope["headers"]
                if name not in (b"content-encoding", b"content-length")
            ] + [(b"content-length", str(len(data)).encode())]
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": data, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(settings: Settings, *, admin: bool = False, access_keys=None):
    if admin and len(settings.admin_token) < 32:
        raise ValueError("Set AVN_ADMIN_TOKEN to a random token of at least 32 characters")
    storage = Storage(settings)
    verifier = (
        AccessVerifier(settings.access_team_domain, settings.access_audience, access_keys)
        if settings.access_enabled
        else None
    )
    accounts = Accounts(storage, settings, verifier)
    nutbot = NutBot(settings, storage, accounts)
    export_slot = BoundedSemaphore(1)

    @asynccontextmanager
    async def lifespan(app):
        storage.initialize()
        accounts.initialize()
        yield

    def current(request: Request) -> Principal:
        """Who is calling; for game routes, also whether they may see that game."""
        principal = accounts.authenticate(request)
        request.state.principal = principal
        game_id = request.path_params.get("game_id")
        if game_id and not accounts.can_see_game(principal, str(game_id)):
            raise HTTPException(404, "Game not found")  # same answer as for a game that isn't there
        return principal

    Current = Annotated[Principal, Depends(current)]

    def manager(request: Request, principal: Current) -> Principal:
        """Admins, or the lead of the workspace the game in the URL belongs to."""
        game_id = request.path_params.get("game_id")
        workspace_id = accounts.workspace_of_game(str(game_id)) if game_id else None
        if not workspace_id or not principal.manages_games_in(workspace_id):
            raise HTTPException(403, "Only admins and team leads can do this")
        return principal

    def team_admin(principal: Current) -> Principal:
        if not principal.manages_team:
            raise HTTPException(403, "Only the admin can do this")
        return principal

    Manager = Annotated[Principal, Depends(manager)]
    TeamAdmin = Annotated[Principal, Depends(team_admin)]

    def bounds(period, selected_date, end_date):
        if period == "custom":
            if end_date is None or end_date < selected_date:
                raise HTTPException(400, "Choose an end date on or after the start date")
            if (end_date - selected_date).days > 365:
                raise HTTPException(400, "Choose a range of 366 days or fewer")
        return period_bounds(period, selected_date, end_date)

    app = FastAPI(
        title="AVN Analytics Admin" if admin else "AVN Analytics Ingest",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.storage = storage
    app.state.accounts = accounts
    app.state.nutbot = nutbot
    app.add_middleware(BodyLimit, max_bytes=settings.max_body_bytes)

    @app.exception_handler(RequestValidationError)
    async def invalid_payload(request, exception):
        errors = [
            {"loc": error["loc"], "msg": error["msg"], "type": error["type"]}
            for error in exception.errors()
        ]
        return JSONResponse({"detail": "Invalid request", "errors": errors}, status_code=400)

    @app.exception_handler(sqlite3.Error)
    async def database_unavailable(request, exception):
        logger.error("Database operation failed: %s", type(exception).__name__)
        return JSONResponse(
            {"detail": "Storage temporarily unavailable"},
            status_code=503,
            headers={"Retry-After": "5"},
        )

    @app.exception_handler(OSError)
    async def filesystem_unavailable(request, exception):
        logger.error("Filesystem operation failed: %s", type(exception).__name__)
        return JSONResponse(
            {"detail": "Storage temporarily unavailable"},
            status_code=503,
            headers={"Retry-After": "60"},
        )

    @app.get("/healthz", dependencies=[Depends(current)] if admin else [])
    def healthz():
        with storage.connect(storage.root / "registry.sqlite3") as connection:
            connection.execute("SELECT count(*) FROM games").fetchone()
        return {"status": "ok", "server_ts": timestamp()}

    if not admin:

        def authorize(x_api_key: Annotated[str | None, Header()] = None):
            return storage.authorize_ingest(x_api_key)

        @app.post("/v1/events")
        def ingest(
            batch: Batch,
            game_id: Annotated[str, Depends(authorize)],
            cf_ipcountry: Annotated[str | None, Header()] = None,
        ):
            return storage.ingest(game_id, batch, country=normalize_country(cf_ipcountry))

        return app

    admin_api = APIRouter(dependencies=[Depends(current)])
    add_website(app)

    # The agent CLI that NutBot starts calls back here with a one-off token.
    def mcp_caller(request: Request):
        host = request.client.host if request.client else ""
        token = request.headers.get("authorization", "")
        if host not in ("127.0.0.1", "::1") or not token.lower().startswith("bearer "):
            raise HTTPException(403, "Not available")
        return token[7:].strip()

    @app.post("/nutbot/mcp", include_in_schema=False)
    async def nutbot_mcp(request: Request):
        token = mcp_caller(request)
        try:
            payload = await request.json()
        except ValueError:
            return JSONResponse({"error": "Invalid JSON"}, 400)
        if not isinstance(payload, dict):
            return JSONResponse({"error": "Batches are not supported"}, 400)
        status, reply = await asyncio.to_thread(nutbot.mcp, token, payload)
        return Response(status_code=202) if reply is None else JSONResponse(reply, status)

    @app.get("/nutbot/mcp", include_in_schema=False)
    def nutbot_mcp_stream(request: Request):
        mcp_caller(request)
        return Response(status_code=405, headers={"Allow": "POST"})

    @admin_api.get("/v1/nutbot")
    def nutbot_status(principal: Current):
        return nutbot.describe()

    @admin_api.post("/v1/games/{game_id}/nutbot/chat")
    async def nutbot_chat(game_id: UUID, body: NutBotChat, principal: Current):
        workspace_id = accounts.workspace_of_game(str(game_id))
        if not workspace_id or not accounts.can_use_nutbot(principal, workspace_id):
            raise HTTPException(403, "NutBot isn't switched on for you in this workspace")
        game = storage.get_game(str(game_id))
        prepared = nutbot.prepare(principal, game, workspace_id, body.model_dump())

        async def lines():
            async for event in nutbot.stream(prepared):
                yield json.dumps(event, ensure_ascii=False, default=str) + "\n"

        return StreamingResponse(
            lines(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @admin_api.patch("/v1/workspaces/{workspace_id}/nutbot")
    def set_workspace_nutbot(workspace_id: UUID, body: WorkspaceNutBot, principal: TeamAdmin):
        accounts.set_nutbot_access(principal, str(workspace_id), body.access)
        return {"status": "saved", "access": body.access}

    @admin_api.get("/v1/me")
    def me(principal: Current):
        return {
            "email": principal.email,
            "name": principal.name,
            "is_admin": principal.is_admin,
            "source": principal.source,
            "can_manage_team": principal.manages_team,
            "workspaces": accounts.workspaces_for(principal),
        }

    @admin_api.get("/v1/overview")
    def overview(
        principal: Current,
        workspace: UUID | None = None,
        tz_offset: Annotated[int, Query(ge=-840, le=840)] = 0,
    ):
        workspace_id = accounts.pick_workspace(principal, str(workspace) if workspace else None)
        visible = {game["id"] for game in accounts.games_in(principal, workspace_id)}
        result = website_overview(storage, visible, tz_offset)
        result["workspace"] = workspace_id
        result["analytics_thresholds"] = accounts.analytics_thresholds(workspace_id)
        return result

    @admin_api.get("/openapi.json")
    def schema():
        return app.openapi()

    @admin_api.get("/v1/games")
    def list_games(principal: Current, workspace: UUID | None = None):
        workspace_id = accounts.pick_workspace(principal, str(workspace) if workspace else None)
        return accounts.games_in(principal, workspace_id)

    @admin_api.post("/v1/games", status_code=201)
    def register_game(game: GameCreate, response: Response, principal: Current):
        response.headers["Cache-Control"] = "no-store"
        workspace_id = accounts.pick_workspace(
            principal, str(game.workspace_id) if game.workspace_id else None
        )
        if not principal.manages_games_in(workspace_id):
            raise HTTPException(403, "Only admins and team leads can do this")
        registered = storage.register_game(game, workspace_id)
        accounts.audit(
            principal, "game.register", registered["id"], f"{game.name} ({game.platform})"
        )
        return registered

    @admin_api.get("/v1/games/{game_id}")
    def game_details(game_id: UUID):
        return storage.game_details(str(game_id))

    @admin_api.patch("/v1/games/{game_id}/analytics-thresholds")
    def set_game_analytics_thresholds(
        game_id: UUID, update: AnalyticsThresholdOverrides, principal: Manager
    ):
        result = storage.set_analytics_thresholds(str(game_id), update)
        accounts.audit(principal, "game.analytics", str(game_id))
        return result

    @admin_api.get("/v1/workspaces/{workspace_id}/analytics-thresholds")
    def workspace_analytics_thresholds(workspace_id: UUID, principal: Current):
        if not principal.sees_workspace(str(workspace_id)):
            raise HTTPException(404, "Workspace not found")
        return accounts.analytics_thresholds(str(workspace_id))

    @admin_api.patch("/v1/workspaces/{workspace_id}/analytics-thresholds")
    def set_workspace_analytics_thresholds(
        workspace_id: UUID, update: AnalyticsThresholds, principal: TeamAdmin
    ):
        return accounts.set_analytics_thresholds(principal, str(workspace_id), update)

    @admin_api.get("/v1/games/{game_id}/environment-fixes")
    def list_environment_fixes(game_id: UUID):
        return insights.environment_fixes(storage, str(game_id))

    @admin_api.post("/v1/games/{game_id}/environment-fixes", status_code=201)
    def add_environment_fix(game_id: UUID, fix: EnvironmentFix, principal: Manager):
        result = insights.add_environment_fix(storage, str(game_id), fix.model_dump())
        detail = f"{fix.from_environment} → {fix.to_environment}" + (
            f" · {fix.app_version}" if fix.app_version else ""
        )
        accounts.audit(principal, "environment.fix", str(game_id), detail)
        return result

    @admin_api.delete("/v1/games/{game_id}/environment-fixes/{fix_id}", status_code=204)
    def delete_environment_fix(game_id: UUID, fix_id: int, principal: Manager):
        insights.delete_environment_fix(storage, str(game_id), fix_id)
        accounts.audit(principal, "environment.unfix", str(game_id), str(fix_id))

    @admin_api.patch("/v1/games/{game_id}")
    def update_game(game_id: UUID, update: GameUpdate, principal: Manager):
        changes = ", ".join(sorted(update.model_dump(exclude_none=True)))
        result = storage.update_game(str(game_id), update)
        accounts.audit(principal, "game.update", str(game_id), changes)
        return result

    @admin_api.delete("/v1/games/{game_id}")
    def delete_game(
        game_id: UUID, principal: Manager, confirm: Annotated[str, Query(max_length=255)] = ""
    ):
        name = storage.get_game(str(game_id))["name"]
        result = storage.delete_game(str(game_id), confirm)
        accounts.forget_game(str(game_id))
        accounts.audit(principal, "game.delete", str(game_id), name)
        return result

    @admin_api.put("/v1/games/{game_id}/icon")
    async def set_icon(game_id: UUID, request: Request, principal: Manager):
        result = storage.set_icon(str(game_id), await request.body())
        accounts.audit(principal, "icon.set", str(game_id))
        return result

    @admin_api.delete("/v1/games/{game_id}/icon", status_code=204)
    def clear_icon(game_id: UUID, principal: Manager):
        storage.clear_icon(str(game_id))
        accounts.audit(principal, "icon.clear", str(game_id))

    @admin_api.get("/v1/games/{game_id}/icon")
    def get_icon(game_id: UUID):
        storage.get_game(str(game_id))
        path = storage.icon_path(str(game_id))
        if not path.exists():
            raise HTTPException(404, "No icon")
        # The dashboard adds ?v=<icon_updated_at>, so a new upload gets a new URL.
        return FileResponse(
            path, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"}
        )

    @admin_api.get("/v1/games/{game_id}/keys")
    def list_keys(game_id: UUID, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return storage.list_keys(str(game_id))

    @admin_api.post("/v1/games/{game_id}/keys", status_code=201)
    def create_key(game_id: UUID, key: KeyCreate, response: Response, principal: Manager):
        response.headers["Cache-Control"] = "no-store"
        created = storage.create_key(str(game_id), key.label)
        accounts.audit(principal, "key.create", str(game_id), key.label)
        return created

    @admin_api.delete("/v1/games/{game_id}/keys/{key_id}", status_code=204)
    def delete_key(game_id: UUID, key_id: UUID, principal: Manager):
        storage.delete_key(str(game_id), str(key_id))
        accounts.audit(principal, "key.delete", str(game_id), str(key_id))

    @admin_api.put("/v1/games/{game_id}/dictionary/{name}")
    def set_definition(game_id: UUID, name: Name, definition: EventDefinition, principal: Current):
        storage.set_definition(str(game_id), name, definition)
        accounts.audit(principal, "dictionary.set", str(game_id), name)
        return {"status": "saved"}

    @admin_api.delete("/v1/games/{game_id}/dictionary/{name}", status_code=204)
    def delete_definition(game_id: UUID, name: Name, principal: Current):
        storage.delete_definition(str(game_id), name)
        accounts.audit(principal, "dictionary.delete", str(game_id), name)

    @admin_api.get("/v1/games/{game_id}/dictionary")
    def get_dictionary(game_id: UUID):
        return storage.get_dictionary(str(game_id))

    @admin_api.get("/v1/games/{game_id}/dictionary/discovery")
    def dictionary_discovery(game_id: UUID):
        return insights.discovery(storage, str(game_id))

    DateParam = Annotated[date, Query(ge=date(1970, 1, 1), le=date(9998, 12, 31))]
    Values = Annotated[list[Annotated[str, Field(max_length=128)]], Query(max_length=100)]

    TimezoneOffset = Annotated[int, Query(ge=-840, le=840)]

    def day_range(start, end, timezone_offset_minutes=0):
        if end < start:
            raise HTTPException(400, "Choose an end date on or after the start date")
        if (end - start).days > 365:
            raise HTTPException(400, "Choose a range of 366 days or fewer")
        zone = timezone(timedelta(minutes=timezone_offset_minutes))
        first = datetime.combine(start, datetime.min.time(), zone).astimezone(UTC)
        after = datetime.combine(end + timedelta(days=1), datetime.min.time(), zone).astimezone(UTC)
        return timestamp(first), timestamp(after)

    def filters(
        env: Values = None,
        not_env: Values = None,
        version: Values = None,
        build: Values = None,
        country: Values = None,
        platform: Values = None,
    ):
        return Filters(
            environments=env or [],
            exclude_environments=not_env or [],
            app_versions=version or [],
            builds=build or [],
            countries=country or [],
            platforms=platform or [],
        ).model_dump()

    Filtered = Annotated[dict, Depends(filters)]

    @admin_api.get("/v1/games/{game_id}/health")
    def game_health(
        game_id: UUID,
        chosen: Filtered,
        selected_date: Annotated[
            date, Query(alias="date", ge=date(1970, 1, 1), le=date(9998, 12, 31))
        ],
        period: Literal["day", "week", "month", "custom"] = "week",
        end_date: Annotated[date | None, Query(ge=date(1970, 1, 1), le=date(9998, 12, 31))] = None,
        basis: Literal["server_ts", "client_ts"] = "server_ts",
    ):
        start, end = bounds(period, selected_date, end_date)
        return storage.health(str(game_id), start, end, basis, chosen)

    @admin_api.get("/v1/games/{game_id}/export")
    def export(
        game_id: UUID,
        principal: Current,
        chosen: Filtered,
        selected_date: Annotated[
            date, Query(alias="date", ge=date(1970, 1, 1), le=date(9998, 12, 31))
        ],
        period: Literal["day", "week", "month", "custom"] = "day",
        basis: Literal["server_ts", "client_ts"] = "server_ts",
        end_date: Annotated[date | None, Query(ge=date(1970, 1, 1), le=date(9998, 12, 31))] = None,
    ):
        bounds(period, selected_date, end_date)
        if not export_slot.acquire(blocking=False):
            raise HTTPException(429, "An export is already running", headers={"Retry-After": "10"})
        try:
            output = build_export(
                storage, str(game_id), period, selected_date, basis, end_date, chosen
            )
        finally:
            export_slot.release()
        accounts.audit(
            principal, "export.download", str(game_id), f"{period} {selected_date} {end_date or ''}"
        )
        return FileResponse(
            output,
            media_type="application/zip",
            filename=f"{game_id}-{period}-{selected_date}"
            + (f"_to_{end_date}" if period == "custom" else "")
            + f"-{basis}.zip",
            headers={"Cache-Control": "no-store"},
            background=BackgroundTask(output.unlink, missing_ok=True),
        )

    @admin_api.get("/v1/games/{game_id}/insights/facets")
    def insights_facets(
        game_id: UUID, start: DateParam, end: DateParam, tz_offset: TimezoneOffset = 0
    ):
        return insights.facets(storage, str(game_id), *day_range(start, end, tz_offset))

    @admin_api.get("/v1/games/{game_id}/insights/summary")
    def insights_summary(
        game_id: UUID,
        start: DateParam,
        end: DateParam,
        chosen: Filtered,
        tz_offset: TimezoneOffset = 0,
    ):
        return insights.summary(
            storage, str(game_id), *day_range(start, end, tz_offset), chosen, tz_offset
        )

    @admin_api.get("/v1/games/{game_id}/insights/retention")
    def insights_retention(
        game_id: UUID,
        start: DateParam,
        end: DateParam,
        chosen: Filtered,
        tz_offset: TimezoneOffset = 0,
    ):
        return insights.retention(
            storage, str(game_id), *day_range(start, end, tz_offset), chosen, tz_offset
        )

    @admin_api.get("/v1/games/{game_id}/insights/catalog")
    def insights_catalog(
        game_id: UUID,
        start: DateParam,
        end: DateParam,
        chosen: Filtered,
        tz_offset: TimezoneOffset = 0,
    ):
        return insights.catalog(storage, str(game_id), *day_range(start, end, tz_offset), chosen)

    @admin_api.post("/v1/games/{game_id}/insights/funnel")
    def insights_funnel(game_id: UUID, query: FunnelQuery):
        return insights.funnel(
            storage,
            str(game_id),
            *day_range(query.start, query.end, query.timezone_offset_minutes),
            query.model_dump(),
        )

    @admin_api.post("/v1/games/{game_id}/insights/journeys")
    def insights_journeys(game_id: UUID, query: JourneyQuery):
        return journeys.journeys(
            storage,
            str(game_id),
            *day_range(query.start, query.end, query.timezone_offset_minutes),
            query.model_dump(),
        )

    @admin_api.post("/v1/games/{game_id}/insights/journeys/players")
    def insights_journey_players(game_id: UUID, query: JourneyPlayersQuery):
        return journeys.journey_players(
            storage,
            str(game_id),
            *day_range(query.start, query.end, query.timezone_offset_minutes),
            query.model_dump(),
        )

    @admin_api.get("/v1/games/{game_id}/insights/story")
    def insights_story(
        game_id: UUID,
        player: Annotated[str, Query(min_length=1, max_length=128)],
        start: DateParam,
        end: DateParam,
        hidden: bool = False,
        level: Annotated[int, Query(ge=0, le=1_000_000)] | None = None,
        cut: Literal["until", "from"] | None = None,
        tz_offset: TimezoneOffset = 0,
    ):
        return journeys.player_story(
            storage,
            str(game_id),
            player,
            *day_range(start, end, tz_offset),
            show_hidden=hidden,
            level=level,
            cut=cut,
        )

    @admin_api.get("/v1/games/{game_id}/insights/device-specs")
    def insights_device_specs(
        game_id: UUID,
        player: Annotated[str, Query(min_length=1, max_length=128)],
    ):
        try:
            return device_specs.for_player(storage, str(game_id), player)
        except device_specs.DeviceSpecsNotFound as error:
            raise HTTPException(404, str(error)) from error
        except device_specs.DeviceSpecsUnavailable as error:
            raise HTTPException(502, str(error)) from error

    @admin_api.get("/v1/games/{game_id}/insights/levels")
    def insights_levels(
        game_id: UUID,
        start: DateParam,
        end: DateParam,
        chosen: Filtered,
        tz_offset: TimezoneOffset = 0,
    ):
        return journeys.level_progress(
            storage, str(game_id), *day_range(start, end, tz_offset), chosen
        )

    @admin_api.get("/v1/games/{game_id}/insights/levels/players")
    def insights_level_players(
        game_id: UUID,
        start: DateParam,
        end: DateParam,
        chosen: Filtered,
        level: Annotated[int, Query(ge=0, le=1_000_000)],
        group: Literal["left", "finished_stopped", "kept_going", "stuck", "started"] = "left",
        sort: Literal["exit_at", "tries", "fails"] = "exit_at",
        offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
        limit: Annotated[int, Query(ge=1, le=2000)] = 50,
        tz_offset: TimezoneOffset = 0,
    ):
        return journeys.level_players(
            storage,
            str(game_id),
            *day_range(start, end, tz_offset),
            chosen,
            level,
            group=group,
            offset=offset,
            limit=limit,
            sort=sort,
        )

    @admin_api.get("/v1/games/{game_id}/insights/players")
    def insights_players(
        game_id: UUID,
        start: DateParam,
        end: DateParam,
        chosen: Filtered,
        search: Annotated[str, Query(max_length=128)] = "",
        offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
        sort: Annotated[str, Query(max_length=20)] = "last_seen",
        order: Literal["asc", "desc"] = "desc",
        rules: Annotated[str, Query(max_length=8000)] = "",
        tz_offset: TimezoneOffset = 0,
    ):
        try:
            parsed = PlayerRules.model_validate_json(rules) if rules else PlayerRules()
        except ValueError as error:
            raise HTTPException(400, "Those player rules aren't valid") from error
        return insights.players(
            storage,
            str(game_id),
            *day_range(start, end, tz_offset),
            chosen,
            search=search,
            offset=offset,
            sort=sort,
            order=order,
            conditions=[item.model_dump() for item in parsed.conditions],
            metrics=[item.model_dump() for item in parsed.metrics],
        )

    @admin_api.get("/v1/games/{game_id}/insights/journey")
    def insights_journey(
        game_id: UUID,
        player: Annotated[str, Query(min_length=1, max_length=128)],
        start: DateParam,
        end: DateParam,
        tz_offset: TimezoneOffset = 0,
    ):
        return insights.journey(storage, str(game_id), player, *day_range(start, end, tz_offset))

    @admin_api.get("/v1/games/{game_id}/insights/funnels")
    def list_funnels(game_id: UUID):
        return insights.saved_funnels(storage, str(game_id))

    @admin_api.post("/v1/games/{game_id}/insights/funnels", status_code=201)
    def create_funnel(game_id: UUID, saved: SavedFunnel):
        return insights.save_funnel(storage, str(game_id), None, saved.model_dump())

    @admin_api.put("/v1/games/{game_id}/insights/funnels/{funnel_id}")
    def update_funnel(game_id: UUID, funnel_id: UUID, saved: SavedFunnel):
        return insights.save_funnel(storage, str(game_id), str(funnel_id), saved.model_dump())

    @admin_api.delete("/v1/games/{game_id}/insights/funnels/{funnel_id}", status_code=204)
    def delete_funnel(game_id: UUID, funnel_id: UUID):
        insights.delete_funnel(storage, str(game_id), str(funnel_id))

    @admin_api.get("/v1/games/{game_id}/access")
    def game_access(game_id: UUID, principal: Manager):
        return accounts.game_members(str(game_id))

    @admin_api.put("/v1/games/{game_id}/access")
    def set_game_access(game_id: UUID, update: AccessUpdate, principal: Manager):
        accounts.set_game_members(principal, str(game_id), update.emails)
        return accounts.game_members(str(game_id))

    @admin_api.get("/v1/workspaces")
    def list_workspaces(principal: Current):
        return accounts.workspaces_for(principal, counts=principal.is_admin)

    @admin_api.post("/v1/workspaces", status_code=201)
    def create_workspace(body: WorkspaceCreate, principal: TeamAdmin):
        return accounts.create_workspace(principal, body.name)

    @admin_api.patch("/v1/workspaces/{workspace_id}")
    def rename_workspace(workspace_id: UUID, body: WorkspaceCreate, principal: TeamAdmin):
        accounts.rename_workspace(principal, str(workspace_id), body.name)
        return {"status": "saved"}

    @admin_api.delete("/v1/workspaces/{workspace_id}")
    def delete_workspace(
        workspace_id: UUID,
        principal: TeamAdmin,
        confirm: Annotated[str, Query(max_length=255)] = "",
        move_to: UUID | None = None,
        delete_games: bool = False,
    ):
        return accounts.delete_workspace(
            principal, str(workspace_id), confirm, str(move_to) if move_to else None, delete_games
        )

    @admin_api.post("/v1/games/{game_id}/move")
    def move_game(game_id: UUID, body: WorkspaceMove, principal: TeamAdmin):
        return accounts.move_game(principal, str(game_id), str(body.workspace_id))

    @admin_api.get("/v1/team")
    def list_team(principal: TeamAdmin):
        return accounts.list_people()

    @admin_api.post("/v1/team", status_code=201)
    def add_team_member(person: TeamAdd, principal: TeamAdmin):
        email = accounts.add_person(
            principal,
            person.email,
            person.name,
            person.role,
            str(person.workspace_id) if person.workspace_id else None,
            [str(g) for g in person.game_ids],
        )
        return {"email": email}

    @admin_api.patch("/v1/team/{email}")
    def update_team_member(email: str, update: TeamUpdate, principal: TeamAdmin):
        accounts.update_person(
            principal,
            email,
            update.name,
            update.admin,
            str(update.workspace_id) if update.workspace_id else None,
            update.role,
            [str(g) for g in update.game_ids] if update.game_ids is not None else None,
        )
        return {"status": "saved"}

    @admin_api.delete("/v1/team/{email}", status_code=204)
    def remove_team_member(email: str, principal: TeamAdmin, workspace_id: UUID | None = None):
        accounts.remove_person(principal, email, str(workspace_id) if workspace_id else None)

    @admin_api.get("/v1/audit")
    def audit_log(principal: TeamAdmin):
        return accounts.audit_log()

    app.include_router(admin_api)
    return app


def create_ingest_app():
    return create_app(Settings.from_env())


def create_admin_app():
    return create_app(Settings.from_env(), admin=True)
