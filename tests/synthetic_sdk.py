"""A deterministic synthetic game shaped like the current Unity SDK sends: many events per level.

tests/synthetic.py is a small, older event set (about 45 events per player). Games on the current
plugin send far more: every ad's lifecycle with its own AD_ID, LEVEL_ANALYSIS rows that each carry
an ATTEMPT_ID, economy and remote-config rows, ad-health snapshots, device details on
session_start, attribution, previous-exit reasons. Each of those parameters is unique per event,
so their size and their effect on scans are what a real game's database looks like. This module
generates that shape for `scripts/benchmark.py generate --shape sdk`; nothing here is real data.
"""

import random
from datetime import timedelta

from synthetic import ANCHOR, _stamp, _uuid

NETWORKS = ("Google AdMob", "AppLovin", "Unity Ads", "Mintegral", "Pangle", "BidMachine")
UNITS = ("5e4b49e1e586929e", "95daf230559dee33", "df75ea891a8e188e")
COUNTRIES = ("US", "IN", "BR", "DE", "GB", "ID", "MX", "TR", "PH", "VN")
MODELS = (
    "samsung SM-A107F",
    "Xiaomi 22095RA98C",
    "vivo vivo Y83",
    "INFINIX Infinix X6528B",
    "General Mobile G314",
    "samsung SM-A145P",
)
OS = (
    "Android OS 12 / API-31 (SP1A.210812.016/V13.0.6.0.0.SLSMIXM)",
    "Android OS 13 / API-33 (TP1A.220624.014/240201V383)",
    "Android OS 14 / API-34 (UP1A.231005.007/A145PXXS8CYB3)",
)
ERRORS = (
    'NetworkError: Unable to resolve host "ms.applvn.com": No address associated with hostname',
    "[com.google.android.gms.ads/3] No fill.",
    "NetworkError: Connection reset",
)
CONFIG = (
    '{"ShowAdBreak":false,"HintUnlockLevel":3,"HammerUnlockLevel":8,"BombUnlockLevel":12,'
    '"FirstPetOpensAlbum":true,"InterstitialCooldown":45,"LevelGate":3}'
)
SOURCES = ("googleadwords_int", "applovin_int", "unityads_int", "organic")


