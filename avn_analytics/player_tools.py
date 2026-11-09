"""One player: who they are (profile) and exactly what they sent (raw events).

The profile joins what the other tools split up: how the player was acquired (the attribution
service's `ATTRIBUTION_ANALYSIS` Install), their device (`DEVICE_ANALYSIS` snapshot and the
`session_start` model and OS), the latest `PLAYER_ANALYSIS` snapshot, what their ads earned and
how their sessions ended. Attribution, device and the snapshot look at everything the player ever
sent; ad money and exits count only the date range, since they are sums over time.

The raw events are the player's events in the order they happened (game time, then the SDK's
`seq` counter when two share a time), optionally narrowed to one event name, one ad (AD_ID) or
one level attempt (ATTEMPT_ID), a page at a time.
"""

import json

from . import insights, player_summary

ATTRIBUTION = "ATTRIBUTION_ANALYSIS"
DEVICE = "DEVICE_ANALYSIS"
PLAYER = "PLAYER_ANALYSIS"
AD_EVENT = "AD_ANALYSIS"
LEVEL_EVENT = "LEVEL_ANALYSIS"
APP_EVENT = "APP_ANALYSIS"
SESSION_START = "session_start"
PROFILE_EVENTS = (ATTRIBUTION, DEVICE, PLAYER, AD_EVENT, LEVEL_EVENT, APP_EVENT, SESSION_START)
MAX_PROFILE_ROWS = 300_000
ATTRIBUTION_FIELDS = {
    "media_source": "MEDIA_SOURCE",
    "campaign": "CAMPAIGN",
    "channel": "CHANNEL",
    "creative": "AD",
    "site": "SITE_ID",
    "attribution_status": "AF_STATUS",
}
DEVICE_FIELDS = {
    "tier": "TIER",
    "ram_mb": "RAM_MB",
    "cpu_cores": "CPU_CORES",
    "gpu_mb": "GPU_MB",
    "quality_level": "QUALITY_LEVEL",
}
MAX_EVENTS = 100
RESULT_CHARACTERS = 9500  # about what one answer may hold; events past it go to the next page


def _money(value):
    return round(value or 0.0, 6)


def _absent(note):
    return {"available": False, "note": note}


def _params(text):
    try:
        found = json.loads(text) if text else {}
    except ValueError:
        return {}
    return found if isinstance(found, dict) else {}


def _trim_summary(summary):
    """The player summary without its long series (the profile has the snapshot instead)."""
    summary = json.loads(json.dumps(summary))
    summary["sessions"].pop("per_day", None)
    summary["levels"].pop("pace", None)
    economy = summary["economy"]
    for key in ("balance_history", "balances", "inventory", "flags", "save_level"):
        economy.pop(key, None)
    return summary


def _first(rows, state=None):
    for row in rows:
        params = _params(row["params"])
        if state is None or params.get("STATE") == state:
            return row, params
    return None, {}


