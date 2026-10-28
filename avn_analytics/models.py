import math
from datetime import UTC, datetime
from datetime import date as datetime_date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    ValidationError,
    field_validator,
    model_validator,
)

from .conditions import numeric_value

Name = Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")]
Context = Annotated[str, Field(min_length=1, max_length=128)]


def timestamp(value: datetime | None = None) -> str:
    return (value or datetime.now(UTC)).astimezone(UTC).isoformat(timespec="microseconds")


def normalize_country(value: str | None) -> str | None:
    """ISO 3166-1 alpha-2 from Cloudflare's CF-IPCountry (XX = unknown, T1 = Tor)."""
    value = (value or "").strip().upper()
    return value if len(value) == 2 and value.isascii() and value.isalnum() else None


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EventBase(StrictModel):
    event_id: UUID
    name: Name
    params: dict[str, str | int | float] = Field(default_factory=dict, max_length=50)
    client_ts: AwareDatetime

    @field_validator("params", mode="before")
    @classmethod
    def validate_params(cls, params):
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        for key, value in params.items():
            if not isinstance(key, str) or not 1 <= len(key) <= 80:
                raise ValueError("param names must be 1-80 characters")
            if type(value) not in (str, int, float):
                raise ValueError("params support only strings and finite numbers")
            if isinstance(value, str) and len(value) > 1024:
                raise ValueError("param strings must be at most 1024 characters")
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("param numbers must be finite")
            if isinstance(value, int) and not -(2**63) <= value < 2**63:
                raise ValueError("param integers must fit in signed 64 bits")
        return params

    @field_validator("client_ts", mode="before")
    @classmethod
    def require_iso_timestamp(cls, value):
        if not isinstance(value, (str, datetime)):
            raise ValueError("client_ts must be an ISO 8601 timestamp with timezone")
        return value


class EventContext(StrictModel):
    """Fields shared by every event in a batch; an event's own value takes precedence."""

    user_id: Context | None = None
    device_id: Context | None = None
    session_id: Context | None = None
    app_version: Context | None = None
    build: Context | None = None
    platform: Context | None = None
    environment: Context | None = (
        None  # production, development, editor...: lets dashboards hide test data
    )


class BatchContext(EventContext):
    """The `context` of a batch: the shared fields, plus what the SDK stamps on it.

    Unknown fields are ignored, not rejected: a rejected batch is lost data, so a newer SDK can add
    a field without waiting for a server release. Events themselves stay strict.
    """

    model_config = ConfigDict(extra="ignore")

    standard: Context | None = None  # the events standard the batch follows, e.g. "avn-events"
    standard_version: int | None = None  # that standard's version; absent on older SDKs and games

    @field_validator("standard", "standard_version", mode="before")
    @classmethod
    def metadata_never_rejects(cls, value, info):
        """These two only describe the batch, so a malformed one is dropped rather than a 400."""
        if info.field_name == "standard":
            ok = isinstance(value, str) and 1 <= len(value) <= 128
        else:
            ok = type(value) is int and 0 <= value < 2**31
        return value if ok else None


class EventIn(EventBase, EventContext):
    """An event as sent: context fields may be omitted when the batch supplies them."""


class Event(EventBase):
    """An event as stored: the complete envelope."""

    user_id: Context | None = None
    device_id: Context | None = None
    session_id: Context
    app_version: Context
    build: Context
    platform: Context
    environment: Context | None = None
    standard: Context | None = None  # from the batch context; stored with the event
    standard_version: int | None = None

    @model_validator(mode="after")
    def require_identity(self):
        if not self.user_id and not self.device_id:
            raise ValueError("user_id or device_id is required")
        return self


