"""One session, worked out from its events whenever a page is read.

Nothing here is stored. The SDK sends a `session_end` at every trip to the background, so a session
can have several; some sessions have none at all (a kill, a crash, an uninstall), and a phone can
deliver events days late. Every page that shows a session or its length goes through this class, so
they all agree, and the answer changes by itself when a late event arrives.

    started_at      client_ts of session_start, else the first event's
    last_event_at   the latest client_ts of any event, session_end included
    last_received   the latest server_ts: idleness is judged on the server's clock, never a phone's
    last end        the session_end with the highest seq; `ended_last` when nothing came after it
    away_seconds    AWAY_SECONDS of the Foreground events up to the timeout. A larger value is the
                    return that started a NEW session, and that time belongs to no session.

    what ended it                                   status        closed_by   end_reason
    quit, recovered or an end with no reason        closed        client      as sent, or recovered
    background end, last, idle past the timeout     closed        client      background
    background end, last, not idle that long        open
    no end, or events after it, idle that long      closed        server      inferred
    no end, or events after it, not idle that long  open

"Idle" is the timeout plus CLOSING_GRACE. `recovered` ends and those of older SDKs are final even
with a higher seq after them: both are written at the next launch with the seq last saved on disk,
so the final seconds of play can outnumber them, yet nothing can follow a run that is over.

Length: the highest duration_seconds when the session ended last (it is a running total of
foreground time, so the highest is the session's), otherwise first event to last event minus the
time away, never below 0.
"""

import json
from datetime import UTC, datetime

DEFAULT_TIMEOUT = 1800
CLOSING_GRACE = 900
FINAL_REASONS = {"quit", "recovered"}
# The events whose params decide anything: the rest only move the times and the seq.
WATCHED = ("session_start", "session_end", "APP_ANALYSIS")
WATCHED_SQL = ", ".join(f"'{name}'" for name in WATCHED)


def clock():
    """Now, on the server. A function so tests can move it."""
    return datetime.now(UTC)


def seconds_between(first, last):
    return (datetime.fromisoformat(last) - datetime.fromisoformat(first)).total_seconds()


def _number(value):
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


class SessionState:
    __slots__ = (
        "started",
        "first",
        "last",
        "received",
        "top_seq",
        "unnumbered",
        "end_seq",
        "end_at",
        "end_reason",
        "has_end",
        "reported",
        "returns",
        "trips",
        "timeout",
        "new_sdk",
    )

    def __init__(self):
        self.started = self.first = self.last = self.received = None
        self.top_seq = self.unnumbered = None
        self.end_seq = self.end_at = self.end_reason = None
        self.has_end = False
        self.reported = None
        self.returns = []  # (AWAY_SECONDS, CAUSE) of each Foreground
        self.trips = []  # CAUSE of each Background
        self.timeout = DEFAULT_TIMEOUT
        self.new_sdk = False

    def add(self, name, client_ts, server_ts, seq, params):
        """One event, in any order. params may be the JSON text; only WATCHED events read it."""
        if self.first is None or client_ts < self.first:
            self.first = client_ts
        if self.last is None or client_ts > self.last:
            self.last = client_ts
        if self.received is None or server_ts > self.received:
            self.received = server_ts
        seq = _number(seq)
        if seq is None:
            if self.unnumbered is None or client_ts > self.unnumbered:
                self.unnumbered = client_ts
        elif self.top_seq is None or seq > self.top_seq:
            self.top_seq = seq
        if name not in WATCHED:
            return
        if isinstance(params, str):
            params = json.loads(params)
        params = params or {}
        if name == "session_start":
            self._start(client_ts, params)
        elif name == "session_end":
            self._end(client_ts, seq, params)
        else:
            self._app(params)

    def _start(self, client_ts, params):
        if self.started is None or client_ts < self.started:
            self.started = client_ts
        timeout = _number(params.get("session_timeout_seconds"))
        if timeout is not None and timeout > 0:
            self.timeout = timeout
            self.new_sdk = True

    def _end(self, client_ts, seq, params):
        reason = params.get("end_reason")
        if isinstance(reason, str):
            self.new_sdk = True
        duration = _number(params.get("duration_seconds"))
        if duration is not None and duration >= 0:
            self.reported = max(self.reported or 0, float(duration))
        if not self.has_end or self._later_end(client_ts, seq):
            self.has_end = True
            self.end_seq, self.end_at = seq, client_ts
            self.end_reason = reason if isinstance(reason, str) else None

    def _later_end(self, client_ts, seq):
        if seq is not None and self.end_seq is not None:
            return seq > self.end_seq
        return seq is not None or (self.end_seq is None and client_ts > self.end_at)

    def _app(self, params):
        state = params.get("STATE")
        cause = params.get("CAUSE")
        cause = cause if isinstance(cause, str) and cause else "Unknown"
        if state == "Background":
            self.trips.append(cause)
        elif state == "Foreground":
            away = _number(params.get("AWAY_SECONDS"))
            if away is not None and away >= 0:
                self.returns.append((float(away), cause))

    @property
    def ended_last(self):
        if not self.has_end:
            return False
        if self.end_seq is None:
            return self.last <= self.end_at
        if self.top_seq is not None and self.top_seq > self.end_seq:
            return False
        return self.unnumbered is None or self.unnumbered <= self.end_at

    @property
    def started_at(self):
        return self.started or self.first

    @property
    def away_seconds(self):
        return sum(away for away, _ in self.returns_inside)

    @property
    def returns_inside(self):
        return [item for item in self.returns if item[0] <= self.timeout]

    @property
    def seconds(self):
        if self.ended_last and self.reported is not None:
            return self.reported
        return max(0.0, seconds_between(self.started_at, self.last) - self.away_seconds)

    def outcome(self, now):
        """(status, closed_by, end_reason, in_progress) as of now: see the table above."""
        idle_for = (now - datetime.fromisoformat(self.received)).total_seconds()
        reason = self.end_reason
        if self.has_end and (reason is None or reason == "recovered"):
            return "closed", "client", reason or "recovered", False
        if self.ended_last and reason in FINAL_REASONS:
            return "closed", "client", reason, False
        if idle_for > self.timeout + CLOSING_GRACE:
            if self.ended_last:
                return "closed", "client", reason, False
            return "closed", "server", "inferred", False
        return "open", None, None, idle_for <= self.timeout

    def summary(self, now):
        status, closed_by, end_reason, in_progress = self.outcome(now)
        return {
            "started_at": self.started_at,
            "last_event_at": self.last,
            "status": status,
            "closed_by": closed_by,
            "end_reason": end_reason,
            "in_progress": in_progress,
            "seconds": round(self.seconds, 1),
            "away_seconds": round(self.away_seconds, 1),
            "trips": len(self.trips),
            "timeout_seconds": self.timeout,
            "measured_old_way": not self.new_sdk,
        }
