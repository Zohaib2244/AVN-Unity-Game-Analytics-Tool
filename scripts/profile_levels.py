"""Profile one cold Levels calculation without changing stored data.

Run in the admin container with its Python and settings; dates are inclusive, as in the UI:

    docker compose exec -T admin python - --game ID --start 2026-11-06 \
        --end 2026-11-12 --version 0.0.9 < scripts/profile_levels.py

This opens SQLite with mode=ro, never initializes Storage, bypasses prepared-answer registration
and response caches, and prints only aggregate counts and function timings. It uses CPU like a
cold page load. --seconds bounds the run, including Python work; an interrupted run still prints
its partial profile. Run when no other heavy dashboard request is active.
"""

import argparse
import cProfile
import pstats
import signal
import sqlite3
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from datetime import time as day_time

from avn_analytics import insights, journeys
from avn_analytics.config import Settings
from avn_analytics.models import timestamp
from avn_analytics.storage import Storage


def profile_levels(storage, game, start, end, filters, scope, seconds, timing_only=False):
    began = time.monotonic()
    cpu_began = time.process_time()

    @contextmanager
    def read_only(path):
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.set_progress_handler(lambda: int(time.monotonic() - began >= seconds), 10000)
        try:
            yield connection
        finally:
            connection.close()

    def expired(signum, frame):
        raise TimeoutError("Profile reached its time limit")

    storage.connect = read_only
    profiler = cProfile.Profile()
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        with storage.connect(storage.game_path(game)) as connection:
            source = insights.read_source(storage, connection)
        print(f"source={source.table} scope={scope} limit_seconds={seconds}", flush=True)
        if not timing_only:
            profiler.enable()
        scan = journeys._scan_levels(
            storage, game, start, end, filters, scope, storage.get_dictionary(game)
        )
        print(f"complete levels={len(scan['levels'])}", flush=True)
    except (TimeoutError, sqlite3.OperationalError, journeys._TooMuch) as error:
        print(f"incomplete: {type(error).__name__}: {error}", flush=True)
    finally:
        profiler.disable()
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
        print(f"elapsed_seconds={time.monotonic() - began:.3f}", flush=True)
        print(f"cpu_seconds={time.process_time() - cpu_began:.3f}", flush=True)
        if not timing_only:
            pstats.Stats(profiler).strip_dirs().sort_stats("cumulative").print_stats(30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", required=True)
    parser.add_argument("--start", type=date.fromisoformat, required=True)
    parser.add_argument("--end", type=date.fromisoformat, required=True)
    parser.add_argument("--version", action="append", default=[])
    parser.add_argument("--scope", choices=journeys.LEVEL_SCOPES, default="all")
    parser.add_argument("--tz-offset", type=int, default=0, help="Browser timezone offset minutes")
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--timing-only", action="store_true", help="Time without profiler overhead")
    args = parser.parse_args()
    if args.seconds <= 0 or args.end < args.start:
        parser.error("seconds must be positive and end must be on or after start")
    zone = timezone(timedelta(minutes=args.tz_offset))
    start = timestamp(datetime.combine(args.start, day_time(), zone))
    end = timestamp(datetime.combine(args.end + timedelta(days=1), day_time(), zone))
    profile_levels(
        Storage(Settings.from_env()),
        args.game,
        start,
        end,
        {"app_versions": args.version, "exclude_environments": insights.TEST_ENVIRONMENTS},
        args.scope,
        args.seconds,
        args.timing_only,
    )


if __name__ == "__main__":
    main()
