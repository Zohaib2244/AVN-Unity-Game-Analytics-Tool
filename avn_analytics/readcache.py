"""A short-lived cache for the dashboard's slow reads.

Most dashboard pages count events from scratch, which takes seconds on a busy game. The same
answer is asked for again and again (opening the page, coming back to it, a filter menu), so
it is kept for a little while. A new event shows up when the time is over; a change to the
event dictionary, an environment fix or the analysis thresholds starts a new answer at once.
"""

import json
import threading
import time


class ReadCache:
    def __init__(self, seconds, entries):
        self.seconds = seconds
        self.entries = entries
        self._items = {}
        self._building = {}
        self._lock = threading.Lock()

    def clear(self):
        with self._lock:
            self._items.clear()

    def get(self, storage, game_id, parts, compute):
        """compute() once for these parts of this game, then reuse it until the time is over.

        Two requests for the same answer wait for one computation instead of each running one.
        The result is shared, so callers must not change it. An error is never kept.
        """
        if self.seconds <= 0:
            return compute()
        key = (
            str(storage.game_path(game_id)),
            _fingerprint(storage, game_id),
            json.dumps(parts, sort_keys=True, default=str),
        )

        def fresh():
            hit = self._items.get(key)
            return hit if hit and time.monotonic() - hit[0] <= self.seconds else None

        with self._lock:
            hit = fresh()
            if hit:
                return hit[1]
            building = self._building.setdefault(key, threading.Lock())
        with building:
            with self._lock:
                hit = fresh()
            if hit:
                return hit[1]
            try:
                value = compute()
            finally:
                with self._lock:
                    self._building.pop(key, None)
            with self._lock:
                self._items[key] = (time.monotonic(), value)
                oldest = sorted(self._items, key=lambda item: self._items[item][0])
                for stale in oldest[: max(0, len(self._items) - self.entries)]:
                    self._items.pop(stale, None)
            return value


def _fingerprint(storage, game_id):
    """What the answers depend on besides the events, so that changing it starts over."""
    definitions = storage.get_dictionary(game_id)  # also refuses a game that doesn't exist
    with storage.connect(storage.game_path(game_id)) as connection:
        fixes = [
            tuple(row)
            for row in connection.execute(
                "SELECT id, from_environment, to_environment, app_version, build "
                "FROM environment_fixes ORDER BY id"
            )
        ]
    thresholds = tuple(sorted(storage.analytics_thresholds(game_id).items()))
    return (hash(json.dumps(definitions, sort_keys=True, default=str)), tuple(fixes), thresholds)
