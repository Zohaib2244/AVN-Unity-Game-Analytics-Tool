"""A bounded ClickHouse feasibility probe on a marked synthetic fixture (never a live database).

This is a storage-engine probe, not an AVN backend or a production delivery mechanism. It checks
exact identity counts, duration medians, retry deduplication and stable event order, and records
end-to-end cold startup/load cost. Full application parity remains required before adoption.
"""

import argparse
import json
import os
import sqlite3
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

from benchmark import checked

IMAGE = (
    "clickhouse/clickhouse-server@sha256:"
    "bdb5c911a23d92fd364e246ab20b5a0a485f00112f3663fa626b083fb46c146b"
)


def probe(directory):
    directory = checked(directory)
    databases = list((directory / "games").glob("*.sqlite3"))
    if len(databases) != 1:
        raise ValueError("The synthetic fixture must contain exactly one game")
    began = time.monotonic()
    players, durations, first = set(), [], []
    count = 0
    with tempfile.TemporaryDirectory(prefix="avn-clickhouse-", dir=directory.parent) as work:
        work = Path(work)
        with sqlite3.connect(databases[0].as_uri() + "?mode=ro", uri=True) as db:
            db.row_factory = sqlite3.Row
            with (work / "events.jsonl").open("w") as output:
                for row in db.execute(
                    "SELECT event_id,id,player,session_id,client_ts,name,params "
                    "FROM analytics_facts ORDER BY client_ts,event_id"
                ):
                    params = json.loads(row["params"]) if row["params"] else {}
                    duration = params.get("duration_seconds")
                    duration = float(duration) if type(duration) in (int, float) else None
                    item = dict(
                        event_id=row["event_id"],
                        seq=row["id"],
                        player=row["player"],
                        session=row["session_id"] or "",
                        ts=row["client_ts"],
                        name=row["name"],
                        duration=duration,
                    )
                    output.write(json.dumps(item) + "\n")
                    count += 1
                    if item["player"] is not None:
                        players.add(item["player"])
                    if duration is not None:
                        durations.append(duration)
                    if len(first) < 10:
                        first.append(item["event_id"])
        sql = """
CREATE TABLE events(event_id String, seq UInt64, player Nullable(String), session String,
                    ts String, name String, duration Nullable(Float64))
ENGINE=ReplacingMergeTree(seq) ORDER BY event_id;
INSERT INTO events SELECT * FROM file('/probe/events.jsonl', 'JSONEachRow');
-- SDK retries have the same identity. FINAL deduplicates before a background merge occurs.
INSERT INTO events SELECT * FROM file('/probe/events.jsonl', 'JSONEachRow') WHERE seq%20=0;
SELECT version() AS version, count() AS events, uniqExact(player) AS players,
       quantileExactInclusive(0.5)(duration) AS median FROM events FINAL FORMAT JSON;
SELECT event_id FROM events FINAL ORDER BY ts,event_id LIMIT 10 FORMAT JSON;
"""
        (work / "probe.sql").write_text(sql)
        command = [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--memory",
            "512m",
            "--cpus",
            "0.5",
            "--pids-limit",
            "128",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--read-only",
            "--tmpfs",
            "/tmp:size=64m",
            "--mount",
            f"type=bind,src={work},dst=/probe",
            "--entrypoint",
            "clickhouse",
            IMAGE,
            "local",
            "--path",
            "/probe/store",
            "--max_threads",
            "1",
            "--background_schedule_pool_size",
            "2",
            "--background_pool_size",
            "16",
            "--max_memory_usage",
            "335544320",
            "--queries-file",
            "/probe/probe.sql",
        ]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=180)
        if completed.returncode:
            return {
                "image": IMAGE,
                "available": False,
                "exit_code": completed.returncode,
                "error": completed.stderr[-2000:],
                "elapsed": time.monotonic() - began,
            }
        decoder = json.JSONDecoder()
        text = completed.stdout.strip()
        objects = []
        while text:
            value, offset = decoder.raw_decode(text)
            objects.append(value)
            text = text[offset:].lstrip()
        totals = objects[0]["data"][0]
        actual_first = [row["event_id"] for row in objects[1]["data"]]
        assert int(totals["events"]) == count
        assert int(totals["players"]) == len(players)
        assert totals["median"] == statistics.median(durations)
        assert actual_first == first
        return {
            "image": IMAGE,
            "available": True,
            "totals": totals,
            "exact": True,
            "query_seconds": [value["statistics"]["elapsed"] for value in objects],
            "startup_export_load_query_seconds": round(time.monotonic() - began, 3),
            "bytes": sum(path.stat().st_size for path in work.rglob("*") if path.is_file()),
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()
    print(json.dumps(probe(args.dir), indent=2))
