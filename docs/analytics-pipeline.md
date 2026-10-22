# Analytics pipeline: how it is built, and what it measured

This is the implementation record for `docs/analytics-plan.md`: what was built for each part of the
plan, where it deliberately differs from the plan, and the measurements behind the decisions. The
plan's review units map to commits on the `analytics/pipeline` branch.

## 1. Baseline and parity harness

- `scripts/benchmark.py` generates deterministic synthetic games (`tests/synthetic.py`) through the
  real ingest code into a scratch directory it creates itself (it refuses any directory without its
  marker file, so it can never touch real data), and measures every heavy page over 7, 30 and 90
  days. Each measurement runs in a fresh process with the response cache off: once right after
  evicting the database from the operating system's page cache (`posix_fadvise`, no root needed:
  "cold disk"), then warm. It also measures the HTTP path with the cache on (first request after
  start, repeated requests), ingest throughput and latency alone and while another process keeps the
  dashboards busy, query plans, and the facts backfill and its disk cost.
- `tests/reference/` freezes the dashboard query modules as they were before this work.
  `tests/parity.py` asks the reference and the production code about 2,300 questions (Overview in
  three time zones, filter menus, Players with every sort, rules and metrics, Events, mapping
  status, Levels in both scopes with every level's player groups, sorts and last-action filters,
  timelines and player stories, catalog, retention, a funnel) over a fixture that adds what
  generated play doesn't cover: a session whose environment arrives and changes after its events,
  two players sharing a session ID, events exactly on range edges and sharing timestamps, and rows
  written by older versions (no player, a numeric version, no platform, upper-case environment).
  `tests/test_parity.py` requires identical answers in every read mode. `benchmark.py compare` runs
  the same comparison on the large synthetic games.

The synthetic game: about 45 events per player, 15k sessions and 5.5k players per 250k events,
levels up to 40, 30% of players linking an account, 8% on test builds, newer versions sending one
mapped `LEVEL_EVENT`. At 250k events it is 215 MB, close to the largest real game (197 MB for 213k
events).

The capacity run at 10 million events was not executed: it needs about 20 GB of scratch space and
the development machine's disk would be left with less than its 5 GB reserve
(`benchmark.py generate` refuses it and says so). Results are reported for 250k and 1M events.

## 2. Analytics facts

`avn_analytics/analytics.py` adds derived tables to each game's database. Raw events and their
`payload` are never changed.

- `analytics_facts`: one row per event (`event_id` unique) with name, client and server
  timestamps, `user_id`, `device_id`, the player (`coalesce(user_id, device_id)`, a virtual
  generated column, so it costs no space in the table), session, app version, build, country,
  platform, the environment the event itself declared (lower case, or NULL) and the parameters as
  JSON. Columns have no declared type, so values keep the type the JSON had (a numeric version stays
  a number, exactly as `json_extract` returns it). Indexes: client time; player, time, event ID;
  session.
- A trigger on `events` writes each new event's facts in the same statement, so they commit or
  roll back together and an older version of the app (which knows nothing about facts) still
  maintains them. Ingest names its insert columns and takes the accepted count from the insert's
  own row count, which does not include rows the trigger writes.
- Triggers on `sessions` record each session whose environment arrives or changes in
  `analytics_changes`, in commit order. Such a change re-counts the session's events, old ones
  included. The order of new events is the facts' `id`, so events need no separate change rows.
- Installation is cheap and atomic: it creates the tables and triggers and records the highest
  existing event row in the same transaction, so every event is either older (copied by the
  backfill) or newer (written by the trigger). Older events are copied by `analytics.step()`, 5,000
  per short transaction, with its cursor stored in the same transaction: an interrupted step leaves
  nothing behind, and running again carries on. Then every event's facts are checked to exist
  (missing ones are added) and every fact is compared with what its event says (a wrong one is
  rewritten). Only then is the game's facts `ready`. A cheap audit (two counts) restarts the
  checks if events and facts ever disagree. A schema version change drops the derived tables and
  rebuilds them from the events.
- What the facts don't store: the session's environment, environment fixes and the dictionary.
  Those are applied when facts are read, so a late `session_start`, a new fix or a mapping edit
  changes old answers at once.
- `python -m avn_analytics.analytics status|prepare [--game ID] [--dry-run]` reports or runs the
  backfill by hand; normally the analytics worker does it.

Measured (synthetic games, compacted databases):

| Events | Without facts | With facts | Growth | Backfill + checks |
| --- | --- | --- | --- | --- |
| 30k | 25.0 MB | 38.4 MB | 54% | 0.8 s |
| 250k | 208 MB | 321 MB | 54% | 14.2 s (backfill 11.6, checks 2.6) |

The plan's earlier 24% estimate was for typed columns added to the events table itself; this
separate table repeats the event ID and timestamps and has its own indexes, so it costs more.
