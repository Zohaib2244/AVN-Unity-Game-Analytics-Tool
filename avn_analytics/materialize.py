"""The analytics worker: keeps every game's derived analytics data up to date, in the background.

It runs as its own process (Compose service `worker`: `python -m avn_analytics.materialize`), never
inside a web request, so its memory and CPU have their own limits and a slow rebuild never holds
up the dashboards or ingest. Ingest keeps storing events (and their facts) whatever it does.

What it does, one bounded piece at a time, game after game: copy and check older events' facts
(analytics.step), check now and then that every event has facts (analytics.audit), and keep the
prepared answers fresh (views.py). Between pieces it re-reads its control, so a Stop is noticed
within about a second, and it holds a per-game lease while working on a game, so two workers
never work on the same game.

Control and status live in the registry database:

- analytics_worker_control: what an admin asked for (running or stopped) and a revision that goes
  up with every change. Set from the website (PUT /v1/admin/analytics-worker); a new
  installation starts as AVN_ANALYTICS_WORKER_DEFAULT_ENABLED says, and the stored choice wins
  from then on, across restarts and deploys.
- analytics_worker_status: the worker's heartbeat, the control revision it has acted on, what it
  is doing, its backlog, and its last success and last error.

The website shows "stopped" only once the worker has acknowledged the matching Stop and released
its work; a heartbeat older than UNAVAILABLE_SECONDS shows "unavailable", never "stopped".
"""

import json
import logging
import os
import signal
import socket
import sqlite3
import sys
import threading
import time
from datetime import UTC, datetime, timedelta

from . import analytics
from .models import timestamp

logger = logging.getLogger("avn_analytics.worker")

UNAVAILABLE_SECONDS = 15  # a heartbeat older than this: the worker is not running
POLL_SECONDS = 1.0  # how often an idle worker looks at its control and for new work
HEARTBEAT_SECONDS = 2.0
LEASE_SECONDS = 60
SLICE_SECONDS = 0.5  # the longest piece of work between two looks at the control
AUDIT_SECONDS = 600  # how often each game's facts are counted against its events
PENDING_SECONDS = 5.0  # how often the backlog summary is recomputed
MAX_BACKOFF = 60.0

CONTROL_SCHEMA = """
CREATE TABLE IF NOT EXISTS analytics_worker_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    desired TEXT NOT NULL CHECK (desired IN ('running', 'stopped')),
    revision INTEGER NOT NULL,
    changed_at TEXT NOT NULL,
    changed_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_worker_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    worker TEXT NOT NULL,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    acknowledged_revision INTEGER NOT NULL,
    observed TEXT NOT NULL,
    game_id TEXT,
    job TEXT,
    pending TEXT NOT NULL DEFAULT '{}',
    last_success_at TEXT,
    errors TEXT NOT NULL DEFAULT '{}'
);
"""


def install_control(connection, enabled):
    """Create the control tables; a new installation starts as `enabled` says (only once)."""
    connection.executescript(CONTROL_SCHEMA)
    connection.execute(
        "INSERT OR IGNORE INTO analytics_worker_control (id, desired, revision, changed_at,"
        " changed_by) VALUES (1, ?, 1, ?, 'installation default')",
        ("running" if enabled else "stopped", timestamp()),
    )


def read_control(connection):
    return dict(connection.execute("SELECT * FROM analytics_worker_control WHERE id=1").fetchone())


def set_desired(storage, desired, actor):
    """Ask the worker to run or stop. Asking for what is already asked changes nothing."""
    if desired not in ("running", "stopped"):
        raise ValueError("desired must be running or stopped")
    with storage.connect(storage.root / "registry.sqlite3") as connection:
        connection.execute("BEGIN IMMEDIATE")
        control = read_control(connection)
        if control["desired"] != desired:
            connection.execute(
                "UPDATE analytics_worker_control SET desired=?, revision=revision+1,"
                " changed_at=?, changed_by=? WHERE id=1",
                (desired, timestamp(), actor),
            )
            control = read_control(connection)
            control["changed"] = True
        else:
            control["changed"] = False
    return control


def _age(stamp, now):
    if not stamp:
        return None
    return max(0.0, (now - datetime.fromisoformat(stamp)).total_seconds())


