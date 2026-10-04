# AVN Analytics

Self-hosted analytics for Unity games: FastAPI services that collect game events
into SQLite and a small website to manage games, API keys and event dictionaries and
to download exports (JSONL.gz plus a dictionary).

Two services run from one image:

| Service | Default port | Purpose |
| --- | --- | --- |
| Ingest | 8100 | Receives `POST /v1/events` from games (API key per game) |
| Admin | 8101 | Management website and admin API (password / bearer token) |

Expose only the ingest service to the internet; keep the admin service private or
behind your own reverse proxy.

## Deploy

```bash
cp .env.example .env     # then edit it
mkdir -p data            # or whatever AVN_HOST_DATA_DIR points to
docker compose up -d --build --wait
```

Settings in `.env`:

| Variable | Purpose |
| --- | --- |
| `AVN_HOST_DATA_DIR` | Host folder where all data is stored (mounted at `/data`) |
| `AVN_UID` / `AVN_GID` | User that owns the data folder |
| `AVN_ADMIN_TOKEN` | Required secret for the admin API |
| `AVN_BIND_HOST` | Address the ports bind to (default `127.0.0.1`) |
| `AVN_INGEST_PORT` / `AVN_ADMIN_PORT` | Host ports (defaults 8100 / 8101) |
| `AVN_REQUESTS_PER_MINUTE` | Per-key rate limit (default 120) |
| `AVN_MAX_EXPORT_BYTES` | Maximum raw export size (default 256 MiB) |

All data (games, events, website password, sessions) lives in the data folder, so
backing up or moving that folder is all that is needed. It must be on a local
filesystem (SQLite WAL). Keep backups; there is no automatic retention or deletion.

Open the admin website (`http://localhost:8101` by default). On first visit, choose
an admin password. Passwords are hashed, sessions are hashed and expire, and cookies
are HttpOnly/SameSite=Strict. Browser writes must come from the website's own origin.
The browser never receives the admin API token; bearer-token API clients still work.

## API examples

Set `AVN_ADMIN_TOKEN` in your shell to the same token as `.env` before running admin
requests. The examples use `GAME_ID` and `GAME_KEY` from registration responses.

Register a game; the raw initial key is returned once:

```bash
curl --fail-with-body http://localhost:8101/v1/games \
  -H "Authorization: Bearer $AVN_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Pilot Game","bundle_id":"com.avn.pilot","platform":"android"}'
```

Bundle ID plus platform is unique. Register iOS separately if it should have a
separate database. UUID game IDs prevent bundle IDs from becoming filesystem paths.
Keys are random 256-bit values; only SHA-256 hashes and short display prefixes are
stored. An embedded game key is an identifier that can be extracted and abused; it
does not establish that an event came from a genuine player.

Send events:

```bash
curl --fail-with-body http://localhost:8100/v1/events \
  -H "X-API-Key: $GAME_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"events":[{
    "event_id":"5ef8a227-1206-4715-b46a-79521b21494e",
    "name":"level_complete",
    "params":{"level":3,"duration_seconds":42.5},
    "device_id":"random-install-id",
    "session_id":"random-session-id",
    "app_version":"1.0.0",
    "build":"1",
    "platform":"android",
    "client_ts":"2026-10-04T09:00:00Z"
  }]}'
```

The response is `{"accepted":1,"duplicates":0,"server_ts":"..."}`. Retrying the
same UUID returns `accepted:0, duplicates:1`. A 200 acknowledges the entire batch,
including previously committed duplicates. Validation failure rejects the whole
batch; the client must not discard queued events on transport failures or 5xx.

Event names start with a letter and contain only letters, digits or underscores
(80 characters max). At least one of `user_id` / `device_id` is required. Use random
installation IDs rather than hardware identifiers. Every event requires session,
version, string-valued build, platform and a timezone-aware ISO client timestamp.
The server normalizes client time to UTC but does not rewrite clock skew.
Parameters allow at most 50 string/number values; no nested values, null, boolean,
NaN or infinity. Strings are limited to 1,024 characters, integers to signed 64-bit.
Unknown envelope fields are rejected so misspellings do not silently lose data.

| Operation | Admin endpoint |
| --- | --- |
| List games | `GET /v1/games` |
| Register game + initial key | `POST /v1/games` |
| List key metadata | `GET /v1/games/{id}/keys` |
| Issue additional key | `POST /v1/games/{id}/keys` with `{"label":"release-2"}` |
| Revoke key | `DELETE /v1/games/{id}/keys/{key_id}` |
| Define event meaning | `PUT /v1/games/{id}/dictionary/{event_name}` |
| Read dictionary | `GET /v1/games/{id}/dictionary` |
| Arrival counts | `GET /v1/games/{id}/health?date=2026-10-04&period=week` |
| Download export | `GET /v1/games/{id}/export?date=2026-10-04&period=day&basis=client_ts` |
| Machine-readable API schema | `GET /openapi.json` |

Every private data endpoint, including `/healthz` and the schema, requires
`Authorization: Bearer ...` or an authenticated website session. Website pages and
sign-in assets are public on the admin port; game data is protected.

Define an event and export:

```bash
curl --fail-with-body -X PUT \
  "http://localhost:8101/v1/games/$GAME_ID/dictionary/level_complete" \
  -H "Authorization: Bearer $AVN_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"description":"Player finished a level","params":{"level":"One-based level number","duration_seconds":"Time spent in this attempt"}}'

curl --fail-with-body \
  "http://localhost:8101/v1/games/$GAME_ID/export?date=2026-10-04&period=day&basis=client_ts" \
  -H "Authorization: Bearer $AVN_ADMIN_TOKEN" \
  -o pilot-export.zip
```