class Batch(StrictModel):
    context: BatchContext | None = None
    events: list[EventIn] = Field(min_length=1, max_length=500)
    _resolved: list[Event] = PrivateAttr(default_factory=list)

    @model_validator(mode="after")
    def resolve_context(self):
        shared = self.context.model_dump(exclude_none=True) if self.context else {}
        resolved = []
        for index, event in enumerate(self.events):
            try:
                resolved.append(
                    Event.model_validate({**shared, **event.model_dump(exclude_none=True)})
                )
            except ValidationError as error:
                first = error.errors()[0]
                where = ".".join(str(part) for part in first["loc"])
                raise ValueError(f"events.{index}.{where}: {first['msg']}") from None
        self._resolved = resolved
        return self

    @property
    def resolved(self) -> list[Event]:
        """Events with the batch context merged in: the shape that gets stored."""
        return self._resolved


class GameCreate(StrictModel):
    name: Annotated[str, Field(min_length=1, max_length=128)]
    bundle_id: Annotated[
        str, Field(min_length=3, max_length=255, pattern=r"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$")
    ]
    platform: Literal["android", "ios"]
    notes: Annotated[str, Field(max_length=2000)] = ""
    workspace_id: UUID | None = None  # defaults to the caller's only (or first) workspace


class GameUpdate(StrictModel):
    """Platform is fixed after registration so a game's events never mix platforms."""

    name: Annotated[str, Field(min_length=1, max_length=128)] | None = None
    bundle_id: (
        Annotated[
            str,
            Field(min_length=3, max_length=255, pattern=r"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$"),
        ]
        | None
    ) = None
    notes: Annotated[str, Field(max_length=2000)] | None = None
    archived: bool | None = None


class KeyCreate(StrictModel):
    label: Annotated[str, Field(min_length=1, max_length=128)] = "default"


# The comparisons every event rule offers (funnel steps, player rules, mappings); the site lists the
# same ones in lib/conditions.ts. Highlight trees add "missing" (ConditionOp).
RuleOp = Literal["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"]
ConditionOp = Literal["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists", "missing"]
CanonicalOp = RuleOp


class CanonicalMapping(StrictModel):
    """Maps one raw event (optionally by a parameter condition) to a shared concept."""

    action: Name
    param: Annotated[str, Field(max_length=80)] = ""
    op: CanonicalOp = "eq"
    value: Annotated[str, Field(max_length=200)] = ""
    # For level actions: the parameter that holds the level number (blank = look for "level").
    number_param: Annotated[str, Field(max_length=80)] = ""
    # Blank applies to every version; otherwise match the event envelope exactly.
    app_version: Annotated[str, Field(max_length=80)] = ""


class EventMappings(StrictModel):
    canonical: list[CanonicalMapping] = Field(default_factory=list, max_length=20)


class MappingPreview(StrictModel):
    event: Name
    rule: CanonicalMapping


class EventDefinition(StrictModel):
    # Blank while an event only has a mapping, a label rule or "hidden" and no description yet.
    description: Annotated[str, Field(max_length=4000)] = ""
    params: dict[str, str] = Field(default_factory=dict, max_length=50)
    # How the event reads in stories, one rule per line: "Started => Started level {Started}".
    # A rule applies when the named parameter is present ("*" always); first match wins.
    labels: Annotated[str, Field(max_length=2000)] = ""
    hidden: bool = False  # left out of player stories and journeys (noise)
    canonical: list[CanonicalMapping] = Field(default_factory=list, max_length=20)

    @field_validator("params")
    @classmethod
    def validate_definitions(cls, params):
        if any(
            not 1 <= len(key) <= 80 or not 1 <= len(value) <= 2000 for key, value in params.items()
        ):
            raise ValueError("Invalid parameter name or description length")
        return params


ImportMode = Literal["fill_blanks", "overwrite_ai_drafts", "overwrite_all"]
ImportConfidence = Literal["certain", "inferred"]


class ImportScope(StrictModel):
    """Which events the agent is asked to cover (and the importer accepts)."""

    events: Literal["undocumented", "all", "listed"] = "undocumented"
    names: list[Name] = Field(default_factory=list, max_length=500)  # with events="listed"
    prefixes: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        default_factory=list, max_length=50
    )  # with events="listed": every event whose name starts with one of these
    seen_within_days: Annotated[int, Field(ge=1, le=3650)] | None = None
    include_not_yet_received: bool = True  # events found in code that were never received
    include_hidden: bool = False  # events hidden from stories and journeys


