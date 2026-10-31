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

## 3. Facts reads and the Levels reducer

`AVN_ANALYTICS_READ_MODE=facts` selects plain facts for complete games, with the raw path for an
incomplete game. The reducer reads each player's ordered history once and shares event decoding and
label interpretation between the table and player groups. Both read modes match the frozen reference
across the parity matrix, including historical context, exact time samples, session environment,
time zones, anonymous events and the existing request-size errors.

On the 250k synthetic game, warm 30-day facts computation took 0.78 s for Overview, 1.17 s for Levels,
1.23 s for first-session Levels, and 0.43 s for Players. Cold disk and empty application cache are
separate measurements; the first facts Overview read after disk eviction took 3.06 s. These are
local measurements, not predictions for a particular deployment.

## 4. Worker and persistent controls

`python -m avn_analytics.materialize` is the separate Compose `worker` service. Its container has a
512 MB memory limit, 0.5 CPU, no published ports and no Docker socket. It supervises one game at a
time, rotates between games, and uses an expiring worker claim and per-game leases. Backfill commits
small batches; SQL progress callbacks notice Stop during copying. Prepared reduction checkpoints at
player batches. A stale worker cannot advance staging or publication after its lease is taken over.

Global admins see Settings → Analytics processing. The desired state and revision are durable in
the registry, separate from the acknowledged state and heartbeat. Stop remains stored over restarts;
changing the installation default cannot override it. Missing/exited/expired workers show
Unavailable. Start persists a request without claiming an absent process has started. Start/Stop
changes are audited; team leads and members cannot inspect or change global jobs. Game readers get
only a scoped paused hint for slow-load feedback. Errors survive a supervisor restart and remain
visible while a failing view waits for retry; one failed view does not block every other view.

The lifecycle tests cover Stop during backfill and player reduction, ingestion while stopped,
resume, rapid controls, lost heartbeat, two workers, lease expiry, per-game errors and persisted Off.
The Settings controls were exercised in a browser at desktop and 390px width in both themes;
Start reached Running, Stop reached Stopped, keyboard focus survived status updates and writes,
touch targets were 44px and the phone page had no horizontal overflow.

## 5. Exact prepared answers

`AVN_ANALYTICS_READ_MODE=prepared` registers requested Overview and Levels specifications and uses
complete, fresh generations. Levels stores its table calculation and every level's player groups
together. Pagination/sorting happens after the shared work. Equivalent filter lists share a key;
dates, scope, filters and Overview time zone remain part of the exact specification.

The worker retains compressed per-player contributions. New facts identify dirty players, including
late events with old client timestamps. Their contributions are replaced rather than added twice.
The final reduction retains exact duration samples and recomputes neighbouring-level counts.
Anonymous counts are separate. Overview starts with a full exact facts calculation, preserving
cross-day identities and partial-session/time-zone semantics.

A generation records its stable definition/fix/algorithm digest, fact-ID watermark, session-change
watermark and source time. It publishes one atomic complete answer; readers cannot see staging.
Each batch uses a consistent short SQLite snapshot. Unrelated new sessions after its fact watermark
do not invalidate it. Session-context changes affecting covered facts or mapping/fix edits make the
old answer ineligible. Before publishing, the worker rechecks interpretation, context and its lease.
No read snapshot remains open between ticks. SQL checks controls every approximately 100 ms; a
single computation has a 30-second snapshot ceiling and reports an error if it cannot finish.

An expired, missing, stopped or unavailable generation uses live facts. Incomplete facts use raw
events for the whole query. Prepared Overview and Levels bypass the server response cache so it cannot extend
the source freshness budget; other dashboard families retain their existing cache. Threshold edits rerender confidence without changing facts. Existing
browser UI may explicitly show previous results while a fresh request runs, as before this change.

Storage is bounded to 12 recently used specifications per game by default, with 24-hour inactivity
expiry and a global 256 MiB logical budget for prepared rows (compressed answers, contributions,
queues and conservative row overhead). This budget excludes raw events, stable facts and their
change log. SQLite may retain freed pages, so it is not a physical database-file limit. No raw rows,
database files, WAL or SHM files are removed by eviction. Additional memory guards bound a prepared
specification to 100k players, a player batch to 25k history rows / 16 MiB of row text, and final
contribution JSON to 64 MiB. A larger query falls back to the existing live path, with its existing
limits; the admin sees a recoverable preparation error.

### Measured prepared reads

