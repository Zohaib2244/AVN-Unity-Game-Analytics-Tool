import hashlib
import secrets
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path

from fastapi import HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ASSETS = Path(__file__).parent / "static"
COOKIE = "avn_session"


class PasswordInput(BaseModel):
    password: str = Field(min_length=12, max_length=128)


class WebAuth:
    def __init__(self, storage):
        self.storage = storage

    def initialize(self):
        with self.storage.connect(self.storage.root / "registry.sqlite3") as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS web_credentials (
                    id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, hash TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS web_sessions (
                    hash TEXT PRIMARY KEY, expires INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS web_login_limit (
                    id INTEGER PRIMARY KEY CHECK(id=1), window INTEGER NOT NULL,
                    attempts INTEGER NOT NULL
                );
            """)

    def credential(self):
        with self.storage.connect(self.storage.root / "registry.sqlite3") as connection:
            return connection.execute("SELECT * FROM web_credentials WHERE id=1").fetchone()

    def same_origin(self, request):
        if request.url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise HTTPException(403, "Use the local website address")
        expected = f"{request.url.scheme}://{request.url.netloc}"
        if request.headers.get("origin") != expected:
            raise HTTPException(403, "This action must come from the website")

    def session_valid(self, request):
        session = request.cookies.get(COOKIE, "")
        if not session or len(session) > 128:
            return False
        with self.storage.connect(self.storage.root / "registry.sqlite3") as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM web_sessions WHERE hash=? AND expires>?",
                    (hashlib.sha256(session.encode()).hexdigest(), int(time.time())),
                ).fetchone()
                is not None
            )

    def throttle(self):
        window = int(time.time() // 60)
        with self.storage.connect(self.storage.root / "registry.sqlite3") as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM web_login_limit WHERE id=1").fetchone()
            count = row["attempts"] if row and row["window"] == window else 0
            if count >= 10:
                raise HTTPException(
                    429, "Too many attempts. Try again in a minute.", headers={"Retry-After": "60"}
                )
            connection.execute(
                "INSERT OR REPLACE INTO web_login_limit VALUES (1, ?, ?)", (window, count + 1)
            )

    def issue_session(self, request, response):
        session = secrets.token_urlsafe(32)
        now = int(time.time())
        with self.storage.connect(self.storage.root / "registry.sqlite3") as connection:
            connection.execute("DELETE FROM web_sessions WHERE expires<=?", (now,))
            connection.execute(
                "INSERT INTO web_sessions VALUES (?, ?)",
                (hashlib.sha256(session.encode()).hexdigest(), now + 28800),
            )
        response.set_cookie(
            COOKIE,
            session,
            httponly=True,
            samesite="strict",
            secure=request.url.scheme == "https",
            max_age=28800,
            path="/",
        )

    def overview(self):
        games = self.storage.list_games()
        today = datetime.now(UTC).strftime("%Y-%m-%dT00:00:00.000000+00:00")
        with self.storage.connect(self.storage.root / "registry.sqlite3") as registry:
            active_keys = registry.execute(
                "SELECT count(*) FROM api_keys WHERE revoked_at IS NULL"
            ).fetchone()[0]
        for game in games:
            with self.storage.connect(self.storage.game_path(game["id"])) as connection:
                game["events"] = connection.execute("SELECT count(*) FROM events").fetchone()[0]
                game["last_event"] = connection.execute(
                    "SELECT max(server_ts) FROM events"
                ).fetchone()[0]
                game["today"] = connection.execute(
                    "SELECT count(*) FROM events WHERE server_ts>=?", (today,)
                ).fetchone()[0]
        disk = shutil.disk_usage(self.storage.root)
        return {
            "games": games,
            "events": sum(game["events"] for game in games),
            "today": sum(game["today"] for game in games),
            "active_keys": active_keys,
            "storage": {
                "total": disk.total,
                "free": disk.free,
                "used": disk.used,
                "reserve": self.storage.settings.min_free_bytes,
            },
            "healthy": disk.free >= self.storage.settings.min_free_bytes,
        }


def add_website(app, auth):
    app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")

    @app.middleware("http")
    async def browser_headers(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
            "object-src 'none'; base-uri 'none'; form-action 'self'"
        )
        return response

    @app.get("/auth/status", include_in_schema=False)
    def auth_status(request: Request):
        return {
            "configured": auth.credential() is not None,
            "authenticated": auth.session_valid(request),
        }

    @app.post("/auth/setup", include_in_schema=False)
    def setup(body: PasswordInput, request: Request, response: Response):
        auth.same_origin(request)
        auth.throttle()
        salt = secrets.token_hex(16)
        password_hash = hashlib.scrypt(
            body.password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1
        ).hex()
        with auth.storage.connect(auth.storage.root / "registry.sqlite3") as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM web_credentials").fetchone():
                raise HTTPException(
                    409, "An admin password is already configured. Sign in instead."
                )
            connection.execute(
                "INSERT INTO web_credentials VALUES (1, ?, ?)", (salt, password_hash)
            )
        auth.issue_session(request, response)
        return {"status": "ok"}

    @app.post("/auth/login", include_in_schema=False)
    def login(body: PasswordInput, request: Request, response: Response):
        auth.same_origin(request)
        auth.throttle()
        credential = auth.credential()
        if credential is None:
            raise HTTPException(401, "Create your admin password first")
        candidate = hashlib.scrypt(
            body.password.encode(), salt=bytes.fromhex(credential["salt"]), n=16384, r=8, p=1
        ).hex()
        if not secrets.compare_digest(candidate, credential["hash"]):
            raise HTTPException(401, "That password is not correct")
        auth.issue_session(request, response)
        return {"status": "ok"}

    @app.post("/auth/logout", include_in_schema=False)
    def logout(request: Request, response: Response):
        auth.same_origin(request)
        digest = hashlib.sha256(request.cookies.get(COOKIE, "").encode()).hexdigest()
        with auth.storage.connect(auth.storage.root / "registry.sqlite3") as connection:
            connection.execute("DELETE FROM web_sessions WHERE hash=?", (digest,))
        response.delete_cookie(COOKIE, path="/")
        return {"status": "ok"}

    def page():
        return FileResponse(ASSETS / "index.html", media_type="text/html")

    for route in (
        "/",
        "/games",
        "/games/new",
        "/games/{game_id}",
        "/keys",
        "/exports",
        "/dictionary",
        "/status",
        "/settings",
        "/login",
    ):
        app.add_api_route(route, page, methods=["GET"], include_in_schema=False)
