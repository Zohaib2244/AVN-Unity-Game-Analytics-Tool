"""Measure persistent answers on a marked synthetic benchmark directory.

Run after scripts/benchmark.py generate/facts. No real data directories are accepted.
"""

import argparse
import json
import resource
import statistics
import time

from benchmark import HIDE_TEST, checked, game_of, storage_for, window

from avn_analytics import insights, journeys, materialize, views


def measure(directory):
    storage = storage_for(checked(directory), analytics_read_mode="prepared", read_cache_seconds=0)
    game = game_of(storage)
    days = window(30)
    calls = {
        "overview": lambda s: views.answer(
            s,
            game,
            "summary",
            (days, HIDE_TEST, 0),
            lambda: insights.summary(s, game, *days, HIDE_TEST),
        ),
        "levels": lambda s: journeys.level_progress(s, game, *days, HIDE_TEST),
        "levels_first": lambda s: journeys.level_progress(
            s, game, *days, HIDE_TEST, "first_session"
        ),
        "level_players": lambda s: journeys.level_players(s, game, *days, HIDE_TEST, 1),
    }
    # Every run measures initial preparation as well as a restart. Clear only this marked
    # fixture's rebuildable answers; raw events/facts remain untouched.
    with storage.connect(storage.game_path(game)) as db:
        db.execute("DELETE FROM analytics_views")
    expected = {name: call(storage) for name, call in calls.items()}
    worker = materialize.Worker(storage, identity="prepared-benchmark")
    began = time.monotonic()
    ticks = 0
    while time.monotonic() - began < 180:
        worker.tick()
        ticks += 1
        with storage.connect(storage.game_path(game)) as db:
            pending = db.execute(
                "SELECT count(*) FROM analytics_views WHERE answer IS NULL"
            ).fetchone()[0]
        if not pending:
            break
        if worker.failing:
            raise RuntimeError(worker.failing)
    else:
        raise RuntimeError("Preparation exceeded 180 seconds")
    result = {"prepare_seconds": round(time.monotonic() - began, 3), "ticks": ticks}
    # A new Storage has no process cache: the published answer must survive an API restart.
    again = storage_for(directory, analytics_read_mode="prepared", read_cache_seconds=0)
    timings = {}
    for name, call in calls.items():
        samples = []
        for _ in range(10):
            # Keep the supervisor running during measurements, as in production. Otherwise
            # a long benchmark can age its answers past the freshness bound and time fallback.
            for _ in range(6):
                worker.tick()
            with storage.connect(storage.game_path(game)) as db:
                eligible = db.execute(
                    "SELECT count(*) FROM analytics_views "
                    "WHERE answer IS NOT NULL AND source_at>=?",
                    (time.time() - storage.settings.analytics_freshness_seconds,),
                ).fetchone()[0]
            assert eligible == 3, "benchmark would time a live fallback"
            worker._write_status(force=True)
            start = time.monotonic()
            answer = call(again)
            samples.append((time.monotonic() - start) * 1000)
            assert answer == expected[name], name
        timings[name] = {
            "p50_ms": round(statistics.median(samples), 2),
            "p95_ms": round(sorted(samples)[-1], 2),
        }
    result.update(
        timings=timings,
        peak_mb=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        derived_bytes=views._space(storage),
        exact=True,
    )
    worker._write_status(observed="exited", force=True)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()
    print(json.dumps(measure(args.dir), indent=2))
