---
name: level-review
summary: Review one level (or the worst levels): where players leave, why, what to change
args: a level number, or nothing for the levels that lose the most players
---
Review {args_or_default}.

1. Call get_context, then get_exits to see how the levels rank (skip this when one level was named).
2. For each level you review (at most three), call get_level_detail. Read the groups: players who left during the level, who finished and then stopped, who got stuck (three or more tries without passing), and what each group did last.
3. Open two or three example players with get_player_levels and look at how they played the level and the ones around it.
4. Compare the leavers with players who went on using compare_cohorts (for example never completed level N vs completed it) and say what differs: sessions, play time, platform, version, country.
5. Check the neighbours: does the drop start one level earlier, or is the next level the problem?

Write the review: the finding and its numbers first, then the likely reasons (separate what the data shows from your guess), then one or two specific, testable changes and the number that will show whether each worked. If the sample is small, say so. End by offering it with propose_report (title like "Level 12 review") with a headline such as the level's exit share.
