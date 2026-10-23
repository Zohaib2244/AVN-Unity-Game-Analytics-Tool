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
- `avn_analytics/analytics.py` — stable per-event facts and resumable verification; raw events remain authoritative. Bump `SCHEMA_VERSION` when changing the extracted facts format.
- `avn_analytics/materialize.py` + `views.py` — worker lifecycle and exact prepared answers. Bump `views.VERSION` when changing reducer/interpretation semantics so old generations cannot be reused. Staging and publication must be fenced by source revisions, control cancellation and worker lease ownership.
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
- Design: follow AVN-Style (`SKILL.md` in the AVN-Style repo; the `avn-design` skill). UX: avn-ux · Style: avn-family. Read the skill before changing UI.
  - The website is plain HTML/CSS/JS with no build step. Colours, fonts and shapes come from the contract roles in `static/avn-family-tokens.css` (`--bg`, `--panel`, `--text`, `--accent`, ...). The older names in `style.css` (`--bg-card`, `--text-muted`, ...) are aliases of those roles; new CSS uses the roles. Fonts are self-hosted in `static/fonts/` because the Content-Security-Policy only allows this origin.
  - The app shell (sidebar, top bar, command palette, rail, tab bar) is `static/shell.js` + `static/avn-shell.css`. Shared UX tools (toasts and the notifications bell, popovers, the inspector drawer, definition tooltips, auto-refresh, shortcuts, entrance motion) are `static/ux.js`; animation is Motion (vendored in `static/vendor/motion.js`, MIT) wrapped by `static/motion-ui.js` as `mo.*`: page open/leave, count-ups, charts growing, overlays in and out, nav glide, press and lift. Animate only opacity and transform, play once, and call `mo.*` rather than the library directly so reduced motion is honoured in one place. Flavour (block piles, Dora, the mini PC, the boot screen) is `static/flavour.js` + `static/avn-flavour.css`. CSS layers load in this order: tokens, `style.css` (older page rules), `avn-shell.css`, `avn-ui.css` (skill components), `avn-briefing.css`, `avn-pages.css`, `avn-flavour.css`. No inline `style="…"` in markup (CSP): set styles from CSS classes.
  - A page follows one pattern from the skill (briefing overview, list, settings, ...): summary before detail, one accent-filled button per area, every state has a word, three widths (wide, rail, phone tab bar), dark and light, two palettes checked.
- Raw events are kept indefinitely and SQLite may hold committed data in `-wal` files: never "clean up" data files as part of a change.
- Don't push, merge or open PRs yourself; leave the branch for review.
