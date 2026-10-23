"""Deterministic synthetic games, for the parity tests and scripts/benchmark.py.

A generated game looks like a small mobile puzzle game: players install over the days, play a few
sessions, work through numbered levels (starting, failing, restarting, finishing, sometimes giving
up), use power-ups, watch ads that send the app to the background, and sometimes link an account
(their user_id then replaces the device ID as their player key). Newer versions send their level
events as one mapped LEVEL_EVENT instead of the standard names, so the dictionary matters. A few
players are on development or editor builds, some sessions only report their environment in
session_start, and some events share a timestamp.

Everything comes from one seeded random generator: the same arguments give the same events.
"""

import random
from datetime import UTC, datetime, timedelta
from uuid import UUID

ANCHOR = datetime(2026, 9, 30, tzinfo=UTC)  # generated activity ends just before this moment
COUNTRIES = ["US", "US", "US", "IN", "IN", "DE", "BR", "GB", "JP", "FR", None]
MAPPED_FROM = 6  # versions 1.6 and later send LEVEL_EVENT instead of level_start/...

# The dictionary every generated game uses: LEVEL_EVENT is mapped to the shared level moments,
# a debug event is hidden, and the menu has a label.
DICTIONARY = {
    "LEVEL_EVENT": {
        "description": "One event for every level moment",
        "params": {"LEVEL_NUMBER": "Level", "ACTION": "Begin, Win, Lose or Retry"},
        "canonical": [
            {
                "action": f"level_{verb}",
                "param": "ACTION",
                "op": "eq",
                "value": value,
                "number_param": "LEVEL_NUMBER",
            }
            for verb, value in (
                ("started", "Begin"),
                ("completed", "Win"),
                ("failed", "Lose"),
                ("restarted", "Retry"),
            )
        ],
    },
    "debug_ping": {"description": "SDK self-test", "hidden": True},
    "MM_ANALYSIS": {"description": "Main menu", "labels": "STATUS => Menu {STATUS}"},
}


def _uuid(rng):
    return str(UUID(int=rng.getrandbits(128), version=4))


