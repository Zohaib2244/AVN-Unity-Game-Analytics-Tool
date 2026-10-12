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
- `avn_analytics/website.py` + `avn_analytics/static/` — admin website (vanilla JS/CSS, no build step)
- `avn_analytics/exports.py` — export ZIPs (Parquet, JSONL, `events.md`, `ANALYSIS.md`)
- `avn_analytics/nutbot.py` — NutBot assistant (shells out to agent CLIs)
- `avn_analytics/skill/` — the analysis skill shipped inside exports
- `unity/AVNAnalytics/` — Unity SDK (C#)
- `tests/` — pytest suite

## Commands

```bash
scripts/setup.sh   # create .venv and install deps (run once per checkout/worktree)
scripts/check.sh   # ruff check + ruff format --check + pytest — must pass before you finish
scripts/dev.sh     # admin website on 127.0.0.1:${PORT:-8201} with a throwaway ./data
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
- Keep this branch generic: no hostnames, IPs, domains or personal deployment details. Deployment-specific changes live on a private branch, not here.
- The admin website follows the AVN Style ("Nutstyle") design system. If a `nutstyle` skill is available, read it before changing UI.
- Raw events are kept indefinitely and SQLite may hold committed data in `-wal` files: never "clean up" data files as part of a change.
- Don't push, merge or open PRs yourself; leave the branch for review.
