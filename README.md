# AVN Analytics

A **self-hosted event analytics pipeline for Unity games**. Collect your game's events into your own database, then export them for whatever you want to do with them:

- **AI agent analysis**: hand a day, week or month of events (plus a data dictionary) to an AI agent such as Claude or Codex and ask it what to change in your game.
- **Custom dashboards**: load the same exports into DuckDB, pandas, Grafana, Metabase or your own tooling.

You own the data, there is no per-event cost, and there is no vendor lock-in. The system deliberately ships **no built-in charts or funnels**: it collects reliably and exports cleanly.

## Features

- **Drop-in Unity SDK** shaped like Firebase's `LogEvent(name, params)`, so migrating is a find-and-replace.
- **Reliable by design**: events are written to disk first, sent in batches, retried with backoff, and deduplicated by the server. Offline play, app kills and server downtime lose nothing.
- **One isolated SQLite database per game**, with hashed API keys and key rotation or revocation.
- **Agent-friendly exports** by day, week or month: gzipped JSONL, a data dictionary (`events.md`) and a manifest, in one ZIP.
- **Private management website** to register games, manage keys, edit the event dictionary, check arrivals and download exports.
- **Rich context on every event**: device, user, session, app version, platform, client and server time, ordering sequence and country.
- **Small footprint**: FastAPI plus SQLite, runs happily on a home server or Raspberry Pi class machine.

## How it works

```
Unity game (AVN SDK)
   |  batched HTTPS POST, API key in header
   v
Reverse proxy / tunnel (e.g. Cloudflare Tunnel)   <- only POST /v1/events is public
   v
Ingest API  ->  one SQLite database per game
                      |
Admin API + website (private)  ->  export ZIP: events.jsonl.gz + events.md + manifest.json
```

Two separate applications share the same data directory:

| Service | Purpose | Exposure |
| --- | --- | --- |
| Ingest (`:8100`) | Receives event batches, validates and stores them | Public, through a proxy or tunnel |
| Admin (`:8101`) | Management website and admin API, exports | Private (localhost, SSH forward or your own proxy) |

## Quick start

Requires Docker with Compose.

```bash
cp .env.example .env
mkdir -p data && chmod 700 data
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'   # put this in AVN_ADMIN_TOKEN
id -u; id -g                                                    # put these in AVN_UID / AVN_GID
chmod 600 .env
docker compose up -d --build
curl --fail http://127.0.0.1:8100/healthz
```

Open `http://127.0.0.1:8101`, choose an admin password on the first visit, register a game and copy its API key. For a remote machine, use an SSH forward (`ssh -N -L 8101:127.0.0.1:8101 user@host`) rather than publishing the admin port.

## Unity SDK

The SDK lives in [`unity/AVNAnalytics`](unity/AVNAnalytics) (Unity 2020.1+, no dependencies). Copy the folder into `Assets/`, then:

```csharp
using Avn.Analytics;

AvnAnalytics.Initialize(new AvnConfig {
    Endpoint = "https://analytics.example.com/v1/events",
    ApiKey   = "YOUR_GAME_KEY",
});

AvnAnalytics.LogEvent("level_complete",
    new AvnParameter("level", 3),
    new AvnParameter("duration_seconds", 42.5));
```

See the [SDK README](unity/AVNAnalytics/README.md) for the persistence design, test harness and configuration.

### Events collected automatically

| Event | When | Notable params |
| --- | --- | --- |
| `first_open` | Once per install | |
| `session_start` | Launch, or return after 30+ minutes away | `session_number`, language, timezone offset, device model, OS version, device type, screen size |
| `session_end` | Logged when the *next* session starts, stamped with the last time the app was alive | `duration_seconds` (foreground time), `session_number` |

Every event also carries `seq`, a per-session counter for exact ordering.

## Event format

Every stored event has the same envelope, which makes funnels, retention, session and progression analysis straightforward:

| Field | Meaning |
| --- | --- |
| `event_id` | Client-generated UUID, used for deduplication |
| `name`, `params` | Event name and up to 50 string/number parameters |
| `user_id`, `device_id` | Optional player ID and a random per-install ID (at least one required) |
| `session_id` | Random per-session ID |
| `app_version`, `build`, `platform` | Build context |
| `client_ts` | Device time, normalized to UTC and corrected for measured clock skew by the SDK |
| `server_ts` | Server receipt time |
| `country` | ISO country code derived by the server from the request IP; coarse, never GPS, and clients cannot set it |

The SDK needs no location permission on Android or iOS. Because country is derived from the IP address, check your store privacy disclosures.

## Exporting data

Each export is a ZIP containing:

- `events.jsonl.gz`: one event per line, ordered by time and `event_id`.
- `events.md`: a data dictionary of every event name, its parameters (observed types plus the descriptions you registered) and the SDK-generated events. Handing this to an AI agent greatly improves its answers.
- `manifest.json`: period, counts and ordering.

```bash
curl -H "Authorization: Bearer $AVN_ADMIN_TOKEN" -o export.zip \
  "http://127.0.0.1:8101/v1/games/$GAME_ID/export?date=2026-10-04&period=week&basis=client_ts"
```

`period` is `day`, `week` (Monday start) or `month`, all in UTC. `basis` is `server_ts` (arrival time, the default) or `client_ts` (when it happened, useful for events delivered late after offline play). Use the **Event dictionary** page of the website, or `PUT /v1/games/{id}/dictionary/{event}`, to describe each event.

Query an export with DuckDB without loading it into memory:

```sql
SELECT name, count(*) FROM read_json_auto('events.jsonl.gz') GROUP BY 1 ORDER BY 2 DESC;
```

Treat event text as untrusted data when giving exports to AI agents.

## Reliability

**Client:** every event is written to a local file before anything else; a batch is deleted only after the server acknowledges it; one request is in flight at a time (50 events per batch by default); flushes happen when a batch fills, every 2 minutes by default (configurable), and on app pause or launch; request bodies are gzipped and carry the shared context (device, user, session, build) once per batch instead of per event, which cuts upload size roughly 5x; failures are retried with exponential backoff and jitter and honor `Retry-After`; invalid batches are split to isolate and quarantine the bad event; the on-disk queue is capped (10,000 events or 5 MB).

**Server:** inserts are idempotent on `event_id`, responses are sent only after the database commit, oversized or malformed batches are rejected whole, and SQLite runs in WAL mode with full synchronous writes.

| Condition | Status | Client behavior |
| --- | --- | --- |
| Committed batch (including duplicates) | 200 | Remove from the local queue |
| Invalid JSON or schema | 400 | Split and quarantine, never retry forever |
| Missing, wrong or revoked key | 401 | Retry rarely |
| Body over 1 MiB or batch over 500 events | 413 / 400 | Reduce batch size |
| Unsupported `Content-Encoding` (only identity and gzip are accepted) | 415 | Send plain or gzip JSON |
| Corrupt gzip, or a body that inflates past the size limit | 400 / 413 | Fix or reduce the batch |
| Per-key rate limit | 429 | Honor `Retry-After`, back off with jitter |
| Database failure | 503 | Honor `Retry-After`, keep the queue |

## Admin API

Every private endpoint needs `Authorization: Bearer $AVN_ADMIN_TOKEN` (or a website session). Register a game; the raw key is returned **once**:

```bash
curl --fail-with-body http://127.0.0.1:8101/v1/games \
  -H "Authorization: Bearer $AVN_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"My Game","bundle_id":"com.example.mygame","platform":"android"}'
```

Bundle ID plus platform is unique; register iOS separately for a separate database. Send a test event:

```bash
curl --fail-with-body http://127.0.0.1:8100/v1/events \
  -H "X-API-Key: $GAME_KEY" -H 'Content-Type: application/json' \
  -d '{"events":[{"event_id":"5ef8a227-1206-4715-b46a-79521b21494e","name":"level_complete",
       "params":{"level":3},"device_id":"install-id","session_id":"s1","app_version":"1.0.0",
       "build":"1","platform":"android","client_ts":"2026-10-04T09:00:00Z"}]}'
```