`scripts/benchmark_prepared.py --dir <marked-synthetic-fixture>` verifies exact answers, prepares
from scratch, creates a new Storage instance (empty process cache), keeps the supervisor active
and checks source freshness before timing reads. It deliberately refuses to report a stale fallback
as a prepared measurement. Ten samples are used per endpoint; reported p95 is their maximum.

For 250,013 events, in a network-isolated container limited to **512 MB and 0.5 CPU**, initial
preparation took **24.7 s**, and peak process RSS was **115.5 MiB**. The three prepared specifications
occupied about **5.1 MB** of logical derived storage. Restarted reads (p95):

| Answer | Time |
| --- | --- |
| Overview | 7.7 ms |
| Levels | 446 ms |
| First-session Levels | 210 ms |
| Level players | 445 ms |

The same fixture without the CPU limit prepared in approximately 10 s and read Levels in
approximately 165 ms. Both measurements had exact output parity. These are computation-path
measurements; the earlier baseline harness separately measures HTTP/auth/serialization overhead.
The memory/CPU-limited probe uses the project's image under a scratch tag and only a marked
synthetic mount, never a deployment mount.

The corrected 1M-event run verified prepared eligibility before every sample. Initial preparation
was 54.7 s, peak process RSS 277.7 MiB, and derived rows occupied 20.3 MB. Restarted p95 was 6.9 ms
for Overview, 807 ms for Levels, 323 ms for first-session Levels and 634 ms for player lists.
Those measurements are unrestricted local computation; they do not establish the 0.5-CPU budget
at 1M. Earlier runs that aged answers into live fallback were rejected. The 10M capacity run
remains unvalidated because scratch preflight would leave less than the disk reserve. A 10M total
game size is a design target, not a claim that every date/filter query at that size fits the
interactive or prepared-memory budget.

### Ingest cost is above the target

The extra facts/index writes have a measurable cost. In repeated 10-second local runs, baseline
p95 was 26.8/23.7/31.0 ms (alone / with dashboards / alone again); facts p95 was
40.1/38.7/45.7 ms. Every accepted event and duplicate acknowledgement reconciled exactly. An earlier
20-second run also exceeded the plan's 20% regression target. These runs share a development host
and are not a controlled production qualification; the target is **not met by the available
measurements**. The 54% disk expansion and this write cost must be reviewed before rollout.

## Deliberate differences from the plan

- SQL triggers maintain facts/change records atomically, including writes by older binaries,
  instead of duplicating extraction logic in Python ingest. Raw insertion still determines
  accepted/duplicate counts. A failed statement rolls back raw events and facts together.
- Mapped interpretations live in versioned per-player contributions and published answers;
  there is no second global per-event interpretation table. The same Labeler is used throughout.
- A session-context change affecting covered history rebuilds the specification. New event
  changes refresh affected player contributions. Context changes are expected to be less common
  and keep a single correctness path; their full-rebuild cost is visible.
- Prepared specifications are registered on demand. The normal 30-day Overview and both Levels
  scopes are retained after first use; the worker does not eagerly scan every unused game/time zone.
- Memory and query limits produce explicit fallback rather than growing worker memory to satisfy
  an arbitrarily large query. Ten-million-event capacity and higher sustained ingest rates still need
  qualification on a larger isolated benchmark host.

## 6. ClickHouse decision: defer a production backend

Because the ingest cost missed its target, `scripts/benchmark_clickhouse.py` performs a bounded
engine feasibility probe against the same marked 250k fixture. It runs a pinned ClickHouse image
(`26.9.19.9`, digest recorded in the script) with no network, 512 MB RAM and 0.5 CPU. It exports only
synthetic facts into an owned temporary directory, repeats 5% of rows as retries, and verifies exact
event/player counts, an interpolated exact duration median, and `(client_ts,event_id)` ordering.

The probe passed: 250,013 unique events, 5,518 players and median duration 535.9 s matched SQLite.
The exact aggregate took 207 ms and the first-events query 131 ms; export, container startup, load,
retries and queries together took 5.84 s. The reported 82.3 MB scratch footprint includes exported
JSON as well as the engine files; it is not a production storage estimate.

