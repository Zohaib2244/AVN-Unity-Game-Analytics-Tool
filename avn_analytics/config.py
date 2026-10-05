import os
from dataclasses import dataclass
from pathlib import Path


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

    def __post_init__(self):
        if self.max_body_bytes < 1 or self.requests_per_minute < 1 or self.max_export_bytes < 1:
            raise ValueError("Invalid storage or request limits")

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
        )
