"""What is arriving at one game right now, for the sidebar's ingest meter.

How fast, how recently, how many players, the last 24 hours hour by hour, which versions are sending
and how big the database is. Everything is counted from when the server received each event
(server_ts); nothing is stored."""

from datetime import UTC, datetime, timedelta

from .insights import PLAYER
from .models import timestamp

RECENT_MINUTES = 5  # "now" is the last few minutes, so a quiet minute doesn't read as a stop
VERSIONS_WINDOW_MINUTES = 60
VERSIONS_SHOWN = 3
HOURS = 24


def _hour_key(moment):
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H")


def ingest_meter(storage, game_id, now=None):
    storage.get_game(game_id)
    now = now or datetime.now(UTC)
    path = storage.game_path(game_id)
    recent_from = timestamp(now - timedelta(minutes=RECENT_MINUTES))
    versions_from = timestamp(now - timedelta(minutes=VERSIONS_WINDOW_MINUTES))
    first_hour = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=HOURS - 1)
    with storage.connect(path) as connection:
        last = connection.execute("SELECT max(server_ts) FROM events").fetchone()[0]
        recent = connection.execute(
            f"SELECT count(*) AS events, count(DISTINCT {PLAYER}) AS players"
            " FROM events WHERE server_ts>=?",
            (recent_from,),
        ).fetchone()
        counted = {
            row["hour"]: row["events"]
            for row in connection.execute(
                "SELECT substr(server_ts, 1, 13) AS hour, count(*) AS events"
                " FROM events WHERE server_ts>=? GROUP BY hour",
                (timestamp(first_hour),),
            )
        }
        versions = [
            {"version": row["version"], "events": row["events"]}
            for row in connection.execute(
                "SELECT coalesce(json_extract(payload, '$.app_version'), 'unknown') AS version,"
                " count(*) AS events FROM events WHERE server_ts>=?"
                " GROUP BY version ORDER BY events DESC LIMIT ?",
                (versions_from, VERSIONS_SHOWN),
            )
        ]
    hourly = []
    for step in range(HOURS):
        key = _hour_key(first_hour + timedelta(hours=step))
        hourly.append({"hour": key, "events": counted.get(key, 0)})
    stored = sum(
        file.stat().st_size for file in (path, path.with_name(path.name + "-wal")) if file.exists()
    )
    return {
        "now": timestamp(now),
        "last_event_at": last,
        "recent_minutes": RECENT_MINUTES,
        "recent_events": recent["events"],
        "per_minute": round(recent["events"] / RECENT_MINUTES, 1),
        "players_now": recent["players"],
        "events_24h": sum(item["events"] for item in hourly),
        "hourly": hourly,
        "versions": versions,
        "stored_bytes": stored,
    }