class ImportStyle(StrictModel):
    language: Annotated[str, Field(min_length=1, max_length=40)] = "English"
    tone: Literal["one_sentence", "concise", "detailed"] = "concise"
    max_description_chars: Annotated[int, Field(ge=20, le=4000)] = 200
    game_context: Annotated[str, Field(max_length=2000)] = ""
    param_values: bool = False  # also list the values a parameter can take


class ImportCode(StrictModel):
    """Hints for the agent about where to look in the game's code."""

    include_paths: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        default_factory=list, max_length=50
    )
    exclude_paths: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        default_factory=list, max_length=50
    )
    call_patterns: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(
        default_factory=list, max_length=20
    )  # extra wrappers around LogEvent, e.g. "Analytics.Track("


class ImportOptions(StrictModel):
    """The rules of one import. They travel inside the file so the prompt, the agent and the
    importer all work from the same ones; the person uploading can still change them."""

    mode: ImportMode = "fill_blanks"
    fields: list[Literal["description", "params"]] = Field(
        default_factory=lambda: ["description", "params"], min_length=1, max_length=2
    )
    scope: ImportScope = ImportScope()
    style: ImportStyle = ImportStyle()
    code: ImportCode = ImportCode()
    min_confidence: ImportConfidence = "inferred"
    require_source: bool = True
    status: Literal["draft", "confirmed"] = "draft"
    # An import that would replace more than this many existing texts is refused.
    max_overwrites: Annotated[int, Field(ge=0, le=100_000)] = 25
    near_duplicates: Literal["warn", "reject"] = "warn"
    type_conflicts: Literal["flag", "ignore"] = "flag"


class ImportProposal(StrictModel):
    """What the agent fills in for one event. null means "no proposal"; it never blanks a field."""

    description: Annotated[str, Field(max_length=4000)] | None = None
    params: dict[Annotated[str, Field(min_length=1, max_length=80)], str | None] = Field(
        default_factory=dict, max_length=50
    )
    param_types: dict[
        Annotated[str, Field(min_length=1, max_length=80)], Literal["string", "number"]
    ] = Field(default_factory=dict, max_length=50)
    confidence: ImportConfidence | Literal["unknown"] | None = None
    source: Annotated[str, Field(max_length=300)] | None = None


class ImportEvent(StrictModel):
    proposed: ImportProposal = ImportProposal()
    # Context the template carries; the importer reads the live dictionary, not this.
    current: dict | None = None
    observed: dict | None = None
    status: str | None = None


class ImportUnresolved(StrictModel):
    source: Annotated[str, Field(max_length=300)] = ""
    note: Annotated[str, Field(max_length=500)] = ""


class ImportFile(StrictModel):
    format: Literal["avn-events/1"]
    game: str | None = None
    instructions: Annotated[str, Field(max_length=8000)] | None = None  # template text, ignored
    options: ImportOptions = ImportOptions()
    events: dict[Name, ImportEvent] = Field(default_factory=dict, max_length=2000)
    unresolved: list[ImportUnresolved] = Field(default_factory=list, max_length=500)
    not_found_in_code: list[Name] = Field(default_factory=list, max_length=2000)


# A whole event ("level_start") or one text of it ("level_start/description",
# "level_start/param:level").
ImportExclude = Annotated[
    str,
    Field(max_length=170, pattern=r"^[A-Za-z][A-Za-z0-9_]*(/(description|param:.{1,80}))?$"),
]


class ImportRequest(StrictModel):
    file: ImportFile
    # Overrides for the options carried by the file; the reviewer has the last word.
    options: ImportOptions | None = None
    exclude: list[ImportExclude] = Field(default_factory=list, max_length=10000)
    # Absent: a dry run. Present: apply, provided it still matches what the dry run showed.
    preview: Annotated[str, Field(min_length=64, max_length=64)] | None = None


