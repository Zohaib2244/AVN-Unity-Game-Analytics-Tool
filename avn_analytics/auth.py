"""Who is making a request, and what they may do.

Sign-in is handled by Cloudflare Access, which puts a signed token on every request. This module
verifies that token and looks the person up in the team list (invite-only). Games live in
workspaces, and a person's role belongs to a workspace:

- admin (global): everything in every workspace, including managing workspaces and people
- lead (in a workspace): manages that workspace's games and who sees them
- member (in a workspace): works with the games they were given in that workspace

Anyone who passes Cloudflare but isn't on the list (or has no workspace) gets a "no access" answer.
When team access is not configured (no Cloudflare team domain and audience), every request is an
admin, which is the original single-user behaviour.
"""

import hmac
import ipaddress
import json
import logging
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from uuid import uuid4

import jwt
from fastapi import HTTPException, Request

from .models import timestamp

logger = logging.getLogger("avn_analytics.auth")

ROLES = ("admin", "lead", "member")
CERTS_TTL = 3600.0
# Headers Cloudflare adds to every request it proxies. Their presence means the request did not
# come from the local network, so it must carry a valid Access token.
CLOUDFLARE_MARKERS = ("cf-ray", "cf-connecting-ip", "cf-ipcountry", "cf-visitor")


@dataclass(frozen=True, eq=False)
class Principal:
    email: str
    name: str
    is_admin: bool
    source: str  # access | lan | token | local
    roles: dict = field(default_factory=dict)  # workspace id -> "lead" | "member"

    def role_in(self, workspace_id):
        return "admin" if self.is_admin else self.roles.get(workspace_id)

    def sees_workspace(self, workspace_id):
        return self.is_admin or workspace_id in self.roles

    def manages_games_in(self, workspace_id):
        return self.is_admin or self.roles.get(workspace_id) == "lead"

    @property
    def manages_team(self):
        return self.is_admin


class AccessVerifier:
    """Validates Cloudflare Access tokens against the team's published signing keys."""

    def __init__(self, team_domain, audience, keys=None):
        self.team_domain = team_domain
        self.audience = audience
        self._fixed = keys is not None  # tests inject {kid: public key}; otherwise fetched
        self._keys = keys
        self._fetched_at = 0.0
        self._lock = threading.Lock()

    def _load_keys(self):
        url = f"https://{self.team_domain}/cdn-cgi/access/certs"
        with urllib.request.urlopen(url, timeout=5) as response:  # noqa: S310 (fixed https URL)
            document = json.load(response)
        return {
            item["kid"]: jwt.PyJWK(item).key for item in document.get("keys", []) if "kid" in item
        }

    def _key_for(self, kid):
        with self._lock:
            if self._fixed:
                return self._keys.get(kid)
            stale = time.monotonic() - self._fetched_at > CERTS_TTL
            if self._keys is None or stale or kid not in self._keys:
                try:
                    self._keys = self._load_keys()
                    self._fetched_at = time.monotonic()
                except Exception:  # keep serving with the last known keys if Cloudflare is slow
                    logger.warning("Could not refresh Cloudflare Access signing keys")
                    if self._keys is None:
                        raise
            return (self._keys or {}).get(kid)

    def email_from(self, token):
        try:
            kid = jwt.get_unverified_header(token).get("kid")
            key = self._key_for(kid)
            if key is None:
                raise HTTPException(401, "Sign-in required")
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=self.audience,
                issuer=f"https://{self.team_domain}",
                options={"require": ["exp", "iat", "aud", "iss"]},
            )
        except HTTPException:
            raise
        except jwt.PyJWTError:
            raise HTTPException(401, "Sign-in required") from None
        except Exception:
            raise HTTPException(503, "Sign-in service unavailable. Try again shortly.") from None
        email = str(claims.get("email") or "").strip().lower()
        if not email:
            raise HTTPException(401, "Sign-in required")
        return email


def client_ip(request: Request):
    """The caller's address. X-Forwarded-For (set by our reverse proxy) is only believed when
    the connection itself comes from a private address, i.e. from that proxy."""
    peer = request.client.host if request.client else ""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded and is_private(peer):
        return forwarded.split(",")[-1].strip()
    return peer


# Addresses that mean "inside the house": loopback, home/office networks, link-local and Tailscale.
# (Python's own is_private also covers documentation ranges, so the list is spelled out.)
LOCAL_NETWORKS = tuple(
    ipaddress.ip_network(block)
    for block in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "100.64.0.0/10",  # Tailscale
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)