def _version(day, days):
    """Versions roll out over the period, newest last; one build each."""
    minor = min(5, day * 6 // max(1, days))
    return f"1.{minor}.0", str(100 + minor)


class _Player:
    def __init__(self, rng, days):
        self.rng = rng
        self.device = f"{rng.getrandbits(128):032x}"
        self.country = rng.choice(COUNTRIES)
        self.environment = "production" if rng.random() > 0.05 else "development"
        self.model, self.os = rng.choice(MODELS), rng.choice(OS)
        self.skill = rng.uniform(0.6, 0.95)
        self.level = 1
        self.coins = 0
        self.sessions = 0
        # Installs grow over the period, as a game with paid acquisition does.
        self.first_day = int(days * rng.random() ** 0.6)
        self.days = days
        self.source = rng.choice(SOURCES)

    def sessions_planned(self):
        rng, day, planned = self.rng, self.first_day, []
        while day < self.days and len(planned) < 40:
            planned.append(day)
            if rng.random() < 0.45 - 0.01 * len(planned):
                break
            day += rng.choice((0, 0, 1, 1, 2, 3, 7))
        return planned

    def session(self, day):
        rng = self.rng
        self.sessions += 1
        moment = ANCHOR - timedelta(days=self.days - day, hours=rng.randrange(24))
        version, build = _version(day, self.days)
        context = {
            "device_id": self.device,
            "session_id": _uuid(rng),
            "app_version": version,
            "build": build,
            "platform": "android",
            "environment": self.environment,
        }
        events = []
        sequence = [0]

        def emit(name, params, seconds=None):
            nonlocal moment
            moment += timedelta(
                seconds=rng.choice((0, 1, 2, 3, 5)) if seconds is None else seconds,
                microseconds=rng.randrange(1_000_000),
            )
            sequence[0] += 1
            events.append(
                {
                    "event_id": _uuid(rng),
                    "name": name,
                    "params": {**params, "LEVEL_NUMBER": self.level, "seq": sequence[0]},
                    "client_ts": _stamp(moment),
                }
            )

        emit(
            "session_start",
            {
                "device_type": "Handheld",
                "session_timeout_seconds": 1800,
                "environment": self.environment,
                "screen_width": 1080,
                "screen_height": 2400,
                "session_number": self.sessions,
                "timezone_offset_minutes": rng.choice((0, 60, 300, -300, 330)),
                "device_model": self.model,
                "os_version": self.os,
            },
            0,
        )
        launch = {"STATE": "Launch", "CAUSE": "Player"}
        if self.sessions > 1:
            launch.update(
                PREV_EXIT=rng.choice(("Background", "Killed")),
                PREV_EXIT_REASON=rng.choice(("LowMemory", "UserRequested", "ExitSelf", "Other")),
                PREV_EXIT_AD=rng.choice(("None", "Interstitial", "Rewarded")),
            )
        emit("APP_ANALYSIS", launch)
        for sdk in ("Firebase", "AdsProvider", "AppOpenProvider"):
            emit("PLUGIN_HEALTH_ANALYSIS", {"STATE": "SdkReady", "SDK": sdk, "SECONDS": 0.6})
        emit("PLUGIN_HEALTH_ANALYSIS", {"STATE": "Config", "PLUGIN_VERSION": "1.1.22"})
        for key in ("GameConfig", "AvnEventsConfig", "LevelSetting"):
            emit("REMOTE_CONFIG_ANALYSIS", {"STATE": "Applied", "KEY": key, "VALUE": CONFIG})
        emit(
            "PLAYER_ANALYSIS",
            {
                "STATE": "Snapshot",
                "ADS_REMOVED": 0,
                "HAS_PURCHASED": 0,
                "BALANCE_COINS": self.coins,
                "HIGHEST_LEVEL": self.level,
            },
        )
        if self.sessions == 1:
            emit(
                "ATTRIBUTION_ANALYSIS",
                {
                    "STATE": "Install",
                    "AF_STATUS": "Organic" if self.source == "organic" else "Non-organic",
                    "MEDIA_SOURCE": self.source,
                    "CAMPAIGN": f"campaign_{rng.randrange(4)}",
                },
                rng.randint(1, 20),
            )

        def ad(format_, placement):
            ad_id = f"{rng.getrandbits(128):032x}"
            unit = rng.choice(UNITS)
            emit("AD_ANALYSIS", {"FORMAT": format_, "STATE": "LoadSent", "AD_ID": ad_id})
            if rng.random() < 0.15:
                emit(
                    "AD_ANALYSIS",
                    {
                        "FORMAT": format_,
                        "STATE": "LoadFailed",
                        "AD_ID": ad_id,
                        "ERROR": rng.choice(ERRORS),
                        "LOAD_MS": rng.randint(200, 9000),
                    },
                )
                return
            emit(
                "AD_ANALYSIS",
                {
                    "FORMAT": format_,
                    "STATE": "Loaded",
                    "AD_ID": ad_id,
                    "AD_UNIT": unit,
                    "LOAD_MS": rng.randint(200, 4000),
                    "SDK_LOAD_MS": rng.randint(200, 4000),
                },
            )
            emit(
                "AD_ANALYSIS",
                {"FORMAT": format_, "STATE": "Show", "AD_ID": ad_id, "PLACEMENT": placement},
            )
            emit(
                "AD_ANALYSIS",
                {"FORMAT": format_, "STATE": "Displayed", "AD_ID": ad_id, "AD_UNIT": unit},
            )
            emit(
                "AD_ANALYSIS",
                {
                    "FORMAT": format_,
                    "STATE": "Revenue",
                    "AD_ID": ad_id,
                    "AD_UNIT": unit,
                    "NETWORK": rng.choice(NETWORKS),
                    "REVENUE": round(rng.uniform(0.0001, 0.02), 6),
                    "PRECISION": "estimated",
                },
                rng.randint(5, 30),
            )
            emit("AD_ANALYSIS", {"FORMAT": format_, "STATE": "Closed", "AD_ID": ad_id})

        if rng.random() < 0.5:
            ad("AppOpen", "app_open")
        playing = True
        while playing:
            attempt_id = f"{rng.getrandbits(128):032x}"
            attempt = 1
            while True:
                emit(
                    "LEVEL_ANALYSIS",
                    {
                        "STATE": "Started",
                        "ATTEMPT_ID": attempt_id,
                        "ATTEMPT": attempt,
                        "LEVEL_ID": f"level_{(self.level - 1) % 30 + 1}",
                        "SOURCE": "Next" if attempt == 1 else "Restart",
                        "IS_REPLAY": 0,
                        "IS_BOSS_LEVEL": int(self.level % 10 == 0),
                    },
                )
                if rng.random() < 0.3:
                    tool = rng.choice(("hammer", "hint", "bomb"))
                    emit(
                        "POWERUP_ANALYSIS",
                        {
                            "STATE": "Used",
                            "POWERUP": tool,
                            "ATTEMPT_ID": attempt_id,
                            "SECONDS_INTO_LEVEL": round(rng.uniform(1, 40), 3),
                        },
                    )
                if rng.random() < 0.4:
                    ad("Banner", "banner")
                won = rng.random() < self.skill - min(0.4, self.level * 0.004)
                emit(
                    "LEVEL_ANALYSIS",
                    {
                        "STATE": "Completed" if won else "Failed",
                        "ATTEMPT_ID": attempt_id,
                        "ATTEMPT": attempt,
                        "SECONDS": round(rng.uniform(10, 240), 4),
                        "PROGRESS_PCT": 100 if won else rng.choice((25, 60, 70)),
                        "BANNER_IMPRESSIONS": rng.randint(0, 3),
                    },
                    rng.randint(10, 240),
                )
                if won:
                    self.coins += 50
                    emit(
                        "ECONOMY_ANALYSIS",
                        {
                            "STATE": "Earned",
                            "CURRENCY": "coins",
                            "AMOUNT": 50,
                            "SOURCE": "level_reward",
                            "BALANCE": self.coins,
                            "ATTEMPT_ID": attempt_id,
                        },
                    )
                    self.level += 1
                    break
                attempt += 1
                if rng.random() < 0.3 or attempt > 4:
                    break
            if self.level > 3 and rng.random() < 0.6:
                ad("Interstitial", "level_interstitial")
            if rng.random() < 0.2:
                emit(
                    "AD_HEALTH_ANALYSIS",
                    {
                        "STATE": "Snapshot",
                        "FORMAT": "Interstitial",
                        "WINDOW_SECONDS": 300,
                        "REQUESTS": rng.randint(0, 6),
                        "IMPRESSIONS": rng.randint(0, 4),
                        "NOT_READY": rng.randint(0, 3),
                        "BLOCKED": rng.randint(0, 3),
                        "TIMEOUTS": 0,
                    },
                )
            playing = rng.random() < 0.82
        emit("APP_ANALYSIS", {"STATE": "Background", "CAUSE": "Player"})
        began = events[0]["client_ts"]
        emit(
            "session_end",
            {
                "end_reason": "background",
                "session_number": self.sessions,
                "duration_seconds": 60.0 if began else 0,
            },
        )
        return context, events


def generate(target_events, seed=1, days=60, batch_size=500):
    """Yield (country, batch) pairs in the SDK's request form, until about target_events."""
    rng = random.Random(seed)
    produced = 0
    while produced < target_events:
        player = _Player(rng, days)
        for day in player.sessions_planned():
            context, events = player.session(day)
            produced += len(events)
            rows = [{**context, **event} for event in events]
            for offset in range(0, len(rows), batch_size):
                yield player.country, {"events": rows[offset : offset + batch_size]}
            if produced >= target_events:
                break
