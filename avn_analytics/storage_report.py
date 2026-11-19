"""Where each game's disk space goes, and (only when asked) giving back the free pages.

    python -m avn_analytics.storage_report            # read-only: every game
    python -m avn_analytics.storage_report --game ID  # read-only: one game
    python -m avn_analytics.storage_report --game ID --compact --yes

The report opens every database read-only and changes nothing: per game, its events, the size
of the database and its write-ahead log, how much of the file is free pages (space SQLite keeps
for reuse after rows are deleted, for instance by old prepared answers or deleted versions), the
bytes per event, and, when this SQLite can tell (the dbstat table), what each table and index
takes.

--compact rewrites one game's database without its free pages (SQLite's VACUUM) so the file
shrinks by that much. It keeps every row: raw events, facts and everything else are copied
as they are. While it runs the game cannot store new events (the SDKs keep them and send them
again later). It took 6.6 s for a 450 MB synthetic game on an SSD; a USB hard disk is several
times slower. It also needs free disk space about the size of the database. It is the owner's
call when to run it; nothing runs it automatically.
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path


def _read_only(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def _parts(connection):
    """name -> bytes for every table and index, or None if this SQLite has no dbstat."""
    try:
        rows = connection.execute(
            "SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC"
        ).fetchall()
    except sqlite3.OperationalError:
        return None
    return {name: size for name, size in rows}


def report(path):
    """One game database's space, read-only."""
    path = Path(path)
    wal = path.with_name(path.name + "-wal")
    connection = _read_only(path)
    try:
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
        pages = connection.execute("PRAGMA page_count").fetchone()[0]
        free = connection.execute("PRAGMA freelist_count").fetchone()[0]
        events = connection.execute("SELECT count(*) FROM events").fetchone()[0]
        parts = _parts(connection)
    finally:
        connection.close()
    file_bytes = path.stat().st_size
    result = {
        "events": events,
        "file_bytes": file_bytes,
        "wal_bytes": wal.stat().st_size if wal.exists() else 0,
        "free_bytes": free * page_size,
        "free_share": round(free / pages, 4) if pages else 0,
        "bytes_per_event": round(pages * page_size / events) if events else None,
    }
    if parts is not None:
        raw = ("events", "sqlite_autoindex_events_1", "events_client_ts", "events_server_ts")
        result["raw_events_bytes"] = sum(parts.get(name, 0) for name in raw)
        derived = ("analytics_facts", "sqlite_autoindex_analytics_facts")
        result["facts_bytes"] = sum(
            size for name, size in parts.items() if name.startswith(derived)
        )
        result["largest"] = dict(list(parts.items())[:12])
    return result


def compact(path):
    """VACUUM one database (keeps every row); returns the file size before and after."""
    path = Path(path)
    before = path.stat().st_size
    connection = sqlite3.connect(path, timeout=30)
    try:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.execute("VACUUM")
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        connection.close()
    return {"before_bytes": before, "after_bytes": path.stat().st_size}


def main(arguments=None):
    from .config import Settings

    parser = argparse.ArgumentParser(prog="python -m avn_analytics.storage_report")
    parser.add_argument("--game", help="one game's id (default: every game)")
    parser.add_argument("--compact", action="store_true", help="give back free pages (VACUUM)")
    parser.add_argument("--yes", action="store_true", help="confirm --compact")
    options = parser.parse_args(arguments)
    root = Settings.from_env().data_dir
    registry = root / "registry.sqlite3"
    if not registry.is_file():
        print("Registry not found; this reads an existing installation only", file=sys.stderr)
        return 1
    connection = _read_only(registry)
    try:
        games = connection.execute("SELECT id, name, platform FROM games ORDER BY name").fetchall()
    finally:
        connection.close()
    games = [game for game in games if options.game in (None, game[0])]
    if options.compact:
        if not options.game or not options.yes:
            print("--compact needs one --game and --yes (see the module's help)", file=sys.stderr)
            return 2
    for game_id, name, platform in games:
        path = root / "games" / f"{game_id}.sqlite3"
        if not path.is_file():
            continue
        line = {"game": game_id, "name": name, "platform": platform, **report(path)}
        if options.compact:
            line["compacted"] = compact(path)
        print(json.dumps(line))
    return 0 if games else 1


if __name__ == "__main__":
    sys.exit(main())
