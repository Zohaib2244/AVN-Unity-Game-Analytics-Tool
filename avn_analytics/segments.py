"""Player segments for agent tools: keep only players who have (or lack) a kind of event.

A segment is "players who sent EVENT with PARAM equal to one of VALUES" (or, with `missing`, players
who never did). The player's install source is the usual case: ATTRIBUTION_ANALYSIS sent when the
attribution service answers, with MEDIA_SOURCE, CAMPAIGN, CHANNEL and so on. The event may be
outside the date range (an install is days before the play), so the test looks at every event the
player ever sent.

Segments are not part of the dashboard's Filters model: only the tools that say they take a
`segment` read it, and `insights.where` applies it as one more condition on the player.
"""

import re

from .nutbot_base import ToolError

ATTRIBUTION = "ATTRIBUTION_ANALYSIS"
# Plain words an agent can use for the attribution event's parameters.
ATTRIBUTION_FIELDS = {
    "media_source": "MEDIA_SOURCE",
    "campaign": "CAMPAIGN",
    "channel": "CHANNEL",
    "creative": "AD",
    "site": "SITE_ID",
    "attribution_status": "AF_STATUS",
}
NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,79}$")
MAX_VALUES = 50
MAX_SEGMENTS = 6

SEGMENT_SCHEMA = {
    "type": "object",
    "description": (
        "Keep only players of one segment. Use install source words (media_source, campaign, "
        "channel, creative, site, attribution_status = Organic or Non-organic; each a list of "
        "values), unattributed=true for players with no attribution record, or event_param for "
        "any event: {event, param, values} keeps players who ever sent that event with one of "
        "those values; add missing=true to keep players who never did."
    ),
    "properties": {
        **{key: {"type": "array", "items": {"type": "string"}} for key in ATTRIBUTION_FIELDS},
        "unattributed": {"type": "boolean"},
        "event_param": {
            "type": "object",
            "properties": {
                "event": {"type": "string"},
                "param": {"type": "string"},
                "values": {"type": "array", "items": {"type": "string"}},
                "missing": {"type": "boolean"},
            },
            "required": ["event"],
            "additionalProperties": False,
        },
    },
    "additionalProperties": False,
}


def _name(value, what):
    value = str(value or "")
    if not NAME.match(value):
        raise ToolError(f"{what} must be a plain name such as MEDIA_SOURCE.")
    return value


def _values(value):
    if not isinstance(value, (list, tuple)) or not value or len(value) > MAX_VALUES:
        raise ToolError(f"Give 1 to {MAX_VALUES} values.")
    return [str(item)[:128] for item in value]


def parse(argument):
    """A tool's `segment` argument as a list of conditions, or [] when there is none."""
    if not argument:
        return []
    if not isinstance(argument, dict):
        raise ToolError('segment is an object such as {"media_source": ["unityads_int"]}.')
    found = []
    for key, param in ATTRIBUTION_FIELDS.items():
        if argument.get(key):
            found.append({"event": ATTRIBUTION, "param": param, "values": _values(argument[key])})
    if argument.get("unattributed"):
        found.append(
            {"event": ATTRIBUTION, "param": "STATE", "values": ["Install"], "missing": True}
        )
    custom = argument.get("event_param")
    if custom:
        condition = {"event": _name(custom.get("event"), "event")}
        if custom.get("param") or custom.get("values"):
            condition["param"] = _name(custom.get("param"), "param")
            condition["values"] = _values(custom.get("values"))
        condition["missing"] = bool(custom.get("missing"))
        found.append(condition)
    unknown = set(argument) - set(ATTRIBUTION_FIELDS) - {"unattributed", "event_param"}
    if unknown:
        raise ToolError(f"Unknown segment key: {sorted(unknown)[0]}.")
    if not found:
        raise ToolError("The segment names nothing to keep.")
    if len(found) > MAX_SEGMENTS:
        raise ToolError(f"Use at most {MAX_SEGMENTS} segment conditions.")
    return found


def clause(condition, source):
    """SQL and arguments keeping events of the players this condition describes."""
    args = [condition["event"]]
    match = ""
    if condition.get("param"):
        marks = ",".join("?" * len(condition["values"]))
        match = f" AND CAST({source.param(condition['param'])} AS TEXT) IN ({marks})"
        args += condition["values"]
    inner = (
        f"SELECT {source.player} FROM {source.table} "
        f"WHERE name=?{match} AND {source.player} IS NOT NULL"
    )
    operator = "NOT IN" if condition.get("missing") else "IN"
    return f"{source.player} {operator} ({inner})", args


class SegmentedTools:
    """For tool mixins whose handlers honour a `segment` argument."""

    def _segment_filters(self, run, args):
        """The usual filters, plus the segment the agent asked for (see parse)."""
        filters = self._filters(run, args)
        conditions = parse(args.get("segment"))
        return {**filters, "segments": conditions} if conditions else filters
