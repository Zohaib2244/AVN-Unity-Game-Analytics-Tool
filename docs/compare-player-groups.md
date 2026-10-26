# Compare player groups

Open **Levels → Compare player groups** to see **My checks**. There are no built-in presets. **New check** opens Population → Behavior → Groups → Outcome, with only the current step visible. Save a named **shortcut** to run that complete comparison directly next time. **New group** stops at Groups: save the population, behavior, split and observation window independently of the outcome. **Use** on a saved group opens the Outcome step for a new check.

Saved groups and shortcuts belong to the game and are shared with people who have access to it. Editing a group does not silently change shortcuts created from it: each shortcut keeps its own definition. Edit and rename from the saved row; Remove offers Undo with the original ID. Saved definitions rerun against current events, rather than freezing player membership. Relative date ranges and Latest/Previous version choices resolve again when used; custom dates and specific versions remain fixed. The unsaved draft and last result setup remain browser-specific.

## Population and follow-up

Dates select players first observed in the game during those dates, after applying the chosen environment rules. Version, build, country and platform must match the first observed event, rather than an event after an upgrade. Follow-up uses all subsequent versions and countries; environment rules still apply. The selected dates are enrollment dates: a player's follow-up can continue beyond the end date.

By default, the first recorded progression must start level 1. A different entry level or any first-observed player can be chosen. Players with earlier history or advanced saves are reported as excluded, with a reason. “New” means first observed in the retained dataset; it does not prove a fresh install.

The observation window starts at the first observed event and ends after the selected number of hours (at most 30 days). A player with an incomplete window is **still observing**, even if an outcome was already recorded; they do not enter a completed group's denominator. The cutoff uses the server clock and is returned as `as_of`. Events with future client timestamps are not counted. Late arrivals can change an answer.

Exclude known player IDs or matching baseline events, optionally narrowed by a parameter test. Exclusion events are considered only up to and including the first recorded progression, so later behavior cannot select the population. Excluding an emulator using a device parameter therefore requires that parameter to have been recorded by that point.

## Behaviors and grouping

- **Time to first level completion:** elapsed client time from that level's first recorded start/restart to its first completion, including retries and time away across sessions. It does not use a reported `duration_seconds` or only the final successful attempt. A completion without a start has no usable duration. No completion and invalid measurement remain visible separately from A/B.
- **Event count/exposure:** count a chosen raw event (optionally with a parameter condition) within a fixed early window. Zero is a known count and belongs to the numeric split, rather than the missing group. A split of zero compares unexposed and exposed players; a larger split can compare repeated prompts.
- **Recorded parameter:** the first recorded value on the chosen event in the early window. Compare a finite numeric split, or one exact value with other recorded values. Missing values and a nonnumeric first value in a numeric comparison are reported separately. This supports device tier, campaign and tutorial metadata when those values are recorded.

Numeric group A includes the split (`≤`); B is above it (`>`). There is no default 70-second threshold. The user enters the split, and the UI labels it exploratory.

The outcome is a later level start/restart or a chosen raw event, optionally narrowed by a parameter condition. Outcomes in A/B must occur strictly after grouping and no later than the observation deadline. For event counts, grouping happens when the fixed early window ends. For durations or parameters, it happens at the completion/value timestamp. Players whose outcome was already recorded before or at that point are counted separately, outside A/B. The missing-behavior row reports outcomes over the whole window and is not part of the A-minus-B comparison.

## Results

Each group shows reached players / total players, the percentage, a 95% Wilson interval, a small-sample label using the game's existing Levels threshold, and up to 50 player examples. Player examples open the centred viewer. Exclusions, missing-data reasons, still-observing counts and outcomes before grouping stay visible or have a named breakdown. CSV contains the result, the full request definition, counts and uncertainty.

The A-minus-B difference uses a 95% Newcombe interval combining the independent groups' Wilson limits ([Newcombe, 1998](https://pubmed.ncbi.nlm.nih.gov/9595617/)). An interval containing zero is labelled unclear. Intervals reflect sampling uncertainty, not confounding, missing instrumentation or threshold selection. Results show association; an experiment is needed to establish whether changing the experience improves progression.

## API

`POST /v1/games/{game_id}/insights/player-groups` is a read-only analytical request with the normal game-access checks and response cache. It supports the raw, facts and prepared read modes through the existing source abstraction. It creates only temporary tables and never changes raw events or materialized generations. It refuses more than 100,000 candidate players or 5 million follow-up events, with guidance to narrow the scope.

```json
{
  "start": "2026-10-01",
  "end": "2026-10-24",
  "timezone_offset_minutes": 0,
  "filters": {"app_versions": ["0.1.3"], "exclude_environments": ["editor", "development", "test", "debug"]},
  "entry_level": 1,
  "exclude_players": [],
  "exclude_events": [],
  "behavior": {"kind": "level_duration", "level": 1, "split": 70},
  "outcome": {"kind": "level", "level": 4, "window_hours": 24}
}
```

For event counts use `behavior.kind = "event_count"`, `event = {"event":"ad_show","param":"type","op":"eq","value":"interstitial"}`, `window_minutes = 10` and a numeric `split`. For parameters use `kind = "parameter"`, the source `event`, `parameter`, `window_minutes`, and either `comparison = "number"` with `split`, or `comparison = "equals"` with `value`. For an event outcome set `outcome.kind = "event"` and provide `outcome.event` using the same event-rule shape.

## Saved library API

`GET/POST /v1/games/{game_id}/insights/group-library` lists or creates saved items. `PUT/DELETE /{item_id}` updates or soft-deletes an item; `POST /{item_id}/restore` supports Undo. Every route enforces the game's normal access rules. The library starts empty and accepts at most 200 active items per game, with case-insensitive names unique within each kind (`groups` or `check`).

The body contains `name`, `kind` and `definition`. A definition includes the population and behavior fields from the analytical request, plus `window_hours`, `range_preset`, `version_mode`, `timezone`, and `hide_test`. A check requires an `outcome` with the same observation window; groups use `outcome: null`. The support table is additive and never modifies raw events.
