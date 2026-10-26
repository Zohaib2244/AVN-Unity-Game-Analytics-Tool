---
name: player-review
summary: Understand one player: how they play, how far they got, whether they are typical
args: a player ID (or open a player first and just send this)
---
Review {args_or_default}.

1. Call get_player_levels for the player, then get_player_events for the events they used most.
2. Call compare_player to see whether they are typical for the range and for players who installed around the same time.
3. If they stopped playing, look at their last session with get_player_story: what they did last, and whether a level was failed several times before.
4. Say what kind of player this is (progression, pace, spending or ad habits if the events show them), where they got stuck or left, and what in the game might have caused it.

Keep it short: the profile in three or four lines, then what stands out, then one suggestion. Do not save a report unless asked.
