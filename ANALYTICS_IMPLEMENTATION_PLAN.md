# Analytics implementation plan

Status: proposed implementation; this document does not change application behaviour.

## Decision and intended result

Keep SQLite as the initial storage engine. Preserve raw events and add a rebuildable analytics
layer that stores commonly queried fields, prepares player histories, and refreshes frequently
used dashboard answers outside web requests. Evaluate ClickHouse against the resulting workload
only if the measured performance or operating cost still falls short.

The primary workflow is Levels → players who quit → an individual player's timeline. Prioritize
that workflow alongside Overview. A larger answer cache alone is not the intended solution.

## Confirmed choices for implementation

- Design for 10 million events per game as the capacity target; measure results rather than
  assume every query will meet the interactive budget at that scale.
- Use a 60-second freshness target during healthy processing. Catch-up after an intentional stop
  is a separate, visible state with measured lag.
- Add a separate worker container with an initial limit of 512 MB RAM and 0.5 CPU, in addition to
  the existing API service budgets. Validate memory headroom and processing throughput.
- Give global administrators a web-app control to start and stop analytics processing, with
  persistent state and safe resume. Keep collecting game events while processing is stopped.
- Proceed autonomously within this plan during implementation. Resolve routine choices using
  the confirmed defaults, record material deviations, and leave the branch for review. Release
  and deployment remain the owner's responsibility.

## What the existing code establishes

- `storage.py` stores five event columns, with most dimensions inside `payload`. Ingest deduplicates
  by `event_id` and also updates the session environment table.
- `insights.scope_events` already removes repeated JSON extraction within several individual
  requests. `readcache.py` reuses answers and level scans for 60 seconds by default.
- `journeys._scan_progress` and `_scan_transitions` read overlapping data. The latter repeatedly
  walks a player's history for individual levels. Earlier profiling identified substantial Python
  computation here, so changing the database alone would leave an important bottleneck.
- Levels selects starters using the requested filters, but reads their history using a narrower
  set of filters. First-session mode has its own historical cohort rules.
- Environment can come from an event, its session, a platform fallback, or a correction rule.
  Dictionary mappings can depend on event parameters and app version.
- Compose currently gives ingest and admin separate processes, each limited to 512 MB and one CPU.
  A host having more memory does not increase those container budgets.
- Earlier deployed measurements included approximately 213,000 events / 197 MB for the largest
  game, with Overview at 16.5 seconds. The optimized branch has not been measured on that server
  in this conversation, and Levels was skipped in that server measurement.

These observations guide the design; they are not a benchmark of the proposed implementation.

## Correctness requirements

1. Raw event payloads remain authoritative and are never rewritten or deleted by this work.
2. Preserve API responses, identity fallback, timestamp ordering, filtering, cohorts, level
   classifications, event references, and session-duration semantics unless a separate change
   explicitly documents and tests different behaviour.
3. Preserve exact counts and statistics. Do not sum daily distinct-player counts into WAU/MAU,
   average averages, or calculate a median from daily medians.
4. A late event can revise an older session, first-session cohort, level outcome, or return flag.
   A client timestamp cannot be the ingestion checkpoint.
5. Duplicate event submissions must not duplicate facts or counters. Existing session-context
   updates, including those accompanying duplicate submissions, must still invalidate affected
   analyses when their effective values change.
6. Changed mappings and environment corrections must never silently reuse answers computed with
   the old interpretation. Presentation thresholds need not rebuild the underlying event facts.
7. Summary failure must not lose accepted events. Ingestion never waits for a dashboard rebuild.
8. Prepared answers must respect authorization and game isolation just as live answers do.

## Phase 0 — Establish an executable baseline

Deliverables:

- Extend `scripts/measure_speed.py` or add a companion benchmark using synthetic data outside
  `data/`. Include approximately 250,000 and 1 million events; add 10 million as a capacity run.
  Preflight scratch-disk requirements and bound generation/measurement resources. If the capacity
  run cannot fit the available environment, record that limit rather than claim it was validated.
- Measure underlying computation with the response cache disabled, repeated HTTP requests with
  the cache enabled, and the first request after process restart. Distinguish an empty application
  cache from an empty operating-system disk cache.
- Include Overview, facets, Players, mapping status, Levels in both scopes, level player lists,
  and player timelines. Cover 7/30/90-day ranges and representative filters.
