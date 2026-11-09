"""NutBot's game-systems tools: ad impact, stability, economy, onboarding and the store.

See ads.py (impact), stability.py and systems.py. Every read goes through `insights.where`, so all
five honour `segment`.
"""

from . import ads, stability, systems
from .nutbot_base import RANGE_PROPS, _tool
from .segments import SEGMENT_SCHEMA, SegmentedTools

LIMIT = {
    "type": "integer",
    "minimum": 1,
    "maximum": 40,
    "description": "How many groups to return, biggest first. Default 15.",
}

SYSTEM_TOOLS = [
    _tool(
        "get_ad_impact",
        "Whether ads hurt the game. (1) Leaving the app on an ad, from the app events: how often players leave and why (cause Ad, Player or Purchase), how long they were away after an ad (median and 90th percentile seconds), and how many launches came after a run that ended while an ad was on screen, by ad format with the previous exit reasons. (2) Day 1 and day 7 retention of new players by how many different ads they saw on their first day (0, 1-3, 4-8, 9+). The retention part is association, not cause: heavier players see more ads. Says so when the game doesn't send app events or first opens. start and end are the dates for both parts; for retention they are the dates players opened the game for the first time.",
        {**RANGE_PROPS, "segment": SEGMENT_SCHEMA},
    ),
    _tool(
        "get_stability",
        "How stable the game is, from how the previous run ended as reported by the next launch: launches, the share of each previous exit reason (Android exit names such as Anr, LowMemory, CrashNative, UserRequested), problem exits (crashes, ANRs, memory or resource kills; Signaled is shown but not counted), problem exits with an ad on screen, and level exits where the game was killed (with how many were recovered). Split by app version, country, platform, device tier, RAM band or device model to find where it fails. Says so when the game sends no launch events.",
        {
            **RANGE_PROPS,
            "group_by": {
                "type": "string",
                "enum": list(stability.GROUPS),
                "description": "Split launches by this. Default none (one overall answer). device_tier, ram_band and device_model use the player's latest device snapshot or session start; players without one are 'unknown'.",
            },
            "segment": SEGMENT_SCHEMA,
            "limit": LIMIT,
        },
    ),
    _tool(
        "get_economy",
        "The game's economy. view=currency (default): per currency, what players earned and spent (amount, events, players) split by source with shares and the top details, the share of earned coins that came from rewarded ads, and the median balance by band of levels. view=powerups: per power-up how many were obtained (by source: coins, gift, rewarded ad) and used (by trigger: tutorial or player), and the level completion share with against without power-ups (association, not cause). Says so when the game sends no economy or power-up events.",
        {
            **RANGE_PROPS,
            "view": {
                "type": "string",
                "enum": list(systems.ECONOMY_VIEWS),
                "description": "currency (default) or powerups.",
            },
            "band": {
                "type": "integer",
                "minimum": 1,
                "maximum": systems.MAX_BAND,
                "description": f"Levels per band for the balance by level. Default {systems.DEFAULT_BAND}. Only for view=currency.",
            },
            "segment": SEGMENT_SCHEMA,
        },
    ),
    _tool(
        "get_onboarding",
        "How new players get started. Per tutorial: players it was shown to, completed and interrupted, the completion rate and the median seconds to complete. And the first session of players who opened the game for the first time in the range (start and end are those dates): the share who completed at least level 1, 3, 5 and 10 in that first session and the median seconds from first open to the first completed level. Says so when the game sends no tutorial events or first opens.",
        {**RANGE_PROPS, "segment": SEGMENT_SCHEMA},
    ),
    _tool(
        "get_store",
        "The store and purchases. Per screen (store, shop, offers...): opens, players and their share of all active players, the median seconds open, how closes split (dismissed or purchased) and the top actions. Per in-app purchase product: clicks, purchases, failures with their reasons, players clicking and activated subscriptions, with revenue summed per currency (never converted). Says when there are clicks but no purchase events, and when the game sends no screen or purchase events.",
        {**RANGE_PROPS, "segment": SEGMENT_SCHEMA, "limit": LIMIT},
    ),
]
SYSTEM_LABELS = {
    "get_ad_impact": "Checking whether ads hurt the game",
    "get_stability": "Checking crashes and kills",
    "get_economy": "Reading the economy",
    "get_onboarding": "Reading onboarding",
    "get_store": "Reading the store",
}
SYSTEM_READ_ONLY = tuple(tool["name"] for tool in SYSTEM_TOOLS)


class SystemTools(SegmentedTools):
    """Handlers (tool_<name>) of SYSTEM_TOOLS; NutBot supplies storage and the range helpers."""

    def tool_get_ad_impact(self, run, game_id, args):
        start, end = self._range(run, args)
        return ads.impact(self.storage, game_id, start, end, self._segment_filters(run, args))

    def tool_get_stability(self, run, game_id, args):
        start, end = self._range(run, args)
        return stability.stability(
            self.storage,
            game_id,
            start,
            end,
            self._segment_filters(run, args),
            args.get("group_by"),
            args.get("limit") or 15,
        )

    def tool_get_economy(self, run, game_id, args):
        start, end = self._range(run, args)
        return systems.economy(
            self.storage,
            game_id,
            start,
            end,
            self._segment_filters(run, args),
            args.get("view"),
            args.get("band"),
        )

    def tool_get_onboarding(self, run, game_id, args):
        start, end = self._range(run, args)
        return systems.onboarding(
            self.storage, game_id, start, end, self._segment_filters(run, args)
        )

    def tool_get_store(self, run, game_id, args):
        start, end = self._range(run, args)
        return systems.store(
            self.storage,
            game_id,
            start,
            end,
            self._segment_filters(run, args),
            args.get("limit") or 15,
        )
