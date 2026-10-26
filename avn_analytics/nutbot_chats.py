"""NutBot's own record of every chat, in the registry database.

The agent keeps its own transcript (so a chat can be continued cheaply); this record is the
truth: it survives agent updates and cleaned homes, it is what the website lists and reopens,
it rebuilds the context when the agent cannot continue, and its assistant rows are the usage
ledger (tokens, cost, calls, seconds per person, agent and model).
"""

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from .models import timestamp

TITLE_LENGTH = 80
REPLAY_RECENT = 6  # messages repeated in full when a chat is rebuilt for the agent
REPLAY_CHARS = 1600  # per repeated message
REPLAY_OLD_CHARS = 200  # per older message (one line each)
UNDO_HOURS = 24  # a deleted chat can come back for this long


def _loads(value, fallback):
    try:
        return json.loads(value) if value else fallback
    except ValueError:
        return fallback


class Chats:
    def __init__(self, storage):
        self.storage = storage

    @property
    def registry(self):
        return self.storage.root / "registry.sqlite3"

    def initialize(self):
        with self.storage.connect(self.registry) as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS nutbot_chats (
                    id TEXT PRIMARY KEY,
                    game_id TEXT NOT NULL,
                    email TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    harness TEXT NOT NULL,
                    model TEXT NOT NULL DEFAULT '',
                    agent_session TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS nutbot_chats_owner
                    ON nutbot_chats(email, game_id, updated_at);
                CREATE TABLE IF NOT EXISTS nutbot_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL REFERENCES nutbot_chats(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    text TEXT NOT NULL DEFAULT '',
                    tools TEXT NOT NULL DEFAULT '[]',
                    actions TEXT NOT NULL DEFAULT '[]',
                    scope TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '',
                    seconds REAL,
                    harness TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    cache_read_tokens INTEGER,
                    cache_write_tokens INTEGER,
                    cost_usd REAL,
                    context_used INTEGER,
                    context_size INTEGER,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS nutbot_messages_chat ON nutbot_messages(chat_id, id);
                CREATE INDEX IF NOT EXISTS nutbot_messages_day ON nutbot_messages(created_at);
            """)

    # ---- chats

    def create(self, game_id, email, harness, model, title=""):
        now = timestamp()
        chat = {
            "id": str(uuid4()),
            "game_id": game_id,
            "email": email,
            "title": title[:TITLE_LENGTH],
            "harness": harness,
            "model": model or "",
            "agent_session": "",
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                """INSERT INTO nutbot_chats
                   (id, game_id, email, title, harness, model, agent_session, created_at,
                    updated_at, deleted_at)
                   VALUES (:id, :game_id, :email, :title, :harness, :model, :agent_session,
                           :created_at, :updated_at, :deleted_at)""",
                chat,
            )
        return self._public(chat, 0)

    def get(self, chat_id, email, include_deleted=False):
        """The chat if it belongs to this person (admins read others' chats elsewhere)."""
        with self.storage.connect(self.registry) as connection:
            row = connection.execute(
                "SELECT c.*, (SELECT count(*) FROM nutbot_messages m WHERE m.chat_id=c.id) AS n"
                " FROM nutbot_chats c WHERE id=? AND email=?",
                (chat_id, email),
            ).fetchone()
        if row is None or (row["deleted_at"] and not include_deleted):
            return None
        return self._public(dict(row), row["n"])

    def list(self, game_id, email, limit=50):
        with self.storage.connect(self.registry) as connection:
            rows = connection.execute(
                """SELECT c.*, (SELECT count(*) FROM nutbot_messages m WHERE m.chat_id=c.id) AS n
                   FROM nutbot_chats c
                   WHERE game_id=? AND email=? AND deleted_at IS NULL
                   ORDER BY updated_at DESC LIMIT ?""",
                (game_id, email, limit),
            ).fetchall()
        return [self._public(dict(row), row["n"]) for row in rows]

    def rename(self, chat_id, email, title):
        with self.storage.connect(self.registry) as connection:
            changed = connection.execute(
                "UPDATE nutbot_chats SET title=? WHERE id=? AND email=? AND deleted_at IS NULL",
                (title.strip()[:TITLE_LENGTH], chat_id, email),
            ).rowcount
        return changed == 1

    def delete(self, chat_id, email):
        """Soft: the chat can be restored for a day (Undo in the toast)."""
        with self.storage.connect(self.registry) as connection:
            changed = connection.execute(
                "UPDATE nutbot_chats SET deleted_at=?"
                " WHERE id=? AND email=? AND deleted_at IS NULL",
                (timestamp(), chat_id, email),
            ).rowcount
        return changed == 1

    def restore(self, chat_id, email):
        with self.storage.connect(self.registry) as connection:
            changed = connection.execute(
                "UPDATE nutbot_chats SET deleted_at=NULL WHERE id=? AND email=?"
                " AND deleted_at IS NOT NULL",
                (chat_id, email),
            ).rowcount
        return changed == 1

    def set_agent_session(self, chat_id, harness, model, session_id):
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                "UPDATE nutbot_chats SET agent_session=?, harness=?, model=?, updated_at=?"
                " WHERE id=?",
                (session_id or "", harness, model or "", timestamp(), chat_id),
            )

    def _public(self, row, count):
        return {
            "id": row["id"],
            "game_id": row["game_id"],
            "email": row["email"],
            "title": row["title"],
            "harness": row["harness"],
            "model": row["model"],
            "agent_session": row["agent_session"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "deleted": bool(row.get("deleted_at")),
            "messages": count,
        }

    # ---- messages

    def add_user(self, chat_id, text):
        now = timestamp()
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                "INSERT INTO nutbot_messages (chat_id, role, text, created_at)"
                " VALUES (?, 'user', ?, ?)",
                (chat_id, text, now),
            )
            connection.execute(
                "UPDATE nutbot_chats SET updated_at=?,"
                " title=CASE WHEN title='' THEN ? ELSE title END WHERE id=?",
                (now, chat_title(text), chat_id),
            )

    def add_assistant(self, chat_id, message):
        """message: text, tools, actions, scope, error, seconds, harness, model, usage, context."""
        usage = message.get("usage") or {}
        context = message.get("context") or {}
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                """INSERT INTO nutbot_messages
                   (chat_id, role, text, tools, actions, scope, error, seconds, harness, model,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
                    context_used, context_size, created_at)
                   VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    chat_id,
                    message.get("text") or "",
                    json.dumps(message.get("tools") or []),
                    json.dumps(message.get("actions") or []),
                    message.get("scope") or "",
                    message.get("error") or "",
                    message.get("seconds"),
                    message.get("harness") or "",
                    message.get("model") or "",
                    usage.get("input_tokens"),
                    usage.get("output_tokens"),
                    usage.get("cache_read_tokens"),
                    usage.get("cache_write_tokens"),
                    usage.get("cost_usd"),
                    context.get("used"),
                    context.get("size"),
                    timestamp(),
                ),
            )
            connection.execute(
                "UPDATE nutbot_chats SET updated_at=? WHERE id=?", (timestamp(), chat_id)
            )

    def messages(self, chat_id, with_trace=False):
        with self.storage.connect(self.registry) as connection:
            rows = connection.execute(
                "SELECT * FROM nutbot_messages WHERE chat_id=? ORDER BY id", (chat_id,)
            ).fetchall()
        items = []
        for row in rows:
            if row["role"] == "user":
                items.append({"id": row["id"], "role": "user", "text": row["text"]})
                continue
            tools = _loads(row["tools"], [])
            if not with_trace:
                tools = [
                    {k: v for k, v in tool.items() if k in ("tool", "ok", "ms", "denied")}
                    for tool in tools
                ]
            items.append(
                {
                    "id": row["id"],
                    "role": "assistant",
                    "text": row["text"],
                    "tools": tools,
                    "actions": _loads(row["actions"], []),
                    "scope": row["scope"],
                    "error": row["error"],
                    "seconds": row["seconds"],
                    "harness": row["harness"],
                    "model": row["model"],
                    "usage": {
                        "input_tokens": row["input_tokens"],
                        "output_tokens": row["output_tokens"],
                        "cache_read_tokens": row["cache_read_tokens"],
                        "cache_write_tokens": row["cache_write_tokens"],
                        "cost_usd": row["cost_usd"],
                    },
                    "context": {"used": row["context_used"], "size": row["context_size"]},
                    "created_at": row["created_at"],
                }
            )
        return items

    def replay(self, chat_id):
        """The earlier conversation as text for an agent that can't continue its own session:
        older turns as one line each, the last few in full."""
        rows = self.messages(chat_id)
        if not rows:
            return ""
        recent, older = rows[-REPLAY_RECENT:], rows[:-REPLAY_RECENT]
        lines = []
        if older:
            lines.append("Earlier in this chat (shortened):")
            for row in older:
                text = " ".join((row["text"] or "").split())[:REPLAY_OLD_CHARS]
                if text:
                    lines.append(f"- {'User' if row['role'] == 'user' else 'You'}: {text}")
            lines.append("")
        lines.append("Most recent messages:")
        for row in recent:
            text = (row["text"] or "").strip()
            if len(text) > REPLAY_CHARS:
                text = text[:REPLAY_CHARS] + " …"
            if text:
                lines.append(f"{'User' if row['role'] == 'user' else 'You'}: {text}")
        return "\n".join(lines)

    # ---- the ledger

    def usage(self, email=None, days=7):
        """Totals per day and agent for one person (or everyone, for an admin)."""
        since = (datetime.now(UTC) - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
        where = "m.role='assistant' AND m.created_at>=?"
        args = [since]
        if email:
            where += " AND c.email=?"
            args.append(email)
        with self.storage.connect(self.registry) as connection:
            rows = connection.execute(
                f"""SELECT substr(m.created_at, 1, 10) AS day, m.harness, m.model,
                           count(*) AS answers,
                           sum(coalesce(m.input_tokens, 0)) AS input_tokens,
                           sum(coalesce(m.output_tokens, 0)) AS output_tokens,
                           sum(coalesce(m.cache_read_tokens, 0)) AS cache_read_tokens,
                           sum(coalesce(m.cost_usd, 0)) AS cost_usd,
                           sum(coalesce(m.seconds, 0)) AS seconds
                    FROM nutbot_messages m JOIN nutbot_chats c ON c.id=m.chat_id
                    WHERE {where}
                    GROUP BY day, m.harness, m.model ORDER BY day DESC""",
                args,
            ).fetchall()
            people = []
            if not email:
                people = [
                    dict(row)
                    for row in connection.execute(
                        f"""SELECT c.email, count(*) AS answers,
                                   sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0))
                                       AS tokens,
                                   sum(coalesce(m.cost_usd, 0)) AS cost_usd,
                                   count(DISTINCT c.id) AS chats
                            FROM nutbot_messages m JOIN nutbot_chats c ON c.id=m.chat_id
                            WHERE {where} GROUP BY c.email ORDER BY answers DESC""",
                        args,
                    )
                ]
        return {"days": days, "rows": [dict(row) for row in rows], "people": people}

    def answers_today(self, email):
        today = datetime.now(UTC).strftime("%Y-%m-%d")
        with self.storage.connect(self.registry) as connection:
            return connection.execute(
                """SELECT count(*) FROM nutbot_messages m JOIN nutbot_chats c ON c.id=m.chat_id
                   WHERE m.role='user' AND c.email=? AND substr(m.created_at, 1, 10)=?""",
                (email, today),
            ).fetchone()[0]

    # ---- housekeeping

    def prune(self, keep_days):
        """Remove chats deleted more than a day ago, and (if keep_days) chats older than that."""
        now = datetime.now(UTC)
        undo_before = (now - timedelta(hours=UNDO_HOURS)).strftime("%Y-%m-%dT%H:%M:%SZ")
        with self.storage.connect(self.registry) as connection:
            try:
                connection.execute(
                    "DELETE FROM nutbot_chats WHERE deleted_at IS NOT NULL AND deleted_at<?",
                    (undo_before,),
                )
                if keep_days:
                    old = (now - timedelta(days=keep_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
                    connection.execute("DELETE FROM nutbot_chats WHERE updated_at<?", (old,))
            except sqlite3.Error:
                pass


def chat_title(text):
    line = " ".join(text.strip().split())
    return (line[: TITLE_LENGTH - 1] + "…") if len(line) > TITLE_LENGTH else line