- Record wall time, peak process/container memory, database/index/WAL/scratch space, ingest
  throughput and p95 latency during concurrent dashboard activity, and relevant query plans.
- Build a deterministic result comparison harness around the current implementation. Keep a
  frozen reference implementation in test tooling during the transition, separate from the
  optimized production implementation.

Target budgets, to validate rather than promise:

- Prepared Overview and Levels responses: p95 below 500 ms on the approximately 250,000-event
  fixture, including after an API restart when prepared data already exists.
- Level player lists and ordinary player timelines: p95 below 500 ms on that fixture.
- Healthy background processing: newly committed events reflected within 60 seconds under the
  documented benchmark ingest rate. Initial backfill is measured separately.
- Ingest p95 regression no greater than 20% against the same workload, with no lost events or
  incorrect duplicate acknowledgements.
- Stay below configured service memory limits with headroom; explicitly measure the additional
  worker and total resource cost. Never justify fast reads by exhausting the ingest budget.

Gate: baseline results and reference answers are reproducible. The owner can run the read-only
measurement on the deployed version; agents do not inspect real data directories.

## Phase 1 — Store stable event fields once

Add an `analytics_facts` table in each game's existing database, rather than initially widening
or replacing the raw `events` table. This preserves its five-column format and makes derived
storage independently rebuildable. Reassess the extra table's join/storage costs in benchmarks.

Initial fields:

- `event_id` as the unique raw-event reference; event name and client/server timestamps.
- Original `user_id` and `device_id`, plus the exact existing player fallback expression.
- Session ID, app version, build, country, and platform.
- Nullable event-declared environment; do not freeze the session fallback or corrected environment.
- Parameters in their existing JSON representation, so parameter rules and custom analysis remain
  available without copying the full envelope. Add extracted numeric fields only where measured.

Introduce versioned analytics metadata and a durable `analytics_changes` sequence in the same
database. The sequence orders accepted events and effective session-context changes by commit
processing, independently of client timestamps.

In `Storage.ingest`, use explicit raw INSERT column names. In one transaction:

1. Insert accepted raw events, obtaining the IDs actually inserted.
2. Insert their facts and durable change records exactly once.
3. Apply session-context updates and record changes for sessions whose stored context changed.
4. Preserve the accepted/duplicate response using raw insert results, not `total_changes` after
   writing additional tables.

Keep dictionary interpretation and summary computation out of this transaction. A transaction
failure rolls back the whole batch and lets existing SDK retries recover it.

Build only indexes justified by query plans: candidates include time/event-ID, player/time/event-ID,
session/time/event-ID, and event-name/time. Avoid indexing every filter permutation.

Historical backfill must be idempotent, resumable, and bounded. Enable facts for new events first;
then copy historical rows in short transactions, without modifying raw payloads. Track progress
durably and verify coverage and extracted values before enabling facts reads for a game. Detect
and repair missing facts after an older application version has written raw events.

Gate: extraction parity, duplicate handling, concurrent ingest/backfill, interrupted backfill,
environment fallback changes, and disk/error recovery tests pass. Measure disk expansion and
write overhead; do not reuse the earlier experimental 24% estimate for this different schema.

## Phase 2 — Move live queries onto facts and simplify Levels computation

Create shared query helpers for facts, effective environment, and filter construction. Migrate
Overview, facets, Players and mapping status, then Levels. Raw event views and exports continue
to use the authoritative envelopes; any shared export filters must retain identical results.

Preserve the distinction between event-declared environment and the `sessions` fallback. A late
session environment update must affect events that omitted environment, including historical rows.
Apply environment corrections with the existing precedence rules.

For Levels, factor one deterministic per-player reducer from the existing implementations:

- Read ordered events once, using `(client_ts, event_id)` as the stable tie order.
- Share classification between progress and transitions.
- Replace repeated full-history searches with indexed lookups or prefix/suffix state where the
  current semantics permit it; measure scaling with both event count and level count.
- Preserve selected starters versus historical context, same-session duration matching, exact
  duration samples, next numbered level versus a higher level, and both analysis scopes.
- Preserve raw event references and sufficient neighbouring context for last action, next action,
  ads/background transitions, and the timeline's highlighted event.

Do not replace filtered/range-limited calculations with lifetime player or session totals. Custom
Players metrics and parameter conditions retain an exact facts-based calculation when no prepared
representation covers them.

Gate: old and new answers match across the comparison matrix, including time boundaries and ties.
Record this phase's improvement independently of background summaries.

