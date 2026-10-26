---
name: exits
summary: Where and why players stop playing
args: optional: a date range or "new players"
---
Find where players leave {args_or_default}.

1. Call get_exits (use get_level_detail with scope first_session when the person asked about new players).
2. For the top three exits call get_level_detail and read what the players who left did last.
3. Build a funnel with run_funnel from first_open through the main levels if the early game matters, and see where it falls.
4. Rank the exits by how many players they cost, not only by percentage, and say which are worth fixing first.

Finish with the ranked list, the likely cause of each, and the first change to try. Offer to open the levels view with propose_level_view.
