# Long-level preparation regression

The important failure was the representation of prepared Levels, not the browser's timeout.
Each per-player contribution repeated detail records across groups, then the final reducer decoded
and retained all players' details for all levels. A large, otherwise valid view exceeded the
64 MiB decoded-contribution guard. Falling back to a cold facts scan left the browser waiting on
another expensive calculation.

Version 6 splits summary contributions from player details. Final reduction keeps counts, exact
duration samples and feature totals. Immutable detail records are indexed in compressed 64-level
buckets and selected through an atomically published player-token map. Table/feature reads do not
load those details; a player drill-down loads its selected bucket. Staging cannot alter a published
answer. The 64 MiB reducer allowance remains, now conservatively charged against retained state,
with a separate 16 MiB limit per decoded summary. Existing storage, source-revision, cancellation
and lease guards still apply.

Browser Levels reads request asynchronous preparation: a healthy worker returns a short HTTP 202
while building, followed by the exact answer when ready. The UI polls with a bounded retry count,
shows a preparation message, and keeps previous results during refresh. A preparation error has a
retry action. The 60-second individual request limit is unchanged. A stopped/unavailable worker and
callers that do not request asynchronous preparation retain the live fallback.

## Reproducible capacity test

[`scripts/benchmark_levels.py`](../scripts/benchmark_levels.py) creates a **marked synthetic**
fixture: 400 players, 200 levels for most players, one player reaching 4,000 levels, changing SDK
sequence numbers/attempt/ad IDs and five events per level. It resets only derived prepared tables
between implementations. It refuses unmarked directories and applies the benchmark disk reserve.

```bash
. scripts/_env.sh
.venv/bin/python scripts/benchmark_levels.py generate --dir /tmp/avn-long-levels
.venv/bin/python scripts/benchmark_levels.py measure --dir /tmp/avn-long-levels \
  --baseline-ref <baseline-commit> --json /tmp/avn-long-levels/results.json --check-refresh
```

For a resource-limited candidate run, mount this checkout read-only and the marked fixture at
`/fixture` in the project's Python runtime image. Use `--network none --read-only --cpus 0.5
--memory 512m` and a writable scratch tmpfs, then run:

```bash
python scripts/benchmark_levels.py phase --dir /fixture \
  --output /fixture/candidate.json --check-refresh
```

Use only a synthetic fixture mount. This is a separate disposable benchmark container, not a
deployment. The baseline command needs Git to load the requested source revision; the normal
runtime image can run the candidate without Git.

## Measured result, 2026-11-12

Full machine-readable output and conditions: [`benchmarks/levels-20261112.json`](benchmarks/levels-20261112.json).

The original implementation failed preparation on **419,800 events / 4,000 levels** with
`Prepared Levels exceeds the bounded reducer memory budget`. No prepared latency is reported
for that failure. The candidate fixture began at 419,802 events because it retained two synthetic
events from an earlier refresh probe.

With **0.5 CPU / 512 MiB**, the candidate completed preparation in **127.0 seconds** and used
**122.4 MiB peak RSS** through preparation and prepared reads. The compact compressed answer was
132,600 bytes; total logical derived storage was 4.68 MB. Five reads per endpoint, using a new
Storage instance with the response cache disabled:

| Prepared answer | Median | Maximum |
| --- | ---: | ---: |
| Levels table | 602 ms | 666 ms |
| Occurrence and drop | 574 ms | 636 ms |
| Selected level's players | 1,015 ms | 1,080 ms |

Table, features and the selected player page matched live facts exactly. Raw/fact counts were
unchanged during preparation, timing and parity. The optional refresh probe then appended two
synthetic events, including activity from the long-history player: the updated generation was
ready in **25.7 seconds** and again matched live facts. Full live parity raised peak process RSS
to 297.7 MiB; that is separate from the prepared-path peak above.

These are Python computation-path measurements. They exclude HTTP encoding, transfer and browser
rendering, and do not predict production latency. The unrestricted baseline and constrained
candidate have different CPU conditions, so their preparation durations are not a speed comparison.
Initial preparation still takes about two minutes in this test; the browser now waits through
short polling requests instead of repeatedly restarting a cold calculation. A newly selected
date/filter/scope combination still needs its own prepared generation.

Regression tests cover exact parity in both scopes and both return filters, selected-level details,
storage accounting, memory refusal without publication, cancellation, source snapshots during
publication, staging isolation, prior-version failure recovery, and HTTP pending/error/ready states.
The browser regression covers preparation, keyboard retry, dense tables and existing return filters
at three widths, both themes and two palettes. A separate 250k-event synthetic game was reviewed
at 1440, 900 and 390 pixels without response mocks, with no page overflow or browser errors.
