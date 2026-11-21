# Load times and size, November 2026

What made pages slow as games grew, what was changed, and what it measured. Numbers are from a
synthetic game shaped like the current Unity plugin (`scripts/benchmark.py generate --shape sdk`):
250,081 events over 60 days, 436 MB, about 1,750 bytes per event. Full figures:
[`benchmarks/load-20261119.json`](benchmarks/load-20261119.json).

## Why pages slowed down as data grew

1. **Whole-history counts on every page load.** Events, Event setup, Discovery, the dictionary
   import and the mappings check counted (and parsed the parameters of) every event the game
   ever sent, whatever dates were picked. They grew with history, not with the range.
2. **Raw JSON reads where the facts already had the answer.** Retention read every session start
   of all time from the raw JSON; device specs scanned every event to find one player's phone;
   event activity (an MCP and NutBot tool) parsed every event's JSON.
3. **Repeated passes.** The filter menus made five full passes over the range; event detail
   expanded every parameter twice; Players replayed every session twice in Python.
4. **The website shipped as one 1.17 MB script, uncompressed** (the reverse proxy does not
   compress this site), and every page waited for all of it.
5. **Levels and Overview computed live** take seconds per request on this size (8 s and 2 s);
   prepared answers (`AVN_ANALYTICS_READ_MODE=prepared` with the worker running) answer the same
   in 28 ms and 5 ms. When the worker is stopped they fall back to the live computation.

## What changed

- `event_stats.py` keeps all-time totals per event name, per (event, app version, parameter,
  JSON type) and the distinct (event, player) pairs, extended by facts `id` in short
  transactions, at most 100k facts per page load, larger backlogs by the analytics worker.
  A read is the kept totals plus a live count of newer facts, so answers stay exact. Deleting
  events, a verification repair or a facts rebuild invalidates them (triggers) and they are
  rebuilt. Cost: about 5 bytes per event (0.3%).
- The mappings verdict (`/mappings/status`, shown on several pages) stops reading once nothing
  can change the answer, and skips parsing events that can't. Same verdict, tested against the
  full read.
- Retention and device specs read the facts and event detail's list of versions reads the kept
  totals; the filter menus count
  from one row per player and dimension combination; event detail expands parameters once;
  Players replays each player's sessions once for both session columns; level captions work out
  name-only checks once per event shape.
- **Behaviour change:** Event setup's example values per parameter come from the same most recent
  150,000 events the page already reads, instead of every event ever.
- The admin app gzip-compresses answers and website files (level 5, from 1 KB; NutBot's line
  stream and MCP event streams are left alone). Built website files were already cached for a
  year by name.
- The website loads each page's code when it is first opened and fetches the rest while the
  browser is idle; libraries (React, TanStack, Motion, `@avn/ui`, Radix) are separate files that
  stay cached across releases.

| Request (250k events, warm, cache off) | Before | After |
| --- | ---: | ---: |
| Events | 4.14 s | 0.73 s |
| Discovery | 3.88 s | 0.01 s |
| Retention | 1.79 s | 0.37 s |
| Mappings check (all rules met) | 1.85 s* | 0.003 s |
| Filter menus (facets) | 1.13 s | 0.76 s |
| Event detail | 2.24 s | 1.40 s |
| Players | 2.09 s | 1.80 s |
| Device specs (SQL part) | 3.0 s | < 1 ms |
| Event activity (MCP/NutBot, one condition) | 1.72 s | 0.56 s |
| Data health (MCP/NutBot, 100k events in window) | 0.99 s | 0.48 s |
| Ads delivery / placements | built the ad table 2x | once per request |

\* 6.4 s through Python on the same data; the fixture's standard mapping includes a Restarted rule
it never sends, so its own check reads to the end (0.4 s) as it must.

Whole-history requests now stay flat as history grows; the others grow with the chosen range.

| Website | Before | After |
| --- | ---: | ---: |
| Script needed for the first page | 1,167 KB (one file) | about 760 KB, 386 KB as sent (gzip) |
| CSS | 315 KB | 315 KB, 59 KB as sent |
| Player timeline answer | 502 KB | 58 KB as sent |

## Size

Where an event's 1,750 bytes went: the raw row 821 (JSON envelope about 625), the facts copy 407,
and nine indexes about 520. Measured again on the same generator after the changes below:
about **1,515 bytes per event, 13% less** (raw row 585; 1,475 was measured with the facts change that was removed, which saved 40 of those). Ingest also got faster here.

- **Stored JSON without the columns it repeated.** `event_id`, `name`, `client_ts` and
  `server_ts` are columns of `events`; new events no longer repeat them inside `payload`, which
  is also written without the spaces `json.dumps` adds. `storage.full_event(row)` puts the four
  back, in the envelope's usual key order, for whoever needs the whole event (exports). About
  210 bytes per event. Every value is still stored once.
- The write-ahead log is cut back to 64 MB after checkpoints instead of staying as large as it
  ever grew.
- `python -m avn_analytics.storage_report` (owner) shows each game's size, free pages and, where
  SQLite has `dbstat`, each table and index. `--game ID --slim --yes` rewrites events stored
  before this change without the four repeated fields (only where each equals its column; a few
  thousand per transaction, collection carries on). `--compact` gives the freed pages back
  (VACUUM: 6.6 s for 450 MB on an SSD; collection waits meanwhile) and checks that every fact
  still points at its event, re-verifying them if not (SQLite keeps row numbers through VACUUM
  but does not promise it).

Not done: keying the facts by their raw row instead of the unique event ID index (about 40 bytes
per event, 2%) was built and removed: it changes the facts schema, which makes every service drop
and rebuild each game's facts at startup (a deploy failed on that). Leaving out envelope keys whose value is null (about 55 bytes per event, 4%) would
change what exports contain (`json_type` tells a missing key from a null one). Binary JSON
(JSONB) for the facts' parameters measured 11% smaller there and 15% faster to read.

## Reproducing

```bash
. scripts/_env.sh
.venv/bin/python scripts/benchmark.py generate --shape sdk --events 250000 --days 60 --dir <scratch>
.venv/bin/python scripts/benchmark_prepared.py --dir <scratch>
```