## Phase 3 — Add a bounded background worker and interpretation versions

Add a dedicated analytics worker entry point, provisionally `avn_analytics/materialize.py`, and
a Compose worker service sharing the data mount, limited initially to 512 MB RAM and 0.5 CPU.
Keep it outside API request handling and outside the admin process so its memory and CPU use can
be limited independently. Start with one worker, processing one game/batch at a time; add no
message broker or distributed scheduler.

The worker consumes `analytics_changes` with a persisted checkpoint. Use a per-game lease to
prevent accidental concurrent workers, bounded batches, lock retries/backoff, and a clean shutdown.
Checkpoint only successfully published work; replay after interruption must be harmless.

Store mapped event facts, provisionally `analytics_interpretations`, with a durable interpretation
version. Reuse `stories.Labeler` and canonical mapping rules rather than introducing another
definition of level actions. Use a stable digest of canonical definition data plus an algorithm
version, not Python's process-local `hash()`.

Track environment-rule revisions separately. Session-context changes dirty affected players and
session-derived data. A mapping edit, dictionary import/undo, environment-fix change, or reducer
version change must trigger the correct rebuild. Threshold changes should normally only rerender
the final result and invalidate response caches.

Build derived data in staging generations and publish only a complete generation. Associate each
generation with its interpretation revisions and a contiguous processed change watermark. Use a
consistent source snapshot while computing; events after its watermark remain queued. Bound
snapshot duration and monitor WAL growth so a rebuild cannot pin an unbounded WAL.

Expose internal progress: last successful refresh, watermark, backlog, backfill completion,
rebuild state, and last error. Log processing time and retries without event payloads or secrets.

### Admin start/stop control and recovery contract

Provide an Analytics processing section in the admin settings, with Start processing / Stop
processing controls. This is a global service setting affecting all games, restricted by the
existing global `TeamAdmin` authorization and recorded in the audit log. Workspace managers and
ordinary members cannot operate or inspect global worker details. Explain in the control that
game events continue to be collected while analytics processing is stopped.

Keep the container running as a lightweight supervisor while processing is off. The web control
changes application state, so it can resume work without Docker access, a container restart, or
a deploy. Do not mount the Docker socket or grant container-management privileges to the web app.
If the worker container itself is missing or stopped externally, report it as unavailable; a Start
request persists the desired state but must not pretend it has started an absent process.

Persist desired state (`running` / `stopped`) and a monotonically increasing control revision in
the registry database. Default new installations to running; thereafter preserve the stored
choice across web-app, worker, and host restarts. The worker publishes a heartbeat, the control
revision it has acknowledged, and its observed state. Use durable timestamps for cross-process
status and monotonic timers only for local timeouts. Poll for control changes while idle too.

Show the observed states Starting, Running, Stopping, Stopped, Catching up, and Unavailable/error.
Display the current game/job, last successful update, pending work, and processing lag. Only show
Stopped after the matching request has been acknowledged and all active work has released its
leases/read snapshots. A lost heartbeat is Unavailable, not proof that stopping finished. A
persisted error must not be hidden by an otherwise healthy supervisor heartbeat.

Stop/resume behaviour:

1. **Idle stop:** acknowledge the stop promptly and stop claiming work. Idle polling remains cheap.
2. **Stop during computation/backfill:** persist the request immediately, show Stopping, and check
   for cancellation at bounded batch/player/chunk boundaries. Do not start another job. Finish an
   already-committing atomic transaction or roll back its incomplete work; never publish partial
   results. Release snapshots/leases before acknowledging Stopped. Target acknowledgement within
   five seconds under normal test load; split expensive units and add inner cancellation points
   where a single player or backfill chunk would otherwise make this unbounded.
3. **Events arriving while stopped:** ingest still commits raw events, stable facts, session-context
   changes and the durable change sequence normally. Historical backfill and summary processing
   pause. Pending work remains discoverable; stopping must never advance its processing checkpoint
   or discard unprocessed records. Surface backlog/disk growth rather than silently dropping work.
4. **Resume:** acquire the lease, inspect persisted checkpoints/staging state and current definition
   revisions, and process all pending changes. Continue from a valid checkpoint. Reuse staging
   work only if its source snapshot/revisions remain valid; otherwise recompute it. Replaying an
   interrupted unit cannot duplicate contributions or counters. Include late events and context
   updates committed while stopped, even when they affect older dates or first-session cohorts.