| Operation | Endpoint |
| --- | --- |
| List / register games | `GET` / `POST /v1/games` |
| List / issue keys | `GET` / `POST /v1/games/{id}/keys` |
| Revoke key | `DELETE /v1/games/{id}/keys/{key_id}` |
| Define / read event dictionary | `PUT /v1/games/{id}/dictionary/{event}`, `GET /v1/games/{id}/dictionary` |
| Arrival counts | `GET /v1/games/{id}/health?date=2026-10-04&period=week` |
| Download export | `GET /v1/games/{id}/export?date=2026-10-04&period=day&basis=client_ts` |
| API schema | `GET /openapi.json` |

A batch may carry a shared `context` (`user_id`, `device_id`, `session_id`, `app_version`, `build`, `platform`) that the server merges into each event; an event's own value wins. Stored rows always have the full envelope. Requests may be gzipped (`Content-Encoding: gzip`); the body limit applies both before and after inflating.

Event names start with a letter and contain letters, digits or underscores (80 max). Parameters allow at most 50 string or number values; no nesting, null, boolean, NaN or infinity. Strings are limited to 1,024 characters and integers to signed 64 bits. Unknown envelope fields are rejected so typos do not silently lose data.

## Security notes

- The API key ships inside the game build, so treat it as an **identifier, not a secret**. Protect the endpoint with rate limits (120 requests per key per minute by default) and body limits, and add edge rate limiting.
- Keys are random 256-bit values, stored only as SHA-256 hashes.
- Only `POST /v1/events` should be reachable publicly. The management website and admin API stay on a private port, with hashed passwords, expiring server-side sessions, `SameSite=Strict` cookies and origin checks.
- Use random installation IDs, not hardware identifiers, and update your store privacy disclosures if you collect device, user or country data.

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AVN_ADMIN_TOKEN` | none | Admin API bearer token (32+ characters, required for the admin service) |
| `AVN_DATA_DIR` | `./data` | Where databases are stored |
| `AVN_REQUESTS_PER_MINUTE` | `120` | Per-key rate limit |
| `AVN_MAX_BODY_BYTES` | `1048576` | Largest accepted request body |
| `AVN_HOST_DATA_DIR` | `./data` | Host folder holding all data |
| `AVN_UID` / `AVN_GID` | `1000` | User that owns the data folder |
| `AVN_BIND_HOST` | `127.0.0.1` | Address the ports bind to (`0.0.0.0` = all interfaces) |
| `AVN_INGEST_PORT` / `AVN_ADMIN_PORT` | `8100` / `8101` | Host ports |
| `AVN_MAX_EXPORT_BYTES` | `268435456` | Largest raw export |

## Storage layout

```text
data/
  registry.sqlite3       games, hashed keys, rate-limit counters, website credentials
  games/<uuid>.sqlite3   raw events and dictionary for one game
  exports/               temporary downloads
```

Raw events are kept indefinitely; there is no retention job or deletion endpoint yet, so watch your disk space. To move or back up the data, stop both services and copy the **whole** directory (SQLite may hold committed data in `-wal` sidecar files). Keep the data on a local filesystem, not SMB or NFS. Clients simply queue events during the downtime.

## Public exposure (Cloudflare Tunnel example)

Any reverse proxy or tunnel works if it forwards only `POST /v1/events` to the ingest port and answers 404 to everything else; example configs for Cloudflare Tunnel, Caddy and nginx are in [`DEPLOYMENT.md`](DEPLOYMENT.md). When using Cloudflare, country detection reads the `CF-IPCountry` header, which Cloudflare adds and a reverse proxy such as Caddy forwards by default. Verify that the header reaches the ingest service in your setup. Without it, `country` is stored as `null`. See [`DEPLOYMENT.md`](DEPLOYMENT.md) for a full self-hosting guide.

## Development

Python 3.12+ and a SQLite build with the WAL-reset fix (3.51.3+, or the 3.44.6 / 3.50.7 backports); the Docker image compiles a pinned version.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

The tests cover duplicate retries, concurrent writes, game isolation, key revocation, validation and limits, rate limiting across instances, export periods and timezones, storage failures, dictionary output, country handling and data-directory relocation.

## Roadmap

- Retention policy and a backup schedule.
- Parquet export if JSONL.gz is not enough.
- Tuning rate limits from real device counts, plus load and power-loss testing.
