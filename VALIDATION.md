# Validation — 2026-10-04

- 37 automated tests passed using Python 3.14.4 and SQLite 3.51.3.
- Ruff lint and formatting checks passed.
- Docker image built successfully, including the checksum-verified SQLite build.
- Both Compose services started with the configured non-root users, read-only
  filesystems, shared data bind mount and health checks.
- An HTTP smoke test against the running containers verified bearer-token API
  access, absence of admin routes on ingest, game registration, committed
  ingestion, duplicate retries, ZIP/JSONL export and key revocation.
- The running container reported SQLite 3.51.3.
- Temporary validation containers and their network were stopped and removed.
  The `avn-analytics:validation` image remains locally for inspection.

The test suite emitted one upstream Starlette deprecation warning about its httpx
test adapter. No tests failed. The native test process used a locally built SQLite
library under the workspace's `work/` directory; no system library was replaced.

The management website was also exercised in Chromium against isolated live
admin/ingest processes. Verified direct local access, game registration, ingestion,
event dictionary editing, downloadable ZIP contents, key creation and revocation,
all navigation pages and mobile layout. No JavaScript or browser console errors
remained. Event descriptions containing HTML were displayed as text. Test games were
confined to the isolated test database.

Website API tests additionally cover direct loopback access, Origin/hostname
protection for writes, bearer-token access for non-local clients, no stored browser
credentials and separation from the ingest service.

See `DEPLOYMENT.md` for installing it on your own server.

After deployment, Chromium loaded the real website from `http://127.0.0.1:8101/`
and verified direct local access. Both deployed containers passed their health
checks, and the existing bearer-token API checks still passed.

Not verified: Cloudflare routing/rules, Unity delivery behavior, sustained production
load, hardware power-loss durability, or the physical replacement drive. No public
service was exposed and no actual player events were collected.
