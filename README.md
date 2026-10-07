# AVN Analytics

A **self-hosted event analytics pipeline for Unity games**. Collect your game's events into your own database, then export them for whatever you want to do with them:

- **AI agent analysis**: hand a day, week or month of events (plus a data dictionary) to an AI agent such as Claude or Codex and ask it what to change in your game.
- **Built-in dashboards**: a game overview, funnels and player journeys, computed live on your own server.
- **Custom dashboards**: load the same exports into DuckDB, pandas, Grafana, Metabase or your own tooling.

You own the data, there is no per-event cost, and there is no vendor lock-in. The built-in dashboards cover the everyday questions; for anything deeper, export the raw events and use whatever tool you like.

## Features

- **Drop-in Unity SDK** shaped like Firebase's `LogEvent(name, params)`, so migrating is a find-and-replace.
- **Reliable by design**: events are written to disk first, sent in batches, retried with backoff, and deduplicated by the server. Offline play, app kills and server downtime lose nothing.
- **One isolated SQLite database per game**, with API keys you can issue and delete at any time.
- **Agent-friendly exports** for any range of up to 366 days: Parquet and gzipped JSONL, a data dictionary (`events.md`), an AI guide (`ANALYSIS.md`) and a manifest, in one ZIP. Exports can be filtered like the dashboards.
- **Private management website**, organized game-first: pick a game (Android and iOS versions together), then see its overview, funnels, players, exports, dictionary, keys and settings. See [Dashboards](#dashboards).
- **Rich context on every event**: device, user, session, app version, build, platform, environment, client and server time, ordering sequence and country.
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
| `environment` | Optional: `production`, `development`, `editor`… Lets the dashboards hide test data (see [Environments and filters](#environments-and-filters)) |
| `client_ts` | Device time, normalized to UTC and corrected for measured clock skew by the SDK |
| `server_ts` | Server receipt time |
| `country` | ISO country code derived by the server from the request IP; coarse, never GPS, and clients cannot set it |

The SDK needs no location permission on Android or iOS. Because country is derived from the IP address, check your store privacy disclosures.

## Team access and workspaces

For a team, put the admin site behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) and set the `AVN_ACCESS_*` variables (see [`DEPLOYMENT.md`](DEPLOYMENT.md#team-access)). Two lists work together, and both must include a person:

1. **Cloudflare** decides who can reach the site at all (add their email to the Access policy).
2. **The Team page** decides what they can do. Anyone who signs in through Cloudflare but isn't listed (or has no workspace) sees a "no access" page that names the admin to contact.

**Workspaces** keep sets of games and people apart, for example work and personal projects. Every game belongs to exactly one workspace, and roles belong to a workspace, so one person can be a lead in one and a member in another. There is always at least one workspace; the first start creates "Default" and puts every existing game and person in it (rename it on the Workspaces page).

| | Admin (every workspace) | Team lead (their workspace) | Member (their workspace) |
| --- | --- | --- | --- |
| View dashboards, funnels, players, exports | ✓ | ✓ | ✓ (assigned games only) |
| Edit funnels and the event dictionary | ✓ | ✓ | ✓ |
| See and copy API keys | ✓ | ✓ | ✓ |
| Register, edit, archive, delete games; icons; create and delete keys | ✓ | ✓ | ✗ |
| Choose which members see a game | ✓ | ✓ | ✗ |
| Create, rename, delete workspaces; move games between them | ✓ | ✗ | ✗ |
| Add people, set roles, read the activity log | ✓ | ✗ | ✗ |

- A workspace is invisible to people who aren't in it: its games, keys and data behave as if they didn't exist, even by direct link. Admins see everything and switch workspace from the sidebar.
- **Moving a game** (Game settings, admin only) moves its other platform version too, with its events, keys, funnels and dictionary. Collection keeps working because keys don't change. Members' per-game access is cleared, and a move is refused if the destination already has a game with the same name and platform.
- **Deleting a workspace** (admin only, type its name to confirm) either moves all its games to another workspace or deletes them (their files go to `data/deleted`, not erased). The last workspace can't be deleted.
- Removing someone from a workspace keeps their other workspaces; removing them from the team blocks them at once.
- `AVN_ADMIN_EMAIL` is always an admin and can't be removed. Requests from your own network (no Cloudflare) count as an admin; turn that off with `AVN_LAN_ADMIN=false`. A request that came through Cloudflare never gets that pass: it must carry a valid Access token, which the server verifies against Cloudflare's published keys (signature, expiry, audience and issuer). The admin token still works for scripts.
- The activity log records changes to games, keys, workspaces, people, access, the dictionary and exports.
- With the `AVN_ACCESS_*` variables empty, everything behaves as before: every request is an admin.

## Dashboards

The website is organized around games. The home page lists your games; Android and iOS versions that share a **name** appear as one game with a platform switch. Open a game to get its own menu:

| Page | What it shows |
| --- | --- |
| **Overview** | Players, new players, sessions and events; daily active users (DAU on the last day, average and peak DAU, WAU, MAU, stickiness); activity per day (players per day is the DAU); a tabbed breakdown by environment, app version, build, country and platform (click a row to filter by it); top events. |
| **Funnels** | Steps you define, in order (up to 100): how many players reach each one, who stops where, and how long it takes. Below it, **Journeys** shows what players did between two steps in plain words, grouped into the most common journeys, plus where players stop. |
| **Levels** | Per level: players who started and finished it, completion, tries per player, fails, median time, power-ups used and where players stop. Open a level with its arrow to see the players behind it: those who quit mid-level, finished it and then stopped, kept going, got stuck, or just started it, each with a link to their story up to or from that level. |
| **Players** | Everyone active in the chosen days, searchable and sortable (last active, first seen, events, sessions, app version). **Event rules** add your own columns from events (times they did something, highest/lowest/total of a parameter, first/last time), sort by them, and keep only players who did, or never did, an event. Countries show their full name on hover. Open a player for their **story**: sessions as chapters, with runs of levels folded into one line ("Played levels 1–10, completed all"). The raw event list is one click away. |
| **Exports** | Download the raw events, using the same days and filters. |
| **Event dictionary** | Describe each event and its parameters. |
| **API keys** | Create, copy and delete the game's collection keys. |
| **Game settings** | Game icon, game details, archive (pause collection) and delete. |

**Game icons:** add one when registering a game or later in Game settings. Any image works; the browser crops it to a square 256×256 PNG before uploading, and it applies to both platforms of the game. Icons are stored in `data/icons/` (a deleted game's icon is moved to `data/deleted/` with it) and fall back to the game's initials when none is set.

To register the other platform of a game, use the **+ iOS** / **+ Android** link on the game card or in the sidebar: it pre-fills the name and bundle ID. Use exactly the same game name so the two versions are grouped.

Everything is computed live from the game's event database, in game time (`client_ts`, UTC). A player is identified by `user_id` when the game sets one, otherwise by the per-install `device_id`. Results are reused for 30 seconds in the browser; the ↻ button in the top bar refetches everything.

### Environments and filters

Every game page has the same filter bar: a days menu (presets, a calendar for any range, and ‹ › to step through time) and a **Filters** menu for environment, app version, build, country and platform. Active filters show as chips you can click to remove, and they are remembered per game in your browser.

**Editor and development data is hidden by default** ("Hide editor & development data" in the Filters menu). An event's environment is, in order of precedence:

1. the `environment` sent with its batch (`context.environment`) or event;
2. the environment recorded for its session from the `environment` param of that session's `session_start` event, so every event of a session is covered without the SDK repeating it;
3. `editor`, when the platform is `editor` (Unity Editor builds);
4. otherwise `unknown` (events from before environments existed).

Environments are stored per session in a `sessions` table in each game's database (existing data is backfilled from `session_start` events the first time the server starts).

### Funnels

A funnel is two to twenty steps. A step is an event name, optionally with a parameter condition: `=`, `≠`, `>`, `≥`, `<`, `≤`, `contains` or "any value" (numbers are compared numerically when both sides are numbers). Steps can have an optional name, and "Level steps…" adds Started/Completed steps for a range of levels in one go.

Each player (or each session, if you choose "Within one session") is matched against the steps in order, taking the first event that fits each step, using game time. Options:

- **Count:** per player across all their sessions, or within one session (each player's best session).
- **Finish within:** only count players who reach later steps within 15 minutes to 30 days of step 1.
- **Break down by:** environment, version, build, country or platform; shows conversion per segment, using each player's step 1 event.

The result shows how many players reached each step, the share of step 1 and of the previous step, the biggest drop, the time between steps (median and 90th percentile, with average, fastest and slowest on hover), and the time to complete the whole funnel. "N stopped here" lists up to 50 of the most recent players who stopped at a step, linking to their journeys. Results can be downloaded as CSV. Funnels can be saved by name (stored in the game's database, so they are the same on every device).

Limits: a funnel refuses ranges with more than 5 million matching events, and a player journey shows the first 5,000 events of the chosen days. Player and filter queries scan the chosen days, which is instant for typical data and may take seconds with millions of events.

## NutBot

NutBot is a chat assistant on every game page. You ask in plain words ("where do players drop off in the first ten levels?"); it runs funnels, follows journeys, reads player stories and level numbers, and answers with the real figures. It can also save a funnel or rename events in the dictionary, but only after you say yes, and only for people who may change things. When it builds a funnel or finds a player worth reading, it adds a button that opens it in the dashboard.

**How it works.** The server starts a local AI agent CLI (Claude Code, OpenCode or Codex) for each message and gives it this app's tools over MCP. The CLI's own tools (shell, files, web) are switched off, so it can only call the tools below; each one runs as the person who asked and only sees the games they may see. Answers stream back to the browser. The agent CLI uses your own subscription or keys; the server needs no API key of its own.

| Tool | What it does |
| --- | --- |
| `get_context`, `list_events` | The game, the dashboard's range and filters, the event dictionary, the events and parameters seen. |
| `get_overview`, `get_level_progress` | Totals, DAU/WAU/MAU and breakdowns; per-level completion, tries, time and where players leave. |
| `run_funnel`, `get_journeys`, `list_journey_players` | Funnels and the journeys between two steps, and who took them. |
| `get_player_story`, `find_players` | A player's sessions in readable lines; player search. |
| `save_funnel`, `set_event_label` | Change data. Need a team lead or admin, and a yes from the user. |
| `show_in_dashboard` | Adds an "open this" button to the answer. |

**Who can use it.** An admin sets this per workspace on the **Workspaces** page: *Admins only*, *Admins + leads* (default) or *Everyone in it*. People without access see NutBot locked. Messages are limited per person per day (`AVN_NUTBOT_DAILY_LIMIT`), one answer runs at a time per person, and each answer is stopped after `AVN_NUTBOT_RUN_SECONDS`. Starting a chat and every change NutBot makes go in the activity log.

**Setting it up.**

1. Make a CLI available inside the admin container: bind-mount its binary folder and point `AVN_NUTBOT_CLAUDE_BIN` at it (see `deploy/nutbot.compose.example.yaml`).
2. Sign it in once. Either run `claude setup-token` on a machine where you are signed in and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, or sign in inside the container: `docker compose exec -it admin sh -c 'HOME=/data/nutbot/home "$(ls -d /opt/nutbot/claude/* | tail -1)" auth login'`. The sign-in is kept in `data/nutbot/home`.
3. Open **Workspaces** and choose who may use it.

Claude (default model `claude-sonnet-5-5`, others selectable in the panel) is the supported, tested assistant. OpenCode works through the same tools with built-in tools disabled; set `AVN_NUTBOT_OPENCODE_BIN` and a model such as `anthropic/claude-sonnet-5-5` plus that provider's key. Codex is off unless `AVN_NUTBOT_ALLOW_CODEX=true` because it can't be limited to this app's tools. Don't point NutBot at an agent that has a shell.

## Exporting data

Each export is a ZIP containing:

- `events.parquet`: one row per event with typed columns (best for analysis tools; params flattened to `param_<name>` columns).
- `events.jsonl.gz`: the same events as JSON lines, ordered by time and `event_id`.
- `events.md`: a data dictionary of every event name, its parameters (observed types plus the descriptions you registered) and the SDK-generated events. Handing this to an AI agent greatly improves its answers.
- `ANALYSIS.md`: a guide for AI assistants working with the export.
- `manifest.json`: period, filters, counts and ordering.

```bash
curl -H "Authorization: Bearer $AVN_ADMIN_TOKEN" -o export.zip \
  "http://127.0.0.1:8101/v1/games/$GAME_ID/export?date=2026-10-04&period=week&basis=client_ts"
```

On the **Exports** page the days and filters work exactly as in the dashboards, with a live count of the events that will be exported. Over the API, `period` is `day`, `week` (Monday start), `month` or `custom` (with `end_date`, up to 366 days), all in UTC. The filter parameters `env`, `not_env`, `version`, `build`, `country` and `platform` can be repeated, for example `&not_env=editor&not_env=development`. `basis` is `server_ts` (arrival time, the default) or `client_ts` (when it happened, useful for events delivered late after offline play). Use the **Event dictionary** page of the website, or `PUT /v1/games/{id}/dictionary/{event}`, to describe each event.

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
| Missing, wrong or deleted key | 401 | Retry rarely |
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
| List / register games | `GET` / `POST /v1/games` (`?workspace=<id>`, `workspace_id` in the body) |
| List / issue keys | `GET` / `POST /v1/games/{id}/keys` |
| Delete key | `DELETE /v1/games/{id}/keys/{key_id}` |
| Set / read / remove game icon | `PUT` (raw PNG body, 16–1024 px, up to 512 KB) / `GET` / `DELETE /v1/games/{id}/icon` |
| Define / read event dictionary | `PUT /v1/games/{id}/dictionary/{event}`, `GET /v1/games/{id}/dictionary` |
| Arrival counts | `GET /v1/games/{id}/health?date=2026-10-04&period=week` (accepts the filter parameters) |
| Download export | `GET /v1/games/{id}/export?date=2026-10-04&period=day&basis=client_ts` |
| Filter menu values | `GET /v1/games/{id}/insights/facets?start=2026-10-01&end=2026-10-31` |
| Overview numbers | `GET /v1/games/{id}/insights/summary?start=…&end=…` (accepts the filter parameters) |
| Event and parameter catalog | `GET /v1/games/{id}/insights/catalog?start=…&end=…` |
| Run a funnel | `POST /v1/games/{id}/insights/funnel` (steps, `scope`, `window_hours`, `breakdown`, `filters`) |
| Players / one player's events | `GET /v1/games/{id}/insights/players?start=…&end=…`, `GET /v1/games/{id}/insights/journey?player=…&start=…&end=…` |
| Saved funnels | `GET` / `POST /v1/games/{id}/insights/funnels`, `PUT` / `DELETE /v1/games/{id}/insights/funnels/{funnel_id}` |
| Players behind a level | `GET /v1/games/{id}/insights/levels/players?start=…&end=…&level=20&group=left` (`left`, `finished_stopped`, `kept_going`, `stuck`, `started`; also `sort`, `offset`, `limit`, and the filter parameters) |
| A player's story up to / from a level | `GET /v1/games/{id}/insights/story?player=…&start=…&end=…&level=20&cut=until` (or `from`) |
| Environment fixes (lead, admin) | `GET` / `POST /v1/games/{id}/environment-fixes`, `DELETE /v1/games/{id}/environment-fixes/{fix_id}`: count what a build reported as `development` as `production`, without touching stored events |
| Who am I, my workspaces and roles | `GET /v1/me` |
| Workspaces (admin) | `GET` / `POST /v1/workspaces`, `PATCH /v1/workspaces/{id}`, `DELETE /v1/workspaces/{id}?confirm=<name>&move_to=<id>` (or `&delete_games=true`) |
| Move a game (admin) | `POST /v1/games/{id}/move` with `{"workspace_id": …}` |
| People (admin) | `GET` / `POST /v1/team`, `PATCH /v1/team/{email}`, `DELETE /v1/team/{email}?workspace_id=…`, `GET /v1/audit` |
| Who can see a game (admin, lead) | `GET` / `PUT /v1/games/{id}/access` |
| API schema | `GET /openapi.json` |

The filter parameters are `env`, `not_env`, `version`, `build`, `country` and `platform`; each may be repeated.

A batch may carry a shared `context` (`user_id`, `device_id`, `session_id`, `app_version`, `build`, `platform`, `environment`) that the server merges into each event; an event's own value wins. Stored rows always have the full envelope. Requests may be gzipped (`Content-Encoding: gzip`); the body limit applies both before and after inflating.

Event names start with a letter and contain letters, digits or underscores (80 max). Parameters allow at most 50 string or number values; no nesting, null, boolean, NaN or infinity. Strings are limited to 1,024 characters and integers to signed 64 bits. Unknown envelope fields are rejected so typos do not silently lose data.

## Security notes

- With team access on, every admin endpoint checks the caller's role and game access on the server; hiding buttons in the website is only a convenience.
- The API key ships inside the game build, so treat it as an **identifier, not a secret**. Protect the endpoint with rate limits (120 requests per key per minute by default) and body limits, and add edge rate limiting.
- Keys are random 256-bit values. Authorization checks a SHA-256 hash, but the dashboard also keeps each new key's full value in the registry so it can be copied again later, so anyone with access to the dashboard or to `data/registry.sqlite3` can read the keys. Keys created before this was added have only a hash and cannot be copied; create a new key if you need one. Deleting a key removes it entirely, and a deleted key is rejected with 401. Events belong to the game, not to the key, so deleting a key never touches collected data.
- Only `POST /v1/events` should be reachable publicly. The management website and admin API stay on a private port, protected by an admin token or by whatever sits in front of it (a VPN, SSH forwarding, or an access gateway such as Cloudflare Access).
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
| `AVN_NUTBOT*` | see `.env.example` | NutBot assistant: agent CLI paths, default model, daily limit |

## Storage layout

```text
data/
  registry.sqlite3       games, API keys, rate-limit counters, team, game access, activity log
  games/<uuid>.sqlite3   raw events, dictionary, session environments and saved funnels for one game
  icons/<uuid>.png       game icons
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

The tests cover duplicate retries, concurrent writes, game isolation, key deletion, validation and limits, funnels, players and journeys, environment filters, filtered exports, rate limiting across instances, export periods and timezones, storage failures, dictionary output, country handling and data-directory relocation.

## Roadmap

- Retention policy and a backup schedule.
- Retention and archiving of old raw events.
- Retention curves and a faster index for very large games.
- Tuning rate limits from real device counts, plus load and power-loss testing.