def _stamp(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def _version(day, days):
    """Older installs start on older versions; the minor number counts up through 1.11."""
    minor = min(11, int(12 * day / max(1, days)))
    return f"1.{minor}", str(100 + minor)


class _Player:
    def __init__(self, rng, index, days):
        self.rng = rng
        self.device = f"d{index:07d}"
        self.user = f"u{index:07d}" if rng.random() < 0.3 else None
        self.install = rng.uniform(0, days - 0.01)
        self.days = days
        roll = rng.random()
        self.platform = "editor" if roll < 0.02 else "ios" if roll < 0.4 else "android"
        roll = rng.random()
        self.environment = (
            "editor"
            if self.platform == "editor"
            else "development"
            if roll < 0.06
            else "test"
            if roll < 0.08
            else "production"
        )
        self.country = rng.choice(COUNTRIES)
        self.skill = rng.uniform(0.35, 0.95)
        self.level = 1
        self.sessions = 0

    def sessions_planned(self):
        rng = self.rng
        count = 1
        while rng.random() < 0.72 and count < 40:
            count += 1
        day = self.install
        for _ in range(count):
            if day >= self.days:
                return
            yield day
            day += rng.choice((0.02, 0.1, 0.4, 1, 1, 2, 3, 6))

    def session(self, day):
        """(context, events) of one session that starts `day` days into the generated period."""
        rng = self.rng
        self.sessions += 1
        moment = ANCHOR - timedelta(days=self.days) + timedelta(days=day)
        session_id = _uuid(rng)
        version, build = _version(day, self.days)
        context = {
            "device_id": self.device,
            "session_id": session_id,
            "app_version": version,
            "build": build,
            "platform": self.platform,
        }
        if self.user and self.sessions > 1:
            context["user_id"] = self.user
        # Most sessions send the environment with every batch; the rest only in session_start.
        quiet = rng.random() < 0.3
        if not quiet:
            context["environment"] = self.environment
        events = []

        def emit(name, params=None, seconds=None):
            nonlocal moment
            if seconds is None:
                seconds = rng.choice((0, 1, 2, 3, 5, 8, 13, 21))
            moment += timedelta(seconds=seconds, microseconds=rng.randrange(1000) * 1000)
            if rng.random() < 0.03 and events:  # same timestamp as the event before
                stamp = events[-1]["client_ts"]
            else:
                stamp = _stamp(moment)
            events.append(
                {"event_id": _uuid(rng), "name": name, "params": params or {}, "client_ts": stamp}
            )

        start_params = {"locale": rng.choice(("en", "de", "hi"))}
        if quiet:
            start_params["environment"] = self.environment
        emit("session_start", start_params, 0)
        if self.sessions == 1:
            emit("first_open")
        mapped = int(version.split(".")[1]) >= MAPPED_FROM
        playing = rng.random() < 0.97
        while playing:
            emit("MM_ANALYSIS", {"STATUS": "OPENED"})
            if rng.random() < 0.05:
                emit("debug_ping", {"seq_check": 1})
            level = self.level
            tries = 0
            while True:
                tries += 1
                if mapped:
                    emit(
                        "LEVEL_EVENT",
                        {"LEVEL_NUMBER": level, "ACTION": "Begin" if tries == 1 else "Retry"},
                    )
                else:
                    emit("level_start" if tries == 1 else "level_restart", {"level": level})
                if rng.random() < 0.3:
                    emit(
                        "POWERUP_USED",
                        {"POWERUP_TYPE": rng.choice(("Bomb", "Hammer")), "LEVEL_NUMBER": level},
                    )
                won = rng.random() < self.skill - level * 0.01
                outcome = ("Win" if won else "Lose") if mapped else None
                if mapped:
                    emit(
                        "LEVEL_EVENT",
                        {"LEVEL_NUMBER": level, "ACTION": outcome},
                        rng.randint(20, 300),
                    )
                else:
                    emit(
                        "level_complete" if won else "level_fail",
                        {"level": level},
                        rng.randint(20, 300),
                    )
                if won:
                    self.level += 1
                    break
                if rng.random() < 0.35 or tries >= 4:
                    break
            if rng.random() < 0.25:
                emit("ad_show", {"placement": "interstitial", "level": level})
                if rng.random() < 0.5:
                    emit("APP_ANALYSIS", {"STATE": "Background", "CAUSE": "Ad"})
                    emit("APP_ANALYSIS", {"STATE": "Foreground", "CAUSE": "Ad"}, rng.randint(5, 40))
            playing = rng.random() < 0.8 - 0.02 * level
        if rng.random() < 0.85:  # some sessions end without the SDK seeing it
            began = datetime.fromisoformat(events[0]["client_ts"])
            ended = datetime.fromisoformat(events[-1]["client_ts"])
            emit("session_end", {"duration_seconds": round((ended - began).total_seconds(), 1)})
        return context, events


def generate(target_events, seed=1, days=120, batch_size=500):
    """Yield (country, batch) pairs in the SDK's request form, until about target_events."""
    rng = random.Random(seed)
    pending = {}
    produced = 0
    index = 0
    while produced < target_events:
        player = _Player(rng, index, days)
        index += 1
        for day in player.sessions_planned():
            context, events = player.session(day)
            produced += len(events)
            queue = pending.setdefault(player.country, [])
            queue.append((context, events))
            if sum(len(item[1]) for item in queue) >= batch_size:
                yield from _flush(player.country, queue, batch_size)
                pending[player.country] = []
            if produced >= target_events:
                break
    for country, queue in pending.items():
        yield from _flush(country, queue, batch_size)


def _flush(country, queue, batch_size):
    """Sessions as batches: each event carries its own context, as an SDK resending a queue does."""
    events = [{**context, **event} for context, items in queue for event in items]
    for offset in range(0, len(events), batch_size):
        yield country, {"events": events[offset : offset + batch_size]}
