# Insights batch 1: implementation plan

Branch: `feature/insights-batch-1` (local only; the owner reviews, releases and deploys).

Six features, built in this order. Each ships as a vertical slice: pure computation module,
API route, NutBot/MCP read tool where it fits, page, tests. A slice is done only when
`scripts/check.sh` passes and, for UI, the `ui-review` skill has been run in the browser.

Shared rules (from AGENTS.md): plain-words answers beside any number, no unexplained columns,
new config through env vars + `.env.example` + README table, bump `views.VERSION` /
`analytics.SCHEMA_VERSION` only if reducer or extracted facts change, new MCP tools only if they
read and are named in `READ_ONLY_TOOLS`.

## 1. Payback forecast (Acquisition page)

Goal: say "this campaign breaks even around day 41" or "will not pay back inside 180 days".

- `avn_analytics/payback.py`: pure functions, no storage. Input: observed value per install at
  days 0,1,3,7,14,30 (only points whose day is over, with player counts) and cost per install.
  Fit cumulative revenue `R(d) = a * (d + 1) ** b` by least squares in log space over the
  observed points (needs >= 3 points and >= 30 players on the latest one). Output: predicted
  D30/D60/D90/D180 value, break-even day (None when beyond the horizon), a `confidence`
  (`enough`, `thin`, `none`) and a plain-words sentence. Never extrapolate past 180 days.
- `acquisition_report.report` / `cohorts` add a `payback` object per row; `all_paid` too.
- Acquisition page: a "Payback" line per campaign with the sentence; no new percentage
  columns. NutBot: the existing acquisition tool returns the same object.
- Tests: exact-curve recovery, flat/zero revenue, too few points, break-even beyond horizon.

## 2. Live event tail (SDK integration helper)

Goal: watch events arrive for one player or device while integrating a game.

- Storage read of events newer than a cursor (`rowid > after`) for a game, optionally one
  player id or device id; capped page size; test-data builds included on request. Read only.
- Admin API `GET /v1/games/{id}/events/tail?after=&player=&limit=`; the page polls (no
  websockets; every 2 s only while the tab is visible).
- Page: "Live events" under Games, a list of event name, time, key parameters; paused state,
  clear, copy-as-JSON. States: waiting, paused, error.
- Tests: cursor semantics, player filter, cap, no writes.

## 3. Level difficulty finder

Goal: flag levels that lose players far more than their neighbours predict.

- `avn_analytics/level_difficulty.py` on top of `level_attempts` / level progress data:
  per level fail and quit rate, expected rate from a robust local baseline (median of the
  +-3 neighbouring levels with enough attempts), outlier score, minimum attempts guard.
- API + Levels page entry as a sorted list with a plain-words reason per flagged level
  ("23% quit here, neighbours about 8%"); NutBot tool `get_level_outliers`.
- Tests on synthetic games with a planted hard level.

## 4. Device and country performance

Goal: show where crashes, slow loads or ad failures cluster.

- `avn_analytics/segment_performance.py` reusing `stability._device_tables` and ad-health
  grouping: for device tier, OS version, country: players, crash rate, ad failure rate, with a
  baseline and a "worse than overall" flag requiring a minimum sample.
- One table with a plain-words top line. Tests with a planted low-end device cluster.

## 5. What separates players who stay (and payers from non-payers)

Goal: automatic comparison of first-day behaviour between two outcome groups.

- `avn_analytics/separators.py`: outcome definitions (retained D7 vs not, payer vs non-payer),
  early-window features per player (event counts, first-level results), ranked by effect size
  with minimum group sizes; plain-words findings, no raw-statistics columns. Wording says
  association, not cause.
- Hand-off to the group library via `nutbot_groups` / `player_chips`. NutBot tool plus an
  entry from Players.

## 6. Churn-risk player lists

Goal: players likely to leave soon, saved as an exportable segment.

- `avn_analytics/churn_risk.py`: transparent score from recency against the player's own
  session gaps, plus the separators from step 5; no opaque model. Ranked list with a reason per
  player. Saved as a `players` group and exported through the existing exports path.
  Depends on 5.

## Order and checkpoints

1 -> 2 -> 3 -> 4 -> 5 -> 6. Commit per slice, `scripts/check.sh` between slices. UI slices need
browser verification at wide, rail and phone widths before they are called finished.

## Status

- [x] 1 Payback forecast: `payback.py`; per row in the acquisition report; shown as one line above the chosen campaign's Cohorts (a table column overflowed the Sources table at 1440 wide, so it moved)
- [x] 2 Live event tail: `live_tail.py`, `GET /v1/games/{id}/events/live`, Live events page under Data (polls every 2 s while visible; Paused/Offline with the last answer time; Player and Build columns only when they differ)
- [x] 3 Level difficulty finder: `level_difficulty.py`, `GET .../insights/levels/difficulty`, NutBot/MCP `get_level_outliers`, a "Harder than nearby" chip in the Levels answer strip (only when no other chip names that level)
- [ ] 4 Device and country performance
- [ ] 5 What separates players who stay
- [ ] 6 Churn-risk lists

## Notes from the UX audit of slices 1-3 (2026-11-19)

Fixed: the Levels chip ignored the first-session / no-return scope (the finder counts every
player, so the chip is only asked for and shown under Everyone); chip shows count first with one
decimal and names one level only; Live events opens a full-width detail row (player, build,
session, received, parameters) and keeps phone columns to time, event, parameters; status time
only in the tooltip on phones; Pause has no clock icon; a mistyped ID offers "Show every player";
payback says "Paid back by day N" once it has happened.

Found but not changed here (already there before this branch):
- One test event from a new build makes it "Latest", so Acquisition (and other pages) open
  empty on the default build filter. Live events makes test-device events more common, so this
  will be hit more. Possible fix: Latest needs a minimum number of players, or skips test builds.
- Acquisition Sources "Return" says "set a goal" on every row when no goals are set (R10.2).
- The "Fewest finish" chip doesn't say what its percentage is a share of.
- Suggested rule R1.5: scoped controls drive everything in their region.
