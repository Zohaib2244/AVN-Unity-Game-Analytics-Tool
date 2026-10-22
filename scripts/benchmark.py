"""Synthetic benchmark for the dashboards: how long each page takes, and what it costs.

Everything happens in a scratch directory this script creates (never a real data directory):

    scripts/benchmark.py generate --events 250000 --dir ~/temp/scratch/avn-bench/250k
    scripts/benchmark.py measure  --dir ~/temp/scratch/avn-bench/250k [--mode facts] [--json out]
    scripts/benchmark.py ingest   --dir ~/temp/scratch/avn-bench/250k --seconds 20
    scripts/benchmark.py plans    --dir ~/temp/scratch/avn-bench/250k
    scripts/benchmark.py compare  --dir ~/temp/scratch/avn-bench/250k [--mode facts]

generate writes a deterministic synthetic game (tests/synthetic.py) through the real ingest code.
It checks the free disk space first and refuses a size that would leave the disk short.

measure times each page over 7, 30 and 90 days in a fresh process with the response cache off
(the underlying computation), once right after evicting the database from the operating system's
page cache ("cold disk") and then warm; then the same request over HTTP with the cache on, first
and repeated. Each process reports its peak memory. --mode picks the dashboards' read path
(AVN_ANALYTICS_READ_MODE) where the version being measured has one.

ingest measures event ingestion (throughput and latency) alone and while another process keeps
the dashboards busy, and checks that every accepted event was stored exactly once.

plans prints SQLite's query plan for every statement the pages run. compare asks the frozen
reference (tests/reference) and the current code the same questions and lists any differences.

Run it with the project's environment: `. scripts/_env.sh && .venv/bin/python scripts/benchmark.py`.
"""

import argparse
import json
import os
import resource
import shutil
import statistics
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from synthetic import ANCHOR, DICTIONARY, generate  # noqa: E402

from avn_analytics.models import timestamp  # noqa: E402

MARKER = ".avn-benchmark"
BYTES_PER_EVENT = 2048  # raw event, its indexes and derived analytics data, with headroom
RESERVE = 5 * 1024**3  # never leave less than this free on the disk
HIDE_TEST = {"exclude_environments": ["editor", "development", "test", "debug"]}
FILTERS = {"default": HIDE_TEST, "us_android": {"countries": ["US"], "platforms": ["android"]}}
RANGES = (7, 30, 90)


def storage_for(directory, **options):
    from avn_analytics.auth import Accounts
    from avn_analytics.config import Settings
    from avn_analytics.storage import Storage

    settings = Settings(data_dir=Path(directory), admin_token="b" * 40, **options)
    storage = Storage(settings)
    storage.initialize()
    Accounts(storage, settings).initialize()
    return storage


def checked(directory):
    """The benchmark directory, refusing anything this script did not create."""
    directory = Path(directory).expanduser().resolve()
    if not (directory / MARKER).exists():
        sys.exit(f"{directory} is not a benchmark directory (no {MARKER}); run generate first")
    return directory


def game_of(storage):
    games = storage.list_games()
    if len(games) != 1:
        sys.exit("A benchmark directory holds exactly one game")
    return games[0]["id"]


def window(days):
    return timestamp(ANCHOR - timedelta(days=days)), timestamp(ANCHOR)


def database_bytes(storage, game_id):
    return {
        path.name.rsplit(".", 1)[-1]: path.stat().st_size
        for path in storage.game_files(game_id)
        if path.exists()
    }


# ---- generate