class ImportPrepare(StrictModel):
    options: ImportOptions = ImportOptions()


FilterValues = Annotated[list[Annotated[str, Field(max_length=128)]], Field(max_length=100)]


class Filters(StrictModel):
    """Narrows dashboard queries; an empty list means no restriction."""

    environments: FilterValues = []
    exclude_environments: FilterValues = []
    app_versions: FilterValues = []
    exclude_app_versions: FilterValues = []
    builds: FilterValues = []
    exclude_builds: FilterValues = []
    countries: FilterValues = []
    exclude_countries: FilterValues = []
    platforms: FilterValues = []
    exclude_platforms: FilterValues = []


Threshold = Annotated[int, Field(ge=1, le=1_000_000)]


class AnalyticsThresholds(StrictModel):
    retention_min_users: Threshold = 100
    levels_min_players: Threshold = 30
    funnels_min_players: Threshold = 30


EnvironmentName = Annotated[
    str, Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9][A-Za-z0-9_\-]*$")
]


class WorkerControl(StrictModel):
    """Start or stop the analytics worker (materialize.py) for every game."""

    desired: Literal["running", "stopped"]


class EnvironmentFix(StrictModel):
    """Count events a build sent as `from_environment` as `to_environment` instead."""

    from_environment: EnvironmentName
    to_environment: EnvironmentName
    app_version: Annotated[str, Field(max_length=64)] | None = None  # None: every version
    build: Annotated[str, Field(max_length=64)] | None = None  # None: every build
    note: Annotated[str, Field(max_length=200)] = ""

    @field_validator("from_environment", "to_environment")
    @classmethod
    def lowercase(cls, value):
        return value.lower()

    @field_validator("app_version", "build")
    @classmethod
    def blank_means_any(cls, value):
        return (value or "").strip() or None

    @model_validator(mode="after")
    def must_change_something(self):
        if self.from_environment == self.to_environment:
            raise ValueError("Pick a different environment to count these events as")
        return self


class AnalyticsThresholdOverrides(StrictModel):
    retention_min_users: Threshold | None = None
    levels_min_players: Threshold | None = None
    funnels_min_players: Threshold | None = None


class FunnelStep(StrictModel):
    event: Name
    param: Annotated[str, Field(max_length=80)] = ""
    op: RuleOp = "eq"
    value: Annotated[str, Field(max_length=200)] = ""
    label: Annotated[str, Field(max_length=80)] = ""


class FunnelDefinition(StrictModel):
    steps: list[FunnelStep] = Field(min_length=2, max_length=100)
    window_hours: Annotated[float, Field(gt=0, le=24 * 366)] | None = None
    scope: Literal["player", "session"] = "player"


class FunnelQuery(FunnelDefinition):
    start: datetime_date = Field(ge=datetime_date(1970, 1, 1), le=datetime_date(9998, 12, 31))
    end: datetime_date = Field(ge=datetime_date(1970, 1, 1), le=datetime_date(9998, 12, 31))
    breakdown: Literal["environment", "app_version", "build", "country", "platform"] | None = None
    filters: Filters = Filters()
    timezone_offset_minutes: Annotated[int, Field(ge=-840, le=840)] = 0


class GroupBehavior(StrictModel):
    kind: Literal["level_duration", "event_count", "parameter"] = "level_duration"
    level: Annotated[int, Field(ge=0, le=1_000_000)] = 1
    event: FunnelStep | None = None
    parameter: Annotated[str, Field(max_length=80)] = ""
    window_minutes: Annotated[float, Field(gt=0, le=24 * 60 * 30, allow_inf_nan=False)] = 10
    comparison: Literal["number", "equals"] = "number"
    split: Annotated[float, Field(allow_inf_nan=False)] | None = None
    value: Annotated[str, Field(max_length=200)] = ""

    @model_validator(mode="after")
    def complete_behavior(self):
        if self.kind != "parameter" or self.comparison == "number":
            if self.split is None:
                raise ValueError("Enter the numeric split for the groups")
            if self.kind != "parameter" and self.split < 0:
                raise ValueError("Duration and event-count splits cannot be negative")
        elif not self.value:
            raise ValueError("Enter the parameter value for group A")
        if self.kind in ("event_count", "parameter") and self.event is None:
            raise ValueError("Choose the behavior event")
        if self.kind == "parameter" and not self.parameter:
            raise ValueError("Choose the parameter to compare")
        return self


