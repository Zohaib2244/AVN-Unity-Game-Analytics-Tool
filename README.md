# AVN Analytics server

Standalone analytics for the AVNS server (the Kini PC, hostname `avns2`): FastAPI
ingestion, a private admin API, one SQLite event database per game, and agent-friendly
downloads. It is independent of AVNs Hub. The local installation lives at
`/opt/docker/avn-analytics`, with data on the main SSD under
`/opt/docker/avn-analytics/data`. See `DEPLOYMENT.md` for the installed service.

## Quick reference

| Purpose | Address or location |
| --- | --- |
| Game event endpoint | `https://gameanalytics.avns.site/v1/events` |
| Private management website | `http://127.0.0.1:8101/` |
| Private admin API | `http://127.0.0.1:8101/v1/...` |
| Local ingest health check | `http://127.0.0.1:8100/healthz` |
| Live service files | `/opt/docker/avn-analytics` |
| Persistent data | `/opt/docker/avn-analytics/data` |

Games send only batched `POST` requests to the public endpoint. The management
website is intentionally not public: use it on the AVNS server or through an SSH
port forward. `gameanalytics.avns.site` exposes no dashboard pages, health route,
schema, exports or admin API.

## Decisions from the plan

- Use FastAPI and SQLite, with WAL and `synchronous=FULL`. Responses acknowledge
  events only after their transaction commits. Duplicate UUIDs keep the first row.
- Store everything under one configurable directory on the current system disk.
  No dedicated drive is needed now. Moving the directory later preserves games,
  keys, dictionary entries and deduplication IDs.
- Provide separate public-ingest and private-admin applications. Public ingestion
  has no admin routes. Registering games, keys, health counts and exports use the
  private API and the standalone management website on port 8101.
- Start with JSONL.gz. Each download is a ZIP containing `events.jsonl.gz`,
  `events.md` and `manifest.json`. Parquet is deferred.
- Keep raw events indefinitely for now; no automatic deletion. A 1 GiB free-space
  reserve pauses ingestion with a retryable 503. Backups and disk monitoring remain
  necessary; the reserve is a guard, not a quota or a guarantee against disk exhaustion.
- Default exports to server arrival time. Select `basis=client_ts` to study when
  offline events occurred. All periods are UTC; weeks start Monday, and months are
  calendar months. Start is inclusive, end is exclusive.

## Run with Docker Compose

Requires Docker Engine and Compose. Run commands from this directory.

These are fresh-install instructions. The AVNS installation already has generated
credentials and a data directory; use `DEPLOYMENT.md` to operate that installation.

```bash
cp .env.example .env
mkdir -p data
chmod 700 data
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
id -u
id -g
```

Put the generated token in `AVN_ADMIN_TOKEN` in `.env`, and set `AVN_UID` / `AVN_GID`
to the printed IDs. The blank token intentionally prevents starting an unconfigured
admin service. Keep the token out of game builds and source control. Set permissions:

```bash
chmod 600 .env
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8100/healthz
```

`AVN_HOST_DATA_DIR=./data` uses the disk holding this project. On the AVNS server,
the installed project's data directory is on its main SSD. Both containers
mount it at `/data`; the SQLite files have no embedded drive paths. An absolute host
directory also works, but create it first and ensure the configured UID can write it.

Ports bind to loopback only:

| Service | Address | Access |
| --- | --- | --- |
| Ingest | `127.0.0.1:8100` | Public only through the tunnel |
| Admin | `127.0.0.1:8101` | Localhost / SSH forwarding plus bearer token |

Use an SSH forward from your workstation if administering a remote host:

```bash
ssh -N -L 8101:127.0.0.1:8101 nutmag2469@avns2
```

The supplied setup uses one process per service, non-root users, bounded
concurrency, memory limits and rotating Docker logs. Keep the admin service at one
worker so its one-export-at-a-time generation limit remains effective.

## Management website

