"""How big each game is, and how long its dashboard pages take to count. Reads only.

Run it inside the running admin container, so it uses the same Python, SQLite and data as the
website (from the folder with compose.yaml):

    docker compose exec -T admin python - < scripts/measure_speed.py

Optional: DAYS=7 (default 30) to time a shorter range, GAME=<game id> for one game only, and
SKIP_LEVELS=1 when Levels is too slow to wait for.

Every database is opened read-only, so nothing can be written. It does use CPU like opening the
pages would, so run it when nobody is busy on the dashboard.
"""

import os
import sqlite3
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

from avn_analytics import events, insights, journeys
from avn_analytics.config import Settings
from avn_analytics.storage import Storage

DAYS = int(os.environ.get("DAYS", "30"))
ONLY_GAME = os.environ.get("GAME", "").strip()
SKIP_LEVELS = os.environ.get("SKIP_LEVELS", "") not in ("", "0")
HIDE_TEST = {"exclude_environments": ["editor", "development", "test", "debug"]}  # the default


@contextmanager
def read_only(path):
    """Like Storage.connect, but SQLite refuses every write."""
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


def stamp(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")


def timed(label, work, *args):
    print(f"    {label:<16}", end="", flush=True)
    began = time.perf_counter()
    try:
        work(*args)
    except Exception as error:  # report it and carry on with the next page
        print(f"failed after {time.perf_counter() - began:.1f} s: {error}")
        return
    print(f"{time.perf_counter() - began:6.1f} s")


def main():
    storage = Storage(Settings.from_env())
    storage.connect = read_only
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    end = stamp(today + timedelta(days=1))
    start = stamp(today - timedelta(days=DAYS - 1))
    games = [game for game in storage.list_games() if not ONLY_GAME or game["id"] == ONLY_GAME]
    print(f"SQLite {sqlite3.sqlite_version} · last {DAYS} days · editor & development hidden\n")
    for game in games:
        game_id = game["id"]
        size = sum(path.stat().st_size for path in storage.game_files(game_id) if path.exists())
        with read_only(storage.game_path(game_id)) as connection:
            total = connection.execute("SELECT count(*) FROM events").fetchone()[0]
            recent = connection.execute(
                "SELECT count(*) FROM events WHERE client_ts>=? AND client_ts<?", (start, end)
            ).fetchone()[0]
        print(f"{game['name']} · {game['platform']}  ({game_id})")
        print(f"    events: {total:,} in total, {recent:,} in the last {DAYS} days")
        print(f"    database: {size / 1e6:,.0f} MB")
        if not recent:
            print("    (nothing in these days to time)\n")
            continue
        days = (storage, game_id, start, end)
        timed("Overview", insights.summary, *days, HIDE_TEST)
        timed("Filter menus", insights.facets, *days)
        timed("Players", insights.players, *days, HIDE_TEST)
        timed("Mapping status", events.mapping_status, storage, game_id)
        if SKIP_LEVELS:
            print(f"    {'Levels':<16}skipped")
        else:
            timed("Levels", journeys.level_progress, *days, HIDE_TEST)
        print()


if __name__ == "__main__":
    main()