def is_private(address):
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return any(ip in network for network in LOCAL_NETWORKS)


def bearer_token(request: Request):
    header = request.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    return value.strip() if scheme.lower() == "bearer" else ""


class Accounts:
    """Workspaces, the team list, per-game access and the audit log, in the registry database."""

    def __init__(self, storage, settings, verifier=None):
        self.storage = storage
        self.settings = settings
        self.verifier = verifier or (
            AccessVerifier(settings.access_team_domain, settings.access_audience)
            if settings.access_enabled
            else None
        )

    @property
    def registry(self):
        return self.storage.root / "registry.sqlite3"

    def initialize(self):
        with self.storage.connect(self.registry) as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS workspaces (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS workspaces_name ON workspaces(lower(name));
                CREATE TABLE IF NOT EXISTS workspace_members (
                    workspace_id TEXT NOT NULL,
                    email TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
                    PRIMARY KEY (workspace_id, email)
                );
                CREATE TABLE IF NOT EXISTS team_users (
                    email TEXT PRIMARY KEY,
                    name TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL CHECK (role IN ('admin', 'lead', 'member')),
                    added_by TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT
                );
                CREATE TABLE IF NOT EXISTS game_access (
                    email TEXT NOT NULL,
                    game_id TEXT NOT NULL,
                    PRIMARY KEY (email, game_id)
                );
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    at TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    game_id TEXT,
                    detail TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
            """)
            now = timestamp()
            if connection.execute("SELECT count(*) FROM workspaces").fetchone()[0] == 0:
                # First start with workspaces: everything that exists lands in "Default", and the
                # roles people had become their roles there. (In team_users, "admin" is global;
                # any other value is just a nominal marker now.)
                default = str(uuid4())
                connection.execute(
                    "INSERT INTO workspaces VALUES (?, 'Default', ?)", (default, now)
                )
                connection.execute(
                    """INSERT OR IGNORE INTO workspace_members
                       SELECT ?, email, role FROM team_users WHERE role IN ('lead', 'member')""",
                    (default,),
                )
                connection.execute("UPDATE team_users SET role='member' WHERE role='lead'")
            default = connection.execute(
                "SELECT id FROM workspaces ORDER BY created_at, rowid LIMIT 1"
            ).fetchone()["id"]
            connection.execute(
                "UPDATE games SET workspace_id=? WHERE workspace_id IS NULL", (default,)
            )
            if self.settings.admin_email:
                connection.execute(
                    """INSERT INTO team_users (email, role, added_by, created_at)
                       VALUES (?, 'admin', 'system', ?)
                       ON CONFLICT(email) DO UPDATE SET role='admin'""",
                    (self.settings.admin_email, now),
                )

    # ---- who is calling

    def _no_access(self, email):
        contact = (
            f" Contact the admin ({self.settings.admin_email}) to get access."
            if (self.settings.admin_email)
            else " Contact the admin to get access."
        )
        return HTTPException(
            403, f"{email} hasn't been given access to this workspace yet.{contact}"
        )

    def authenticate(self, request: Request) -> Principal:
        if not self.settings.access_enabled:
            return Principal("local", "Local admin", True, "local")
        supplied = bearer_token(request)
        if supplied:
            if self.settings.admin_token and hmac.compare_digest(
                supplied.encode(), self.settings.admin_token.encode()
            ):
                return Principal("token", "Admin token", True, "token")
            raise HTTPException(401, "Invalid admin token")
        assertion = request.headers.get("cf-access-jwt-assertion")
        if assertion:
            return self._team_member(self.verifier.email_from(assertion))
        if any(marker in request.headers for marker in CLOUDFLARE_MARKERS):
            # Came through Cloudflare but without a valid Access sign-in: never trust the network.
            raise HTTPException(401, "Sign-in required")
        if self.settings.lan_admin and is_private(client_ip(request)):
            return Principal("lan", "Admin (local network)", True, "lan")
        raise HTTPException(401, "Sign-in required")

    def _team_member(self, email):
        with self.storage.connect(self.registry) as connection:
            row = connection.execute("SELECT * FROM team_users WHERE email=?", (email,)).fetchone()
            if row is None:
                raise self._no_access(email)
            roles = {
                member["workspace_id"]: member["role"]
                for member in connection.execute(
                    "SELECT workspace_id, role FROM workspace_members WHERE email=?", (email,)
                )
            }
            is_admin = row["role"] == "admin"
            if not is_admin and not roles:
                raise self._no_access(email)
            now = timestamp()
            if not row["last_seen_at"] or row["last_seen_at"][:13] != now[:13]:  # hourly
                connection.execute(
                    "UPDATE team_users SET last_seen_at=? WHERE email=?", (now, email)
                )
        return Principal(email, row["name"], is_admin, "access", roles)

    # ---- workspaces

    def _workspace(self, connection, workspace_id):
        row = connection.execute("SELECT * FROM workspaces WHERE id=?", (workspace_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Workspace not found")
        return row

    def workspace_of_game(self, game_id):
        with self.storage.connect(self.registry) as connection:
            row = connection.execute(
                "SELECT workspace_id FROM games WHERE id=?", (game_id,)
            ).fetchone()
        return row["workspace_id"] if row else None

    def workspaces_for(self, principal, counts=False):
        """The workspaces a person can open, with their role in each."""
        with self.storage.connect(self.registry) as connection:
            rows = [
                dict(row)
                for row in connection.execute("SELECT * FROM workspaces ORDER BY created_at, rowid")
            ]
            if counts:
                for row in rows:
                    row["games"] = connection.execute(
                        "SELECT count(*) FROM games WHERE workspace_id=?", (row["id"],)
                    ).fetchone()[0]
                    row["members"] = connection.execute(
                        "SELECT count(*) FROM workspace_members WHERE workspace_id=?", (row["id"],)
                    ).fetchone()[0]
        result = []
        for row in rows:
            if principal.sees_workspace(row["id"]):
                result.append({**row, "role": principal.role_in(row["id"])})
        return result

    def pick_workspace(self, principal, requested=None):
        """The workspace a request is about: the one asked for, or the person's first."""
        available = self.workspaces_for(principal)
        if requested:
            if not any(item["id"] == requested for item in available):
                raise HTTPException(404, "Workspace not found")
            return requested
        if not available:
            raise self._no_access(principal.email)
        return available[0]["id"]

    def _check_name(self, name):
        name = (name or "").strip()
        if not 1 <= len(name) <= 60:
            raise HTTPException(400, "Give the workspace a name of 1–60 characters")
        return name

    def create_workspace(self, actor, name):
        name = self._check_name(name)
        workspace_id = str(uuid4())
        with self.storage.connect(self.registry) as connection:
            if connection.execute(
                "SELECT 1 FROM workspaces WHERE lower(name)=lower(?)", (name,)
            ).fetchone():
                raise HTTPException(409, "A workspace with that name already exists")
            connection.execute(
                "INSERT INTO workspaces VALUES (?, ?, ?)", (workspace_id, name, timestamp())
            )
        self.audit(actor, "workspace.create", None, name)
        return {"id": workspace_id, "name": name}

    def rename_workspace(self, actor, workspace_id, name):
        name = self._check_name(name)
        with self.storage.connect(self.registry) as connection:
            old = self._workspace(connection, workspace_id)
            if connection.execute(
                "SELECT 1 FROM workspaces WHERE lower(name)=lower(?) AND id<>?",
                (name, workspace_id),
            ).fetchone():
                raise HTTPException(409, "A workspace with that name already exists")
            connection.execute("UPDATE workspaces SET name=? WHERE id=?", (name, workspace_id))
        self.audit(actor, "workspace.rename", None, f"{old['name']} → {name}")

    def _conflicts(self, connection, games, destination):
        """Moving would put two games with the same name and platform in one workspace."""
        for game in games:
            clash = connection.execute(
                """SELECT 1 FROM games WHERE workspace_id=? AND lower(name)=lower(?)
                   AND platform=? AND id<>?""",
                (destination, game["name"], game["platform"], game["id"]),
            ).fetchone()
            if clash:
                raise HTTPException(
                    409,
                    f"The destination already has a {game['platform']} game named "
                    f"“{game['name']}”. Rename one of them first.",
                )

    def move_game(self, actor, game_id, destination):
        """Moves a game, and its other platform versions, to another workspace."""
        with self.storage.connect(self.registry) as connection:
            connection.execute("BEGIN IMMEDIATE")
            game = connection.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
            if game is None:
                raise HTTPException(404, "Game not found")
            target = self._workspace(connection, destination)
            if game["workspace_id"] == destination:
                raise HTTPException(400, "That game is already in this workspace")
            siblings = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM games WHERE workspace_id=? AND lower(name)=lower(?)",
                    (game["workspace_id"], game["name"]),
                )
            ]
            self._conflicts(connection, siblings, destination)
            ids = [item["id"] for item in siblings]
            marks = ",".join("?" * len(ids))
            connection.execute(
                f"UPDATE games SET workspace_id=? WHERE id IN ({marks})", (destination, *ids)
            )
            # Members were granted games in the old workspace; those grants no longer apply.
            dropped = connection.execute(
                f"DELETE FROM game_access WHERE game_id IN ({marks})", ids
            ).rowcount
        self.audit(
            actor,
            "game.move",
            game_id,
            f"{game['name']} → {target['name']} ({dropped} grant(s) cleared)",
        )
        return {"moved": ids, "workspace_id": destination, "grants_cleared": dropped}

    def delete_workspace(self, actor, workspace_id, confirm, move_to=None, delete_games=False):
        with self.storage.connect(self.registry) as connection:
            connection.execute("BEGIN IMMEDIATE")
            workspace = self._workspace(connection, workspace_id)
            if confirm != workspace["name"]:
                raise HTTPException(400, "Type the workspace's name to confirm")
            if connection.execute("SELECT count(*) FROM workspaces").fetchone()[0] <= 1:
                raise HTTPException(400, "There must always be at least one workspace")
            games = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM games WHERE workspace_id=?", (workspace_id,)
                )
            ]
            if games and not move_to and not delete_games:
                raise HTTPException(
                    409,
                    f"This workspace has {len(games)} game(s). Choose a workspace to move them "
                    "to, or choose to delete them.",
                )
            if games and move_to:
                if move_to == workspace_id:
                    raise HTTPException(400, "Choose a different workspace to move the games to")
                self._workspace(connection, move_to)
                self._conflicts(connection, games, move_to)
                connection.execute(
                    "UPDATE games SET workspace_id=? WHERE workspace_id=?", (move_to, workspace_id)
                )
                games_to_delete = []
            else:
                games_to_delete = games
            ids = [game["id"] for game in games]
            if ids:
                connection.execute(
                    f"DELETE FROM game_access WHERE game_id IN ({','.join('?' * len(ids))})", ids
                )
            connection.execute(
                "DELETE FROM workspace_members WHERE workspace_id=?", (workspace_id,)
            )
            connection.execute("DELETE FROM workspaces WHERE id=?", (workspace_id,))
        if games_to_delete:  # files go to data/deleted; the workspace is already gone
            self.storage.delete_games(games_to_delete)
        outcome = (
            f"{len(games)} game(s) moved"
            if games and move_to
            else f"{len(games)} game(s) deleted"
            if games
            else "empty"
        )
        self.audit(actor, "workspace.delete", None, f"{workspace['name']} ({outcome})")
        return {"status": "deleted", "games": len(games), "moved": bool(move_to)}

    # ---- games a person may see

    def can_see_game(self, principal, game_id):
        workspace_id = self.workspace_of_game(game_id)
        if workspace_id is None:
            return False
        role = principal.role_in(workspace_id)
        if role in ("admin", "lead"):
            return True
        if role != "member":
            return False
        with self.storage.connect(self.registry) as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM game_access WHERE email=? AND game_id=?",
                    (principal.email, game_id),
                ).fetchone()
                is not None
            )

    def games_in(self, principal, workspace_id):
        """The games of one workspace that this person may open."""
        games = self.storage.list_games(workspace_id)
        if principal.role_in(workspace_id) in ("admin", "lead"):
            return games
        with self.storage.connect(self.registry) as connection:
            granted = {
                row["game_id"]
                for row in connection.execute(
                    "SELECT game_id FROM game_access WHERE email=?", (principal.email,)
                )
            }
        return [game for game in games if game["id"] in granted]

    # ---- people

    def list_people(self):
        with self.storage.connect(self.registry) as connection:
            people = [dict(row) for row in connection.execute("SELECT * FROM team_users")]
            members = connection.execute("SELECT * FROM workspace_members").fetchall()
            grants = connection.execute("SELECT * FROM game_access").fetchall()
        for person in people:
            person["admin"] = person.pop("role") == "admin"
            person["memberships"] = {
                m["workspace_id"]: m["role"] for m in members if m["email"] == person["email"]
            }
            person["game_ids"] = sorted(
                g["game_id"] for g in grants if g["email"] == person["email"]
            )
        people.sort(key=lambda person: (not person["admin"], person["email"]))
        return people

    def _clean_email(self, email):
        email = (email or "").strip().lower()
        if "@" not in email or email.startswith("@") or " " in email or len(email) > 254:
            raise HTTPException(400, "Enter a valid email address")
        return email

    def _grant(self, connection, email, workspace_id, game_ids):
        valid = {
            row["id"]
            for row in connection.execute(
                "SELECT id FROM games WHERE workspace_id=?", (workspace_id,)
            )
        }
        connection.execute(
            "DELETE FROM game_access WHERE email=? AND game_id IN "
            "(SELECT id FROM games WHERE workspace_id=?)",
            (email, workspace_id),
        )
        connection.executemany(
            "INSERT INTO game_access VALUES (?, ?)",
            [(email, game_id) for game_id in sorted(set(game_ids) & valid)],
        )

    def add_person(self, actor, email, name, role, workspace_id, game_ids):
        email = self._clean_email(email)
        with self.storage.connect(self.registry) as connection:
            exists = connection.execute(
                "SELECT role FROM team_users WHERE email=?", (email,)
            ).fetchone()
            if role == "admin":
                if exists:
                    connection.execute("UPDATE team_users SET role='admin' WHERE email=?", (email,))
                else:
                    connection.execute(
                        "INSERT INTO team_users (email, name, role, added_by, created_at) "
                        "VALUES (?, ?, 'admin', ?, ?)",
                        (email, (name or "").strip()[:80], actor.email, timestamp()),
                    )
            else:
                if not workspace_id:
                    raise HTTPException(400, "Choose a workspace")
                self._workspace(connection, workspace_id)
                if connection.execute(
                    "SELECT 1 FROM workspace_members WHERE workspace_id=? AND email=?",
                    (workspace_id, email),
                ).fetchone():
                    raise HTTPException(409, "That person is already in this workspace")
                if not exists:
                    connection.execute(
                        "INSERT INTO team_users (email, name, role, added_by, created_at) "
                        "VALUES (?, ?, 'member', ?, ?)",
                        (email, (name or "").strip()[:80], actor.email, timestamp()),
                    )
                elif name and not exists["role"] == "admin":
                    connection.execute(
                        "UPDATE team_users SET name=? WHERE email=? AND name=''",
                        (name.strip()[:80], email),
                    )
                connection.execute(
                    "INSERT INTO workspace_members VALUES (?, ?, ?)", (workspace_id, email, role)
                )
                if role == "member":
                    self._grant(connection, email, workspace_id, game_ids)
        self.audit(actor, "user.add", None, f"{email} as {role}")
        return email

    def update_person(
        self, actor, email, name=None, admin=None, workspace_id=None, role=None, game_ids=None
    ):
        email = email.strip().lower()
        events = []  # written after the transaction closes, so they don't wait on its lock
        with self.storage.connect(self.registry) as connection:
            row = connection.execute("SELECT * FROM team_users WHERE email=?", (email,)).fetchone()
            if row is None:
                raise HTTPException(404, "Person not found")
            if name is not None:
                connection.execute(
                    "UPDATE team_users SET name=? WHERE email=?", (name.strip()[:80], email)
                )
            if admin is not None and admin != (row["role"] == "admin"):
                if not admin and email == self.settings.admin_email:
                    raise HTTPException(400, "The primary admin can't lose admin rights")
                if (
                    not admin
                    and connection.execute(
                        "SELECT count(*) FROM team_users WHERE role='admin' AND email<>?", (email,)
                    ).fetchone()[0]
                    == 0
                ):
                    raise HTTPException(400, "There must be at least one admin")
                connection.execute(
                    "UPDATE team_users SET role=? WHERE email=?",
                    ("admin" if admin else "member", email),
                )
                label = "admin" if admin else "not admin"
                events.append(("user.role", f"{email}: {label}"))
            if workspace_id and role:
                self._workspace(connection, workspace_id)
                changed = connection.execute(
                    "UPDATE workspace_members SET role=? WHERE workspace_id=? AND email=?",
                    (role, workspace_id, email),
                ).rowcount
                if not changed:
                    raise HTTPException(404, "That person isn't in this workspace")
                if role == "lead":  # leads see everything, so per-game grants no longer apply
                    connection.execute(
                        "DELETE FROM game_access WHERE email=? AND game_id IN "
                        "(SELECT id FROM games WHERE workspace_id=?)",
                        (email, workspace_id),
                    )
                events.append(("user.role", f"{email}: {role}"))
            if game_ids is not None:
                if not workspace_id:
                    raise HTTPException(400, "Choose a workspace")
                member = connection.execute(
                    "SELECT role FROM workspace_members WHERE workspace_id=? AND email=?",
                    (workspace_id, email),
                ).fetchone()
                if member is None or member["role"] != "member":
                    raise HTTPException(400, "Only members have a list of games")
                self._grant(connection, email, workspace_id, game_ids)
                events.append(("access.set", f"{email}: {len(game_ids)} game(s)"))
        for action, detail in events:
            self.audit(actor, action, None, detail)

    def remove_person(self, actor, email, workspace_id=None):
        """Takes someone out of one workspace, or (without one) out of the team altogether."""
        email = email.strip().lower()
        if email == self.settings.admin_email:
            raise HTTPException(400, "The primary admin can't be removed")
        with self.storage.connect(self.registry) as connection:
            row = connection.execute("SELECT * FROM team_users WHERE email=?", (email,)).fetchone()
            if row is None:
                raise HTTPException(404, "Person not found")
            if workspace_id:
                self._workspace(connection, workspace_id)
                connection.execute(
                    "DELETE FROM workspace_members WHERE workspace_id=? AND email=?",
                    (workspace_id, email),
                )
                connection.execute(
                    "DELETE FROM game_access WHERE email=? AND game_id IN "
                    "(SELECT id FROM games WHERE workspace_id=?)",
                    (email, workspace_id),
                )
            else:
                if (
                    row["role"] == "admin"
                    and connection.execute(
                        "SELECT count(*) FROM team_users WHERE role='admin' AND email<>?", (email,)
                    ).fetchone()[0]
                    == 0
                ):
                    raise HTTPException(400, "There must be at least one admin")
                for table in ("workspace_members", "game_access", "team_users"):
                    connection.execute(f"DELETE FROM {table} WHERE email=?", (email,))
        self.audit(actor, "user.remove", None, email + (" (one workspace)" if workspace_id else ""))

    def game_members(self, game_id):
        """People of the game's workspace, and whether each can open this game."""
        workspace_id = self.workspace_of_game(game_id)
        with self.storage.connect(self.registry) as connection:
            admins = [
                {"email": row["email"], "name": row["name"], "role": "admin", "has_access": 1}
                for row in connection.execute("SELECT * FROM team_users WHERE role='admin'")
            ]
            rows = connection.execute(
                """SELECT u.email, u.name, m.role,
                          EXISTS(SELECT 1 FROM game_access g
                                 WHERE g.email=u.email AND g.game_id=?) AS has_access
                   FROM workspace_members m JOIN team_users u ON u.email=m.email
                   WHERE m.workspace_id=? ORDER BY u.email""",
                (game_id, workspace_id),
            )
            people = [dict(row) for row in rows]
        for person in people:
            if person["role"] == "lead":
                person["has_access"] = 1
        return [*admins, *people]

    def set_game_members(self, actor, game_id, emails):
        """Replaces which members of the game's workspace can open this game."""
        workspace_id = self.workspace_of_game(game_id)
        wanted = {email.strip().lower() for email in emails}
        with self.storage.connect(self.registry) as connection:
            members = {
                row["email"]
                for row in connection.execute(
                    "SELECT email FROM workspace_members WHERE workspace_id=? AND role='member'",
                    (workspace_id,),
                )
            }
            connection.execute("DELETE FROM game_access WHERE game_id=?", (game_id,))
            connection.executemany(
                "INSERT INTO game_access VALUES (?, ?)",
                [(email, game_id) for email in sorted(wanted & members)],
            )
        self.audit(actor, "access.game", game_id, f"{len(wanted & members)} member(s)")

    def forget_game(self, game_id):
        with self.storage.connect(self.registry) as connection:
            connection.execute("DELETE FROM game_access WHERE game_id=?", (game_id,))

    # ---- audit log

    def audit(self, actor, action, game_id=None, detail=""):
        who = getattr(actor, "email", actor)
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                "INSERT INTO audit_log (at, actor, action, game_id, detail) VALUES (?, ?, ?, ?, ?)",
                (timestamp(), who, action, game_id, detail[:500]),
            )

    def audit_log(self, limit=200):
        with self.storage.connect(self.registry) as connection:
            return [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
                )
            ]
