"""Concurrent ingest/catch-up probe on an owned copy of a marked synthetic fixture."""

import argparse
import json
import shutil
import tempfile
import threading
import time
from pathlib import Path

from benchmark import HIDE_TEST, checked, game_of, storage_for, window
from synthetic import generate

from avn_analytics import insights, journeys, materialize, views
from avn_analytics.models import Batch


def measure(directory, seconds):
    original = checked(directory)
    with tempfile.TemporaryDirectory(prefix="avn-freshness-", dir=original.parent) as temporary:
        directory = Path(temporary) / "fixture"
        shutil.copytree(original, directory)
        storage = storage_for(directory, analytics_read_mode="prepared", read_cache_seconds=0)
        game = game_of(storage)
        # Copied leases belong to a finished benchmark, not to a process operating this copy.
        with storage.connect(storage.root / "registry.sqlite3") as db:
            db.execute("UPDATE analytics_worker_status SET observed='exited'")
        days = window(30)
        with storage.connect(storage.game_path(game)) as db:
            db.execute("DELETE FROM analytics_views")
        views.answer(
            storage,
            game,
            "summary",
            (days, HIDE_TEST, 0),
            lambda: insights.summary(storage, game, *days, HIDE_TEST),
        )
        for scope in ("all", "first_session"):
            journeys.level_progress(storage, game, *days, HIDE_TEST, scope)
        worker = materialize.Worker(storage, identity="freshness-probe")
        thread = threading.Thread(target=worker.run, daemon=True)
        thread.start()
        pending, latency, sent = [], [], 0
        batches = iter(generate(100_000, seed=9731, days=30, batch_size=100))
        began = time.monotonic()
        deadline = began + seconds

        def observe():
            with storage.connect(storage.game_path(game)) as db:
                mark = (
                    db.execute("SELECT min(coalesce(watermark,0)) FROM analytics_views").fetchone()[
                        0
                    ]
                    or 0
                )
            while pending and pending[0][0] <= mark:
                _, committed = pending.pop(0)
                latency.append(time.monotonic() - committed)

        try:
            while time.monotonic() < deadline:
                country, batch = next(batches)
                result = storage.ingest(game, Batch.model_validate(batch), country=country)
                sent += result["accepted"]
                with storage.connect(storage.game_path(game)) as db:
                    mark = db.execute("SELECT max(id) FROM analytics_facts").fetchone()[0]
                pending.append((mark, time.monotonic()))
                observe()
                time.sleep(1)
            catchup = time.monotonic()
            while pending and time.monotonic() - catchup < 60:
                observe()
                time.sleep(0.1)
            if pending:
                raise RuntimeError(f"Catch-up exceeded 60 seconds: {materialize.describe(storage)}")
            days = window(30)
            parts = (days, HIDE_TEST, 0)
            actual = views.answer(storage, game, "summary", parts, lambda: None)
            assert actual == insights.summary(storage, game, *days, HIDE_TEST), (
                materialize.describe(storage)
            )
            from dataclasses import replace

            from avn_analytics.storage import Storage

            live = Storage(replace(storage.settings, analytics_read_mode="facts"))
            for scope in ("all", "first_session"):
                assert journeys.level_progress(storage, game, *days, HIDE_TEST, scope) == (
                    journeys.level_progress(live, game, *days, HIDE_TEST, scope)
                )
            return {
                "accepted": sent,
                "ingest_seconds": seconds,
                "events_per_second": round(sent / seconds, 1),
                "max_commit_to_all_views_seconds": round(max(latency, default=0), 2),
                "catchup_seconds": round(time.monotonic() - catchup, 2),
                "exact": True,
            }
        finally:
            worker.stop()
            thread.join(10)
            if thread.is_alive():
                raise RuntimeError("Worker did not stop within 10 seconds")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True)
    parser.add_argument("--seconds", type=int, default=20, choices=range(1, 61))
    args = parser.parse_args()
    print(json.dumps(measure(args.dir, args.seconds), indent=2))
