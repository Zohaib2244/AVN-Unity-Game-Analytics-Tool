"""Campaign cost: what each campaign spent per day, pulled from a cost endpoint and kept here.

The endpoint (`AVN_COST_API_URL`) answers `GET ?appIds=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD` with
`{"data": [{"date", "appId", "network", "campaign", "cost", "installs"}], "failedApps": []}`:
one row per day, media source and campaign name, as the attribution service counted them. It is
asked at most every REFRESH_SECONDS per app, when a page needs the numbers; nothing runs on a
timer. Rows are kept in the registry so a page still has costs when the endpoint is down.

A game is matched by its app ID: the bundle ID on Android, and a store ID such as `id123456789`
on iOS, which the owner types in once (`game_cost_settings.app_id`). The same table keeps the
game's return goals ("by day 7, ad revenue should cover 75% of the cost"), with a
campaign's own goals replacing the game's for that campaign.

An endpoint that refuses the app (403) means cost is not available for that game: callers get
`state: "not_allowed"` and show that, never zeros.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, date, datetime, timedelta

TABLES = """
CREATE TABLE IF NOT EXISTS campaign_costs (
    app_id TEXT NOT NULL, day TEXT NOT NULL, network TEXT NOT NULL, campaign TEXT NOT NULL,
    cost REAL NOT NULL, installs INTEGER NOT NULL,
    PRIMARY KEY (app_id, day, network, campaign)
);
CREATE TABLE IF NOT EXISTS campaign_cost_fetches (
    app_id TEXT PRIMARY KEY, first_day TEXT, last_day TEXT, fetched_at TEXT NOT NULL,
    state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS game_cost_settings (
    game_id TEXT PRIMARY KEY, app_id TEXT NOT NULL DEFAULT '', goals TEXT NOT NULL DEFAULT '{}'
);
"""
REFRESH_SECONDS = 3 * 3600  # how long fetched costs are trusted before asking again
RETRY_SECONDS = 600  # after a failure
REFUSED_SECONDS = 24 * 3600  # after the endpoint said this app is not allowed
MAX_SPAN_DAYS = 93  # the endpoint's limit for one request
TIMEOUT_SECONDS = 20
MAX_GOALS = 6
MAX_CAMPAIGN_GOALS = 50
MAX_GOAL_DAY = 90
ORGANIC = "organic"


class Refused(Exception):
    """The endpoint does not serve this app."""


def _registry(storage):
    return storage.connect(storage.root / "registry.sqlite3")


def _install(connection):
    connection.executescript(TABLES)


def fetch(url, app_id, first_day, last_day):
    """One request to the cost endpoint. Returns its rows; raises Refused on 403."""
    query = urllib.parse.urlencode({"appIds": app_id, "from": first_day, "to": last_day})
    request = urllib.request.Request(
        f"{url}{'&' if '?' in url else '?'}{query}", headers={"Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310
            body = json.loads(response.read(8_000_000))
    except urllib.error.HTTPError as error:
        if error.code == 403:
            raise Refused(app_id) from error
        raise
    if app_id in (body.get("failedApps") or []):
        raise RuntimeError("The cost endpoint could not read this app.")
    return [row for row in body.get("data") or [] if row.get("appId") == app_id]


def _clean_list(goals):
    if not isinstance(goals, list) or len(goals) > MAX_GOALS:
        raise ValueError(f"Give up to {MAX_GOALS} goals.")
    found = {}
    for goal in goals:
        try:
            day, percent = int(goal["day"]), float(goal["percent"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("A goal is a day and a return percentage.") from None
        if not 0 <= day <= MAX_GOAL_DAY:
            raise ValueError(f"A goal's day is from 0 to {MAX_GOAL_DAY}.")
        if not 0 < percent <= 1000:
            raise ValueError("A goal's return is from 1 to 1000 percent.")
        found[day] = round(percent, 1)
    return [{"day": day, "percent": found[day]} for day in sorted(found)]


def clean_goals(goals):
    """Goals as {"game": [{day, percent}], "campaigns": {name: [{day, percent}]}}, or raise
    ValueError. A campaign's own list replaces the game's for that campaign."""
    if isinstance(goals, list):  # the game's goals alone
        goals = {"game": goals}
    if not isinstance(goals, dict):
        raise ValueError("goals is {game: [...], campaigns: {name: [...]}}.")
    campaigns = goals.get("campaigns") or {}
    if not isinstance(campaigns, dict) or len(campaigns) > MAX_CAMPAIGN_GOALS:
        raise ValueError(f"Set goals for up to {MAX_CAMPAIGN_GOALS} campaigns.")
    return {
        "game": _clean_list(goals.get("game") or []),
        "campaigns": {
            str(name)[:200]: _clean_list(items)
            for name, items in campaigns.items()
            if str(name).strip() and items
        },
    }


def goals_for(goals, campaign):
    """The goals that apply to one campaign: its own, else the game's."""
    return goals.get("campaigns", {}).get(campaign) or goals.get("game", [])


def default_app_id(game):
    """Android games are known to the attribution service by their bundle ID; iOS ones are not."""
    return game["bundle_id"] if game["platform"] == "android" else ""


def settings(storage, game):
    """The game's app ID for costs (typed in, else the default) and its return goals."""
    with _registry(storage) as connection:
        _install(connection)
        row = connection.execute(
            "SELECT app_id, goals FROM game_cost_settings WHERE game_id=?", (game["id"],)
        ).fetchone()
    typed = row["app_id"] if row else ""
    return {
        "app_id": typed or default_app_id(game),
        "typed_app_id": typed,
        "default_app_id": default_app_id(game),
        "goals": clean_goals(json.loads(row["goals"])) if row else clean_goals({}),
    }


def save_settings(storage, game, app_id=None, goals=None):
    current = settings(storage, game)
    typed = current["typed_app_id"] if app_id is None else str(app_id).strip()[:200]
    kept = current["goals"] if goals is None else clean_goals(goals)
    with _registry(storage) as connection:
        _install(connection)
        connection.execute(
            """INSERT INTO game_cost_settings (game_id, app_id, goals) VALUES (?, ?, ?)
               ON CONFLICT(game_id) DO UPDATE SET app_id=excluded.app_id, goals=excluded.goals""",
            (game["id"], typed, json.dumps(kept)),
        )
    return settings(storage, game)


def _age(stamp, now):
    return (now - datetime.fromisoformat(stamp)).total_seconds()


def ensure(storage, game, first_day, last_day, now=None):
    """Make sure costs for the game's app cover the days, asking the endpoint when they are old.

    Returns what a page should say: state is one of off (no endpoint configured), no_app_id,
    not_allowed, ok, or failed (the last request failed; older rows, if any, are still served).
    """
    url = storage.settings.cost_api_url
    if not url:
        return {"state": "off"}
    app_id = settings(storage, game)["app_id"]
    if not app_id:
        return {"state": "no_app_id"}
    now = now or datetime.now(UTC)
    today = now.date().isoformat()
    first_day, last_day = str(first_day), min(str(last_day), today)
    with _registry(storage) as connection:
        _install(connection)
        known = connection.execute(
            "SELECT * FROM campaign_cost_fetches WHERE app_id=?", (app_id,)
        ).fetchone()
    if known:
        age = _age(known["fetched_at"], now)
        covered = (
            known["first_day"] and known["first_day"] <= first_day and known["last_day"] >= last_day
        )
        if known["state"] == "not_allowed" and age < REFUSED_SECONDS:
            return {"state": "not_allowed", "app_id": app_id}
        if known["state"] == "failed" and age < RETRY_SECONDS:
            return {"state": "failed", "app_id": app_id, "detail": known["detail"]}
        if known["state"] == "ok" and covered and age < REFRESH_SECONDS:
            return {"state": "ok", "app_id": app_id, "fetched_at": known["fetched_at"]}
        if known["first_day"]:  # keep what is already covered in one piece
            first_day = min(first_day, known["first_day"])
            last_day = max(last_day, min(known["last_day"], today))
    state, detail, rows = "ok", "", []
    try:
        cursor = date.fromisoformat(first_day)
        end = date.fromisoformat(last_day)
        while cursor <= end:
            until = min(end, cursor + timedelta(days=MAX_SPAN_DAYS - 1))
            rows.extend(fetch(url, app_id, cursor.isoformat(), until.isoformat()))
            cursor = until + timedelta(days=1)
    except Refused:
        state = "not_allowed"
    except Exception as error:  # the endpoint is someone else's: any failure keeps the old rows
        state, detail = "failed", str(error)[:300]
    with _registry(storage) as connection:
        _install(connection)
        connection.execute("BEGIN IMMEDIATE")
        if state == "ok":
            connection.execute(
                "DELETE FROM campaign_costs WHERE app_id=? AND day BETWEEN ? AND ?",
                (app_id, first_day, last_day),
            )
            connection.executemany(
                """INSERT OR REPLACE INTO campaign_costs
                   (app_id, day, network, campaign, cost, installs) VALUES (?, ?, ?, ?, ?, ?)""",
                [
                    (
                        app_id,
                        str(row["date"])[:10],
                        str(row.get("network") or ""),
                        str(row.get("campaign") or ""),
                        float(row.get("cost") or 0),
                        int(row.get("installs") or 0),
                    )
                    for row in rows
                ],
            )
        connection.execute(
            """INSERT INTO campaign_cost_fetches
               (app_id, first_day, last_day, fetched_at, state, detail) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(app_id) DO UPDATE SET
                 first_day=CASE WHEN excluded.state='ok' THEN excluded.first_day ELSE first_day END,
                 last_day=CASE WHEN excluded.state='ok' THEN excluded.last_day ELSE last_day END,
                 fetched_at=excluded.fetched_at, state=excluded.state, detail=excluded.detail""",
            (app_id, first_day, last_day, now.isoformat(), state, detail),
        )
        connection.execute("COMMIT")
    result = {"state": state, "app_id": app_id}
    if state == "ok":
        result["fetched_at"] = now.isoformat()
    if detail:
        result["detail"] = detail
    return result


def rows(storage, game, first_day, last_day):
    """The kept cost rows of the game's app for these days (paid sources only)."""
    app_id = settings(storage, game)["app_id"]
    if not app_id:
        return []
    with _registry(storage) as connection:
        _install(connection)
        return [
            dict(row)
            for row in connection.execute(
                """SELECT day, network, campaign, cost, installs FROM campaign_costs
                   WHERE app_id=? AND day BETWEEN ? AND ? AND lower(network) != ?
                   ORDER BY day""",
                (app_id, str(first_day), str(last_day), ORGANIC),
            )
        ]