def profile(storage, game_id, player, start, end):
    """Who this player is, in one answer."""
    player = str(player or "")
    if not player:
        raise ValueError("Give the player id.")
    storage.get_game(game_id)
    marks = ",".join("?" * len(PROFILE_EVENTS))
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        if not connection.execute(
            f"SELECT 1 FROM {source.table} WHERE {source.player}=? LIMIT 1", (player,)
        ).fetchone():
            return _absent(
                "No events for this player id. Ids come from find_players or list_journey_players."
            )
        connection.execute("DROP TABLE IF EXISTS temp.pe")
        connection.execute(
            f"""CREATE TEMP TABLE pe AS
                SELECT name, client_ts, {source.params} AS params
                FROM {source.table} WHERE {source.player}=? AND name IN ({marks})
                ORDER BY client_ts, event_id LIMIT {MAX_PROFILE_ROWS}""",
            (player, *PROFILE_EVENTS),
        )

        def rows(name, newest=False):
            order = "DESC" if newest else "ASC"
            return connection.execute(
                "SELECT client_ts, params FROM pe WHERE name=? "
                f"ORDER BY client_ts {order} LIMIT 200",
                [name],
            ).fetchall()

        installs = rows(ATTRIBUTION)
        device_snapshots = rows(DEVICE, newest=True)
        sessions = rows(SESSION_START, newest=True)
        snapshots = rows(PLAYER, newest=True)
        in_range = "name=? AND client_ts>=? AND client_ts<?"
        paid = connection.execute(
            f"""SELECT coalesce(json_extract(params, '$.FORMAT'), 'Unknown') AS format,
                       count(*) AS impressions,
                       sum(CAST(json_extract(params, '$.REVENUE') AS REAL)) AS revenue
                FROM pe WHERE {in_range} AND json_extract(params, '$.STATE')='Revenue'
                GROUP BY format ORDER BY revenue DESC""",
            [AD_EVENT, start, end],
        ).fetchall()
        banner = connection.execute(
            f"""SELECT sum(CAST(json_extract(params, '$.BANNER_IMPRESSIONS') AS INTEGER))
                           AS impressions,
                       sum(CAST(json_extract(params, '$.BANNER_REVENUE') AS REAL)) AS revenue
                FROM pe WHERE {in_range}""",
            [LEVEL_EVENT, start, end],
        ).fetchone()
        killed = connection.execute(
            f"""SELECT count(*) FROM pe WHERE {in_range}
                AND json_extract(params, '$.STATE')='Left'
                AND json_extract(params, '$.REASON')='Killed'""",
            [LEVEL_EVENT, start, end],
        ).fetchone()[0]
        launches = connection.execute(
            f"""SELECT coalesce(json_extract(params, '$.PREV_EXIT_REASON'), 'Not reported')
                           AS reason, count(*) AS launches
                FROM pe WHERE {in_range} AND json_extract(params, '$.STATE')='Launch'
                GROUP BY reason ORDER BY launches DESC""",
            [APP_EVENT, start, end],
        ).fetchall()
    base = player_summary.player_summary(storage, game_id, player)

    install_row, install = _first(installs, "Install")
    if install_row:
        attribution = {
            "available": True,
            **{key: install.get(param) for key, param in ATTRIBUTION_FIELDS.items()},
            "recorded_at": install_row["client_ts"],
        }
    else:
        attribution = _absent(
            "No attribution record for this player (the game may not send ATTRIBUTION_ANALYSIS, "
            "or the service never answered). That is not the same as organic."
        )

    snapshot_row, snapshot = _first(device_snapshots, "Snapshot")
    session = next(
        (
            found
            for found in map(_params, (row["params"] for row in sessions))
            if found.get("device_model")
        ),
        {},
    )
    device = {
        **{key: snapshot.get(param) for key, param in DEVICE_FIELDS.items()},
        "model": session.get("device_model"),
        "os_version": session.get("os_version"),
        "snapshot_at": snapshot_row["client_ts"] if snapshot_row else None,
    }
    if not snapshot_row and not session:
        device = _absent("No device snapshot or session_start with a device model for this player.")

    saved_row, saved = _first(snapshots, "Snapshot")
    latest = (
        {
            "available": True,
            "at": saved_row["client_ts"],
            "values": {key: value for key, value in saved.items() if key != "STATE"},
        }
        if saved_row
        else _absent("No PLAYER_ANALYSIS snapshot for this player.")
    )

    full_screen = sum(row["revenue"] or 0.0 for row in paid)
    banner_money = banner["revenue"] or 0.0
    impressions = {row["format"]: row["impressions"] for row in paid}
    if banner["impressions"]:
        impressions["Banner"] = banner["impressions"]
    if paid or banner["impressions"] or banner["revenue"]:
        revenue = {
            "available": True,
            "currency": "USD (assumed)",
            "full_screen_revenue": _money(full_screen),
            "banner_revenue": _money(banner_money),
            "total": _money(full_screen + banner_money),
            "impressions_by_format": impressions,
        }
    else:
        revenue = _absent("No ad revenue events for this player in this range.")

    return {
        "available": True,
        "player": player,
        "range": {"start": start[:10], "end_before": end[:10]},
        "means": (
            "attribution, device and latest_snapshot look at everything the player ever sent; "
            "ad_revenue and exits count only the range. Attribution missing means the game "
            "never recorded one, not that the player is organic."
        ),
        "first_seen": base["first_seen"],
        "last_seen": base["last_seen"],
        "attribution": attribution,
        "device": device,
        "latest_snapshot": latest,
        "ad_revenue": revenue,
        "exits": {
            "app_launches_by_previous_exit": {row["reason"]: row["launches"] for row in launches},
            "levels_ended_by_kill": killed,
        },
        "summary": _trim_summary(base),
    }


def raw_events(
    storage,
    game_id,
    player,
    start,
    end,
    event=None,
    ad_id=None,
    attempt_id=None,
    offset=0,
    limit=50,
):
    """A page of the player's events in the order they happened."""
    player = str(player or "")
    if not player:
        raise ValueError("Give the player id.")
    offset = max(0, int(offset or 0))
    limit = max(1, min(int(limit or 50), MAX_EVENTS))
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        conditions = [f"{source.player}=?", "client_ts>=?", "client_ts<?"]
        args = [player, start, end]
        if event:
            conditions.append("name=?")
            args.append(str(event))
        for key, value in (("AD_ID", ad_id), ("ATTEMPT_ID", attempt_id)):
            if value:
                conditions.append(f"CAST({source.param(key)} AS TEXT)=?")
                args.append(str(value))
        condition = " AND ".join(conditions)
        total = connection.execute(
            f"SELECT count(*) FROM {source.table} WHERE {condition}", args
        ).fetchone()[0]
        seq = source.param("seq")
        found = connection.execute(
            f"""SELECT client_ts, name, {source.params} AS params FROM {source.table}
                WHERE {condition}
                ORDER BY client_ts, CASE WHEN typeof({seq}) IN ('integer', 'real') THEN {seq} END,
                         event_id
                LIMIT ? OFFSET ?""",
            [*args, limit, offset],
        ).fetchall()
    events, used = [], 0
    for row in found:
        params = {
            key: value
            for key, value in _params(row["params"]).items()
            if key not in insights.HIDDEN_PARAMS
        }
        item = {"time": row["client_ts"], "name": row["name"], "params": params}
        used += len(json.dumps(item, ensure_ascii=False, default=str))
        if events and used > RESULT_CHARACTERS:
            break
        events.append(item)
    reached = offset + len(events)
    return {
        "available": bool(total),
        "player": player,
        "total_matching": total,
        "offset": offset,
        "returned": len(events),
        "next_offset": reached if reached < total else None,
        "means": (
            "Events in the order they happened (game time, then the SDK's seq counter). "
            "Pass next_offset as offset for the next page; ad_id or attempt_id follow one ad or "
            "one level attempt."
        ),
        "events": events,
        **(
            {}
            if total
            else {
                "note": "No events match for this player in this range. Check the player id, the "
                "dates and the event name."
            }
        ),
    }