Open `http://127.0.0.1:8101` on the server. On the first visit, choose an admin
password (at least 12 characters). You do not need the `.env` token to use the
website. The pages include Overview, Games, API keys, Exports, Event dictionary,
Server status and Settings. Registration, key creation/revocation, dictionary
editing and ZIP downloads operate on the real backend. Settings displays server
configuration; drive changes and retention remain operator tasks.

The website uses hashed passwords and hashed, expiring server-side sessions with
HttpOnly, SameSite=Strict cookies. Sign-out revokes the session. Browser writes
require a matching local Origin. First-time setup is only available until a
password has been configured; keep the management service bound to localhost.
The browser never receives the server's admin API token. Existing bearer-token
API clients continue to work. Website credentials and sessions live in the
registry database and move with the data directory.

For remote private administration, SSH-forward port 8101 and visit its localhost
address. Public Cloudflare routing remains reserved for ingestion, not the admin
website. The allowed browser hosts are localhost, 127.0.0.1 and ::1.

## API examples

Set `AVN_ADMIN_TOKEN` in your shell to the same token as `.env` before running admin
requests. The examples use `GAME_ID` and `GAME_KEY` from registration responses.

Register a game; the raw initial key is returned once:

```bash
curl --fail-with-body http://127.0.0.1:8101/v1/games \
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
curl --fail-with-body http://127.0.0.1:8100/v1/events \
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

| Operation | Private endpoint |
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
sign-in assets are public on the private admin port; game data is protected.

Define an event and export:

```bash
curl --fail-with-body -X PUT \
  "http://127.0.0.1:8101/v1/games/$GAME_ID/dictionary/level_complete" \
  -H "Authorization: Bearer $AVN_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"description":"Player finished a level","params":{"level":"One-based level number","duration_seconds":"Time spent in this attempt"}}'

curl --fail-with-body \
  "http://127.0.0.1:8101/v1/games/$GAME_ID/export?date=2026-10-04&period=day&basis=client_ts" \
  -H "Authorization: Bearer $AVN_ADMIN_TOKEN" \
  -o pilot-export.zip
```

Exports read a consistent SQLite snapshot, stream rows to a temporary archive on
the data drive, and delete it after delivery. Raw exports are capped at 256 MiB;
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
| Database failure / low free space | 503 | Honor `Retry-After`, retain queue |

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
Keep the admin site at `http://127.0.0.1:8101` or behind SSH forwarding.

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

## Development and validation

The Docker image compiles checksum-pinned SQLite 3.51.3 and verifies Python loads it.
SQLite documents a concurrent WAL-reset corruption bug fixed in that version;
startup rejects older unpatched versions, including the 3.46.1 initially found in
the host and base container. Supported older fix branches are 3.44.6 and 3.50.7.
See [SQLite's WAL-reset advisory](https://www.sqlite.org/wal.html#walreset).

For native execution, Python must also load a supported SQLite library. Check with
`python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'`; use the Docker image if
your system library is too old. The application does not change system libraries.

Use Python 3.12+ and a venv (on Debian/Ubuntu, install the matching python3-venv
package if missing):

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/ruff check .
.venv/bin/ruff format --check .
```

For native execution, set `AVN_DATA_DIR` to the full data directory and
`AVN_ADMIN_TOKEN` for the admin process. Start each application in its own terminal:

```bash
.venv/bin/uvicorn avn_analytics.api:create_ingest_app --factory --host 127.0.0.1 --port 8100
.venv/bin/uvicorn avn_analytics.api:create_admin_app --factory --host 127.0.0.1 --port 8101
```

The tests cover duplicate retries, concurrent writes, game isolation, key revocation,
request validation/limits, rate limiting across instances, export periods/timezones,
disk/storage failures, dictionary output and data-directory relocation.

## Remaining rollout work

- Supply the public analytics hostname and tunnel configuration for game clients.
- Build the Unity SDK's durable queue and run a pilot alongside Firebase.
- Tune limits from actual device counts and batching behavior; perform load and
  power-loss testing on the target hardware. Existing tests are correctness checks.
- Choose a retention/deletion policy and backup schedule before collecting real
  player data. This version has no deletion endpoint or retention job.
- Add Parquet if JSONL.gz is insufficient; avoid extra dependencies until needed.
