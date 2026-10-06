import os
from dataclasses import dataclass
from pathlib import Path


def _text(name, default=""):
    return os.environ.get(name, "").strip() or default


def _flag(name, default):
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() not in ("0", "false", "no", "off")


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    admin_token: str = ""
    max_body_bytes: int = 1_048_576
    requests_per_minute: int = 120
    max_export_bytes: int = 268_435_456
    public_ingest_url: str = ""
    # Team access. Enabled when both the Cloudflare Access team domain and the application's
    # audience tag are set; otherwise every request is an admin (the original single-user mode).
    access_team_domain: str = ""  # e.g. example.cloudflareaccess.com
    access_audience: str = ""  # the Access application's "Application Audience (AUD) Tag"
    admin_email: str = ""  # always an admin; can't be removed or demoted from the website
    lan_admin: bool = True  # requests from the private network (no Cloudflare) count as admin
    # NutBot: an assistant that drives the dashboard through a local AI agent CLI (claude, opencode,
    # codex). Which people may use it is set per workspace by an admin.
    nutbot_enabled: bool = True
    nutbot_internal_url: str = "http://127.0.0.1:8000"  # how the agent CLI reaches this app
    nutbot_daily_limit: int = 100  # messages per person per day
    nutbot_run_seconds: int = 300  # longest a single answer may take
    nutbot_default_harness: str = "claude"
    nutbot_claude_bin: str = ""  # path or glob of the claude binary; empty = look on PATH
    nutbot_claude_model: str = "claude-sonnet-5-5"
    nutbot_opencode_bin: str = ""
    nutbot_opencode_model: str = ""  # e.g. anthropic/claude-sonnet-5-5
    nutbot_codex_bin: str = ""
    nutbot_codex_model: str = ""
    nutbot_allow_codex: bool = False  # codex can't be limited to this app's tools: opt in

    def __post_init__(self):
        if self.max_body_bytes < 1 or self.requests_per_minute < 1 or self.max_export_bytes < 1:
            raise ValueError("Invalid storage or request limits")

    @property
    def nutbot_home(self):
        return self.data_dir / "nutbot" / "home"

    @property
    def access_enabled(self):
        return bool(self.access_team_domain and self.access_audience)

    @classmethod
    def from_env(cls):
        return cls(
            data_dir=Path(os.environ.get("AVN_DATA_DIR", "./data")).resolve(),
            admin_token=os.environ.get("AVN_ADMIN_TOKEN", ""),
            max_body_bytes=int(os.environ.get("AVN_MAX_BODY_BYTES", "1048576")),
            requests_per_minute=int(os.environ.get("AVN_REQUESTS_PER_MINUTE", "120")),
            max_export_bytes=int(os.environ.get("AVN_MAX_EXPORT_BYTES", "268435456")),
            public_ingest_url=os.environ.get("AVN_PUBLIC_INGEST_URL", "").rstrip("/"),
            access_team_domain=os.environ.get("AVN_ACCESS_TEAM_DOMAIN", "")
            .strip()
            .removeprefix("https://")
            .rstrip("/"),
            access_audience=os.environ.get("AVN_ACCESS_AUDIENCE", "").strip(),
            admin_email=os.environ.get("AVN_ADMIN_EMAIL", "").strip().lower(),
            lan_admin=os.environ.get("AVN_LAN_ADMIN", "true").strip().lower()
            not in ("0", "false", "no", "off"),
            nutbot_enabled=_flag("AVN_NUTBOT", True),
            nutbot_internal_url=os.environ.get("AVN_NUTBOT_INTERNAL_URL", "http://127.0.0.1:8000")
            .strip()
            .rstrip("/"),
            nutbot_daily_limit=int(os.environ.get("AVN_NUTBOT_DAILY_LIMIT", "100")),
            nutbot_run_seconds=int(os.environ.get("AVN_NUTBOT_RUN_SECONDS", "300")),
            nutbot_default_harness=os.environ.get("AVN_NUTBOT_DEFAULT_HARNESS", "claude").strip(),
            nutbot_claude_bin=os.environ.get("AVN_NUTBOT_CLAUDE_BIN", "").strip(),
            nutbot_claude_model=os.environ.get(
                "AVN_NUTBOT_CLAUDE_MODEL", "claude-sonnet-5-5"
            ).strip(),
            nutbot_opencode_bin=os.environ.get("AVN_NUTBOT_OPENCODE_BIN", "").strip(),
            nutbot_opencode_model=os.environ.get("AVN_NUTBOT_OPENCODE_MODEL", "").strip(),
            nutbot_codex_bin=os.environ.get("AVN_NUTBOT_CODEX_BIN", "").strip(),
            nutbot_codex_model=os.environ.get("AVN_NUTBOT_CODEX_MODEL", "").strip(),
            nutbot_allow_codex=_flag("AVN_NUTBOT_ALLOW_CODEX", False),
        )
