# Self-hosting guide

How to run AVN Analytics on your own machine: a home server, a mini PC, a Raspberry Pi class
board or a small VPS. Allow about 15 minutes, plus extra for exposing it to the internet.

You run two services from one image, sharing one data directory:

| Service | Port | Who may reach it |
| --- | --- | --- |
| **Ingest**: receives event batches from games | `8100` | The public internet, through a proxy or tunnel. Only `POST /v1/events`. |
| **Admin**: management website, admin API, exports | `8101` | You only (localhost, an SSH forward or a VPN). Never publish it. |

## 1. Requirements

- Linux (any distro) with **Docker Engine and the Compose plugin**.
- About 1 GB RAM free and local disk space (an event is roughly 0.5 KB on disk). Use a local filesystem, not NFS or SMB.
- A way to reach the ingest service from the internet if your games are not on your LAN: a domain name plus a Cloudflare Tunnel, or a reverse proxy with TLS (section 4).

No Docker? See [Running without Docker](#running-without-docker).

## 2. Install

```bash
git clone <this repository> avn-analytics && cd avn-analytics

cp .env.example .env
mkdir -p data && chmod 700 data

python3 -c 'import secrets; print(secrets.token_urlsafe(48))'   # copy this output
id -u; id -g                                                    # note both numbers
```

Edit `.env`:

| Variable | What to set |
| --- | --- |
| `AVN_ADMIN_TOKEN` | The random token you just generated (32+ characters). The admin service refuses to start without it. |
| `AVN_UID` / `AVN_GID` | The numbers from `id -u` / `id -g`, so the containers can write `data/`. |
| `AVN_HOST_DATA_DIR` | Where data lives. `./data` is fine; an absolute path also works if you create it first and the UID can write to it. |
| `AVN_REQUESTS_PER_MINUTE` | Per-API-key rate limit. Default 120; raise it if many players share one key. |
| `AVN_BIND_HOST` | Address the ports bind to. Default `127.0.0.1` (this machine only); use `0.0.0.0` to listen on all interfaces, for example when a proxy on another host forwards to it. |
| `AVN_INGEST_PORT` / `AVN_ADMIN_PORT` | Host ports. Defaults 8100 and 8101. |
| `AVN_MAX_EXPORT_BYTES` | Largest raw export. Default 256 MiB. |

Keep the token out of game builds and source control, then start:

```bash
chmod 600 .env
docker compose up -d --build --wait
docker compose ps
curl --fail http://127.0.0.1:8100/healthz        # {"status":"ok",...}
```

The first build compiles a pinned SQLite (the server refuses SQLite versions with a known WAL-reset corruption bug), so it takes a few minutes. By default both ports bind to `127.0.0.1` only (`AVN_BIND_HOST`), so nothing is exposed yet.

## 3. First use

1. Open **`http://127.0.0.1:8101`** on that machine (or from your workstation: `ssh -N -L 8101:127.0.0.1:8101 you@your-server`, then open the same address locally).
2. On the first visit, choose an admin password (12+ characters). Browser sign-in is separate from the `.env` token, which is for scripts.
3. **Games, Register a game**: enter a name, bundle ID (`com.example.mygame`) and platform (`android`, `ios`...). Register iOS and Android separately if you want separate databases.
4. Copy the **API key**. It is shown once; you can issue more later (rotate by creating a new key, shipping it, then revoking the old one).
5. Optionally describe your events on the **Event dictionary** page. These descriptions end up in every export.

Send a test event from the server itself:

```bash
curl --fail-with-body http://127.0.0.1:8100/v1/events \
  -H "X-API-Key: YOUR_GAME_KEY" -H 'Content-Type: application/json' \
  -d '{"events":[{"event_id":"5ef8a227-1206-4715-b46a-79521b21494e","name":"test_event",
       "params":{"n":1},"device_id":"test-device","session_id":"s1","app_version":"1",
       "build":"1","platform":"android","client_ts":"2026-01-01T00:00:00Z"}]}'
# {"accepted":1,"duplicates":0,"server_ts":"..."}   (run it again: accepted 0, duplicates 1)
```

## 4. Let your games reach it

Games only ever call `POST https://your-domain/v1/events`. Whatever you choose must:

- terminate **HTTPS** (mobile platforms require it),
- forward **only** `POST /v1/events` to `127.0.0.1:8100`, answering 404 to everything else,
- never route anything to port `8101`.

### Option A: Cloudflare Tunnel (no open ports at home)

Good for home servers behind NAT. You need a domain on Cloudflare and `cloudflared` installed.

**Dashboard-managed tunnel:** in Cloudflare Zero Trust, *Networks, Tunnels*, add a **Public Hostname** to your tunnel: subdomain/domain such as `analytics.example.com`, type `HTTP`, URL `127.0.0.1:8100` (or the address of whatever proxy sits in front, see option B). A dashboard hostname forwards every path, so to keep other paths closed also put a proxy in front (option B), or add a Cloudflare WAF rule that blocks anything except `POST /v1/events`.

**Config-file tunnel:** a `config.yml` that routes only `/v1/events` to port 8100 and ends with a 404 catch-all:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /etc/cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: analytics.example.com
    path: ^/v1/events$
    service: http://127.0.0.1:8100
  - service: http_status:404
```

Check it with `cloudflared tunnel ingress validate`.

If `cloudflared` runs in a container, `127.0.0.1` is the container itself; use host networking or a shared Docker network instead.

### Option B: Reverse proxy with TLS

**Caddy** (gets certificates automatically):

```caddyfile
analytics.example.com {
    @ingest {
        method POST
        path /v1/events
    }
    handle @ingest {
        reverse_proxy 127.0.0.1:8100
    }
    handle {
        respond 404
    }
}
```

**nginx** (add your own TLS config or certbot):

```nginx
server {
    listen 443 ssl;
    server_name analytics.example.com;
    # ssl_certificate ... ssl_certificate_key ...

    client_max_body_size 1m;

    location = /v1/events {
        limit_except POST { deny all; }
        proxy_pass http://127.0.0.1:8100;
    }
    location / { return 404; }
}
```

If your proxy runs **in Docker**, join it to the ingest service's network instead of using `127.0.0.1`: `docker compose -f compose.yaml -f compose.proxy.example.yaml up -d` (edit the network name in that file) and proxy to `http://avn-analytics-ingest:8000`.

### Verify it

```bash
curl -i -X POST https://analytics.example.com/v1/events            # 401: reachable, key missing
curl -i https://analytics.example.com/                            # 404: nothing else exposed
curl -i https://analytics.example.com/openapi.json                # 404
```

### Edge rate limiting

The app rate-limits per API key, but the key ships in your game, so junk traffic with bad keys still reaches your server. Add a rate-limit rule at your edge (Cloudflare WAF rate limiting, or `limit_req` in nginx) for `/v1/events`.

### Country data

The server fills each event's `country` from the `CF-IPCountry` header, which Cloudflare adds to proxied requests. Reverse proxies such as Caddy and nginx pass it through. Without Cloudflare in front, `country` is `null`. The header is trusted as-is, so only expose the ingest service through your proxy and not directly.

## 5. Connect the Unity SDK

Copy `unity/AVNAnalytics` into your project's `Assets/` folder and initialize it with your endpoint and key:

```csharp
AvnAnalytics.Initialize(new AvnConfig {
    Endpoint = "https://analytics.example.com/v1/events",
    ApiKey   = "YOUR_GAME_KEY",
});
```

Use the demo component in the SDK folder to test. Confirm arrival on the website's Overview or Games page.

## 6. Exports

Open a game, then its **Exports** page. Choose the days (up to 366), optional filters (environment, app version, build, country, platform; editor and development data is hidden by default) and a time basis (`server_ts` = arrival, `client_ts` = when it happened). You get a ZIP with `events.parquet`, `events.jsonl.gz`, `events.md` (the data dictionary), `ANALYSIS.md` (a guide for AI assistants) and `manifest.json`. Scripted version:

```bash
set -a; . ./.env; set +a
curl -H "Authorization: Bearer $AVN_ADMIN_TOKEN" -o export.zip \
  "http://127.0.0.1:8101/v1/games/$GAME_ID/export?date=2026-10-04&period=week&basis=client_ts&not_env=editor"
```

Hand the ZIP to an AI agent or load it into DuckDB, pandas or a dashboard tool.

### Dashboards

You don't need an export to look at your data: each game has an **Overview**, **Funnels** and **Players** page on the website, computed live from the event database. See the [README](README.md#dashboards) for what each shows, how environments are decided, and the limits (very large ranges and millions of events can take a few seconds).

When you upgrade from a version without dashboards, nothing needs migrating by hand: on first start the server adds the new per-game tables (session environments and saved funnels) and fills the environments from existing `session_start` events. Back up `data/` first, as always.

## Team access

Skip this if you are the only user. To let a team in, with roles and per-game access (see the [README](README.md#team-access)):

1. **Cloudflare Access:** in Zero Trust → Access → Applications, edit the application that protects the admin hostname. In its Allow policy, include *Emails ending in* your company domain (for example `@example.com`) and your own email. Leave the separate Bypass application for `POST /v1/events` as it is, so games can still send events.
2. **Find two values:** the team domain (Zero Trust → Settings → Custom pages, shown as `<team>.cloudflareaccess.com`) and the application's **Application Audience (AUD) Tag** (Access → Applications → your app → Overview).
3. **Set them in `.env`:**

   ```bash
   AVN_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
   AVN_ACCESS_AUDIENCE=<the AUD tag>
   AVN_ADMIN_EMAIL=you@yourcompany.com     # the email you sign in with; always an admin
   AVN_ALLOWED_EMAIL_DOMAIN=yourcompany.com
   AVN_LAN_ADMIN=true
   ```

4. **Restart the admin service:** `docker compose up -d admin`. Open the site through Cloudflare, sign in, then add people on the **Team** page.

If something is misconfigured and you can't sign in remotely, you are not locked out: open the site from your own network (it counts as the admin), or call the API with the admin token. Remove the `AVN_ACCESS_*` values to return to single-user mode. Your reverse proxy must forward the `Cf-Access-Jwt-Assertion` header (Caddy and nginx do by default) and should set `X-Forwarded-For` (Caddy does), because the server uses it to tell a request from your home network from one that came through Cloudflare.

## 7. Operating it

```bash
docker compose ps                          # status and health
docker compose logs --tail 100 -f          # logs
docker compose stop                        # stop (data is untouched)
docker compose up -d --wait                # start
```

- **Updating:** `git pull`, then `docker compose up -d --build --wait`. The ingest and admin services both use the image, so rebuild both: a brief restart of ingest is safe (games queue events and retry). Keep `.env` and `data/` as they are. Do not overwrite `.env` with `.env.example` or you will lose the admin token.
- **Boot:** services use `restart: unless-stopped`; enable the Docker service at boot (`systemctl enable docker`).
- **Rotating the admin token:** edit `AVN_ADMIN_TOKEN` in `.env`, then `docker compose up -d --force-recreate`. Website sessions are unaffected.
- **Disk:** check free space occasionally. There is no automatic retention or deletion, and a full disk makes the server return 503 (clients keep their events and retry), so plan capacity or export and archive.
- **Failures are safe:** if the server is down, games queue events on the device and catch up later.

## 8. Backups and moving to another disk

All state lives in `data/`:

```text
data/
  registry.sqlite3       games, hashed keys, rate limits, website password
  games/<uuid>.sqlite3   one database per game
  exports/               temporary download files (safe to delete when stopped)
```

SQLite runs in WAL mode, so a live `.sqlite3` file can be missing committed data that is still in its `-wal` sidecar. **Stop both services** before copying, and copy the whole directory:

```bash
docker compose stop
rsync -a ./data/ /mnt/backup/avn-analytics/
docker compose up -d --wait
```

To move to a new disk: stop, `rsync -a ./data/ /new/disk/avn-data/`, set `AVN_HOST_DATA_DIR=/new/disk/avn-data` in `.env`, run `docker compose up -d --force-recreate`, and compare event counts on the website before deleting the old copy. Keep backups on a different physical device and test a restore now and then. A copy on the same disk does not protect you from disk failure.

## 9. Security checklist

- [ ] Only `POST /v1/events` is reachable from the internet; port 8101 is not routed anywhere public.
- [ ] HTTPS is enforced at your proxy or tunnel.
- [ ] `.env` is `chmod 600`, and the admin token is not in any game build or repository.
- [ ] Remember the dashboard stores each new API key's full value (so it can be copied again): keep port 8101 and `data/` private, and back them up as sensitive.
- [ ] You chose a strong admin password; remote admin access goes through SSH forwarding or a VPN.
- [ ] Edge rate limiting is on for the ingest hostname.
- [ ] Backups run and have been restored at least once.
- [ ] Your store privacy disclosures cover the device, user and (IP-derived) country data you collect.

## 10. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `docker compose up` complains about `AVN_ADMIN_TOKEN` | It is empty in `.env`. |
| Ingest or admin container restarts, log says "Use SQLite 3.51.3+" | You are running outside the Docker image on an older system SQLite. Use the image. |
| Permission errors writing `data/` | `AVN_UID`/`AVN_GID` don't match the owner of the data directory. |
| Game gets **401** | Wrong, deleted or missing API key, or the proxy strips the `X-API-Key` header. |
| Game gets **404/405** | Proxy only allows `POST /v1/events`; check the URL path and method. |
| Game gets **415** | A `Content-Encoding` other than gzip (for example a proxy re-encoding the body). An SDK talking to a server that predates gzip support falls back to plain JSON by itself. |
| Game gets **429** | Per-key rate limit; the SDK backs off. Raise `AVN_REQUESTS_PER_MINUTE` if many players share a key. |
| **503** responses | Database or disk problem (a full disk is the usual cause); check `docker compose logs` and `df -h`. |
| Events never show up, SDK says "offline" | Device has no connectivity, or the endpoint URL in `AvnConfig` is wrong (check `LastStatus` in the demo). |
| `country` is always `null` | Not behind Cloudflare, or a proxy drops the `CF-IPCountry` header. |

## Running without Docker

Needs Python 3.12+ and a patched SQLite (3.51.3+, or the 3.44.6 / 3.50.7 backports). Check with `python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'`; if it is too old, use the Docker image.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock && .venv/bin/pip install -e .
export AVN_DATA_DIR=/var/lib/avn-analytics AVN_ADMIN_TOKEN='your-long-random-token'
.venv/bin/uvicorn avn_analytics.api:create_ingest_app --factory --host 127.0.0.1 --port 8100
.venv/bin/uvicorn avn_analytics.api:create_admin_app --factory --host 127.0.0.1 --port 8101 --workers 1
```

Run each as a systemd service (one `ExecStart=` line per unit, `Restart=on-failure`, a dedicated user that owns the data directory) so they survive reboots. Keep the admin service at **one worker** so the one-export-at-a-time limit stays effective.
