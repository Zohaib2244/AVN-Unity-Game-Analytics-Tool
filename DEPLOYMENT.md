# AVNS server deployment

Installed and checked on 2026-10-04 on `avns2`, the AVNS Kini PC. This is a standalone
analytics service; it has no dependency on AVNs Hub.

## Live installation

| Item | Value |
| --- | --- |
| Service directory | `/opt/docker/avn-analytics` |
| Compose project | `avn-analytics` |
| Data directory | `/opt/docker/avn-analytics/data` |
| Current storage | Main SSD, `/dev/sda2`, ext4 |
| Ingest API | `http://127.0.0.1:8100/v1/events` |
| Ingest health | `http://127.0.0.1:8100/healthz` |
| Private admin API | `http://127.0.0.1:8101` |
| Management website | `http://127.0.0.1:8101/` |
| Credentials | `/opt/docker/avn-analytics/.env`, owner-readable/writable only (0600) |
| SQLite runtime | 3.51.3 |
| Restart policy | `unless-stopped`; Docker is enabled at boot |

Both containers are running and healthy. Verified that the admin API rejects
unauthenticated requests, admin routes are absent from the ingest application,
and both services mount the intended SSD data directory. No games are registered
yet, and no test games were inserted into the live registry.

The runtime installation and data are independent of the chat workspace. Run
operational commands from `/opt/docker/avn-analytics`. This output directory is the
source/handoff copy; edits here do not automatically update the live installation.

## Operate the service

```bash
cd /opt/docker/avn-analytics
docker compose ps
docker compose logs --tail 100
curl --fail http://127.0.0.1:8100/healthz
```

Stop with `docker compose stop`; start again with `docker compose up -d --wait`.
For code updates, update the installed source first and run
`docker compose up -d --build --wait`. Preserve `.env` and `data/` across updates.
Do not copy `.env.example` over the live `.env` or regenerate the admin token unless
you intend to rotate credentials.

To use the admin examples from `README.md`, load the generated configuration into
your local shell without printing the token:

```bash
cd /opt/docker/avn-analytics
set -a
. ./.env
set +a
curl --fail http://127.0.0.1:8101/v1/games \
  -H "Authorization: Bearer $AVN_ADMIN_TOKEN"
unset AVN_ADMIN_TOKEN
```

Open `http://127.0.0.1:8101/` on this PC to use the management website. On first
visit, choose your admin password. The site has Overview, Games, API keys,
Exports, Event dictionary, Server status and Settings pages. Forms manage real
game registrations, key creation/revocation, dictionary definitions and downloads.
The browser password is separate from the `.env` token used for API automation.
No default browser password is set; initial setup is left for the owner.

The website remains local-only. An SSH forward lets you use it privately from
another computer. Browser sign-in and writes accept only localhost, 127.0.0.1
or ::1 origins. Cloudflare ingestion setup is still deferred.

## Internet access — deferred

Per the deployment plan, Cloudflare setup waits until the domain purchase and
tunnel setup are ready. Neither endpoint is currently exposed on LAN interfaces or
the internet, and no existing proxy/DNS service was changed.

The server is now prepared for `gameanalytics.avns.site`: Caddy forwards only `POST
/v1/events` to the ingest container via an internal Docker network. The Cloudflare
Public Hostname still needs to be added to the existing remotely managed tunnel:
`gameanalytics.avns.site` → HTTP `192.168.1.24:80`. Do not publish port 8101 or create
a public hostname for the management website.

### Cloudflare configuration

In the existing AVNS Tunnel, create this Public Hostname:

| Field | Value |
| --- | --- |
| Subdomain | `gameanalytics` |
| Domain | `avns.site` |
| Service | `HTTP` → `192.168.1.24:80` |

The Tunnel configuration currently has explicit hostname entries, so creating a DNS
record alone is insufficient; add the hostname to the Tunnel too. Cloudflare creates
the DNS record when the Public Hostname is saved. Once it is active, game builds use
`https://gameanalytics.avns.site/v1/events`. Test the public route without a key:

```bash
curl -i -X POST https://gameanalytics.avns.site/v1/events
```

It should return `401 Unauthorized`. `GET /`, `GET /openapi.json`, and requests to
the management website do not have public routes and return `404`.

A host-installed Cloudflare connector on this PC should forward the chosen public
hostname's `/v1/events` path to `http://127.0.0.1:8100`, with a catch-all 404. Keep the
admin port private. If the connector runs in Docker, its localhost is not the host;
configure the container network or host networking explicitly when connecting it.

## Later drive migration

The complete persistent state is in `data/`, including the registry, per-game
databases and their SQLite sidecars. Stop both services, copy the whole directory
to the mounted replacement local drive, change `AVN_HOST_DATA_DIR` in the live
`.env`, then recreate the containers and verify counts. The detailed migration and
backup procedure is in `README.md`. No hard drive paths are embedded in game keys
or database records.
