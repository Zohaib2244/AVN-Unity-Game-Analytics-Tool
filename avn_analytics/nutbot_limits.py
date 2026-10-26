"""The agents' subscription windows ("63% of this week's allowance used"), best effort.

Claude: the sign-in in NutBot's home holds an OAuth token; the usage endpoint behind Claude
Code's `/usage` reports the 5-hour and 7-day windows. It is not a documented API, so a failure
only means "unknown". Codex: `codex app-server` answers `account/rateLimits/read` over JSON-RPC
with the same two windows. OpenCode has no windows of its own (limits are the provider's).
Answers are cached for a few minutes; nothing here ever counts against the allowance.
"""

import asyncio
import contextlib
import json
import os
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime

CACHE_SECONDS = 300
CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CODEX_SECONDS = 20


def _window(name, used_percent, resets_at, minutes=None):
    return {
        "name": name,
        "used_percent": None if used_percent is None else round(float(used_percent), 1),
        "resets_at": resets_at,
        "minutes": minutes,
    }


def _iso(value):
    if value in (None, ""):
        return None
    if isinstance(value, int | float):
        return datetime.fromtimestamp(float(value), UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(value)


def _window_name(minutes, fallback):
    if minutes is None:
        return fallback
    if minutes <= 360:
        return "5 hours"
    if minutes >= 10000:
        return "week"
    return f"{round(minutes / 60)} hours"


class Limits:
    def __init__(self, settings):
        self.settings = settings
        self.cache = {}

    async def read(self, harness_id, force=False):
        """{"windows": [...], "checked_at", "error"} for one agent, from the cache when fresh."""
        entry = self.cache.get(harness_id)
        if entry and not force and time.time() - entry["at"] < CACHE_SECONDS:
            return entry["result"]
        reader = {"claude": self._claude, "codex": self._codex}.get(harness_id)
        if reader is None:
            result = {"windows": [], "checked_at": None, "error": ""}
        else:
            try:
                windows = await reader()
                result = {
                    "windows": windows,
                    "checked_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "error": "",
                }
            except Exception as error:  # noqa: BLE001 - outside our control, best effort
                result = {"windows": [], "checked_at": None, "error": str(error)[:200]}
        self.cache[harness_id] = {"at": time.time(), "result": result}
        return result

    # ---- Claude

    def _claude_token(self):
        token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "").strip()
        if token:
            return token
        path = self.settings.nutbot_home / ".claude" / ".credentials.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return ""
        return str((data.get("claudeAiOauth") or {}).get("accessToken") or "")

    async def _claude(self):
        token = self._claude_token()
        if not token:
            raise RuntimeError("No Claude sign-in found")
        return await asyncio.to_thread(self._claude_fetch, token)

    def _claude_fetch(self, token):
        request = urllib.request.Request(
            CLAUDE_USAGE_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "avn-analytics-nutbot",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Claude usage endpoint answered {error.code}") from error
        return parse_claude_usage(data)

    # ---- Codex

    async def _codex(self):
        from .nutbot_acp import resolve_binary

        codex = resolve_binary(self.settings.nutbot_codex_bin, "codex")
        if not codex:
            raise RuntimeError("The codex command wasn't found")
        home = self.settings.nutbot_home
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(home),
            "CODEX_HOME": str(home / ".codex"),
            "NO_COLOR": "1",
        }
        process = await asyncio.create_subprocess_exec(
            codex,
            "app-server",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
            cwd=str(home),
        )
        try:
            async with asyncio.timeout(CODEX_SECONDS):
                return await self._codex_talk(process)
        finally:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(process.wait(), timeout=5)

    async def _codex_talk(self, process):
        def send(message):
            process.stdin.write((json.dumps(message) + "\n").encode())

        send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "avn-analytics",
                        "title": "AVN Analytics",
                        "version": "1",
                    }
                },
            }
        )
        send({"jsonrpc": "2.0", "method": "initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read"})
        await process.stdin.drain()
        while True:
            line = await process.stdout.readline()
            if not line:
                raise RuntimeError("codex app-server ended without an answer")
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("id") == 2:
                if message.get("error"):
                    raise RuntimeError(str(message["error"].get("message", "error"))[:160])
                return parse_codex_limits(message.get("result") or {})


def parse_claude_usage(data):
    windows = []
    for key, name, minutes in (("five_hour", "5 hours", 300), ("seven_day", "week", 10080)):
        block = data.get(key)
        if isinstance(block, dict):
            windows.append(
                _window(name, block.get("utilization"), _iso(block.get("resets_at")), minutes)
            )
    return windows


def parse_codex_limits(result):
    limits = result.get("rateLimits") or {}
    windows = []
    for slot in ("primary", "secondary"):
        block = limits.get(slot)
        if not isinstance(block, dict):
            continue
        minutes = block.get("windowDurationMins", block.get("window_duration_mins"))
        used = block.get("usedPercent", block.get("used_percent"))
        resets = block.get("resetsAt", block.get("resets_at"))
        windows.append(_window(_window_name(minutes, slot), used, _iso(resets), minutes))
    return windows
