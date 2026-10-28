"""The AVN events standard: one Markdown file, and the prompt that sets it up in a game.

`avn_events_standard/avn_events_standard.md` is the built-in standard. A workspace can replace it
by uploading its own `.md` (Settings → Events standard); the website then hands out that one. The
standard is a document for people and agents. Nothing checks games against it: the Dictionary
shows what a game really sends, and Mappings say which events the dashboards read. The one thing
the server takes from it is the level mappings below, filled in for a game that sends
`LEVEL_ANALYSIS` and has no level mappings of its own yet.
"""

import io
import re
import zipfile
from functools import cache
from pathlib import Path

from .models import timestamp

FOLDER = Path(__file__).parent / "avn_events_standard"
GUIDE = "avn_events_standard.md"
PROMPT = "AGENT_PROMPT.md"
MAX_BYTES = 512 * 1024
TITLE = re.compile(r"\A\s*#[^\n]*?\bversion\s+(\d+)", re.I)
EVENT = re.compile(r"^# ([A-Z][A-Z0-9_]*)\s*$", re.M)
STATE = re.compile(r"^### (.+?)\s*$", re.M)
SECTION_END = re.compile(r"^#{1,2} ", re.M)

# What a game following the standard means by the level moments the dashboards read.
LEVEL_EVENT = "LEVEL_ANALYSIS"
LEVEL_MAPPINGS = [
    {"action": f"level_{verb}", "param": param, "op": "eq", "value": value}
    | {"number_param": "LEVEL_NUMBER", "app_version": ""}
    for verb, param, value in (
        ("started", "STATE", "Started"),
        ("completed", "STATE", "Completed"),
        ("failed", "STATE", "Failed"),
        ("restarted", "STATE", "Restarted"),
        ("restarted", "ACTION", "Restart"),
    )
]


def follows_level_shape(event):
    """A LEVEL_ANALYSIS event as the standard sends it, with a STATE and a LEVEL_NUMBER."""
    return event.name == LEVEL_EVENT and "STATE" in event.params and "LEVEL_NUMBER" in event.params


class StandardError(ValueError):
    """An uploaded file that isn't a standard; the message says what is wrong."""


@cache
def _read(name):
    return (FOLDER / name).read_text(encoding="utf-8")


def builtin():
    return _read(GUIDE)


def version_of(text):
    """The number in the first heading ("# AVN events standard — version 5")."""
    found = TITLE.match(text)
    return int(found.group(1)) if found else None


def events_of(text):
    """[{name, states}] from the `# EVENT_NAME` and `### State` headings, in file order."""
    starts = list(EVENT.finditer(text))
    events = []
    for index, heading in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
        section = text[heading.end() : end]
        closed = SECTION_END.search(section)  # "## Changelog" and the like end the last event
        section = section[: closed.start()] if closed else section
        states = []
        for found in STATE.finditer(section):
            title = found.group(1)
            if title.lower() == "rules":
                continue
            states += [part.strip(" `*") for part in title.split("/") if part.strip(" `*")]
        events.append({"name": heading.group(1), "states": states})
    return events


def check(raw):
    """The uploaded bytes as text, or StandardError saying why they can't be the standard."""
    if len(raw) > MAX_BYTES:
        raise StandardError("The file is larger than 512 KB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise StandardError("The file is not UTF-8 text") from error
    if version_of(text) is None:
        raise StandardError(
            'The first line must be a heading with the version, like "# AVN events standard — '
            'version 5"'
        )
    if not events_of(text):
        raise StandardError("No events found: each event needs a heading like `# LEVEL_ANALYSIS`")
    return text.replace("\r\n", "\n")


def init(connection):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS workspace_standard (
            workspace_id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            uploaded_at TEXT NOT NULL,
            uploaded_by TEXT NOT NULL
        )
    """)


def _uploaded(storage, workspace_id):
    with storage.connect(storage.root / "registry.sqlite3") as registry:
        init(registry)
        row = registry.execute(
            "SELECT * FROM workspace_standard WHERE workspace_id=?", (workspace_id,)
        ).fetchone()
    return dict(row) if row else None


def text_for(storage, workspace_id):
    """The workspace's standard: its upload, else the built-in one."""
    uploaded = _uploaded(storage, workspace_id) if workspace_id else None
    return uploaded["text"] if uploaded else builtin()


def describe(storage, workspace_id):
    uploaded = _uploaded(storage, workspace_id)
    text = uploaded["text"] if uploaded else builtin()
    return {
        "version": version_of(text),
        "builtin_version": version_of(builtin()),
        "source": "uploaded" if uploaded else "builtin",
        "uploaded_at": uploaded["uploaded_at"] if uploaded else None,
        "uploaded_by": uploaded["uploaded_by"] if uploaded else None,
        "events": events_of(text),
        "prompt": prompt(),
    }


def upload(storage, workspace_id, raw, who):
    text = check(raw)
    with storage.connect(storage.root / "registry.sqlite3") as registry:
        init(registry)
        registry.execute(
            "INSERT INTO workspace_standard VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) "
            "DO UPDATE SET text=excluded.text, uploaded_at=excluded.uploaded_at, "
            "uploaded_by=excluded.uploaded_by",
            (workspace_id, text, timestamp(), who),
        )
    return version_of(text)


def reset(storage, workspace_id):
    with storage.connect(storage.root / "registry.sqlite3") as registry:
        init(registry)
        registry.execute("DELETE FROM workspace_standard WHERE workspace_id=?", (workspace_id,))


def prompt():
    """The text between the two `---` lines of AGENT_PROMPT.md."""
    return _read(PROMPT).split("\n---\n")[1].strip() + "\n"


def bundle(text):
    """A ZIP to unpack in the root of the game project: the prompt and the standard."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(PROMPT, prompt())
        archive.writestr(GUIDE, text)
    return buffer.getvalue()


def game_version(connection, recent=5000):
    """The standard version the game's newest events say they follow (None when they don't).

    Looks at the newest events only, so a big game answers at once and an update shows as soon as
    the new build sends.
    """
    row = connection.execute(
        """SELECT json_extract(payload, '$.standard_version') FROM
           (SELECT payload FROM events ORDER BY rowid DESC LIMIT ?)
           WHERE json_extract(payload, '$.standard_version') IS NOT NULL LIMIT 1""",
        (recent,),
    ).fetchone()
    return int(row[0]) if row and row[0] is not None else None
