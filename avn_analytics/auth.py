"""Who is making a request, and what they may do.

Sign-in is handled by Cloudflare Access, which puts a signed token on every request. This module
verifies that token, looks the person up in the team list (invite-only), and applies a role:

- admin: everything, including managing the team
- lead: everything except managing the team; sees every game
- member: works with the games they were given access to; cannot manage games

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
from dataclasses import dataclass

import jwt
from fastapi import HTTPException, Request

from .models import timestamp

logger = logging.getLogger("avn_analytics.auth")

ROLES = ("admin", "lead", "member")
CERTS_TTL = 3600.0
# Headers Cloudflare adds to every request it proxies. Their presence means the request did not
# come from the local network, so it must carry a valid Access token.
CLOUDFLARE_MARKERS = ("cf-ray", "cf-connecting-ip", "cf-ipcountry", "cf-visitor")


@dataclass(frozen=True)
class Principal:
    email: str
    name: str
    role: str
    source: str  # access | lan | token | local

    @property
    def sees_all_games(self):
        return self.role in ("admin", "lead")

    @property
    def manages_games(self):
        return self.role in ("admin", "lead")

    @property
    def manages_team(self):
        return self.role == "admin"

    def describe(self):
        return {
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "source": self.source,
            "can_manage_games": self.manages_games,
            "can_manage_team": self.manages_team,
            "sees_all_games": self.sees_all_games,
        }


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
    """The team list, per-game access and the audit log, kept in the registry database."""

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
                CREATE TABLE IF NOT EXISTS team_users (
                    email TEXT PRIMARY KEY,
                    name TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL CHECK (role IN ('admin', 'lead', 'member')),
                    added_by TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT
                );
                CREATE TABLE IF NOT EXISTS game_access (
                    email TEXT NOT NULL REFERENCES team_users(email) ON DELETE CASCADE,
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
            if self.settings.admin_email:
                connection.execute(
                    """INSERT INTO team_users (email, role, added_by, created_at)
                       VALUES (?, 'admin', 'system', ?)
                       ON CONFLICT(email) DO UPDATE SET role='admin'""",
                    (self.settings.admin_email, timestamp()),
                )

    # ---- who is calling

    def authenticate(self, request: Request) -> Principal:
        if not self.settings.access_enabled:
            return Principal("local", "Local admin", "admin", "local")
        supplied = bearer_token(request)
        if supplied:
            if self.settings.admin_token and hmac.compare_digest(
                supplied.encode(), self.settings.admin_token.encode()
            ):
                return Principal("token", "Admin token", "admin", "token")
            raise HTTPException(401, "Invalid admin token")
        assertion = request.headers.get("cf-access-jwt-assertion")
        if assertion:
            return self._team_member(self.verifier.email_from(assertion))
        if any(marker in request.headers for marker in CLOUDFLARE_MARKERS):
            # Came through Cloudflare but without a valid Access sign-in: never trust the network.
            raise HTTPException(401, "Sign-in required")
        if self.settings.lan_admin and is_private(client_ip(request)):
            return Principal("lan", "Admin (local network)", "admin", "lan")
        raise HTTPException(401, "Sign-in required")

    def _team_member(self, email):
        with self.storage.connect(self.registry) as connection:
            row = connection.execute("SELECT * FROM team_users WHERE email=?", (email,)).fetchone()
            if row is None:
                raise HTTPException(
                    403,
                    f"{email} hasn't been added to this workspace yet. "
                    "Ask the admin to add your email.",
                )
            now = timestamp()
            if not row["last_seen_at"] or row["last_seen_at"][:13] != now[:13]:  # hourly
                connection.execute(
                    "UPDATE team_users SET last_seen_at=? WHERE email=?", (now, email)
                )
        return Principal(email, row["name"], row["role"], "access")

    # ---- games a person may see

    def game_ids_for(self, principal, all_ids):
        if principal.sees_all_games:
            return set(all_ids)
        with self.storage.connect(self.registry) as connection:
            rows = connection.execute(
                "SELECT game_id FROM game_access WHERE email=?", (principal.email,)
            )
            return {row["game_id"] for row in rows} & set(all_ids)

    def can_see_game(self, principal, game_id):
        if principal.sees_all_games:
            return True
        with self.storage.connect(self.registry) as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM game_access WHERE email=? AND game_id=?",
                    (principal.email, game_id),
                ).fetchone()
                is not None
            )

    # ---- team management

    def _check_email(self, email):
        email = (email or "").strip().lower()
        if "@" not in email or email.startswith("@") or " " in email or len(email) > 254:
            raise HTTPException(400, "Enter a valid email address")
        domain = self.settings.allowed_email_domain
        if domain and not email.endswith("@" + domain):
            raise HTTPException(400, f"Only @{domain} addresses can be added")
        return email

    def list_users(self):
        with self.storage.connect(self.registry) as connection:
            users = [dict(row) for row in connection.execute("SELECT * FROM team_users")]
            grants = connection.execute("SELECT email, game_id FROM game_access").fetchall()
        for user in users:
            user["game_ids"] = sorted(g["game_id"] for g in grants if g["email"] == user["email"])
        order = {role: index for index, role in enumerate(ROLES)}
        users.sort(key=lambda user: (order[user["role"]], user["email"]))
        return users

    def add_user(self, actor, email, name, role, game_ids):
        email = self._check_email(email)
        with self.storage.connect(self.registry) as connection:
            if connection.execute("SELECT 1 FROM team_users WHERE email=?", (email,)).fetchone():
                raise HTTPException(409, "That person is already on the team")
            connection.execute(
                "INSERT INTO team_users (email, name, role, added_by, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (email, (name or "").strip()[:80], role, actor.email, timestamp()),
            )
        if role == "member" and game_ids:
            self.set_games(actor, email, game_ids, audit=False)
        self.audit(actor, "user.add", None, f"{email} as {role}")
        return email

    def update_user(self, actor, email, role=None, name=None):
        email = email.strip().lower()
        with self.storage.connect(self.registry) as connection:
            row = connection.execute("SELECT * FROM team_users WHERE email=?", (email,)).fetchone()
            if row is None:
                raise HTTPException(404, "Person not found")
            if email == self.settings.admin_email and role not in (None, "admin"):
                raise HTTPException(400, "The primary admin's role can't be changed")
            if role and row["role"] == "admin" and role != "admin":
                remaining = connection.execute(
                    "SELECT count(*) FROM team_users WHERE role='admin' AND email<>?", (email,)
                ).fetchone()[0]
                if remaining == 0:
                    raise HTTPException(400, "There must be at least one admin")
            if role:
                connection.execute("UPDATE team_users SET role=? WHERE email=?", (role, email))
            if name is not None:
                connection.execute(
                    "UPDATE team_users SET name=? WHERE email=?", (name.strip()[:80], email)
                )
        if role and role != row["role"]:
            self.audit(actor, "user.role", None, f"{email}: {row['role']} → {role}")

    def remove_user(self, actor, email):
        email = email.strip().lower()
        if email == self.settings.admin_email:
            raise HTTPException(400, "The primary admin can't be removed")
        with self.storage.connect(self.registry) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            row = connection.execute("SELECT * FROM team_users WHERE email=?", (email,)).fetchone()
            if row is None:
                raise HTTPException(404, "Person not found")
            if row["role"] == "admin" and (
                connection.execute(
                    "SELECT count(*) FROM team_users WHERE role='admin' AND email<>?", (email,)
                ).fetchone()[0]
                == 0
            ):
                raise HTTPException(400, "There must be at least one admin")
            connection.execute("DELETE FROM game_access WHERE email=?", (email,))
            connection.execute("DELETE FROM team_users WHERE email=?", (email,))
        self.audit(actor, "user.remove", None, email)

    def set_games(self, actor, email, game_ids, audit=True):
        """Replaces the games a member can see."""
        email = email.strip().lower()
        known = {game["id"] for game in self.storage.list_games()}
        wanted = sorted(set(game_ids) & known)
        with self.storage.connect(self.registry) as connection:
            row = connection.execute(
                "SELECT role FROM team_users WHERE email=?", (email,)
            ).fetchone()
            if row is None:
                raise HTTPException(404, "Person not found")
            connection.execute("DELETE FROM game_access WHERE email=?", (email,))
            connection.executemany(
                "INSERT INTO game_access VALUES (?, ?)", [(email, game_id) for game_id in wanted]
            )
        if audit:
            self.audit(actor, "access.set", None, f"{email}: {len(wanted)} game(s)")

    def game_members(self, game_id):
        """Members with their access to one game (admins and leads see everything anyway)."""
        with self.storage.connect(self.registry) as connection:
            rows = connection.execute(
                """SELECT u.email, u.name, u.role,
                          EXISTS(SELECT 1 FROM game_access g
                                 WHERE g.email=u.email AND g.game_id=?) AS has_access
                   FROM team_users u ORDER BY u.email""",
                (game_id,),
            )
            return [dict(row) for row in rows]

    def set_game_members(self, actor, game_id, emails):
        """Replaces which members can see one game; only members are affected."""
        wanted = {email.strip().lower() for email in emails}
        with self.storage.connect(self.registry) as connection:
            members = {
                row["email"]
                for row in connection.execute("SELECT email FROM team_users WHERE role='member'")
            }
            connection.execute(
                "DELETE FROM game_access WHERE game_id=? AND email IN "
                "(SELECT email FROM team_users WHERE role='member')",
                (game_id,),
            )
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
