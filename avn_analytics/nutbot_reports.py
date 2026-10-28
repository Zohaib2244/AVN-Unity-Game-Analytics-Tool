"""NutBot's reports: findings kept per game so the team can list, reopen and pin them.

A report is markdown the assistant wrote (offered as a card the person saves, or saved from an
answer), an optional headline
(a small figure that can be pinned to the Overview) and who asked. They live in the registry next to
the chats. Everyone who may use NutBot in the workspace can read a game's reports; the author and
workspace leads and admins can change or delete one (a deleted report can come back for a day).
"""

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from .models import timestamp
from .nutbot_base import ToolError, _tool

MAX_BODY = 20000
MAX_REPORTS = 300  # per game, newest kept in listings
UNDO_HOURS = 24
HEADLINE = {
    "type": "object",
    "description": "A small figure that can be pinned to the Overview: {title, value, sub}, e.g. {title: 'Level 7 exits', value: '34%', sub: 'of its starters stop there'}.",
    "properties": {
        "title": {"type": "string"},
        "value": {"type": "string"},
        "sub": {"type": "string"},
    },
    "required": ["title", "value"],
    "additionalProperties": False,
}

REPORT_TOOLS = [
    _tool(
        "propose_report",
        "Offer your findings as a report for this game. The person gets a card and the report is "
        "saved only when they press Save, so never say it was saved. Use it when they ask for a "
        "report or the skill you are following says so. `body` is the report in markdown: the "
        "finding with its numbers first, then what to try, then what could not be answered. Add a "
        "headline when one number sums it up.",
        {
            "title": {"type": "string", "description": "At most 80 characters."},
            "body": {"type": "string"},
            "headline": HEADLINE,
            "why": {"type": "string", "description": "One line: why this is worth keeping."},
        },
        ["title", "body"],
    ),
]


def clean_headline(value):
    if not value:
        return None
    if (
        not isinstance(value, dict)
        or not str(value.get("title") or "").strip()
        or not str(value.get("value") or "").strip()
    ):
        raise ValueError("A headline needs a title and a value.")
    return {key: str(value.get(key) or "").strip()[:80] for key in ("title", "value", "sub")}