5. **Crash/kill during work:** SQLite rolls back an unfinished transaction; unpublished generations
   remain invisible. After lease expiry/recovery, follow the persisted desired state: stay idle
   when stopped, or resume pending work when running. Never set the checkpoint ahead of the
   successfully published contiguous watermark.
6. **Rapid/repeated commands:** Start and Stop are idempotent desired-state updates. Fence worker
   acknowledgements with the control revision so an acknowledgement for an older Stop cannot
   override a later Start. Expose desired and observed state separately during the transition;
   an in-flight transaction may finish before Stopped is acknowledged.
7. **Definition changes while stopped:** record the revision change immediately. Existing answers
   with obsolete interpretations become ineligible; rebuild the required generations on resume.

Dashboard reads must continue through the exact live facts path when the worker is stopped,
unavailable, still backfilling, or catching up beyond the freshness budget. If facts coverage is
incomplete, use the existing raw-event path for the whole affected query. Never mix partially
backfilled totals with complete totals. Preserve the existing loading feedback; show a concise
explanation when processing is paused and a live calculation takes longer. Honor the existing
request limits/timeouts and report a recoverable error if necessary. Never imply that an old
prepared answer includes events received after its source watermark.

Keep the control labelled, keyboard-accessible and usable in both themes, following Nutstyle's
documented Calm layer. Status refresh must not reset page focus. Disable duplicate requests only
while their API write is pending; show acknowledgement separately from the processing transition.

Gate: restart/replay, concurrent ingest, worker lease, revision changes during a build, bounded
memory, and failure before/after publication all preserve correct results. Add regression coverage
for stopping during backfill/reduction/publication, ingest while stopped, catching up exactly after
resume, rapid Start/Stop races, worker unavailability, stored Off surviving restarts, and global
admin authorization/auditing. Exercise the admin controls in a browser in both themes.

## Phase 4 — Prepare exact answers for frequently used views

Persist the expensive Levels and Overview computations for actively used query specifications.
Store the Levels table and its player groups together so opening a level does not start another
history scan. Include the default 30-day view and both Levels scopes as initial priorities.

A query specification includes the game, endpoint family, exact start/end instants, filters,
scope, timezone offset where applicable, and algorithm version. Its published generation also
records mapping/environment revisions and the source watermark. Normalize only semantically
equivalent filter representations; exclude pagination and sorting from expensive shared work
where they can be applied to the prepared rows.

Keep per-player contributions for each active Levels specification. When new data arrives,
recompute affected players from the necessary history and replace their contributions; derive
the level totals from those rows. Recompute affected global flags and neighbouring level counts
as part of publication. Preserve exact duration samples for medians/percentiles. Maintain
anonymous counts separately, since those events do not have a player contribution.

Late events before the selected dates can still alter first-session eligibility and entry history;
do not discard those changes because their timestamps are outside the visible range. Session
context changes can affect multiple players if a session ID is shared; find all affected identities.

For Overview, start with a persisted exact answer built from facts and identity-preserving activity
data. Add reusable activity/session summaries only when benchmarks justify them. Preserve player
identities across days for exact WAU/MAU, and retain event-level fallback for partial sessions,
arbitrary filters, or timezone boundaries that a coarser summary cannot represent.

Bound active specifications with expiry and an LRU-style limit, initially 12 per game, and enforce
a global derived-storage budget. Refresh recently used specifications proactively and retire
unused ones. Handle day rollover as a new date specification. Eviction applies only to explicitly
derived tables, never raw databases, raw events, or SQLite sidecars.

New/custom queries use the exact facts-based path while their prepared answer builds. Existing
matching prepared answers can be served within the documented freshness budget. Beyond it,
fall back to current facts computation or report an explicit temporary failure; never silently
serve indefinitely stale data. Never serve an answer with obsolete mapping/environment revisions.
The existing response cache must not extend source-data staleness beyond that budget.

Gate: requests match live computation at the same watermark, including range/filter changes,
first-session eligibility changes, changed outcomes after returns, exact statistics, simultaneous
table/player-list requests, and a stopped or failing worker. Benchmark server restarts separately
from the first-ever build; initial preparation still has a real, measured cost.

## Phase 5 — Roll out in reversible stages

Proposed configuration, finalized during implementation:

- `AVN_ANALYTICS_READ_MODE=legacy|facts|prepared` for staged read selection and rollback.
- `AVN_ANALYTICS_WORKER_DEFAULT_ENABLED=true` to initialize the persisted desired state once on a
  new installation. Existing stored state always wins; changing this default or restarting a
  service must never undo an administrator's Stop. The runtime control lives in the database,
  not a restart-only environment variable.
- A bounded worker batch size, refresh interval, active-view limit, and global derived-storage
  budget, each documented with measured defaults.

Document every new variable in `.env.example`, the README configuration table, and deployment
instructions; pass it to the relevant Compose service. Add worker resource limits explicitly.

Implementation modules: `storage.py` for atomic ingest/schema; new `analytics.py` or a small
analytics package for facts/revisions/reducers; `materialize.py` for background work;
`insights.py`/`journeys.py` for read selection; `readcache.py` for generation-aware freshness;
`config.py`, `api.py` and Compose for wiring; `auth.py` for global administration/auditing; and
the existing settings UI for controls and observed status. Add admin-only status and desired-state
API endpoints, provisionally `GET`/`PUT /v1/admin/analytics-worker`. Keep API authorization on every
read and write path and apply the existing authenticated mutation protections.

Rollout order for the owner:

1. Follow the existing stopped-services, whole-directory backup procedure and verify restoration
   on an isolated location. Agents never read or modify live data directories.
2. Deploy additive schema and new ingest writes with legacy reads. Both services must use the
   compatible version; heavy backfill must not block API startup.
3. Backfill and validate facts; enable facts reads after coverage and parity checks pass.
4. Enable the worker and compare prepared/live answers in a bounded shadow-validation run.
5. Enable prepared reads for one game, verify freshness/latency/resources, then expand.
6. Rehearse Stop while work is active, continue ingesting synthetic events, restart both services
   with processing still Off, then Start and verify parity after catch-up. Confirm dashboards
   remain usable through the documented live fallback throughout.

On a problem, switch read mode back and pause the worker; retain raw data and do not attempt a
destructive down migration. An old application binary requires a documented compatibility check:
it will not maintain facts/change records. Before returning to prepared reads, audit coverage and
force catch-up or a full derived rebuild. Restoring an old backup after new ingestion is not an
ordinary rollback, because it would discard newly accepted events.

Gate: rollback rehearsal and restore rehearsal succeed on synthetic databases. Every behaviour
change has regression coverage and `scripts/check.sh` passes. Owner alone releases and deploys;
agents leave changes for review without pushing, merging, or opening PRs.

## Phase 6 — Decide whether ClickHouse adds enough value

Run this evaluation if the SQLite implementation misses the agreed budgets, refresh work falls
behind the measured ingest rate, resource costs are unacceptable, or a documented growth target
requires it. There is no universal event-count threshold that mandates migration.

Use an isolated ClickHouse instance and synthetic fixtures first. Store typed event fields and
use the same query semantics. Include custom filtered analysis, history-heavy Levels and timelines,
not just `COUNT(*)`. Compare end-to-end results, latency, ingestion, memory, disk, background work,
restart/recovery, operational effort, and data freshness with the optimized SQLite implementation.

Specifically test duplicate SDK retries, out-of-order events, correction/mapping rebuilds, and exact
distinct/median requirements. A ClickHouse primary/sorting key is not a SQLite uniqueness constraint;
do not assume background deduplication alone makes retry counts immediately correct.

If the measured benefit justifies adoption, keep game/team/configuration records in SQLite and
move event analytics behind a narrow storage boundary. Specify durable delivery, replay,
deduplication and reconciliation before cutover; do not introduce best-effort dual writes.
Otherwise keep the simpler SQLite deployment and retain the benchmark as a regression tool.

## Suggested review units

1. Baseline fixtures, parity harness, and explicit performance budgets.
2. Additive facts schema, atomic ingest/change tracking, resumable backfill.
3. Facts-based queries and Levels reducer improvements, independently benchmarked.
4. Worker lifecycle, persisted admin start/stop controls, revisions, staging generations, and
   stop/resume/recovery tests.
5. Exact persistent Levels/Overview views, bounded refresh, freshness-aware reads.
6. Operational documentation, configuration, resource tests, and rollout rehearsals.
7. Conditional ClickHouse benchmark and a written adopt/defer decision.

Each unit must be independently reviewable and pass the repository gate. Do not implement the
entire pipeline in one change or migrate the database before measuring the simpler design.
