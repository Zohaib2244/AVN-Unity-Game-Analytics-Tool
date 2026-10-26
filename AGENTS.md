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
- `avn_analytics/website.py` — serves the admin website: `index.html` for every page route and `/assets/*` from `avn_analytics/static/`, which is the **Vite build output of `web/`** (gitignored; `scripts/check.sh` and the Dockerfile build it)
- `web/` — the admin website source: React 18 + TypeScript + Vite on `@avn/ui` (the shared components from AVN-Style), TanStack Query / Router / Table / Virtual, Motion, Radix. `web/src/app/` (providers, router, shell, session), `web/src/api/` (request contract, query layer), `web/src/lib/` (pure helpers: formats, filters, conditions), `web/src/components/` (feedback, filters, date range, editors), `web/src/pages/` (one folder or file per page), `web/src/styles/` (CSS layers), `web/e2e/` (Playwright self-check). `web/PORTING.md` is the map
- `avn_analytics/exports.py` — export ZIPs (Parquet, JSONL, `events.md`, `ANALYSIS.md`)
- `avn_analytics/nutbot.py` — NutBot assistant (shells out to agent CLIs)
- `avn_analytics/skill/` — the analysis skill shipped inside exports
- `avn_analytics/avn_events_standard.py` + `avn_analytics/avn_events_standard/` — the AVN events standard (spec, guide, setup prompt) served by the website
- `avn_analytics/sdk/` — the built Unity SDK package (`AVNAnalytics.unitypackage`, made in Unity; the C# source is not kept in this repo)
- `tests/` — pytest suite. `tests/reference/` is a frozen copy of the dashboard queries from before the analytics pipeline work; `tests/parity.py` asks it and the current code the same questions (`tests/test_parity.py`), and `tests/synthetic.py` generates the deterministic games both it and `scripts/benchmark.py` use

## Commands

```bash
scripts/setup.sh   # create .venv, install Python deps and `npm ci` in web/ (run once per checkout/worktree; needs Node 20+)
scripts/check.sh   # web typecheck + Vitest + build, then ruff check + ruff format --check + pytest — must pass before you finish
scripts/dev.sh     # admin website on 127.0.0.1:${PORT:-8201} with a throwaway ./data (serves the last web build)
cd web && npm run dev   # live-reloading website on 127.0.0.1:5190, proxying /v1 to the server above
cd web && npm run e2e   # Playwright screenshot self-check at three widths (needs scripts/dev.sh running)
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
- Design: follow AVN-Style (`SKILL.md` in the AVN-Style repo; installed as the `avn-design` skill, with `avn-ux` for the UX rules). UX: avn-ux · Style: avn-family. Read the skill before changing UI.
  - Stack (from `ux/references/stack.md`): React 18 + TypeScript (strict) + Vite, plain CSS, Motion (`motion/react`), `@avn/ui` for every shared component (shell, nav, drawer, dialogs, pickers, toasts, command palette, tags, KPIs, charts, rule editor, highlights, NutBot panel), TanStack Query for server data, TanStack Router for routes and URL state, TanStack Table/Virtual for dense tables, Radix through `@avn/ui`, Vitest + Testing Library for tests, Playwright for the three-width screenshot check. No Tailwind, no CSS-in-JS.
  - `@avn/ui` is vendored as a tarball in `web/vendor/` (it is not on npm). To update it: clone AVN-Style, `npm install && npm run build`, `cd packages/ui && npm pack`, copy the `.tgz` over and `npm install` in `web/`.
  - Colours, fonts and shapes come only from the contract roles (`--bg`, `--panel`, `--text`, `--accent`, ...) loaded from `@avn/ui/css/avn-family/tokens.css`; app CSS lives in `web/src/styles/` (`legacy.css` = the pre-React page rules, `pages.css`, `shell.css`, `briefing.css`, `flavour.css`, `app.css` for new rules) and uses roles only. Fonts are self-hosted in `web/public/fonts/` because the Content-Security-Policy only allows this origin; the CSP also forbids inline `<script>`/`<style>`/`style=""` in markup (React's `style={{}}` props are set through the CSSOM and are fine).
  - Data: `useRead` (reads, shared cache, previous answer shown while a new one loads) and `write` (any change; clears the cache) in `web/src/api/`; never `fetch` directly except for binary downloads. Loading, errors, empty states, toasts (Undo for reversible actions), typed-name confirmations and definitions are in `web/src/components/feedback.tsx`. Animation goes through `motion/react` or `@avn/ui` components, opacity and transform only, once, honouring reduced motion.
  - A page follows one pattern from the skill (briefing overview, list, settings, ...): summary before detail, one accent-filled button per area, every state has a word, three widths (wide, rail, phone tab bar), dark and light, two palettes checked (`npm run e2e` takes the screenshots).
  - Pure browser logic that must agree with the server (`web/src/lib/conditions.ts`, `player-events.ts`) is written in erasable TypeScript so `tests/test_conditions.py` and `tests/test_player_events.py` can run it directly with Node.
- Raw events are kept indefinitely and SQLite may hold committed data in `-wal` files: never "clean up" data files as part of a change.
- Don't push, merge or open PRs yourself; leave the branch for review.

## Design preferences

- Player details open in a centred viewer for focused reading and quick browsing; never move them to the screen edge or stack them beside NutBot as another sidebar.
- Undo and notification actions keep the current page and player viewer open; picker positions follow their trigger through scrolling.
- Home opens Games with a browser-local Continue toast. Remember the last page separately for each account and workspace; selections and filters stay browser-specific.

- Complex analytical comparisons use guided steps, with a short visible summary of the choices; avoid crowding every setup field onto one screen.

- Analytical tools open with task shortcuts and reusable, named saved groups. Do not phrase shortcuts as questions or add built-in presets until the owner supplies them. Keep setup and statistical detail optional; extra hint paragraphs increase overload.