Exports read a consistent SQLite snapshot, stream rows to a temporary archive in
the data directory, and delete it after delivery. Raw exports are capped at 256 MiB;
choose shorter periods if a week/month exceeds it. If a day exceeds it, an operator
must raise the cap or implement finer time ranges. Dictionaries include registered
meanings and observed parameter types; missing meanings are marked `UNDOCUMENTED`.
Observed schemas are capped at 1,000 names and 100 parameter names per event, with
truncation flagged in the manifest. Raw rows are never truncated. Event text and
dictionary descriptions are untrusted input when providing exports to AI agents.

## Limits and retries

| Condition | HTTP status | Client behavior |
| --- | --- | --- |
| Committed batch or duplicates | 200 | Remove this batch from local queue |
| Invalid JSON/schema | 400 | Quarantine/fix; do not retry forever |
| Missing, wrong or revoked key | 401 | Retry rarely; check configuration |
| Body over 1 MiB or batch over 500 events | 413 / 400 | Reduce batch size |
| Compressed request body | 415 | Send uncompressed JSON |
| Per-key limit | 429 | Honor `Retry-After`, back off with jitter |
| Database failure | 503 | Honor `Retry-After`, retain queue |

The default rate limit is 120 requests per key per UTC minute, shared across
processes and persisted across restarts. This is a fixed-window limit and allows a
boundary burst. A key shared by many game installations needs tuning after a pilot;
120 is a starting value, not a fleet capacity promise. Unauthenticated and malformed
traffic also needs edge rate limiting. Requests are byte-limited even without a
Content-Length header; compressed request bodies are rejected.

## Cloudflare Tunnel

`deploy/cloudflared.example.yml` is a template for a **host-installed** cloudflared
connector. Set the tunnel ID, credentials path and real analytics hostname. It routes
only `/v1/events` to port 8100 and ends with a 404 catch-all. Keep port 8101 out of the
public tunnel. If cloudflared runs in a container, its localhost is different; use
host networking on Linux or an explicitly configured private container network.

Create the hostname route in your Cloudflare account, enforce HTTPS at the edge,
and add suitable request rate rules before a pilot. Available rule features depend
on your Cloudflare plan; the application does not assume a paid rule feature.
Validate the connector config with `cloudflared tunnel ingress validate`.
No tunnel, DNS record, credentials or edge policy is created by this implementation.
See [Cloudflare ingress configuration](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/).

### AVNS public ingestion route

The AVNS server uses its existing Caddy and remotely managed Cloudflare Tunnel. The
public hostname is `gameanalytics.avns.site`. Caddy accepts only `POST /v1/events` for
that hostname and proxies it to the private ingest container over Docker networking.
Every other method and path returns 404. The dashboard/admin website is never routed
through Cloudflare.

In Cloudflare Zero Trust, add a Public Hostname to the existing AVNS tunnel:

| Field | Value |
| --- | --- |
| Subdomain | `gameanalytics` |
| Domain | `avns.site` |
| Type | `HTTP` |
| URL | `192.168.1.24:80` |

Cloudflare will create the corresponding DNS record. Verify it resolves, then test a
request without a key: `curl -i -X POST https://gameanalytics.avns.site/v1/events` should
return 401. Use `https://gameanalytics.avns.site/v1/events` as the Unity SDK endpoint.
Keep the admin site at `http://localhost:8101` or behind SSH forwarding.

## Storage layout and moving to another drive

```text
data/
  registry.sqlite3       games, hashed keys, shared rate-limit counters
  games/<uuid>.sqlite3   raw events and dictionary for that game
  exports/               temporary downloads
```

SQLite may also create `-wal` and `-shm` sidecars. Do not copy a live `.sqlite3` file
alone: committed data can still be in its WAL. Keep both services stopped for the
whole-directory migration. SQLite WAL requires a local filesystem; do not move
these databases to SMB/NFS. See [SQLite WAL documentation](https://www.sqlite.org/wal.html).

1. Mount the new local drive, for example at `/mnt/avn-data`, with enough capacity.
2. Run `docker compose stop` and ensure no other process writes to these databases.
3. Copy the **entire** current data directory (including sidecars if present) into
   an empty `/mnt/avn-data/analytics` directory, preserving file ownership. For
   example, `rsync -a ./data/ /mnt/avn-data/analytics/` when using the default source.
4. Set `AVN_HOST_DATA_DIR=/mnt/avn-data/analytics` in `.env`. Keep the original copy.
5. Run `docker compose up -d --force-recreate`, check both health checks, list games,
   and compare a known day's event counts/export before reopening traffic.
6. After verifying backups and the new location, retire the old copy deliberately.

Client queues will retry during the short downtime. Rollback is a config switch
only **before** new writes reach the new drive; afterwards preserve/merge those
writes before switching back. Use the same stop-and-copy procedure for backups,
store copies on a different physical device, and periodically test restoring one.
Copying data to another directory on the same SSD is not disk-failure protection.

An interrupted export can leave a temporary ZIP. With admin stopped, remove stale
`.zip` files from `data/exports/`; they contain no unique data. Never remove database
sidecars while a service may be using them.

## Development

Use Python 3.12+ with a SQLite library of version 3.44.6, 3.50.7 or 3.51.3+ (older
versions have a WAL-reset bug; startup rejects them). The Docker image builds a
patched SQLite. Check native SQLite with
`python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'`.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/ruff check .
```

To run natively, set `AVN_DATA_DIR` and `AVN_ADMIN_TOKEN`, then:

```bash
.venv/bin/uvicorn avn_analytics.api:create_ingest_app --factory --port 8100
.venv/bin/uvicorn avn_analytics.api:create_admin_app --factory --port 8101
```
