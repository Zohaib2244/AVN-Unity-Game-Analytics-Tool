---
name: release-check
summary: Compare the latest published build with the one before it
args: optional: two versions to compare
---
Compare the builds for {args_or_default}.

1. Call get_context and read published_builds: the first is the latest, the second the build before it (use the two versions the person named if they gave any).
2. Call compare_segments with dimension app_version and the two builds, then get_level_progress and get_retention for each build with filters app_versions set to that build alone. Put them side by side: completion, tries per player, fails and drop for each level, and retention.
3. Name the levels that got better or worse by a margin that is bigger than the sample allows for (ignore levels with few players), and what changed in what players did there (get_level_detail for the biggest movers).
4. For new players, run compare_player_groups on the early behaviour that matters (time to finish level 1, say) for each build if the builds have enough new players, and say whether the outcome moved.

Say plainly which build is healthier and where, how sure you are, and what to check or fix first. End by offering it with propose_report titled with both versions.
