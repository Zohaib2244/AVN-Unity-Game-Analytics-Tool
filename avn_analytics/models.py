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

    @model_validator(mode="after")
    def require_identity(self):
        if not self.user_id and not self.device_id:
            raise ValueError("user_id or device_id is required")
        return self


class Batch(StrictModel):
    context: EventContext | None = None
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


class EventDefinition(StrictModel):
    description: Annotated[str, Field(min_length=1, max_length=4000)]
    params: dict[str, str] = Field(default_factory=dict, max_length=50)
    # How the event reads in stories, one rule per line: "Started => Started level {Started}".
    # A rule applies when the named parameter is present ("*" always); first match wins.
    labels: Annotated[str, Field(max_length=2000)] = ""
    hidden: bool = False  # left out of player stories and journeys (noise)

    @field_validator("params")
    @classmethod
    def validate_definitions(cls, params):
        if any(
            not 1 <= len(key) <= 80 or not 1 <= len(value) <= 2000 for key, value in params.items()
        ):
            raise ValueError("Invalid parameter name or description length")
        return params


FilterValues = Annotated[list[Annotated[str, Field(max_length=128)]], Field(max_length=100)]


class Filters(StrictModel):
    """Narrows dashboard queries; an empty list means no restriction."""

    environments: FilterValues = []
    exclude_environments: FilterValues = []
    app_versions: FilterValues = []
    builds: FilterValues = []
    countries: FilterValues = []
    platforms: FilterValues = []


class FunnelStep(StrictModel):
    event: Name
    param: Annotated[str, Field(max_length=80)] = ""
    op: Literal["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"] = "eq"
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


class JourneyPlayersQuery(JourneyQuery):
    target: JourneyTarget


ParamName = Annotated[str, Field(max_length=80, pattern=r'^[^"\\]*$')]
RuleOp = Literal["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"]


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


class NutBotChat(StrictModel):
    message: Annotated[str, Field(min_length=1, max_length=4000)]
    harness: Annotated[str, Field(max_length=20)] | None = None
    model: Annotated[str, Field(max_length=80)] | None = None
    session_id: Annotated[str, Field(max_length=80)] | None = None
    context: dict = Field(default_factory=dict)


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