def command_generate(options):
    directory = Path(options.dir).expanduser().resolve()
    if directory.exists() and any(directory.iterdir()):
        sys.exit(f"{directory} is not empty; pick a new directory")
    parent = directory if directory.exists() else directory.parent
    parent.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(parent)
    needed = options.events * BYTES_PER_EVENT
    if usage.free - needed < max(RESERVE, usage.total // 10):
        sys.exit(
            f"Not generating {options.events:,} events: they need about {needed / 1e9:.1f} GB and "
            f"{usage.free / 1e9:.1f} GB is free, which would leave the disk short. "
            "Record this as the limit of this machine, or use a larger scratch disk."
        )
    directory.mkdir(parents=True, exist_ok=True)
    (directory / MARKER).write_text("synthetic benchmark data; safe to delete\n")
    from avn_analytics.models import Batch, EventDefinition, GameCreate

    storage = storage_for(directory)
    game = storage.register_game(
        GameCreate(name="Benchmark", bundle_id="com.avn.benchmark", platform="android")
    )
    game_id = game["id"]
    with storage.connect(storage.game_path(game_id)) as connection:
        for name, definition in DICTIONARY.items():
            storage.write_definition(connection, name, EventDefinition.model_validate(definition))
        connection.execute(
            "INSERT INTO environment_fixes (from_environment, to_environment, app_version, build,"
            " note, created_at) VALUES ('development', 'production', NULL, '103', '', ?)",
            (timestamp(),),
        )
    began = time.perf_counter()
    stored = 0
    for country, batch in generate(options.events, seed=options.seed, days=options.days):
        stored += storage.ingest(game_id, Batch.model_validate(batch), country=country)["accepted"]
        if stored // 100_000 != (stored - len(batch["events"])) // 100_000:
            print(f"  {stored:,} events ({time.perf_counter() - began:.0f} s)", flush=True)
    seconds = time.perf_counter() - began
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    print(f"{stored:,} events in {seconds:.0f} s ({stored / seconds:,.0f}/s) into {directory}")
    print("database bytes:", database_bytes(storage, game_id))


# ---- one measurement, in its own process


def heaviest_player(storage, game_id, directory):
    remembered = directory / "heaviest-player.txt"
    if remembered.exists():
        return remembered.read_text().strip()
    with storage.connect(storage.game_path(game_id)) as connection:
        start, end = window(30)
        player = connection.execute(
            "SELECT coalesce(json_extract(payload, '$.user_id'), json_extract(payload,"
            " '$.device_id')) AS player FROM events WHERE client_ts>=? AND client_ts<?"
            " GROUP BY player ORDER BY count(*) DESC LIMIT 1",
            (start, end),
        ).fetchone()["player"]
    remembered.write_text(player)
    return player


def pages(storage, game_id, directory):
    """name -> (function(start, end, filters), depends on the range?)."""
    from avn_analytics import events, insights, journeys

    player = heaviest_player(storage, game_id, directory)
    return {
        "overview": (lambda s, e, f: insights.summary(storage, game_id, s, e, f, 0), True),
        "facets": (lambda s, e, f: insights.facets(storage, game_id, s, e), True),
        "players": (lambda s, e, f: insights.players(storage, game_id, s, e, f), True),
        "mapping_status": (lambda s, e, f: events.mapping_status(storage, game_id), False),
        "levels": (lambda s, e, f: journeys.level_progress(storage, game_id, s, e, f), True),
        "levels_first": (
            lambda s, e, f: journeys.level_progress(storage, game_id, s, e, f, "first_session"),
            True,
        ),
        "level_players": (
            lambda s, e, f: journeys.level_players(storage, game_id, s, e, f, 3),
            True,
        ),
        "timeline": (
            lambda s, e, f: insights.journey(storage, game_id, player, s, e),
            True,
        ),
        "story": (
            lambda s, e, f: journeys.player_story(storage, game_id, player, s, e),
            True,
        ),
    }


def peak_megabytes():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def evict(storage, game_id):
    """Ask the kernel to drop the database's cached pages (no root needed for our own files)."""
    for path in storage.game_files(game_id):
        if path.exists():
            descriptor = os.open(path, os.O_RDONLY)
            try:
                os.posix_fadvise(descriptor, 0, 0, os.POSIX_FADV_DONTNEED)
            finally:
                os.close(descriptor)


def command_one(options):
    """Prints one JSON line: the page's computation time and this process's peak memory."""
    directory = checked(options.dir)
    storage = storage_for(directory, read_cache_seconds=0)
    game_id = game_of(storage)
    function, _ = pages(storage, game_id, directory)[options.page]
    start, end = window(options.days)
    if options.cold:
        evict(storage, game_id)
    before = peak_megabytes()
    began = time.perf_counter()
    try:
        function(start, end, FILTERS[options.filter])
        error = None
    except Exception as failure:  # report it; the summary shows which page failed
        error = f"{type(failure).__name__}: {failure}"
    seconds = time.perf_counter() - began
    print(
        json.dumps(
            {
                "seconds": round(seconds, 3),
                "peak_mb": round(peak_megabytes(), 1),
                "base_mb": round(before, 1),
                "error": error,
            }
        )
    )


def run_one(directory, page, days, filters, mode, cold=False):
    environment = {**os.environ, "AVN_ANALYTICS_READ_MODE": mode}
    command = [
        sys.executable,
        __file__,
        "_one",
        "--dir",
        str(directory),
        "--page",
        page,
        "--days",
        str(days),
        "--filter",
        filters,
    ] + (["--cold"] if cold else [])
    output = subprocess.run(command, env=environment, capture_output=True, text=True, check=True)
    return json.loads(output.stdout.strip().splitlines()[-1])


def percentile(values, share):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(share * len(ordered)))]


