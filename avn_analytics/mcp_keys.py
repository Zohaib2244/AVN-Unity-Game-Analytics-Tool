"""Keys for the read-only MCP server (see mcp_server.py).

An admin makes a key, names it and picks what it may read: whole workspaces (including games
added to them later) and/or single games. A key never writes anything. The key text is kept
as is, so the admin can show it again and hand it to someone; whoever holds it can read what
it allows, so switch it off or regenerate it when it leaks. A key is sent in the
`Authorization: Bearer` header; a key that has `url_access` on may also be put in the URL path,
for clients that only accept a link.
"""

import hmac
import json
import secrets
from dataclasses import dataclass, field
from uuid import uuid4

from fastapi import HTTPException

from .models import timestamp

PREFIX = "avn_mcp_"
MAX_SCOPE_ITEMS = 200


def _ids(values, what):
    if not isinstance(values, (list, tuple)) or len(values) > MAX_SCOPE_ITEMS:
        raise HTTPException(400, f"{what} must be a short list")
    cleaned = []
    for value in values:
        text = str(value).strip()
        if text and text not in cleaned:
            cleaned.append(text)
    return cleaned


@dataclass(frozen=True, eq=False)
class McpPrincipal:
    """Who a key's calls run as. It has no role anywhere: access is the key's own scope."""

    key_id: str
    name: str
    email: str = field(init=False)
    is_admin: bool = False
    source: str = "mcp"
    roles: dict = field(default_factory=dict)

    def __post_init__(self):
        object.__setattr__(self, "email", f"mcp:{self.name}")

    def manages_games_in(self, workspace_id):
        return False


class McpKeys:
    def __init__(self, storage, accounts):
        self.storage = storage
        self.accounts = accounts

    @property
    def registry(self):
        return self.accounts.registry

    def initialize(self):
        with self.storage.connect(self.registry) as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS mcp_keys (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    secret TEXT NOT NULL UNIQUE,
                    workspace_ids TEXT NOT NULL DEFAULT '[]',
                    game_ids TEXT NOT NULL DEFAULT '[]',
                    url_access INTEGER NOT NULL DEFAULT 0,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_used_at TEXT,
                    calls INTEGER NOT NULL DEFAULT 0
                );
            """)

    # ---- reading

    @staticmethod
    def _view(row):
        item = dict(row)
        item["workspace_ids"] = json.loads(item["workspace_ids"])
        item["game_ids"] = json.loads(item["game_ids"])
        item["url_access"] = bool(item["url_access"])
        item["enabled"] = bool(item["enabled"])
        return item

    def list(self):
        with self.storage.connect(self.registry) as connection:
            rows = connection.execute("SELECT * FROM mcp_keys ORDER BY created_at, rowid")
            return [self._view(row) for row in rows]

    def get(self, key_id):
        with self.storage.connect(self.registry) as connection:
            row = connection.execute("SELECT * FROM mcp_keys WHERE id=?", (key_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "That key doesn't exist")
        return self._view(row)

    def find(self, secret, *, from_url=False):
        """The enabled key with this secret, or None. Every key is compared, so the time taken
        doesn't say how much of a guess was right."""
        secret = (secret or "").strip()
        if not secret.startswith(PREFIX):
            return None
        found = None
        for key in self.list():
            if hmac.compare_digest(key["secret"].encode(), secret.encode()):
                found = key
        if found is None or not found["enabled"] or (from_url and not found["url_access"]):
            return None
        return found

    def games(self, key):
        """The games this key may read, newest scope first: its workspaces' games, then its own."""
        seen, games = set(), []
        for workspace_id in key["workspace_ids"]:
            for game in self.storage.list_games(workspace_id):
                if game["id"] not in seen:
                    seen.add(game["id"])
                    games.append(game)
        for game in self.storage.list_games():
            if game["id"] in key["game_ids"] and game["id"] not in seen:
                seen.add(game["id"])
                games.append(game)
        return games

    def can_read(self, key, game_id):
        return any(game["id"] == game_id for game in self.games(key))

    def principal(self, key):
        return McpPrincipal(key["id"], key["name"])

    # ---- changing (admin only; the caller has checked)

    def _checked_scope(self, workspace_ids, game_ids):
        workspace_ids = _ids(workspace_ids, "Workspaces")
        game_ids = _ids(game_ids, "Games")
        if not workspace_ids and not game_ids:
            raise HTTPException(400, "Choose at least one workspace or game")
        with self.storage.connect(self.registry) as connection:
            known_workspaces = {
                row["id"] for row in connection.execute("SELECT id FROM workspaces")
            }
        known_games = {game["id"] for game in self.storage.list_games()}
        if any(item not in known_workspaces for item in workspace_ids):
            raise HTTPException(400, "One of those workspaces doesn't exist")
        if any(item not in known_games for item in game_ids):
            raise HTTPException(400, "One of those games doesn't exist")
        return workspace_ids, game_ids

    @staticmethod
    def _name(name):
        name = str(name or "").strip()
        if not 1 <= len(name) <= 80:
            raise HTTPException(400, "Give the key a name of 1 to 80 characters")
        return name

    def create(self, actor, name, workspace_ids, game_ids, url_access=False):
        name = self._name(name)
        workspace_ids, game_ids = self._checked_scope(workspace_ids, game_ids)
        key_id = str(uuid4())
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                """INSERT INTO mcp_keys
                   (id, name, secret, workspace_ids, game_ids, url_access, created_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    key_id,
                    name,
                    PREFIX + secrets.token_urlsafe(32),
                    json.dumps(workspace_ids),
                    json.dumps(game_ids),
                    int(bool(url_access)),
                    getattr(actor, "email", str(actor)),
                    timestamp(),
                ),
            )
        self.accounts.audit(actor, "mcp.key_create", None, name)
        return self.get(key_id)

    def update(self, actor, key_id, changes):
        key = self.get(key_id)
        name = self._name(changes["name"]) if "name" in changes else key["name"]
        workspace_ids, game_ids = self._checked_scope(
            changes.get("workspace_ids", key["workspace_ids"]),
            changes.get("game_ids", key["game_ids"]),
        )
        enabled = bool(changes.get("enabled", key["enabled"]))
        url_access = bool(changes.get("url_access", key["url_access"]))
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                """UPDATE mcp_keys SET name=?, workspace_ids=?, game_ids=?, enabled=?, url_access=?
                   WHERE id=?""",
                (
                    name,
                    json.dumps(workspace_ids),
                    json.dumps(game_ids),
                    int(enabled),
                    int(url_access),
                    key_id,
                ),
            )
        self.accounts.audit(actor, "mcp.key_update", None, name)
        return self.get(key_id)

    def regenerate(self, actor, key_id):
        key = self.get(key_id)
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                "UPDATE mcp_keys SET secret=? WHERE id=?",
                (PREFIX + secrets.token_urlsafe(32), key_id),
            )
        self.accounts.audit(actor, "mcp.key_regenerate", None, key["name"])
        return self.get(key_id)

    def delete(self, actor, key_id):
        key = self.get(key_id)
        with self.storage.connect(self.registry) as connection:
            connection.execute("DELETE FROM mcp_keys WHERE id=?", (key_id,))
        self.accounts.audit(actor, "mcp.key_delete", None, key["name"])

    def used(self, key_id):
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                "UPDATE mcp_keys SET calls=calls+1, last_used_at=? WHERE id=?",
                (timestamp(), key_id),
            )
