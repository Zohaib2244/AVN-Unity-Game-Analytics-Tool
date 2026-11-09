"""NutBot's acquisition tools: where players came from and what they were worth (see acquisition.py)."""

from . import acquisition
from .nutbot_base import RANGE_PROPS, _tool
from .segments import SEGMENT_SCHEMA, SegmentedTools

LIMIT = {
    "type": "integer",
    "minimum": 1,
    "maximum": 40,
    "description": "How many groups to return, biggest first. Default 15.",
}
GROUP_BY = {
    "type": "string",
    "enum": list(acquisition.GROUPS),
    "description": "Group installs by this attribution field (status = organic or paid). Default media_source.",
}
COHORT = "start and end are the dates players opened the game for the first time."

ACQUISITION_TOOLS = [
    _tool(
        "get_acquisition",
        "Where players came from: installs by media source, campaign, channel, creative or site, from the game's attribution events, with what each group did afterwards: day 1, 3 and 7 retention (only players whose day is over), the share who completed a level and the median highest level, and the share who clicked a store button. Players with no attribution record are 'Unattributed', separate from 'organic'. "
        + COHORT
        + " Says so when the game sends no attribution.",
        {**RANGE_PROPS, "group_by": GROUP_BY, "segment": SEGMENT_SCHEMA, "limit": LIMIT},
    ),
    _tool(
        "get_ltv",
        "What players are worth by install source: cumulative ad revenue (full-screen plus banner, USD) per player by day since first open (0, 1, 3, 7, 14, 30 unless days is given), with how many players each number rests on, since newer players have no later days yet. Use it to compare campaigns or media sources by value per install. "
        + COHORT,
        {
            **RANGE_PROPS,
            "group_by": GROUP_BY,
            "segment": SEGMENT_SCHEMA,
            "days": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0, "maximum": acquisition.MAX_LTV_DAY},
                "description": "Which days to report. Default 0, 1, 3, 7, 14, 30.",
            },
            "limit": LIMIT,
        },
    ),
]


class AcquisitionTools(SegmentedTools):
    """Handlers of ACQUISITION_TOOLS; NutBot supplies storage and the range and filter helpers."""

    def tool_get_acquisition(self, run, game_id, args):
        start, end = self._range(run, args)
        return acquisition.acquisition(
            self.storage,
            game_id,
            start,
            end,
            self._segment_filters(run, args),
            args.get("group_by"),
            args.get("limit") or 15,
        )

    def tool_get_ltv(self, run, game_id, args):
        start, end = self._range(run, args)
        return acquisition.ltv(
            self.storage,
            game_id,
            start,
            end,
            self._segment_filters(run, args),
            args.get("group_by"),
            args.get("days"),
            args.get("limit") or 15,
        )