def http_timings(directory, page, days, mode, repeats):
    """The same page through the admin API with the response cache on: first, then repeated."""
    os.environ["AVN_ANALYTICS_READ_MODE"] = mode
    from fastapi.testclient import TestClient

    from avn_analytics.api import create_app
    from avn_analytics.config import Settings

    settings = Settings(data_dir=directory, admin_token="b" * 40, read_cache_seconds=60)
    storage = storage_for(directory)
    game_id = game_of(storage)
    first_day = (ANCHOR - timedelta(days=days)).date().isoformat()
    last_day = (ANCHOR - timedelta(days=1)).date().isoformat()
    paths = {
        "overview": "insights/summary",
        "levels": "insights/levels",
        "players": "insights/players",
        "facets": "insights/facets",
    }
    query = {"start": first_day, "end": last_day, "not_env": HIDE_TEST["exclude_environments"]}
    if page == "facets":
        query.pop("not_env")
    url = f"/v1/games/{game_id}/{paths[page]}"
    times = []
    with TestClient(create_app(settings, admin=True)) as client:
        for _ in range(repeats + 1):
            began = time.perf_counter()
            response = client.get(
                url, params=query, headers={"Authorization": "Bearer " + "b" * 40}
            )
            times.append(time.perf_counter() - began)
            response.raise_for_status()
    return {"first": round(times[0], 3), "repeat_p95": round(percentile(times[1:], 0.95), 4)}


def command_http(options):
    print(
        json.dumps(http_timings(checked(options.dir), options.page, options.days, options.mode, 10))
    )


def command_measure(options):
    directory = checked(options.dir)
    storage = storage_for(directory)
    game_id = game_of(storage)
    names = pages(storage, game_id, directory)
    chosen = options.pages.split(",") if options.pages else list(names)
    results = {
        "mode": options.mode,
        "database_bytes": database_bytes(storage, game_id),
        "events": events_count(storage, game_id),
        "pages": [],
        "http": [],
    }
    print(f"{results['events']:,} events · mode {options.mode} · {results['database_bytes']}")
    print(
        f"{'page':<15}{'days':>5} {'filter':<11}{'cold disk':>10}{'warm':>9}{'p95':>9}"
        f"{'peak MB':>9}"
    )
    for page in chosen:
        ranged = names[page][1]
        for days in RANGES if ranged else (30,):
            for filters in FILTERS if days == 30 else ("default",):
                cold = run_one(directory, page, days, filters, options.mode, cold=True)
                warm = [
                    run_one(directory, page, days, filters, options.mode)
                    for _ in range(options.runs)
                ]
                seconds = [item["seconds"] for item in warm]
                row = {
                    "page": page,
                    "days": days,
                    "filter": filters,
                    "cold_disk": cold["seconds"],
                    "warm_median": statistics.median(seconds),
                    "warm_p95": percentile(seconds, 0.95),
                    "peak_mb": max(item["peak_mb"] for item in [cold, *warm]),
                    "base_mb": min(item["base_mb"] for item in [cold, *warm]),
                    "error": cold["error"] or warm[0]["error"],
                }
                results["pages"].append(row)
                print(
                    f"{page:<15}{days:>5} {filters:<11}{row['cold_disk']:>9.2f}s"
                    f"{row['warm_median']:>8.2f}s{row['warm_p95']:>8.2f}s{row['peak_mb']:>9.0f}"
                    + (f"  {row['error']}" if row["error"] else ""),
                    flush=True,
                )
    for page in ("overview", "levels", "players", "facets"):
        if page not in chosen:
            continue
        command = [
            sys.executable,
            __file__,
            "_http",
            "--dir",
            str(directory),
            "--page",
            page,
            "--days",
            "30",
            "--mode",
            options.mode,
        ]
        output = subprocess.run(command, capture_output=True, text=True, check=True)
        timing = {"page": page, **json.loads(output.stdout.strip().splitlines()[-1])}
        results["http"].append(timing)
        print(
            f"HTTP {page:<10} first request after start {timing['first']:.2f}s, "
            f"repeated (cache) p95 {timing['repeat_p95'] * 1000:.1f} ms",
            flush=True,
        )
    if options.json:
        Path(options.json).write_text(json.dumps(results, indent=2) + "\n")


