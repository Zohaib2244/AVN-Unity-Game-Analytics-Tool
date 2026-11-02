#!/usr/bin/env python3
"""Can NutBot's tools answer the questions people really ask, and what does it cost?

Builds a synthetic game in a temporary folder (never real data), runs each question through the
tool calls an agent would make, and checks the numbers against a count taken straight from the
raw events, independently of the tools. No agent runs, so this spends no allowance: it measures
what the tools can fetch, not how well the agent writes it up.

    scripts/nutbot_questions.py                    # the table
    scripts/nutbot_questions.py --json before.json # keep the numbers to compare a later run

Verdicts: exact (every checked number matches), wrong (a number differs from the raw events),
partial (part of the question has no tool).
"""

import argparse
import json
import sys
import tempfile
import time
from collections import Counter, defaultdict
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from synthetic import ANCHOR, DICTIONARY, generate  # noqa: E402

from avn_analytics import nutbot as nutbot_module  # noqa: E402
from avn_analytics.auth import Accounts, Principal  # noqa: E402
from avn_analytics.config import Settings  # noqa: E402
from avn_analytics.models import Batch, EventDefinition, GameCreate  # noqa: E402
from avn_analytics.nutbot import MAX_TOOL_RESULT, NutBot, Run  # noqa: E402
from avn_analytics.storage import Storage  # noqa: E402

DAYS = 60
LEVEL = 5  # the "level x" of the questions
SOURCE = "\n".join(path.read_text() for path in (ROOT / "avn_analytics").glob("nutbot*.py"))
# What each dashboard read adds. A read NutBot's code never calls is a gap in what it can fetch.
READS = {
    "level_features": "ads, fail reasons and power-ups per level, and what players did next",
    "activity(": "when an event happened, day by day",
    "retention(": "retention (D1, D7, ...)",
}
WHALE = "whale-player"


def missing(*reads):
    return [READS[read] for read in reads if read not in SOURCE]


def player_of(event):
    return event.get("user_id") or event.get("device_id")


def build(directory, target):
    """A synthetic game, plus one heavy player with more events than one read returns."""
    settings = Settings(data_dir=directory, admin_token="b" * 40)
    storage = Storage(settings)
    storage.initialize()
    accounts = Accounts(storage, settings)
    accounts.initialize()
    game_id = storage.register_game(
        GameCreate(name="Questions", bundle_id="com.avn.questions", platform="android")
    )["id"]
    with storage.connect(storage.game_path(game_id)) as connection:
        for name, definition in DICTIONARY.items():
            storage.write_definition(connection, name, EventDefinition.model_validate(definition))
    for country, batch in generate(target, seed=1, days=DAYS):
        storage.ingest(game_id, Batch.model_validate(batch), country=country)
    moment = ANCHOR - timedelta(days=DAYS - 1)
    for start in range(0, 7000, 500):
        events = [
            {
                "event_id": f"00000000-0000-4000-8000-{index:012d}",
                "name": "ad_show" if index % 4 == 0 else "MM_ANALYSIS",
                "params": {"placement": "interstitial"} if index % 4 == 0 else {"STATUS": "OPENED"},
                "client_ts": (moment + timedelta(minutes=index)).strftime(
                    "%Y-%m-%dT%H:%M:%S.000000Z"
                ),
            }
            for index in range(start, start + 500)
        ]
        batch = {
            "context": {
                "device_id": WHALE,
                "session_id": f"whale-{start}",
                "app_version": "1.0",
                "build": "100",
                "platform": "android",
                "environment": "production",
            },
            "events": events,
        }
        storage.ingest(game_id, Batch.model_validate(batch), country="US")
    return storage, accounts, settings, game_id


def raw_events(storage, game_id):
    """Every stored event, read directly: the counts the tools are checked against."""
    with storage.connect(storage.game_path(game_id)) as connection:
        rows = connection.execute("SELECT name, client_ts, payload FROM events").fetchall()
    events = []
    for name, stamp, payload in rows:
        event = json.loads(payload)
        event["name"], event["client_ts"] = name, stamp
        events.append(event)
    return events


def level_of(event):
    """(level, what happened) of a level event, or None."""
    name, params = event["name"], event.get("params") or {}
    if name == "LEVEL_EVENT":
        return params.get("LEVEL_NUMBER"), params.get("ACTION")
    plain = {
        "level_start": "Begin",
        "level_restart": "Retry",
        "level_complete": "Win",
        "level_fail": "Lose",
    }
    if name in plain:
        return params.get("level"), plain[name]
    return None


def _levels(group):
    return [found for event in group if (found := level_of(event))]