def describe(storage, now=None):
    """What the website shows an admin: the requested state, the worker's, and its work."""
    now = now or datetime.now(UTC)
    with storage.connect(storage.root / "registry.sqlite3") as connection:
        control = read_control(connection)
        row = connection.execute("SELECT * FROM analytics_worker_status WHERE id=1").fetchone()
    status = dict(row) if row else None
    heartbeat = _age(status["heartbeat_at"], now) if status else None
    alive = heartbeat is not None and heartbeat <= UNAVAILABLE_SECONDS
    if status and status["observed"] == "exited":
        alive = False
    if not alive:
        state = "unavailable"
    elif control["desired"] == "stopped":
        acknowledged = status["acknowledged_revision"] >= control["revision"]
        state = "stopped" if acknowledged and status["observed"] == "stopped" else "stopping"
    elif status["acknowledged_revision"] < control["revision"] or status["observed"] == "starting":
        state = "starting"
    elif status["observed"] == "catching_up":
        state = "catching_up"
    else:
        state = "running"
    names = {game["id"]: game["name"] for game in storage.list_games()}
    # A game's problem stays shown until that game's work succeeds again, whatever the others do.
    errors = sorted(
        (
            {"game_id": game_id, "game": names.get(game_id), **problem}
            for game_id, problem in (json.loads(status["errors"]) if status else {}).items()
        ),
        key=lambda item: item["at"],
        reverse=True,
    )
    games = []
    for game_id, name in names.items():
        path = storage.game_path(game_id)
        if not path.exists():
            continue
        with storage.connect(path) as connection:
            games.append({"id": game_id, "name": name, **game_backlog(storage, connection, now)})
    return {
        "desired": control["desired"],
        "revision": control["revision"],
        "changed_at": control["changed_at"],
        "changed_by": control["changed_by"],
        "state": state,
        "worker": {
            "heartbeat_at": status["heartbeat_at"],
            "heartbeat_age_seconds": round(heartbeat, 1),
            "started_at": status["started_at"],
            "acknowledged_revision": status["acknowledged_revision"],
            "observed": status["observed"],
            "game_id": status["game_id"],
            "game": names.get(status["game_id"]),
            "job": status["job"],
        }
        if status
        else None,
        "last_success_at": status["last_success_at"] if status else None,
        "error": errors[0] if errors else None,
        "errors": errors,
        "pending": json.loads(status["pending"]) if status else {},
        "games": games,
        "read_mode": storage.settings.analytics_read_mode,
        "freshness_seconds": storage.settings.analytics_freshness_seconds,
    }


def game_backlog(storage, connection, now=None):
    """One game's derived-data state: facts progress, and what is waiting to be processed."""
    from . import views

    now = now or datetime.now(UTC)
    state = analytics.progress(connection)
    backlog = {"facts": state}
    backlog.update(views.backlog(storage, connection, now))
    return backlog