def events_count(storage, game_id):
    with storage.connect(storage.game_path(game_id)) as connection:
        return connection.execute("SELECT count(*) FROM events").fetchone()[0]


# ---- ingest under dashboard load


def command_dashboard_load(options):
    """Keeps the heavy pages busy until killed (the background half of `ingest`)."""
    directory = checked(options.dir)
    storage = storage_for(directory, read_cache_seconds=0)
    game_id = game_of(storage)
    names = pages(storage, game_id, directory)
    start, end = window(30)
    while True:
        for page in ("overview", "levels", "players"):
            names[page][0](start, end, HIDE_TEST)


def ingest_round(client, key, seconds, seed):
    """Sends 100-event batches for `seconds`; every tenth batch is resent (an SDK retry)."""
    from synthetic import generate as more

    latencies, accepted, duplicates, expected_duplicates, sent = [], 0, 0, 0, 0
    batches = more(10_000_000, seed=seed, days=30, batch_size=100)
    began = time.perf_counter()
    previous = None
    count = 0
    while time.perf_counter() - began < seconds:
        count += 1
        if previous is not None and count % 10 == 0:
            batch, expected_duplicates = previous, expected_duplicates + len(previous["events"])
        else:
            _, batch = next(batches)
            sent += len(batch["events"])
        moment = time.perf_counter()
        response = client.post("/v1/events", json=batch, headers={"X-API-Key": key})
        latencies.append(time.perf_counter() - moment)
        response.raise_for_status()
        body = response.json()
        accepted += body["accepted"]
        duplicates += body["duplicates"]
        previous = batch
    elapsed = time.perf_counter() - began
    return {
        "requests": len(latencies),
        "events_per_second": round(sent / elapsed),
        "p50_ms": round(1000 * percentile(latencies, 0.5), 1),
        "p95_ms": round(1000 * percentile(latencies, 0.95), 1),
        "p99_ms": round(1000 * percentile(latencies, 0.99), 1),
        "sent": sent,
        "accepted": accepted,
        "duplicates": duplicates,
        "expected_duplicates": expected_duplicates,
    }


def command_ingest(options):
    original = checked(options.dir)
    # Work on a copy, so the measured game stays the same size for every later run.
    directory = original.with_name(original.name + "-ingest-copy")
    shutil.rmtree(directory, ignore_errors=True)
    shutil.copytree(original, directory)
    try:
        ingest_into(directory, options)
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def ingest_into(directory, options):
    from fastapi.testclient import TestClient

    from avn_analytics.api import create_app
    from avn_analytics.config import Settings

    storage = storage_for(directory)
    game_id = game_of(storage)
    key = storage.create_key(game_id, "benchmark")["api_key"]
    settings = Settings(data_dir=directory, requests_per_minute=10_000_000)
    report = {}
    with TestClient(create_app(settings)) as client:
        ingest_round(client, key, 2, seed=1000)  # warm-up, not reported
        before = events_count(storage, game_id)
        report["alone"] = ingest_round(client, key, options.seconds, seed=1001)
        load = subprocess.Popen(
            [sys.executable, __file__, "_load", "--dir", str(directory)],
            env={**os.environ, "AVN_ANALYTICS_READ_MODE": options.mode},
        )
        try:
            time.sleep(2)
            report["with_dashboards"] = ingest_round(client, key, options.seconds, seed=1002)
        finally:
            load.kill()
            load.wait()
        report["alone_again"] = ingest_round(client, key, options.seconds, seed=1003)
        stored = events_count(storage, game_id) - before
    accepted = sum(item["accepted"] for item in report.values())
    report["stored"] = stored
    report["exact"] = stored == accepted and all(
        item["duplicates"] == item["expected_duplicates"]
        for item in report.values()
        if isinstance(item, dict)
    )
    print(json.dumps(report, indent=2))
    if options.json:
        Path(options.json).write_text(json.dumps(report, indent=2) + "\n")