class Reports:
    def __init__(self, storage):
        self.storage = storage

    @property
    def registry(self):
        return self.storage.root / "registry.sqlite3"

    def initialize(self):
        with self.storage.connect(self.registry) as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS nutbot_reports (
                    id TEXT PRIMARY KEY,
                    game_id TEXT NOT NULL,
                    email TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    headline TEXT NOT NULL DEFAULT '',
                    pinned INTEGER NOT NULL DEFAULT 0,
                    chat_id TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS nutbot_reports_game
                    ON nutbot_reports(game_id, updated_at);
            """)

    def _public(self, row, body=False):
        item = {
            "id": row["id"],
            "game_id": row["game_id"],
            "email": row["email"],
            "title": row["title"],
            "headline": json.loads(row["headline"]) if row["headline"] else None,
            "pinned": bool(row["pinned"]),
            "chat_id": row["chat_id"] or None,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        if body:
            item["body"] = row["body"]
        return item

    def create(self, game_id, email, title, body, headline=None, chat_id=""):
        title, body = str(title or "").strip()[:80], str(body or "").strip()
        if not title or not body:
            raise ValueError("A report needs a title and some text.")
        headline = clean_headline(headline)
        report_id, now = str(uuid4()), timestamp()
        with self.storage.connect(self.registry) as connection:
            if chat_id:  # pressing Save on the same card again (say after a reload) keeps one copy
                same = connection.execute(
                    "SELECT id FROM nutbot_reports WHERE game_id=? AND chat_id=? AND title=? "
                    "AND body=? AND deleted_at IS NULL",
                    (game_id, chat_id, title, body[:MAX_BODY]),
                ).fetchone()
                if same:
                    return self.get(same["id"], game_id)
            connection.execute(
                "INSERT INTO nutbot_reports VALUES (?,?,?,?,?,?,0,?,?,?,NULL)",
                (
                    report_id,
                    game_id,
                    email,
                    title,
                    body[:MAX_BODY],
                    json.dumps(headline) if headline else "",
                    chat_id or "",
                    now,
                    now,
                ),
            )
        return self.get(report_id, game_id)

    def get(self, report_id, game_id, include_deleted=False):
        with self.storage.connect(self.registry) as connection:
            row = connection.execute(
                "SELECT * FROM nutbot_reports WHERE id=? AND game_id=?", (report_id, game_id)
            ).fetchone()
        if row is None or (row["deleted_at"] and not include_deleted):
            return None
        return self._public(row, body=True)

    def list(self, game_id, pinned=False):
        with self.storage.connect(self.registry) as connection:
            rows = connection.execute(
                f"""SELECT * FROM nutbot_reports WHERE game_id=? AND deleted_at IS NULL
                    {"AND pinned=1" if pinned else ""} ORDER BY updated_at DESC LIMIT ?""",
                (game_id, MAX_REPORTS),
            ).fetchall()
        return [self._public(row) for row in rows]

    def update(self, report_id, game_id, title=None, pinned=None):
        sets, args = ["updated_at=?"], [timestamp()]
        if title is not None:
            if not title.strip():
                raise ValueError("A report needs a title.")
            sets.append("title=?")
            args.append(title.strip()[:80])
        if pinned is not None:
            sets.append("pinned=?")
            args.append(1 if pinned else 0)
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                f"UPDATE nutbot_reports SET {', '.join(sets)} WHERE id=? AND game_id=? "
                "AND deleted_at IS NULL",
                (*args, report_id, game_id),
            )
        return self.get(report_id, game_id)

    def delete(self, report_id, game_id):
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                "UPDATE nutbot_reports SET deleted_at=?, pinned=0 WHERE id=? AND game_id=?",
                (timestamp(), report_id, game_id),
            )

    def restore(self, report_id, game_id):
        report = self.get(report_id, game_id, include_deleted=True)
        with self.storage.connect(self.registry) as connection:
            row = connection.execute(
                "SELECT deleted_at FROM nutbot_reports WHERE id=? AND game_id=?",
                (report_id, game_id),
            ).fetchone()
            if report is None or not row["deleted_at"]:
                return False
            deleted = datetime.fromisoformat(row["deleted_at"].replace("Z", "+00:00"))
            if datetime.now(UTC) - deleted > timedelta(hours=UNDO_HOURS):
                return False
            connection.execute("UPDATE nutbot_reports SET deleted_at=NULL WHERE id=?", (report_id,))
        return True

    def prune(self):
        """Forget reports deleted more than a day ago."""
        cutoff = timestamp(datetime.now(UTC) - timedelta(hours=UNDO_HOURS))
        with self.storage.connect(self.registry) as connection:
            connection.execute(
                "DELETE FROM nutbot_reports WHERE deleted_at IS NOT NULL AND deleted_at<?",
                (cutoff,),
            )


class ReportTools:
    """The propose_report handler; NutBot supplies `_propose` and the run. Nothing is saved here."""

    def tool_propose_report(self, run, game_id, args):
        title, body = str(args.get("title") or "").strip()[:80], str(args.get("body") or "").strip()
        if not title or not body:
            raise ToolError("A report needs a title and some text.")
        if len(body) > MAX_BODY:
            raise ToolError(f"A report can be at most {MAX_BODY} characters.")
        try:
            headline = clean_headline(args.get("headline"))
        except ValueError as error:
            raise ToolError(str(error)) from error
        plain = [f"Saves “{title}” to this game's Reports"]
        if headline:
            plain.append(f"Headline for the Overview: {headline['title']} · {headline['value']}")
        payload = {"title": title, "body": body, "headline": headline}
        return self._propose(run, game_id, "report", {**args, "title": title}, payload, plain)