class GroupOutcome(StrictModel):
    kind: Literal["level", "event"] = "level"
    level: Annotated[int, Field(ge=0, le=1_000_000)] = 4
    event: FunnelStep | None = None
    window_hours: Annotated[float, Field(gt=0, le=24 * 30, allow_inf_nan=False)] = 24

    @model_validator(mode="after")
    def complete_outcome(self):
        if self.kind == "event" and self.event is None:
            raise ValueError("Choose the outcome event")
        return self


class PlayerGroupsPopulation(StrictModel):
    start: datetime_date = Field(ge=datetime_date(1970, 1, 1), le=datetime_date(9998, 12, 31))
    end: datetime_date = Field(ge=datetime_date(1970, 1, 1), le=datetime_date(9998, 12, 31))
    filters: Filters = Filters()
    timezone_offset_minutes: Annotated[int, Field(ge=-840, le=840)] = 0
    entry_level: Annotated[int, Field(ge=0, le=1_000_000)] | None = 1
    exclude_players: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(
        default_factory=list, max_length=200
    )
    exclude_events: list[FunnelStep] = Field(default_factory=list, max_length=20)
    behavior: GroupBehavior


class PlayerGroupsQuery(PlayerGroupsPopulation):
    outcome: GroupOutcome = GroupOutcome()

    @model_validator(mode="after")
    def ordered_windows(self):
        if (
            self.behavior.kind != "level_duration"
            and self.behavior.window_minutes >= self.outcome.window_hours * 60
        ):
            raise ValueError("The behavior window must end before the outcome window")
        if (
            self.behavior.kind == "level_duration"
            and self.outcome.kind == "level"
            and self.outcome.level <= self.behavior.level
        ):
            raise ValueError("Choose an outcome level after the behavior level")
        return self


class SavedGroupDefinition(PlayerGroupsPopulation):
    window_hours: Annotated[float, Field(gt=0, le=720, allow_inf_nan=False)] = 24
    range_preset: Literal["today", "yesterday", "7", "30", "90", "month", "lastmonth", "custom"] = (
        "custom"
    )
    version_mode: Literal["latest", "previous", "custom", "all"] = "custom"
    timezone: Literal["local", "utc"] = "local"
    hide_test: bool = True
    outcome: GroupOutcome | None = None

    @model_validator(mode="after")
    def valid_setup(self):
        if self.end < self.start or (self.end - self.start).days > 365:
            raise ValueError("Choose a date range of at most 366 days")
        if self.behavior.kind != "level_duration":
            if self.behavior.window_minutes >= self.window_hours * 60:
                raise ValueError("The behavior window must end before the observation window")
        if self.outcome is not None:
            if self.outcome.window_hours != self.window_hours:
                raise ValueError("The outcome and observation windows must match")
            PlayerGroupsQuery.model_validate(
                {
                    **self.model_dump(
                        exclude={
                            "window_hours",
                            "range_preset",
                            "version_mode",
                            "timezone",
                            "hide_test",
                        }
                    ),
                }
            )
        return self