# ---- query plans and answer comparison


def command_plans(options):
    directory = checked(options.dir)
    storage = storage_for(directory, read_cache_seconds=0)
    game_id = game_of(storage)
    names = pages(storage, game_id, directory)
    statements = []
    original = storage.connect

    def traced(path):
        context = original(path)

        class Traced:
            def __enter__(self):
                connection = context.__enter__()
                connection.set_trace_callback(statements.append)
                return connection

            def __exit__(self, *exc):
                return context.__exit__(*exc)

        return Traced()

    storage.connect = traced
    start, end = window(30)
    for page, (function, _) in names.items():
        statements.clear()
        function(start, end, HIDE_TEST)
        print(f"==== {page}")
        with original(storage.game_path(game_id)) as connection:
            for statement in dict.fromkeys(statements):
                text = statement.strip()
                if not text.upper().startswith(("SELECT", "WITH", "CREATE TEMP")):
                    continue
                if text.upper().startswith("CREATE TEMP"):
                    text = text[text.upper().index(" AS ") + 4 :]
                try:
                    plan = connection.execute(f"EXPLAIN QUERY PLAN {text}").fetchall()
                except Exception as error:
                    print(f"  (no plan: {error})")
                    continue
                print("  " + " ".join(text.split())[:160])
                for row in plan:
                    print(f"      {row['detail']}")


def command_compare(options):
    os.environ["AVN_ANALYTICS_READ_MODE"] = options.mode
    from parity import PRODUCTION, REFERENCE, compare, snapshot

    directory = checked(options.dir)
    storage = storage_for(directory, read_cache_seconds=60)
    game_id = game_of(storage)
    began = time.perf_counter()
    expected = snapshot(storage, game_id, REFERENCE, full=False)
    middle = time.perf_counter()
    actual = snapshot(storage, game_id, PRODUCTION, full=False)
    done = time.perf_counter()
    problems = compare(expected, actual)
    print(
        f"{len(expected)} answers; reference {middle - began:.0f} s, current {done - middle:.0f} s;"
        f" {len(problems)} differ"
    )
    for problem in problems[:40]:
        print("  " + problem)
    sys.exit(1 if problems else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    generate_parser = commands.add_parser("generate")
    generate_parser.add_argument("--events", type=int, required=True)
    generate_parser.add_argument("--dir", required=True)
    generate_parser.add_argument("--seed", type=int, default=1)
    generate_parser.add_argument("--days", type=int, default=120)
    for name in ("measure", "ingest", "plans", "compare", "_load", "_one", "_http"):
        sub = commands.add_parser(name)
        sub.add_argument("--dir", required=True)
        sub.add_argument("--mode", default=os.environ.get("AVN_ANALYTICS_READ_MODE", "legacy"))
        sub.add_argument("--json")
        sub.add_argument("--runs", type=int, default=3)
        sub.add_argument("--pages", default="")
        sub.add_argument("--seconds", type=int, default=20)
        sub.add_argument("--page")
        sub.add_argument("--days", type=int, default=30)
        sub.add_argument("--filter", default="default")
        sub.add_argument("--cold", action="store_true")
    options = parser.parse_args()
    handlers = {
        "generate": command_generate,
        "measure": command_measure,
        "ingest": command_ingest,
        "plans": command_plans,
        "compare": command_compare,
        "_load": command_dashboard_load,
        "_one": command_one,
        "_http": command_http,
    }
    handlers[options.command](options)


if __name__ == "__main__":
    main()