class Ask:
    """Tool calls for one question, counted the way an answer pays for them."""

    def __init__(self, bot, run):
        self.bot, self.run = bot, run
        self.calls, self.chars, self.seconds, self.cut = 0, 0, 0.0, 0

    def __call__(self, name, **arguments):
        began = time.perf_counter()
        text, error = self.bot._call(self.run, name, arguments)
        self.seconds += time.perf_counter() - began
        self.calls += 1
        self.chars += len(text)
        if len(text) > MAX_TOOL_RESULT:
            self.cut += 1
            return None
        return None if error else json.loads(text)


def table_rows(table):
    return [dict(zip(table["columns"], row, strict=True)) for row in table["rows"]]


def check(wanted, got):
    return "ok" if wanted == got else f"tool says {got}, raw events say {wanted}"


def verdict(checks, gaps):
    problems = [value for value in checks.values() if value != "ok"]
    if problems:
        return "wrong"
    return "partial" if gaps else "exact"


def questions(ask, facts):
    """Yields (number, question, checks, gaps), each after running its tool calls."""
    events, by_player = facts["events"], facts["by_player"]
    level_events = [(event, *found) for event in events if (found := level_of(event))]

    def starters(level):
        return {
            player_of(event)
            for event, number, action in level_events
            if number == level and action == "Begin"
        }

    detail = ask("get_level_detail", level=LEVEL)
    ask("get_level_features", from_level=LEVEL, to_level=LEVEL)
    row = next(item for item in detail["rows"] if item["level"] == LEVEL)
    fails = sum(1 for _, number, action in level_events if number == LEVEL and action == "Lose")
    yield (
        1,
        "failure reasons on level x",
        {"fails": check(fails, row["fails"])},
        missing("level_features"),
    )

    rows = table_rows(ask("get_level_progress", from_level=1, to_level=10))
    yield (
        2,
        "analysis of levels x to y",
        {
            "started": check(
                [len(starters(n)) for n in range(1, 11)], [item["started"] for item in rows]
            )
        },
        [],
    )

    ads = Counter(player_of(e) for e in events if e["name"] == "ad_show")
    typical = next(player for player, _ in ads.most_common() if player != WHALE)
    seen = ask(
        "get_player_events",
        player=typical,
        event="ad_show",
        param_filters={"placement": "interstitial"},
    )
    heavy = ask("get_player_events", player=WHALE, event="ad_show")
    yield (
        3,
        "how many {ad type} ads has this player seen",
        {
            "typical player": check(ads[typical], seen["events"][0]["times"]),
            "heavy player": check(ads[WHALE], heavy["events"][0]["times"]),
        },
        [],
    )

    passed = defaultdict(set)
    for event, number, action in level_events:
        if action == "Win":
            passed[player_of(event)].add(number)
    leaver = max(passed, key=lambda player: (len(by_player[player]), player))
    levels = ask("get_player_levels", player=leaver)
    ask("get_player_story", player=leaver)
    yield (
        4,
        "why did this player quit",
        {"highest level": check(max(passed[leaver]), levels["summary"]["highest_level_passed"])},
        [],
    )

    uses = Counter(player_of(e) for e in events if e["name"] == "POWERUP_USED")
    user = uses.most_common(1)[0][0]
    used = ask("get_player_events", player=user, event="POWERUP_USED")
    yield (
        5,
        "did this player use this feature",
        {"times": check(uses[user], used["events"][0]["times"])},
        [],
    )

    found = ask("get_event_activity", event="POWERUP_USED")
    by_day = defaultdict(set)
    for event in events:
        if event["name"] == "POWERUP_USED":
            by_day[event["client_ts"][:10]].add(player_of(event))
    busiest = {day: len(players) for day, players in sorted(by_day.items())}
    yield (
        6,
        "how many players used this feature and when",
        {
            "players": check(len(uses), found["players"]),
            "players per day": check(busiest, {day: count for day, _, count in found["days"]}),
        },
        missing("activity("),
    )

    def players_where(key, value):
        return len({player_of(event) for event in events if event.get(key) == value})

    compared = ask("compare_segments", dimension="country", limit=3)
    yield (
        7,
        "behaviour per region, compared with other regions",
        {
            "players per region": check(
                {
                    item["value"]: players_where("country", item["value"])
                    for item in compared["segments"]
                },
                {item["value"]: item["players"] for item in compared["segments"]},
            )
        },
        [],
    )

    context = ask("get_context")
    versions = context["published_builds"][:2]
    version_players = {}
    side_by_side = ask("compare_segments", dimension="app_version", values=versions)
    for item in side_by_side["segments"]:
        version_players[item["value"]] = item["players"]
    for version in versions:
        ask("get_level_progress", filters={"app_versions": [version]})
        ask("get_retention", filters={"app_versions": [version]})
    yield (
        8,
        "improvements and changes between versions",
        {
            "players per version": check(
                {version: players_where("app_version", version) for version in versions},
                version_players,
            )
        },
        missing("retention("),
    )

    exits = ask("get_exits")
    full = table_rows(ask("get_level_progress"))
    steady = [item for item in full if not item["low_sample"] and item["drop_percent"] is not None]
    top = sorted(steady, key=lambda item: -item["drop_percent"])[:3]
    page = top[0]["level"]
    for item in top:
        ask("get_level_detail", level=item["level"])
    ask("get_level_features", from_level=top[-1]["level"], to_level=top[-1]["level"])
    yield (
        9,
        "drop reasons",
        {"worst level": check(page, exits["levels"][0]["level"])},
        [],
    )

    table = ask("get_level_progress")
    gaps = missing("level_features")
    if "fail_drop_percent" not in table["columns"]:
        gaps.append("how many players quit after failing")
    worst = sorted(table_rows(table), key=lambda item: -(item["fails"] or 0))[0]
    ask("get_level_features", from_level=worst["level"], to_level=worst["level"])
    quits = sum(
        1
        for player, group in by_player.items()
        if any(number == worst["level"] and action == "Lose" for number, action in _levels(group))
    )
    yield (
        10,
        "analyse failure: should I make it easier",
        {"players who failed it": check(quits, worst["failed"])},
        gaps,
    )

    for version in versions:
        ask("get_level_progress", filters={"app_versions": [version]})
    yield (
        11,
        "what to improve, and what past changes did",
        {},
        ["only knows a change once you say what it was, and only in that chat"],
    )