class SavedPlayerGroup(StrictModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    kind: Literal["groups", "check"]
    definition: SavedGroupDefinition

    @model_validator(mode="after")
    def complete_saved_item(self):
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("Give this item a name")
        if (self.kind == "check") != (self.definition.outcome is not None):
            raise ValueError("Checks require an outcome; saved groups have no outcome")
        return self


class JourneyTarget(StrictModel):
    """Which players to list: one whole journey (its steps and outcome), or one exit."""

    steps: list[Annotated[str, Field(max_length=300)]] | None = Field(default=None, max_length=40)
    status: Literal["reached", "stopped", "continued"] | None = None
    exit: Annotated[str, Field(max_length=300)] | None = None


class JourneyQuery(FunnelDefinition):
    """Journeys of players between two steps of a funnel (default: first to last)."""

    start: datetime_date = Field(ge=datetime_date(1970, 1, 1), le=datetime_date(9998, 12, 31))
    end: datetime_date = Field(ge=datetime_date(1970, 1, 1), le=datetime_date(9998, 12, 31))
    filters: Filters = Filters()
    route_from: Annotated[int, Field(ge=1, le=100)] = 1
    route_to: Annotated[int, Field(ge=2, le=100)] | None = None
    ignore: list[Name] = Field(default_factory=list, max_length=100)
    span: Literal["session", "all"] = "session"
    timezone_offset_minutes: Annotated[int, Field(ge=-840, le=840)] = 0


class JourneyPlayersQuery(JourneyQuery):
    target: JourneyTarget


ParamName = Annotated[str, Field(max_length=80, pattern=r'^[^"\\]*$')]


class EventTest(StrictModel):
    field: Literal["event", "param"] = "param"
    param: Annotated[str, Field(max_length=80)] = ""
    op: ConditionOp = "eq"
    value: Annotated[str, Field(max_length=200)] = ""

    @model_validator(mode="after")
    def valid_test(self):
        if self.field == "param" and not self.param:
            raise ValueError("Choose a parameter")
        if self.field == "event" and self.op not in ("eq", "ne", "contains"):
            raise ValueError("Event names support equals, not equals and contains")
        if self.field == "event" and not self.value:
            raise ValueError("Choose an event name")
        if self.op in ("gt", "gte", "lt", "lte"):
            if numeric_value(self.value) is None:
                raise ValueError("Compare with a finite number")
        return self


class EventConditionGroup(StrictModel):
    match: Literal["all", "any"] = "all"
    conditions: list["EventTest | EventConditionGroup"] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def bounded_tree(self):
        def size(node, depth=1):
            if depth > 6:
                raise ValueError("Use at most 6 levels of condition groups")
            return 1 + sum(
                size(child, depth + 1) if isinstance(child, EventConditionGroup) else 1
                for child in node.conditions
            )

        if size(self) > 100:
            raise ValueError("Use at most 100 conditions and groups")
        return self


class EventActivityQuery(StrictModel):
    name: Name
    start: datetime_date = Field(ge=datetime_date(1970, 1, 1), le=datetime_date(9998, 12, 31))
    end: datetime_date = Field(ge=datetime_date(1970, 1, 1), le=datetime_date(9998, 12, 31))
    filters: Filters = Filters()
    timezone_offset_minutes: Annotated[int, Field(ge=-840, le=840)] = 0
    conditions: EventConditionGroup | None = None


class SavedHighlight(StrictModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    color: Literal["orange", "cyan", "green", "pink", "violet", "gold"] = "gold"
    conditions: EventConditionGroup


class PlayerCondition(StrictModel):
    """Keep only players who did (or never did) an event, optionally with a parameter test."""

    event: Name
    param: ParamName = ""
    op: RuleOp = "eq"
    value: Annotated[str, Field(max_length=200)] = ""
    does: Literal["did", "didnt"] = "did"
    min_times: Annotated[int, Field(ge=1, le=100000)] = 1


class PlayerMetric(StrictModel):
    """An extra column per player, also usable as the sort key: how many times they did an event,
    the highest/lowest/total of one of its parameters, or when they first/last did it."""

    event: Name
    param: ParamName = ""
    op: RuleOp = "eq"
    value: Annotated[str, Field(max_length=200)] = ""
    agg: Literal["count", "max", "min", "sum", "first", "last"] = "count"
    of: ParamName = ""  # the parameter to total/compare; defaults to `param`
    label: Annotated[str, Field(max_length=80)] = ""


class PlayerRules(StrictModel):
    conditions: list[PlayerCondition] = Field(default_factory=list, max_length=6)
    metrics: list[PlayerMetric] = Field(default_factory=list, max_length=3)


class NutBotHeadline(StrictModel):
    title: Annotated[str, Field(min_length=1, max_length=80)]
    value: Annotated[str, Field(min_length=1, max_length=80)]
    sub: Annotated[str, Field(max_length=80)] = ""


class NutBotReportCreate(StrictModel):
    title: Annotated[str, Field(min_length=1, max_length=80)]
    body: Annotated[str, Field(min_length=1, max_length=20000)]
    headline: NutBotHeadline | None = None
    chat_id: UUID | None = None


class NutBotReportChange(StrictModel):
    title: Annotated[str, Field(min_length=1, max_length=80)] | None = None
    pinned: bool | None = None


class NutBotChat(StrictModel):
    message: Annotated[str, Field(min_length=1, max_length=4000)]
    harness: Annotated[str, Field(max_length=20)] | None = None
    model: Annotated[str, Field(max_length=80)] | None = None
    chat_id: UUID | None = None
    context: dict = Field(default_factory=dict)


class NutBotChatCreate(StrictModel):
    harness: Annotated[str, Field(max_length=20)] | None = None
    model: Annotated[str, Field(max_length=80)] | None = None
    title: Annotated[str, Field(max_length=80)] = ""


class NutBotChatRename(StrictModel):
    title: Annotated[str, Field(min_length=1, max_length=80)]


class WorkspaceNutBot(StrictModel):
    access: Literal["admins", "leads", "everyone"]


class SavedFunnel(FunnelDefinition):
    name: Annotated[str, Field(min_length=1, max_length=80)]


Role = Literal["admin", "lead", "member"]
MemberRole = Literal["lead", "member"]
Email = Annotated[str, Field(min_length=3, max_length=254)]
WorkspaceName = Annotated[str, Field(min_length=1, max_length=60)]


class TeamAdd(StrictModel):
    email: Email
    name: Annotated[str, Field(max_length=80)] = ""
    role: Role = "member"  # "admin" is global; lead and member apply to workspace_id
    workspace_id: UUID | None = None
    game_ids: list[UUID] = Field(default_factory=list, max_length=500)


class TeamUpdate(StrictModel):
    name: Annotated[str, Field(max_length=80)] | None = None
    admin: bool | None = None
    workspace_id: UUID | None = None
    role: MemberRole | None = None
    game_ids: list[UUID] | None = Field(default=None, max_length=500)


class AccessUpdate(StrictModel):
    emails: list[Email] = Field(max_length=500)


class WorkspaceCreate(StrictModel):
    name: WorkspaceName


class WorkspaceMove(StrictModel):
    workspace_id: UUID


class CustomParam(StrictModel):
    key: Annotated[str, Field(min_length=1, max_length=40)]
    type: Literal["int", "float", "string"]
    required: bool = False
    note: Annotated[str, Field(max_length=200)] = ""
    values: Annotated[list[Annotated[str, Field(max_length=40)]], Field(max_length=30)] = []


class CustomState(StrictModel):
    name: Annotated[str, Field(min_length=1, max_length=40)]
    trigger: Annotated[str, Field(max_length=300)] = ""
    params: Annotated[list[CustomParam], Field(max_length=30)] = []


class CustomEvent(StrictModel):
    """An event added to the AVN events standard from the website."""

    purpose: Annotated[str, Field(max_length=300)] = ""
    states: Annotated[list[CustomState], Field(min_length=1, max_length=30)]


class IgnoreOlder(StrictModel):
    """Ignore the events only older app versions sent (the chosen version, and optionally newer)."""

    version: Annotated[str, Field(min_length=1, max_length=100)]
    newer: bool = False


class CustomEventTier(StrictModel):
    """Promote a custom event to the core tier, or demote it back to custom."""

    tier: Literal["custom", "core"]
