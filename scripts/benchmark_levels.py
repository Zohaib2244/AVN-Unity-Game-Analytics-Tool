"""Reproduce large Levels preparation on a marked, deterministic SDK-like fixture.

    . scripts/_env.sh
    .venv/bin/python scripts/benchmark_levels.py generate --dir /tmp/avn-levels-capacity
    .venv/bin/python scripts/benchmark_levels.py measure --dir /tmp/avn-levels-capacity \
        --baseline-ref main --json /tmp/avn-levels-results.json

One player reaches 4,000 levels; the rest stop earlier. Every event has changing SDK metadata.
Only a marked synthetic directory is accepted. Measurement resets prepared tables only, runs
each implementation in its own process, verifies raw/fact counts, and reports preparation
failure as failure rather than timing a live fallback as a prepared read.
"""

import argparse
import importlib
import json
import os
import resource
import shutil
import sqlite3
import statistics
import subprocess
import sys
import time
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

from benchmark import ANCHOR, HIDE_TEST, MARKER, RESERVE, checked, game_of, storage_for, window


def generate(args):
    from avn_analytics import analytics
    from avn_analytics.models import Batch, GameCreate, timestamp

    directory = Path(args.dir).resolve()
    if directory.exists() and any(directory.iterdir()):
        raise ValueError("Choose an empty scratch directory")
    directory.parent.mkdir(parents=True, exist_ok=True)
    events = (args.players - 1) * args.levels * 5 + args.tail * 5 + args.players * 2
    disk = shutil.disk_usage(directory.parent)
    if disk.free - events * 2048 < max(RESERVE, disk.total // 10):
        raise ValueError("The fixture would leave less than the benchmark disk reserve")
    directory.mkdir(exist_ok=True)
    (directory / MARKER).write_text("synthetic long-level benchmark; safe to delete\n")
    storage = storage_for(directory, analytics_read_mode="facts")
    game = storage.register_game(
        GameCreate(name="Long Levels", bundle_id="com.avn.longlevels", platform="android")
    )["id"]
    serial, accepted = 0, 0
    began = time.monotonic()
    for player in range(args.players):
        origin = ANCHOR - timedelta(days=1 + player % 7)
        count = args.tail if player == 0 else args.levels
        pending = []
        seq = 0

        def emit(name, params, origin=origin, pending=pending):
            nonlocal serial, seq
            serial += 1
            pending.append(
                {
                    "event_id": str(UUID(int=serial)),
                    "name": name,
                    "client_ts": timestamp(origin + timedelta(seconds=seq * 2)),
                    "params": {"seq": seq, **params},
                }
            )
            seq += 1

        context = {
            "device_id": f"p{player:06}",
            "session_id": f"s{player:06}",
            "app_version": "1.0.0",
            "build": "100",
            "platform": "android",
            "environment": "production",
        }
        emit("session_start", {"session_timeout_seconds": 1800})
        for level in range(1, count + 1):
            emit(
                "LEVEL_ANALYSIS",
                {"STATE": "Started", "LEVEL_NUMBER": level, "ATTEMPT_ID": f"{player}-{level}"},
            )
            emit(
                "AD_ANALYSIS",
                {
                    "STATE": "Show",
                    "FORMAT": "Interstitial",
                    "PLACEMENT": "between_levels",
                    "LEVEL_NUMBER": level,
                    "AD_ID": f"ad-{player}-{level}",
                },
            )
            emit(
                "APP_ANALYSIS",
                {"STATE": "Foreground", "CAUSE": "Ad", "AWAY_SECONDS": 5, "LEVEL_NUMBER": level},
            )
            emit("POWERUP_ANALYSIS", {"STATE": "Used", "POWERUP": "Hammer", "LEVEL_NUMBER": level})
            emit(
                "LEVEL_ANALYSIS",
                {
                    "STATE": "Completed",
                    "LEVEL_NUMBER": level,
                    "SECONDS": 8,
                    "ATTEMPT_ID": f"{player}-{level}",
                },
            )
            if len(pending) >= 500:
                accepted += storage.ingest(
                    game,
                    Batch.model_validate({"context": context, "events": pending[:500]}),
                    country="US",
                )["accepted"]
                del pending[:500]
        emit("session_end", {"end_reason": "quit", "duration_seconds": seq * 2 - count * 5})
        if pending:
            accepted += storage.ingest(
                game, Batch.model_validate({"context": context, "events": pending}), country="US"
            )["accepted"]
        if (player + 1) % 100 == 0:
            print(f"generated players={player + 1} events={accepted}", flush=True)
    with storage.connect(storage.game_path(game)) as db:
        while not analytics.facts_ready(db):
            analytics.step(db)
    report = {
        "events": accepted,
        "players": args.players,
        "tail_levels": args.tail,
        "normal_levels": args.levels,
        "generate_seconds": round(time.monotonic() - began, 3),
    }
    (directory / "levels-fixture.json").write_text(json.dumps(report, indent=2))
    return report


def reset_views(directory):
    # This is deliberately restricted to the fixture's derived prepared tables.
    games = list((checked(directory) / "games").glob("*.sqlite3"))
    if len(games) != 1:
        raise ValueError("Expected one synthetic game")
    with sqlite3.connect(games[0]) as db:
        for table in (
            "analytics_level_groups",
            "analytics_level_players",
            "analytics_level_staging",
            "analytics_group_tokens",
            "analytics_queue",
            "analytics_parts",
            "analytics_views",
        ):
            db.execute(f"DROP TABLE IF EXISTS {table}")


def phase(args):
    directory = checked(args.dir)
    if args.baseline_ref:
        root = Path(__file__).resolve().parent.parent
        for name in ("readbudget", "readcache", "stories", "journeys", "views", "materialize"):
            source = subprocess.check_output(
                ["git", "show", f"{args.baseline_ref}:avn_analytics/{name}.py"], cwd=root
            ).decode()
            module = importlib.import_module(f"avn_analytics.{name}")
            exec(compile(source, module.__file__, "exec"), module.__dict__)
    from avn_analytics import journeys, materialize, views

    reset_views(directory)
    storage = storage_for(directory, analytics_read_mode="prepared", read_cache_seconds=0)
    game, days = game_of(storage), window(7)
    with storage.connect(storage.game_path(game)) as db:
        before = tuple(
            db.execute(
                "SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM analytics_facts)"
            ).fetchone()
        )
    views.answer(storage, game, "levels", (*days, HIDE_TEST, "all"), lambda: None)
    worker = materialize.Worker(storage, identity="long-level-benchmark")
    began = time.monotonic()
    report = {}
    try:
        for _tick in range(10000):
            if time.monotonic() - began > 600:
                raise TimeoutError("Preparation exceeded ten minutes")
            worked = worker.tick()
            with storage.connect(storage.game_path(game)) as db:
                row = db.execute(
                    "SELECT answer,stage,source_at,error FROM analytics_views"
                ).fetchone()
            if row["error"]:
                report.update(prepared=False, error=row["error"])
                break
            if row["answer"] is not None and row["stage"] is None:
                if time.time() - row["source_at"] <= storage.settings.analytics_freshness_seconds:
                    report["prepared"] = True
                    break
                # No ingest is running: immediately request a genuine watermark recheck.
                with storage.connect(storage.game_path(game)) as db:
                    db.execute("UPDATE analytics_views SET checked_at=0")
            if not worked:
                time.sleep(0.02)
        report.update(prepare_seconds=round(time.monotonic() - began, 3), ticks=_tick + 1)
        if report["prepared"]:
            again = storage_for(directory, analytics_read_mode="prepared", read_cache_seconds=0)
            calls = {
                "levels": lambda: journeys.level_progress(again, game, *days, HIDE_TEST),
                "features": lambda: journeys.level_features(again, game, *days, HIDE_TEST),
                "players": lambda: journeys.level_players(
                    again, game, *days, HIDE_TEST, 1, group="started"
                ),
            }
            timings, actual = {}, {}
            for name, call in calls.items():
                samples = []
                for _ in range(5):
                    start = time.monotonic()
                    answer = call()
                    samples.append((time.monotonic() - start) * 1000)
                timings[name] = {
                    "p50_ms": round(statistics.median(samples), 2),
                    "max_ms": round(max(samples), 2),
                }
                actual[name] = answer
                if name == "levels":
                    report["levels"] = len(answer["levels"])
            report["timings"] = timings
            report["prepared_peak_mb"] = round(
                resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1
            )
            from avn_analytics.storage import Storage

            live = Storage(
                replace(storage.settings, analytics_read_mode="facts", read_cache_seconds=60)
            )
            expected = {
                "levels": journeys.level_progress(live, game, *days, HIDE_TEST),
                "features": journeys.level_features(live, game, *days, HIDE_TEST),
                "players": journeys.level_players(live, game, *days, HIDE_TEST, 1, group="started"),
            }
            assert actual == expected, "Prepared answers differ from exact live answers"
            report["exact"] = True
        with storage.connect(storage.game_path(game)) as db:
            after = tuple(
                db.execute(
                    "SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM analytics_facts)"
                ).fetchone()
            )
            report["summary_answer_bytes"] = db.execute(
                "SELECT length(answer) FROM analytics_views"
            ).fetchone()[0]
        assert before == after and before[0] == before[1]
        report.update(
            raw_events=before[0],
            raw_counts_unchanged=True,
            derived_bytes=views._space(storage),
            peak_mb=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        )
        if report["prepared"] and args.check_refresh:
            from avn_analytics.models import Batch, timestamp

            # Recheck the unchanged source after live parity, which can outlast freshness.
            with storage.connect(storage.game_path(game)) as db:
                db.execute("UPDATE analytics_views SET checked_at=0")
            worker.tick()
            stamp = timestamp(ANCHOR - timedelta(minutes=1))
            accepted = storage.ingest(
                game,
                Batch.model_validate(
                    {
                        "events": [
                            {
                                "event_id": str(uuid4()),
                                "name": "LEVEL_ANALYSIS",
                                "params": {"STATE": "Failed", "LEVEL_NUMBER": 1},
                                "device_id": f"p{player:06}",
                                "session_id": f"refresh-{uuid4().hex}",
                                "app_version": "1.0.0",
                                "build": "100",
                                "platform": "android",
                                "environment": "production",
                                "client_ts": stamp,
                            }
                            for player in (0, 1)
                        ]
                    }
                ),
            )["accepted"]
            committed = time.monotonic()
            with storage.connect(storage.game_path(game)) as db:
                mark = db.execute("SELECT max(id) FROM analytics_facts").fetchone()[0]
            while time.monotonic() - committed < 60:
                worked = worker.tick()
                with storage.connect(storage.game_path(game)) as db:
                    row = db.execute(
                        "SELECT watermark,stage,source_at,error FROM analytics_views"
                    ).fetchone()
                if row["error"]:
                    raise RuntimeError(row["error"])
                if (
                    row["watermark"] >= mark
                    and row["stage"] is None
                    and time.time() - row["source_at"]
                    <= storage.settings.analytics_freshness_seconds
                ):
                    break
                if not worked:
                    time.sleep(materialize.POLL_SECONDS)
            else:
                raise RuntimeError("Incremental refresh exceeded sixty seconds")
            lag = time.monotonic() - committed
            current = journeys.level_progress(again, game, *days, HIDE_TEST)
            live = Storage(
                replace(storage.settings, analytics_read_mode="facts", read_cache_seconds=60)
            )
            assert current == journeys.level_progress(live, game, *days, HIDE_TEST)
            report["refresh"] = {
                "accepted": accepted,
                "commit_to_ready_seconds": round(lag, 3),
                "exact": True,
            }
            report["peak_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    finally:
        worker._write_status(observed="exited", force=True)
    Path(args.output).write_text(json.dumps(report, indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("generate", "measure", "phase"))
    parser.add_argument("--dir", required=True)
    parser.add_argument("--players", type=int, default=400)
    parser.add_argument("--levels", type=int, default=200)
    parser.add_argument("--tail", type=int, default=4000)
    parser.add_argument("--baseline-ref")
    parser.add_argument("--json")
    parser.add_argument("--output")
    parser.add_argument(
        "--check-refresh",
        action="store_true",
        help="Append two synthetic events after parity and verify a fresh incremental publication",
    )
    args = parser.parse_args()
    if args.players < 2 or args.levels < 1 or args.tail < args.levels:
        parser.error("Use at least two players and tail >= levels >= 1")
    if args.command == "generate":
        result = generate(args)
    elif args.command == "phase":
        result = phase(args)
    else:
        directory = checked(args.dir)
        result = {}
        for name, reference in (("baseline", args.baseline_ref), ("candidate", None)):
            if name == "baseline" and reference is None:
                continue
            output = directory / f"levels-{name}.json"
            command = [
                sys.executable,
                __file__,
                "phase",
                "--dir",
                str(directory),
                "--output",
                str(output),
            ]
            if reference:
                command.extend(["--baseline-ref", reference])
            if args.check_refresh and name == "candidate":
                command.append("--check-refresh")
            subprocess.run(command, check=True, env=os.environ)
            result[name] = json.loads(output.read_text())
        if args.json:
            Path(args.json).write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    main()
