import logging
import sqlite3
from contextlib import asynccontextmanager
from datetime import date
from threading import BoundedSemaphore
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

from .config import Settings
from .exports import build_export, period_bounds
from .models import (
    Batch,
    EventDefinition,
    GameCreate,
    KeyCreate,
    Name,
    normalize_country,
    timestamp,
)
from .storage import Storage
from .website import add_website
from .website import overview as website_overview

logger = logging.getLogger(__name__)


class BodyLimit:
    def __init__(self, app, max_bytes):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        if headers.get(b"content-encoding", b"identity").lower() != b"identity":
            await JSONResponse({"detail": "Compressed requests are not supported"}, 415)(
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
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(settings: Settings, *, admin: bool = False):
    if admin and len(settings.admin_token) < 32:
        raise ValueError("Set AVN_ADMIN_TOKEN to a random token of at least 32 characters")
    storage = Storage(settings)
    export_slot = BoundedSemaphore(1)

    @asynccontextmanager
    async def lifespan(app):
        storage.initialize()
        yield

    def require_admin():
        # No application-level login: access control is handled by Cloudflare Access
        # (and the LAN) in front of the admin service.
        return

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

    @app.get("/healthz", dependencies=[Depends(require_admin)] if admin else [])
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

    admin_api = APIRouter(dependencies=[Depends(require_admin)])
    add_website(app)

    @admin_api.get("/v1/overview")
    def overview():
        return website_overview(storage)

    @admin_api.get("/openapi.json")
    def schema():
        return app.openapi()

    @admin_api.get("/v1/games")
    def list_games():
        return storage.list_games()

    @admin_api.post("/v1/games", status_code=201)
    def register_game(game: GameCreate, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return storage.register_game(game)

    @admin_api.get("/v1/games/{game_id}/keys")
    def list_keys(game_id: UUID):
        return storage.list_keys(str(game_id))

    @admin_api.post("/v1/games/{game_id}/keys", status_code=201)
    def create_key(game_id: UUID, key: KeyCreate, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return storage.create_key(str(game_id), key.label)

    @admin_api.delete("/v1/games/{game_id}/keys/{key_id}", status_code=204)
    def revoke_key(game_id: UUID, key_id: UUID):
        storage.revoke_key(str(game_id), str(key_id))

    @admin_api.put("/v1/games/{game_id}/dictionary/{name}")
    def set_definition(game_id: UUID, name: Name, definition: EventDefinition):
        storage.set_definition(str(game_id), name, definition)
        return {"status": "saved"}

    @admin_api.get("/v1/games/{game_id}/dictionary")
    def get_dictionary(game_id: UUID):
        return storage.get_dictionary(str(game_id))

    @admin_api.get("/v1/games/{game_id}/health")
    def game_health(
        game_id: UUID,
        selected_date: Annotated[
            date, Query(alias="date", ge=date(1970, 1, 1), le=date(9998, 12, 31))
        ],
        period: Literal["day", "week", "month", "custom"] = "week",
        end_date: Annotated[date | None, Query(ge=date(1970, 1, 1), le=date(9998, 12, 31))] = None,
        basis: Literal["server_ts", "client_ts"] = "server_ts",
    ):
        start, end = bounds(period, selected_date, end_date)
        return storage.health(str(game_id), start, end, basis)

    @admin_api.get("/v1/games/{game_id}/export")
    def export(
        game_id: UUID,
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
            output = build_export(storage, str(game_id), period, selected_date, basis, end_date)
        finally:
            export_slot.release()
        return FileResponse(
            output,
            media_type="application/zip",
            filename=f"{game_id}-{period}-{selected_date}"
            + (f"_to_{end_date}" if period == "custom" else "")
            + f"-{basis}.zip",
            headers={"Cache-Control": "no-store"},
            background=BackgroundTask(output.unlink, missing_ok=True),
        )

    app.include_router(admin_api)
    return app


def create_ingest_app():
    return create_app(Settings.from_env())


def create_admin_app():
    return create_app(Settings.from_env(), admin=True)