def main():
    options = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    options.add_argument("--events", type=int, default=150_000)
    options.add_argument("--json", type=Path, help="also write the numbers to this file")
    arguments = options.parse_args()
    with tempfile.TemporaryDirectory(prefix="nutbot-questions-") as folder:
        storage, accounts, settings, game_id = build(Path(folder), arguments.events)
        bot = NutBot(settings, storage, accounts)
        end = (ANCHOR + timedelta(days=1)).date()
        start = end - timedelta(days=DAYS + 1)
        run = Run(
            token="questions",
            principal=Principal(email="owner@example.com", name="", is_admin=True, source="local"),
            game_id=game_id,
            workspace_id=None,
            can_write=False,
            defaults={
                "start": start.isoformat(),
                "end": end.isoformat(),
                "hide_test": False,
                "filters": dict.fromkeys(
                    ("environments", "app_versions", "builds", "countries", "platforms"), []
                ),
            },
        )
        events = raw_events(storage, game_id)
        by_player = defaultdict(list)
        for event in events:
            by_player[player_of(event)].append(event)
        ask = Ask(bot, run)
        results = []
        generator = questions(ask, {"events": events, "by_player": by_player})
        while True:
            ask.calls, ask.chars, ask.seconds, ask.cut = 0, 0, 0.0, 0
            try:
                number, question, checks, gaps = next(generator)
            except StopIteration:
                break
            state = verdict(checks, gaps)
            results.append(
                {
                    "number": number,
                    "question": question,
                    "verdict": state,
                    "calls": ask.calls,
                    "chars": ask.chars,
                    "seconds": round(ask.seconds, 2),
                    "cut_results": ask.cut,
                    "checks": checks,
                    "gaps": gaps,
                }
            )
        tools = json.dumps(nutbot_module.TOOLS)
        summary = {
            "events": len(events),
            "tools": len(nutbot_module.TOOLS),
            "tool_schema_chars": len(tools),
            "system_prompt_chars": len(bot.system_prompt()),
            "questions": results,
        }
    print(
        f"{summary['events']:,} events · {summary['tools']} tools · "
        f"{summary['tool_schema_chars']:,} chars of tool schemas · "
        f"{summary['system_prompt_chars']:,} chars of system prompt\n"
    )
    print(f"{'#':>2}  {'verdict':8} {'calls':>5} {'chars':>7} {'secs':>6} {'cut':>3}  question")
    for item in results:
        print(
            f"{item['number']:>2}  {item['verdict']:8} {item['calls']:>5} {item['chars']:>7,} "
            f"{item['seconds']:>6.2f} {item['cut_results']:>3}  {item['question']}"
        )
        for name, value in item["checks"].items():
            if value != "ok":
                print(f"    {name}: {value}")
        for gap in item["gaps"]:
            print(f"    limit: {gap}")
    if arguments.json:
        arguments.json.write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
