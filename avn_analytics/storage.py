import hashlib
import json
import secrets
import shutil
import sqlite3
import time
from contextlib import contextmanager
from uuid import uuid4

from fastapi import HTTPException

from .config import Settings
from .models import Batch, EventDefinition, GameCreate, timestamp


class Storage:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = settings.data_dir

    @contextmanager
    def connect(self, path):
        connection = sqlite3.connect(path, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA synchronous=FULL")
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self):
        version = sqlite3.sqlite_version_info
        if not (
            version >= (3, 51, 3)
            or (3, 44, 6) <= version < (3, 45, 0)
            or (3, 50, 7) <= version < (3, 51, 0)
        ):
            raise RuntimeError(
                "Use SQLite 3.51.3+ (or 3.44.6/3.50.7 backport) for the WAL-reset fix"
            )
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.root / "games").mkdir(exist_ok=True, mode=0o700)
        (self.root / "exports").mkdir(exist_ok=True, mode=0o700)
        with self.connect(self.root / "registry.sqlite3") as connection:
            if connection.execute("PRAGMA user_version").fetchone()[0] > 1:
                raise RuntimeError("Database schema is newer than this application")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS games (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    bundle_id TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(bundle_id, platform)
                );
                CREATE TABLE IF NOT EXISTS api_keys (
                    id TEXT PRIMARY KEY,
                    game_id TEXT NOT NULL REFERENCES games(id),
                    key_hash TEXT NOT NULL UNIQUE,
                    prefix TEXT NOT NULL,
                    label TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    revoked_at TEXT,
                    window INTEGER NOT NULL DEFAULT 0,
                    requests INTEGER NOT NULL DEFAULT 0
                );
                PRAGMA user_version=1;
            """)

    def game_path(self, game_id):
        return self.root / "games" / f"{game_id}.sqlite3"

    def require_space(self):
        if shutil.disk_usage(self.root).free < self.settings.min_free_bytes:
            raise HTTPException(503, "Storage reserve reached", headers={"Retry-After": "60"})

    def register_game(self, game: GameCreate):
        self.require_space()
        game_id = str(uuid4())
        created_at = timestamp()
        with self.connect(self.root / "registry.sqlite3") as registry:
            registry.execute("BEGIN IMMEDIATE")
            if registry.execute(
                "SELECT 1 FROM games WHERE bundle_id=? AND platform=?",
                (game.bundle_id, game.platform),
            ).fetchone():
                raise HTTPException(409, "Bundle ID and platform already registered")
            with self.connect(self.game_path(game_id)) as database:
                database.execute("PRAGMA journal_mode=WAL")
                database.executescript("""
                    CREATE TABLE events (
                        event_id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        client_ts TEXT NOT NULL,
                        server_ts TEXT NOT NULL,
                        payload TEXT NOT NULL
                    );
                    CREATE INDEX events_server_ts ON events(server_ts, event_id);
                    CREATE INDEX events_client_ts ON events(client_ts, event_id);
                    CREATE TABLE dictionary (
                        name TEXT PRIMARY KEY,
                        definition TEXT NOT NULL
                    );
                    PRAGMA user_version=1;
                """)
            registry.execute(
                "INSERT INTO games VALUES (?, ?, ?, ?, ?)",
                (game_id, game.name, game.bundle_id, game.platform, created_at),
            )
            key = self._new_key(registry, game_id, "initial")
        return {"id": game_id, **game.model_dump(), "created_at": created_at, "key": key}

    def list_games(self):
        with self.connect(self.root / "registry.sqlite3") as connection:
            return [
                dict(row) for row in connection.execute("SELECT * FROM games ORDER BY created_at")
            ]

    def get_game(self, game_id):
        with self.connect(self.root / "registry.sqlite3") as connection:
            row = connection.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Game not found")
        return dict(row)

    def _new_key(self, connection, game_id, label):
        raw_key = "avn_" + secrets.token_urlsafe(32)
        key_id = str(uuid4())
        created_at = timestamp()
        connection.execute(
            """INSERT INTO api_keys (id, game_id, key_hash, prefix, label, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                key_id,
                game_id,
                hashlib.sha256(raw_key.encode()).hexdigest(),
                raw_key[:12],
                label,
                created_at,
            ),
        )
        return {"id": key_id, "api_key": raw_key, "label": label, "created_at": created_at}

    def create_key(self, game_id, label):
        self.get_game(game_id)
        with self.connect(self.root / "registry.sqlite3") as connection:
            return self._new_key(connection, game_id, label)

    def list_keys(self, game_id):
        self.get_game(game_id)
        with self.connect(self.root / "registry.sqlite3") as connection:
            return [
                dict(row)
                for row in connection.execute(
                    "SELECT id, prefix, label, created_at, revoked_at "
                    "FROM api_keys WHERE game_id=?",
                    (game_id,),
                )
            ]

    def revoke_key(self, game_id, key_id):
        with self.connect(self.root / "registry.sqlite3") as connection:
            result = connection.execute(
                "UPDATE api_keys SET revoked_at=COALESCE(revoked_at, ?) WHERE id=? AND game_id=?",
                (timestamp(), key_id, game_id),
            )
            if result.rowcount == 0:
                raise HTTPException(404, "Key not found")

    def authorize_ingest(self, raw_key):
        if not raw_key or len(raw_key) > 128:
            raise HTTPException(401, "Invalid API key")
        digest = hashlib.sha256(raw_key.encode()).hexdigest()
        current_time = time.time()
        window = int(current_time // 60)
        with self.connect(self.root / "registry.sqlite3") as connection:
            connection.execute("BEGIN IMMEDIATE")
            key = connection.execute(
                "SELECT * FROM api_keys WHERE key_hash=?", (digest,)
            ).fetchone()
            if key is None or key["revoked_at"] is not None:
                raise HTTPException(401, "Invalid API key")
            count = key["requests"] if key["window"] == window else 0
            if count >= self.settings.requests_per_minute:
                raise HTTPException(
                    429,
                    "Rate limit exceeded",
                    headers={
                        "Retry-After": str(max(1, 60 - int(current_time % 60))),
                    },
                )
            connection.execute(
                "UPDATE api_keys SET window=?, requests=? WHERE id=?",
                (window, count + 1, key["id"]),
            )
            return key["game_id"]

    def ingest(self, game_id, batch: Batch, country: str | None = None):
        self.require_space()
        server_ts = timestamp()
        rows = []
        for event in batch.events:
            payload = event.model_dump(mode="json")
            payload["client_ts"] = timestamp(event.client_ts)
            payload["server_ts"] = server_ts
            payload["country"] = country  # set from the request IP by the server, never by clients
            rows.append(
                (
                    str(event.event_id),
                    event.name,
                    payload["client_ts"],
                    server_ts,
                    json.dumps(payload, ensure_ascii=True, allow_nan=False),
                )
            )
        with self.connect(self.game_path(game_id)) as connection:
            connection.executemany(
                "INSERT INTO events VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING",
                rows,
            )
            accepted = connection.total_changes
        return {"accepted": accepted, "duplicates": len(rows) - accepted, "server_ts": server_ts}

    def set_definition(self, game_id, name, definition: EventDefinition):
        self.get_game(game_id)
        with self.connect(self.game_path(game_id)) as connection:
            connection.execute(
                """INSERT INTO dictionary VALUES (?, ?) ON CONFLICT(name)
                   DO UPDATE SET definition=excluded.definition""",
                (name, definition.model_dump_json()),
            )

    def get_dictionary(self, game_id):
        self.get_game(game_id)
        with self.connect(self.game_path(game_id)) as connection:
            return {
                row["name"]: json.loads(row["definition"])
                for row in connection.execute("SELECT * FROM dictionary ORDER BY name")
            }

    def health(self, game_id, start, end):
        self.get_game(game_id)
        with self.connect(self.game_path(game_id)) as connection:
            days = [
                dict(row)
                for row in connection.execute(
                    """SELECT substr(server_ts, 1, 10) AS day, count(*) AS events
                   FROM events WHERE server_ts>=? AND server_ts<? GROUP BY day ORDER BY day""",
                    (start, end),
                )
            ]
        return {
            "game_id": game_id,
            "basis": "server_ts",
            "days": days,
            "free_bytes": shutil.disk_usage(self.root).free,
        }
