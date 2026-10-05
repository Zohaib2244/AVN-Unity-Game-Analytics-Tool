import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from uuid import uuid4

from fastapi import HTTPException

from . import insights
from .config import Settings
from .models import Batch, EventDefinition, GameCreate, GameUpdate, timestamp

# Normalizes a stored environment string (production, Editor, DEVELOPMENT...) to lower case.
ENVIRONMENT_VALUE = "lower(substr(trim({column}), 1, 64))"


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
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > 2:
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
            """)
            if version < 2:
                # v2: game notes and archiving (archived games stop accepting events).
                columns = {row["name"] for row in connection.execute("PRAGMA table_info(games)")}
                if "notes" not in columns:
                    connection.execute(
                        "ALTER TABLE games ADD COLUMN notes TEXT NOT NULL DEFAULT ''"
                    )
                if "archived_at" not in columns:
                    connection.execute("ALTER TABLE games ADD COLUMN archived_at TEXT")
                connection.execute("PRAGMA user_version=2")
            # Keys created from here on keep their full value so the dashboard can copy them again.
            # Older keys only have a hash and stay uncopyable. Added without bumping user_version.
            key_columns = {row["name"] for row in connection.execute("PRAGMA table_info(api_keys)")}
            if "api_key" not in key_columns:
                connection.execute("ALTER TABLE api_keys ADD COLUMN api_key TEXT")
            game_ids = [row["id"] for row in connection.execute("SELECT id FROM games")]
        for game_id in game_ids:
            if self.game_path(game_id).exists():
                with self.connect(self.game_path(game_id)) as database:
                    self.upgrade_game_database(database)

    def upgrade_game_database(self, connection):
        """Tables added after v1, created on demand so existing game databases keep working.

        sessions: the environment (production, editor, development...) of each session, taken
        from the batch's `environment` or from session_start's `environment` param, so every event
        of a session can be filtered without the SDK repeating it. funnels: saved funnel steps.
        """
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                environment TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS funnels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                definition TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        """)
        if connection.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0:
            declared = ENVIRONMENT_VALUE.format(
                column="json_extract(payload, '$.params.environment')"
            )
            connection.execute(f"""
                INSERT OR IGNORE INTO sessions
                SELECT json_extract(payload, '$.session_id'),
                       {declared}
                FROM events
                WHERE name='session_start' AND json_extract(payload, '$.session_id') IS NOT NULL
                  AND json_type(payload, '$.params.environment')='text'
                ORDER BY client_ts
            """)

    def game_path(self, game_id):
        return self.root / "games" / f"{game_id}.sqlite3"

    def register_game(self, game: GameCreate):
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
                self.upgrade_game_database(database)
            registry.execute(
                "INSERT INTO games (id, name, bundle_id, platform, notes, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (game_id, game.name, game.bundle_id, game.platform, game.notes, created_at),
            )
            key = self._new_key(registry, game_id, "initial")
        return {
            "id": game_id,
            **game.model_dump(),
            "created_at": created_at,
            "archived_at": None,
            "key": key,
        }

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

    def game_files(self, game_id):
        path = self.game_path(game_id)
        return [path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")]

    def game_details(self, game_id):
        game = self.get_game(game_id)
        today = timestamp()[:10] + "T00:00:00.000000+00:00"
        with self.connect(self.game_path(game_id)) as connection:
            stats = connection.execute(
                """SELECT count(*) AS events, min(server_ts) AS first_event,
                          max(server_ts) AS last_event,
                          count(*) FILTER (WHERE server_ts>=?) AS today,
                          count(DISTINCT name) AS event_names
                   FROM events""",
                (today,),
            ).fetchone()
            definitions = connection.execute("SELECT count(*) FROM dictionary").fetchone()[0]
        with self.connect(self.root / "registry.sqlite3") as connection:
            keys = connection.execute(
                "SELECT count(*) AS total, count(*) FILTER (WHERE revoked_at IS NULL) AS active "
                "FROM api_keys WHERE game_id=?",
                (game_id,),
            ).fetchone()
        size = sum(path.stat().st_size for path in self.game_files(game_id) if path.exists())
        return {
            **game,
            **dict(stats),
            "definitions": definitions,
            "keys_total": keys["total"],
            "keys_active": keys["active"],
            "storage_bytes": size,
        }

    def update_game(self, game_id, update: GameUpdate):
        changes = update.model_dump(exclude_none=True)
        with self.connect(self.root / "registry.sqlite3") as registry:
            registry.execute("BEGIN IMMEDIATE")
            game = registry.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
            if game is None:
                raise HTTPException(404, "Game not found")
            if (
                "bundle_id" in changes
                and registry.execute(
                    "SELECT 1 FROM games WHERE bundle_id=? AND platform=? AND id<>?",
                    (changes["bundle_id"], game["platform"], game_id),
                ).fetchone()
            ):
                raise HTTPException(409, "Bundle ID and platform already registered")
            if "archived" in changes:
                archived = changes.pop("archived")
                if archived and game["archived_at"] is None:
                    changes["archived_at"] = timestamp()
                elif not archived:
                    changes["archived_at"] = None
            for column, value in changes.items():
                registry.execute(f"UPDATE games SET {column}=? WHERE id=?", (value, game_id))
        return self.game_details(game_id)

    def delete_game(self, game_id, confirm):
        """Removes the game and its keys; its database is moved to data/deleted/, not erased."""
        game = self.get_game(game_id)
        if confirm != game["bundle_id"]:
            raise HTTPException(400, "Type the game's bundle ID to confirm deletion")
        with self.connect(self.game_path(game_id)) as database:
            database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        trash = self.root / "deleted"
        trash.mkdir(exist_ok=True, mode=0o700)
        stamp = timestamp().replace(":", "").replace("+", "_")
        with self.connect(self.root / "registry.sqlite3") as registry:
            registry.execute("BEGIN IMMEDIATE")
            registry.execute("DELETE FROM api_keys WHERE game_id=?", (game_id,))
            registry.execute("DELETE FROM games WHERE id=?", (game_id,))
            for path in self.game_files(game_id):
                if path.exists():
                    path.rename(trash / f"{stamp}-{game['bundle_id']}-{path.name}")
        return {"status": "deleted", "moved_to": str(trash.relative_to(self.root))}

    def _new_key(self, connection, game_id, label):
        raw_key = "avn_" + secrets.token_urlsafe(32)
        key_id = str(uuid4())
        created_at = timestamp()
        connection.execute(
            """INSERT INTO api_keys (id, game_id, key_hash, prefix, label, created_at, api_key)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                key_id,
                game_id,
                hashlib.sha256(raw_key.encode()).hexdigest(),
                raw_key[:12],
                label,
                created_at,
                raw_key,
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
                    "SELECT id, prefix, label, created_at, revoked_at, api_key "
                    "FROM api_keys WHERE game_id=?",
                    (game_id,),
                )
            ]

    def delete_key(self, game_id, key_id):
        # Events are stored per game, not per key, so deleting a key never touches collected data.
        with self.connect(self.root / "registry.sqlite3") as connection:
            result = connection.execute(
                "DELETE FROM api_keys WHERE id=? AND game_id=?", (key_id, game_id)
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
                "SELECT api_keys.*, games.archived_at FROM api_keys "
                "JOIN games ON games.id=api_keys.game_id WHERE key_hash=?",
                (digest,),
            ).fetchone()
            if key is None or key["revoked_at"] is not None:
                raise HTTPException(401, "Invalid API key")
            if key["archived_at"] is not None:
                # The Unity SDK keeps events queued on 403 and retries later, so nothing is lost.
                raise HTTPException(403, "Game is archived; collection is paused")
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
        server_ts = timestamp()
        rows = []
        for event in batch.resolved:
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
        environments = {}
        for event in batch.resolved:
            declared = event.environment
            if event.name == "session_start" and isinstance(event.params.get("environment"), str):
                declared = declared or event.params["environment"]
            if declared and event.session_id:
                environments[event.session_id] = declared.strip().lower()[:64]
        with self.connect(self.game_path(game_id)) as connection:
            connection.executemany(
                "INSERT INTO events VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING",
                rows,
            )
            accepted = connection.total_changes
            connection.executemany(
                "INSERT INTO sessions VALUES (?, ?) "
                "ON CONFLICT(session_id) DO UPDATE SET environment=excluded.environment",
                environments.items(),
            )
        return {"accepted": accepted, "duplicates": len(rows) - accepted, "server_ts": server_ts}

    def set_definition(self, game_id, name, definition: EventDefinition):
        self.get_game(game_id)
        with self.connect(self.game_path(game_id)) as connection:
            connection.execute(
                """INSERT INTO dictionary VALUES (?, ?) ON CONFLICT(name)
                   DO UPDATE SET definition=excluded.definition""",
                (name, definition.model_dump_json()),
            )

    def delete_definition(self, game_id, name):
        self.get_game(game_id)
        with self.connect(self.game_path(game_id)) as connection:
            if connection.execute("DELETE FROM dictionary WHERE name=?", (name,)).rowcount == 0:
                raise HTTPException(404, "Definition not found")

    def get_dictionary(self, game_id):
        self.get_game(game_id)
        with self.connect(self.game_path(game_id)) as connection:
            return {
                row["name"]: json.loads(row["definition"])
                for row in connection.execute("SELECT * FROM dictionary ORDER BY name")
            }

    def health(self, game_id, start, end, basis="server_ts", filters=None):
        if basis not in ("server_ts", "client_ts"):
            raise ValueError("Invalid timestamp basis")
        self.get_game(game_id)
        condition, args = insights.where(start, end, filters, column=basis)
        with self.connect(self.game_path(game_id)) as connection:
            days = [
                dict(row)
                for row in connection.execute(
                    f"""SELECT substr({basis}, 1, 10) AS day, count(*) AS events
                   FROM events WHERE {condition} GROUP BY day ORDER BY day""",
                    args,
                )
            ]
        return {
            "game_id": game_id,
            "basis": basis,
            "total": sum(day["events"] for day in days),
            "days": days,
        }
