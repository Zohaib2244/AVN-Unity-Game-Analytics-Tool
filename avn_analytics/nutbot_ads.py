"""NutBot's ad tools: revenue, ad network health and how ads are served (see ads.py)."""

from . import ads
from .nutbot_base import RANGE_PROPS, _tool
from .segments import SEGMENT_SCHEMA, SegmentedTools

LIMIT = {
    "type": "integer",
    "minimum": 1,
    "maximum": 40,
    "description": "How many groups to return, biggest first. Default 15.",
}


def _group(options, default, words):
    return {"type": "string", "enum": list(options), "description": f"{words} Default {default}."}


AD_TOOLS = [
    _tool(
        "get_ad_revenue",
        "What ads earn (USD). Full-screen ads (interstitial, rewarded, app open) from their Revenue events: impressions, revenue, eCPM and players paid for; banners apart (read from level results); total revenue, revenue per active player and ARPDAU (revenue per active player per day). Also how many shown ads have a revenue report, since some shows never get one. Split by format, placement, network, ad unit, country, platform, app version or day. Says so when the game sends no ad revenue.",
        {
            **RANGE_PROPS,
            "group_by": _group(
                ads.REVENUE_GROUPS, "format", "How to split the full-screen ad revenue."
            ),
            "segment": SEGMENT_SCHEMA,
            "limit": LIMIT,
        },
    ),
    _tool(
        "get_ad_health",
        "Whether ads load and show, from the ad plugin's health snapshots: load requests, loaded, load failures and the success rate; ad requests and how many found no ad ready; how many were held back by the game's own rules; show calls, displayed, show failures; impressions; recovered and timeouts. Split by format (interstitial, rewarded, banner, app open), country, platform, app version or day, plus the most common load errors (for example no fill or an eCPM floor). Use it for 'are the ads working' and 'which network or format is failing'. Says so when the game sends no ad health.",
        {
            **RANGE_PROPS,
            "group_by": _group(ads.HEALTH_GROUPS, "format", "How to split the health counters."),
            "segment": SEGMENT_SCHEMA,
            "limit": LIMIT,
        },
    ),
    _tool(
        "get_ad_serving",
        "How the game asks for and shows ads, per placement or format: ads wanted, shown, held back by the game's own rules (with the reasons: cooldown, level gate...), failed (with the reasons: not ready, show failed...), closed, with a revenue report, how often a rewarded ad gave its reward and the average time on screen. Plus pacing: ads shown per session and the median seconds between interstitials in a session. Use it to see whether ads are shown as often as intended and why they are not.",
        {
            **RANGE_PROPS,
            "group_by": _group(ads.SERVING_GROUPS, "placement", "What to split by."),
            "segment": SEGMENT_SCHEMA,
            "limit": LIMIT,
        },
    ),
]


class AdTools(SegmentedTools):
    """Handlers of AD_TOOLS; NutBot supplies storage and the range and filter helpers."""

    def _ad_read(self, function, run, game_id, args):
        start, end = self._range(run, args)
        return function(
            self.storage,
            game_id,
            start,
            end,
            self._segment_filters(run, args),
            args.get("group_by"),
            args.get("limit") or 15,
        )

    def tool_get_ad_revenue(self, run, game_id, args):
        return self._ad_read(ads.revenue, run, game_id, args)

    def tool_get_ad_health(self, run, game_id, args):
        return self._ad_read(ads.health, run, game_id, args)

    def tool_get_ad_serving(self, run, game_id, args):
        return self._ad_read(ads.serving, run, game_id, args)
