"""The sidebar's ingest meter: what is arriving now, counted from when events were received."""

from datetime import UTC, datetime, timedelta

from test_backend import backend as backend
from test_backend import event, register, send

from avn_analytics import ingest_meter


def meter(admin, game):
    response = admin.get(f"/v1/games/{game['id']}/health/live")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_game_with_no_events_has_nothing_arriving(backend):
    admin, _, _ = backend
    data = meter(admin, register(admin))
    assert data["last_event_at"] is None
    assert (data["per_minute"], data["players_now"], data["events_24h"]) == (0.0, 0, 0)
    assert len(data["hourly"]) == 24 and sum(item["events"] for item in data["hourly"]) == 0
    assert data["versions"] == []


def test_events_just_received_count_now_and_in_the_last_hour(backend):
    admin, ingest, _ = backend
    game = register(admin)
    now = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    events = [
        event(
            device_id=f"player-{index % 3}",
            app_version="2.0" if index < 8 else "1.9",
            client_ts=now,
        )
        for index in range(10)
    ]
    assert send(ingest, game, events).status_code == 200
    data = meter(admin, game)
    assert data["recent_events"] == 10 and data["per_minute"] == 2.0
    assert data["players_now"] == 3
    assert (
        data["events_24h"] == 10
        and data["hourly"][-1]["events"] + data["hourly"][-2]["events"] == 10
    )
    assert data["versions"] == [
        {"version": "2.0", "events": 8},
        {"version": "1.9", "events": 2},
    ]
    assert data["last_event_at"] and data["stored_bytes"] > 0


def test_older_events_are_not_now_but_still_the_last_event(backend):
    admin, ingest, settings = backend
    game = register(admin)
    assert send(ingest, game, [event(device_id="p1")]).status_code == 200
    from avn_analytics.storage import Storage

    later = datetime.now(UTC) + timedelta(hours=3)
    data = ingest_meter.ingest_meter(Storage(settings), game["id"], now=later)
    assert data["last_event_at"] is not None
    assert data["recent_events"] == 0 and data["players_now"] == 0
    assert data["events_24h"] == 1  # still inside the last 24 hours
