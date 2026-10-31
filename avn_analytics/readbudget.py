"""Stops a dashboard read once nobody is waiting for it.

A slow page used to keep counting after the browser had given up on it (it waits a minute, then
shows an error), and whoever opened the next page queued behind that work on the same CPU. Now
each dashboard read has a budget: it is spent when the browser disconnects, or when the read has
run for AVN_READ_DEADLINE_SECONDS. A statement that is running when the budget is spent is
interrupted by SQLite (see Storage.connect) and the request ends with a 504.

Only reads are covered: the insights pages and the mapping status. Writes, exports, ingest and
NutBot never run under a budget, so nothing is interrupted half way through a change.
"""

import asyncio
import contextvars
import threading
import time

CHECK_EVERY = 100_000  # SQLite virtual machine steps between two looks at the budget (a few ms)

_current = contextvars.ContextVar("avn_read_budget", default=None)

# POST requests that only read (a funnel is described in the body, so it is not a GET).
READ_POSTS = (
    "/insights/funnel",
    "/insights/journeys",
    "/insights/journeys/players",
    "/insights/player-groups",
    "/insights/events/activity",
)


class Budget:
    def __init__(self, seconds):
        self.deadline = time.monotonic() + seconds if seconds else None
        self.abandoned = threading.Event()  # the browser has gone

    def spent(self):
        if self.abandoned.is_set():
            return True
        return self.deadline is not None and time.monotonic() > self.deadline


def watch(connection):
    """Let the current request's budget interrupt statements on this connection.

    Returns the budget (None outside a budgeted request, where nothing is interrupted)."""
    budget = _current.get()
    if budget is not None:
        connection.set_progress_handler(lambda: 1 if budget.spent() else 0, CHECK_EVERY)
    return budget


def is_read(scope):
    path, method = scope["path"], scope["method"]
    if not path.startswith("/v1/games/"):
        return False
    if method == "GET":
        return "/insights/" in path or path.endswith(("/mappings", "/mappings/status"))
    return method == "POST" and path.endswith(READ_POSTS)


class ReadBudget:
    """ASGI wrapper that gives each dashboard read a budget and notices the browser going away."""

    def __init__(self, app, seconds, max_body_bytes):
        self.app = app
        self.seconds = seconds
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not is_read(scope):
            await self.app(scope, receive, send)
            return
        budget = Budget(self.seconds)
        token = _current.set(budget)
        messages = asyncio.Queue()

        async def watch_browser():
            # Nothing else listens while a read runs in its thread, so this does. What the browser
            # sends is passed on to the app unchanged, up to the body limit (which then refuses it).
            queued = 0
            while True:
                message = await receive()
                messages.put_nowait(message)
                if message["type"] == "http.disconnect":
                    budget.abandoned.set()
                    return
                queued += len(message.get("body", b""))
                if queued > self.max_body_bytes:
                    return

        async def passed_on():
            if budget.abandoned.is_set() and messages.empty():
                return {"type": "http.disconnect"}
            return await messages.get()

        watcher = asyncio.create_task(watch_browser())
        try:
            await self.app(scope, passed_on, send)
        finally:
            watcher.cancel()
            _current.reset(token)