class Worker:
    """One worker process. run() loops until stop() (or SIGTERM); tick() is one iteration."""

    def __init__(self, storage, identity=None, clock=None):
        self.storage = storage
        self.identity = identity or f"{socket.gethostname()}:{os.getpid()}:{time.time():.0f}"
        self.clock = clock or (lambda: datetime.now(UTC))
        self.started_at = timestamp(self.clock())
        self.observed = "starting"
        self.acknowledged = 0
        self.job = (None, None)
        self.pending = {}
        self.last_success = None
        self.failing = {}  # game id -> {"message", "at"}, until that game succeeds again
        self._stopping = threading.Event()
        self._heartbeat_at = 0.0
        self._pending_at = 0.0
        self._audited = {}
        self._backoff = {}  # game id -> (monotonic time to retry, delay)
        self._turn = 0
        self.active = False  # whether this process holds the worker role
        self._written = None  # (observed, acknowledged, job) last written

    # ---- the loop

    def stop(self):
        self._stopping.set()

    def run(self):
        logger.info("analytics worker %s started", self.identity)
        while not self._stopping.is_set():
            try:
                worked = self.tick()
            except sqlite3.Error as error:  # the registry is busy or unavailable: try again
                logger.warning("analytics worker: %s", type(error).__name__)
                worked = False
            if not worked:
                self._stopping.wait(POLL_SECONDS)
        self._write_status(observed="exited", force=True)
        logger.info("analytics worker %s exited", self.identity)

    def tick(self):
        """Read the control, report, and do at most one bounded piece of work. True if it did."""
        control = self._control()
        if not self._claim():
            return False
        if control["desired"] == "stopped":
            self.observed = "stopped"
            self.acknowledged = control["revision"]
            self.job = (None, None)
            self._refresh_pending()
            self._write_status()
            return False
        self.acknowledged = control["revision"]
        worked = self._work(control["revision"])
        if not worked:
            self.job = (None, None)
        self._refresh_pending()
        self.observed = "catching_up" if self.pending.get("waiting") else "running"
        self._write_status(force=not worked)
        return worked

    def should_stop(self, revision):
        """Whether to stop the current piece of work: shutdown, or the control changed."""
        if self._stopping.is_set():
            return True
        return self._control()["revision"] != revision

    # ---- control, status and claim

    def _registry(self):
        return self.storage.connect(self.storage.root / "registry.sqlite3")

    def _control(self):
        with self._registry() as connection:
            return read_control(connection)

    def _claim(self):
        """Take the worker role unless another live worker has it."""
        with self._registry() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT worker, heartbeat_at, observed, errors "
                "FROM analytics_worker_status WHERE id=1"
            ).fetchone()
            if (
                row
                and row["worker"] != self.identity
                and row["observed"] != "exited"
                and _age(row["heartbeat_at"], self.clock()) <= UNAVAILABLE_SECONDS
            ):
                if self.active:
                    logger.warning("analytics worker %s: another worker took over", self.identity)
                self.active = False
                return False
            if not self.active:
                if row:
                    self.failing = json.loads(row["errors"])
                self._write(connection, observed=self.observed)
                self.active = True
        return True

    def _write_status(self, observed=None, force=False):
        if not self.active and observed != "exited":
            return
        changed = self._written != (observed or self.observed, self.acknowledged, self.job)
        if not (force or changed) and time.monotonic() - self._heartbeat_at < HEARTBEAT_SECONDS:
            return
        with self._registry() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT worker FROM analytics_worker_status WHERE id=1"
            ).fetchone()
            if row and row["worker"] != self.identity:
                return
            self._write(connection, observed=observed or self.observed)

    def _write(self, connection, observed):
        game_id, job = self.job
        connection.execute(
            """INSERT INTO analytics_worker_status (id, worker, started_at, heartbeat_at,
                   acknowledged_revision, observed, game_id, job, pending, last_success_at,
                   errors)
               VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET worker=excluded.worker,
                   started_at=excluded.started_at, heartbeat_at=excluded.heartbeat_at,
                   acknowledged_revision=excluded.acknowledged_revision,
                   observed=excluded.observed, game_id=excluded.game_id, job=excluded.job,
                   pending=excluded.pending,
                   last_success_at=coalesce(excluded.last_success_at, last_success_at),
                   errors=excluded.errors""",
            (
                self.identity,
                self.started_at,
                timestamp(self.clock()),
                self.acknowledged,
                observed,
                game_id,
                job,
                json.dumps(self.pending),
                self.last_success,
                json.dumps(self.failing),
            ),
        )
        self._heartbeat_at = time.monotonic()
        self._written = (observed, self.acknowledged, self.job)

    # ---- work

    def _work(self, revision):
        games = [game["id"] for game in self.storage.list_games()]
        if not games:
            return False
        for offset in range(len(games)):
            if self.should_stop(revision):
                return False
            game_id = games[(self._turn + offset) % len(games)]
            retry = self._backoff.get(game_id)
            if retry and time.monotonic() < retry[0]:
                continue
            if not self.storage.game_path(game_id).exists():
                continue
            try:
                worked = self._work_on(game_id, revision)
            except Exception as error:  # keep going with the other games; never log payloads
                self._failed(game_id, error)
                continue
            self._backoff.pop(game_id, None)
            if worked and game_id in self.failing:
                from . import views

                if not views.has_errors(self.storage, game_id):
                    self.failing.pop(game_id)
                    self._write_status(force=True)
            if worked:
                self._turn = (self._turn + offset + 1) % len(games)
                self.last_success = timestamp(self.clock())
                return True
        self._turn += 1
        return False

    def _failed(self, game_id, error):
        delay = min(MAX_BACKOFF, 2 * (self._backoff.get(game_id, (0, 1.0))[1]))
        self._backoff[game_id] = (time.monotonic() + delay, delay)
        message = f"{type(error).__name__}: {str(error)[:300]}"
        logger.warning(
            "analytics worker: game %s failed (%s), retry in %.0f s",
            game_id,
            type(error).__name__,
            delay,
        )
        self.failing[game_id] = {"message": message, "at": timestamp(self.clock())}
        self._write_status(force=True)

    def _work_on(self, game_id, revision):
        """One bounded piece of work on one game, under its lease. True if there was some."""
        from . import views

        path = self.storage.game_path(game_id)
        with self.storage.connect(path) as connection:
            if not self._lease(connection, game_id):
                return False
        try:
            began = time.monotonic()
            worked = False
            while True:  # facts first: copy and check older events, a step at a time
                with self.storage.connect(path) as connection:
                    state = analytics.progress(connection)
                    if state["ready"]:
                        break
                    self.job = (game_id, f"facts: {state['phase']}")
                    self._write_status()
                    connection.set_progress_handler(self._interrupt(revision), 10000)
                    analytics.step(
                        connection,
                        backfill_rows=self.storage.settings.analytics_batch_rows,
                    )
                worked = True
                if self.should_stop(revision) or time.monotonic() - began >= SLICE_SECONDS:
                    break
            if worked:
                return True
            if time.monotonic() - self._audited.get(game_id, 0) > AUDIT_SECONDS:
                self._audited[game_id] = time.monotonic()
                with self.storage.connect(path) as connection:
                    if analytics.audit(connection):
                        logger.warning(
                            "analytics worker: game %s has events without facts", game_id
                        )
                        return True
            return views.refresh(self, game_id, revision)
        except sqlite3.OperationalError as error:
            if str(error) == "interrupted" and self.should_stop(revision):
                return False
            raise
        finally:
            with self.storage.connect(path) as connection:
                self._release(connection)

    def _interrupt(self, revision):
        checked = 0.0

        def interrupt():
            nonlocal checked
            if time.monotonic() - checked < 0.1:
                return 0
            checked = time.monotonic()
            self._write_status()
            return int(self.should_stop(revision))

        return interrupt

    def _lease(self, connection, game_id):
        """Take this game's lease, unless another worker holds a live one."""
        connection.execute("BEGIN IMMEDIATE")
        meta = analytics.read_meta(connection)
        owner, until = meta.get("lease_owner"), meta.get("lease_until")
        now = self.clock()
        if owner and owner != self.identity and until and datetime.fromisoformat(until) > now:
            return False
        connection.executemany(
            "INSERT INTO analytics_meta (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [
                ("lease_owner", self.identity),
                ("lease_until", timestamp(now + timedelta(seconds=LEASE_SECONDS))),
            ],
        )
        return True

    def _release(self, connection):
        connection.execute("BEGIN IMMEDIATE")
        if analytics.read_meta(connection).get("lease_owner") == self.identity:
            connection.execute(
                "UPDATE analytics_meta SET value=NULL WHERE key IN ('lease_owner', 'lease_until')"
            )

    def _refresh_pending(self):
        if time.monotonic() - self._pending_at < PENDING_SECONDS:
            return
        self._pending_at = time.monotonic()
        waiting, facts_remaining, views_waiting, lag = 0, 0, 0, 0.0
        for game in self.storage.list_games():
            path = self.storage.game_path(game["id"])
            if not path.exists():
                continue
            with self.storage.connect(path) as connection:
                backlog = game_backlog(self.storage, connection, self.clock())
            facts = backlog["facts"]
            if not facts["ready"]:
                waiting += 1
                facts_remaining += max(0, facts["total"] - facts["done"])
            if backlog["views_waiting"]:
                waiting += 1
                views_waiting += backlog["views_waiting"]
            lag = max(lag, backlog["lag_seconds"] or 0.0)
        self.pending = {
            "waiting": waiting,
            "facts_remaining": facts_remaining,
            "views_waiting": views_waiting,
            "lag_seconds": round(lag, 1),
        }


def check_health(storage, now=None):
    """0 when this installation's worker heartbeat is recent (the container healthcheck)."""
    now = now or datetime.now(UTC)
    with storage.connect(storage.root / "registry.sqlite3") as connection:
        row = connection.execute(
            "SELECT heartbeat_at, observed FROM analytics_worker_status WHERE id=1"
        ).fetchone()
    if row is None or row["observed"] == "exited":
        return 1
    return 0 if _age(row["heartbeat_at"], now) <= UNAVAILABLE_SECONDS else 1


def main(arguments=None):
    """python -m avn_analytics.materialize [run|health]"""
    from .config import Settings
    from .storage import Storage

    command = (arguments if arguments is not None else sys.argv[1:]) or ["run"]
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    storage = Storage(Settings.from_env())
    if command[0] == "health":
        return check_health(storage)
    if command[0] != "run":
        raise SystemExit("usage: python -m avn_analytics.materialize [run|health]")
    storage.initialize()
    worker = Worker(storage)
    signal.signal(signal.SIGTERM, lambda *_: worker.stop())
    signal.signal(signal.SIGINT, lambda *_: worker.stop())
    worker.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
