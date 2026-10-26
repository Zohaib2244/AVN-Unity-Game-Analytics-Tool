---
name: digest
summary: What players have been doing lately: habits, loops, unused features, changes
args: optional: a date range
---
Write a behaviour digest {args_or_default}.

1. Call get_behaviour. Look at what players do most and least, the common sequences, repeated loops, parameters that are almost always one value, and what moved in the last 7 days.
2. Pick the three most surprising or useful findings (not the obvious ones: players play levels). For each, check it with one more tool call (get_player_events on an example player, run_funnel, or compare_cohorts) before you claim it.
3. For each finding say what it suggests about why players behave this way, and what to test.
4. Note events that look unused or unclear and which are worth adding to the event dictionary.

Keep it to one screen. End by saving it with save_report titled with the date range.
