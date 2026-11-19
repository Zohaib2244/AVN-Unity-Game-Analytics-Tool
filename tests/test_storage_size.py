"""What events cost on disk: compact JSON, a bounded write-ahead log, and the storage report."""

import hashlib
import json

from parity import make_storage
from synthetic_sdk import generate

from avn_analytics import storage_report
from avn_analytics.models import Batch, GameCreate
from avn_analytics.storage import WAL_SIZE_LIMIT


def _game(storage):
    game_id = storage.register_game(
        GameCreate(name="Size", bundle_id="com.avn.size", platform="android")
    )["id"]
    for country, batch in generate(600, seed=5, days=10, batch_size=100):
        storage.ingest(game_id, Batch.model_validate(batch), country=country)
    return game_id


def test_events_are_stored_as_compact_json_with_the_same_values(tmp_path):
    storage = make_storage(tmp_path)
    game_id = _game(storage)
    with storage.connect(storage.game_path(game_id)) as connection:
        rows = connection.execute(
            "SELECT payload, json_extract(payload, '$.params') AS params, params AS fact"
            " FROM events JOIN analytics_facts USING (event_id)"
        ).fetchall()
        limit = connection.execute("PRAGMA journal_size_limit").fetchone()[0]
    assert rows and limit == WAL_SIZE_LIMIT
    for row in rows:
        payload = json.loads(row["payload"])
        assert row["payload"] == json.dumps(payload, separators=(",", ":"))
        assert row["params"] == row["fact"]


def _digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_storage_report_reads_only_and_compact_keeps_every_row(tmp_path, monkeypatch, capsys):
    storage = make_storage(tmp_path)
    game_id = _game(storage)
    path = storage.game_path(game_id)
    with storage.connect(path) as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        before = connection.execute(
            "SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM analytics_facts)"
        ).fetchone()
        # Rows deleted from a derived table leave free pages behind.
        connection.execute("CREATE TABLE scratch_rows (value TEXT)")
        connection.executemany("INSERT INTO scratch_rows VALUES (?)", [("x" * 2000,)] * 500)
    with storage.connect(path) as connection:
        connection.execute("DROP TABLE scratch_rows")
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    monkeypatch.setenv("AVN_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AVN_ADMIN_TOKEN", "x" * 40)
    digest = _digest(path)
    assert storage_report.main([]) == 0
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert _digest(path) == digest  # the report changes nothing
    assert line["events"] == before[0] and line["free_bytes"] > 500_000
    # Compacting needs a game and a confirmation.
    assert storage_report.main(["--compact"]) == 2
    assert storage_report.main(["--game", game_id, "--compact"]) == 2
    assert storage_report.main(["--game", game_id, "--compact", "--yes"]) == 0
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["compacted"]["after_bytes"] < line["compacted"]["before_bytes"] - 500_000
    with storage.connect(path) as connection:
        after = connection.execute(
            "SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM analytics_facts)"
        ).fetchone()
        assert tuple(after) == tuple(before)
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
