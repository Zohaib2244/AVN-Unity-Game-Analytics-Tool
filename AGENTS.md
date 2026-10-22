# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, ...) working in this repo.
`CLAUDE.md` is a symlink to this file.

## What this is

AVN Analytics: a self-hosted event analytics pipeline for Unity games.
FastAPI + SQLite (one database per game), a Unity SDK, a private admin
website with dashboards, and agent-friendly exports. See `README.md` for the
full picture; `DEPLOYMENT.md` for self-hosting.

## Layout

- `avn_analytics/api.py` — app factories: `create_ingest_app` (public, `POST /v1/events`) and `create_admin_app` (private website + admin API)
- `avn_analytics/storage.py` — SQLite storage, one DB per game plus `registry.sqlite3`
- `avn_analytics/insights.py`, `journeys.py`, `stories.py`, `rules.py` — dashboard computations
- `avn_analytics/analytics.py` — analytics facts: plain per-event columns beside the raw events, written by a trigger on `events` and backfilled/verified in short steps (`python -m avn_analytics.analytics status|prepare`). Derived only: never change raw events from here
- `avn_analytics/readcache.py` — short-lived cache for the slow dashboard reads (`AVN_READ_CACHE_SECONDS`). Slow reads that count events should read them once (`insights.scope_events` copies the days and filters into a temporary table of plain columns) rather than re-deriving each value from the JSON for every count
- `avn_analytics/website.py` + `avn_analytics/static/` — admin website (vanilla JS/CSS, no build step)
- `avn_analytics/exports.py` — export ZIPs (Parquet, JSONL, `events.md`, `ANALYSIS.md`)
- `avn_analytics/nutbot.py` — NutBot assistant (shells out to agent CLIs)
- `avn_analytics/skill/` — the analysis skill shipped inside exports
- `avn_analytics/avn_events_standard.py` + `avn_analytics/avn_events_standard/` — the AVN events standard (spec, guide, setup prompt) served by the website
- `avn_analytics/sdk/` — the built Unity SDK package (`AVNAnalytics.unitypackage`, made in Unity; the C# source is not kept in this repo)
- `tests/` — pytest suite. `tests/reference/` is a frozen copy of the dashboard queries from before the analytics pipeline work; `tests/parity.py` asks it and the current code the same questions (`tests/test_parity.py`), and `tests/synthetic.py` generates the deterministic games both it and `scripts/benchmark.py` use

## Commands

```bash
scripts/setup.sh   # create .venv and install deps (run once per checkout/worktree)
scripts/check.sh   # ruff check + ruff format --check + pytest — must pass before you finish
scripts/dev.sh     # admin website on 127.0.0.1:${PORT:-8201} with a throwaway ./data
scripts/release.sh # (owner) run the gate, tag main vX.Y.Z, push
scripts/deploy.sh  # (owner) deploy the newest tag on the server, health-checked, auto-rollback
docker compose exec -T admin python - < scripts/measure_speed.py  # (owner) read-only: events per game and how long each page takes
scripts/benchmark.py generate|measure|ingest|plans|compare --dir <scratch dir>  # synthetic benchmark (never a real data dir)
```

The app refuses to run on SQLite older than 3.51.3 (WAL-reset fix). When the
system library is older, `setup.sh` builds the pinned version into
`~/.cache/avn-analytics/` and the scripts put it on `LD_LIBRARY_PATH`. So run
tests through `scripts/check.sh` (or `. scripts/_env.sh` first); a bare
`.venv/bin/python -m pytest` can fail with "Use SQLite 3.51.3+".

## Rules

- Run `scripts/check.sh` before saying you are done, and fix what it reports. A change is not finished while it fails.
- Behaviour changes need tests in `tests/`. Bug fixes get a test that fails without the fix.
- Ruff: line length 100, rules E/F/I/UP/B (see `pyproject.toml`). Format with `.venv/bin/ruff format`.
- New configuration goes through environment variables, documented in `.env.example` and the Configuration table in `README.md`.
- Never commit `.env`, anything under `data/`, API keys or tokens. Never read or modify real data directories.
- Keep the repo generic: no hostnames, IPs, domains or personal deployment details. Per-server settings live outside git (`.env`, `compose.override.yaml`, both gitignored; commit only the `*.example`).
- Releases and deploys are the owner's job: `scripts/release.sh` tags and pushes, `scripts/deploy.sh` updates the server. Agents never run them.
- The admin website follows the AVN Style ("Nutstyle") design system. If a `nutstyle` skill is available, read it before changing UI.
  - One documented exception: the "Calm layer" at the end of `avn_analytics/static/style.css` (system UI font for body text, sentence-case labels, thin borders, no offset shadows). Keep new UI inside it: colours from tokens (use the `-text` variants for small text), sizes from the `--fs-*` scale, 44px touch targets, labelled controls, and check both themes.
- Raw events are kept indefinitely and SQLite may hold committed data in `-wal` files: never "clean up" data files as part of a change.
- Don't push, merge or open PRs yourself; leave the branch for review.