The prototype uses `ReplacingMergeTree` with `FINAL` for correct retry counts before background
merges. Background deduplication alone is insufficient, as described in the
[official ReplacingMergeTree guide](https://clickhouse.com/docs/concepts/features/operations/update/replacing-merge-tree).
This checks engine feasibility, not full AVN endpoint parity. It does not establish server idle
memory, durable SQLite-to-ClickHouse delivery, history-aware Levels, correction/mapping rebuilds,
crash replay, authorization integration or operating effort at 10M events. Those are adoption gates,
not properties inferred from a fast count.

The decision for this branch is to keep SQLite: the primary 250k prepared-read budget is met within
the worker resource limit, while switching engines would still require a durable delivery boundary
and the same player reducer. Do not add best-effort dual writes to hide the measured ingest cost.
Review that cost before rollout; run a full isolated backend comparison if the agreed ingestion or
larger-capacity workload makes it unacceptable. The probe is retained to make that decision
reproducible; this branch adds no ClickHouse dependency or service to the application.

### Concurrent freshness probe

`scripts/benchmark_freshness.py` copies a marked synthetic fixture to an owned scratch directory,
runs the worker concurrently with ingestion, checks every committed watermark against all three
prepared specifications, and compares caught-up answers with exact live facts. In the 250k local
probe, 1,165 new events were accepted over 20 seconds (58.2 events/s). The maximum measured
commit-to-all-views time was 17.2 s, with exact final parity. This meets the 60-second freshness
target at that measured rate; it does not qualify higher ingest rates or a production CPU budget.

The accepted numeric reports are retained in
[`benchmarks/analytics-20261022.json`](benchmarks/analytics-20261022.json). Re-run the scripts for
new hardware, budgets or algorithms rather than treating these local samples as service guarantees.

## Reproducing the probes

Use an empty scratch location outside any real data directory. The generation command refuses a
nonempty destination and checks its disk reserve; later commands require its synthetic marker.

```bash
. scripts/_env.sh
.venv/bin/python scripts/benchmark.py generate --events 250000 --dir /tmp/avn-synthetic-benchmark
.venv/bin/python scripts/benchmark.py facts --dir /tmp/avn-synthetic-benchmark
.venv/bin/python scripts/benchmark.py measure --mode facts --dir /tmp/avn-synthetic-benchmark
.venv/bin/python scripts/benchmark_prepared.py --dir /tmp/avn-synthetic-benchmark
.venv/bin/python scripts/benchmark_freshness.py --dir /tmp/avn-synthetic-benchmark --seconds 20
```

The optional ClickHouse engine probe requires Docker and the pinned image in its script. It uses
an owned scratch directory, no network in the container, and no application/deployment mounts.
Benchmark reports are synthetic evidence, not commands to run against a deployed data directory.

The facts CLI's `status` and `prepare --dry-run` use read-only SQLite connections, including when
analytics tables have not been installed. They do not initialize a missing data directory or schema.
Regression tests verify unchanged database hashes on an older synthetic installation.

## Dashboard read performance

New configurations default to `facts`; existing explicit `legacy` settings still take precedence.
Facts are used only after backfill and verification, with raw-event fallback for incomplete games.
For persistent Overview and Levels answers, set `AVN_ANALYTICS_READ_MODE=prepared` in the
deployment environment and keep the worker running. The owner applies deployment changes.
Check worker lag against `AVN_ANALYTICS_FRESHNESS_SECONDS` before increasing retained views.

The `avn_analytics.views` logger emits INFO records for prepared lookups: `kind`,
`source`, and `elapsed_ms`. Live fallbacks additionally include `fallback`: missing,
facts_not_ready, expired, definitions_changed, context_changed, or worker_unavailable.
Elapsed time includes lookup and live computation on a miss. These records cover lookups
that reach the prepared layer, not browser or response-cache hits; enable INFO for this logger
in the server logging configuration when diagnosing misses. No player IDs or filter values
are logged.

Browser analytics remain fresh for 30 seconds; dictionary and saved funnel/group lists use five
minutes. Writes invalidate affected game reads, with isolated invalidation for keys, saved
funnels/groups and chat history. Global/access changes retain broad invalidation. Uncertain write
failures also reconcile affected reads because the server may already have committed.
Other browsers see configuration changes when their freshness window expires.

Use `scripts/benchmark.py` with a synthetic scratch directory to compare cold and repeated
reads and inspect query plans before adding indexes. Never run synthetic generation on a real
data directory. Longer cache windows improve reuse, not the first computation.

Workspace startup reads registry metadata through `/v1/overview?totals=false` before fetching
workspace totals separately. Counting a busy game cannot block the shell or game navigation.
Until those totals arrive, Home and Status show loading states; an error stays local to those
totals with Retry. Daily workspace counts share a two-day event scope and use verified facts
when available, while raw events remain authoritative.
