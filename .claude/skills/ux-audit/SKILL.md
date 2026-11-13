---
name: ux-audit
description: Find UX problems in the AVN Analytics website. Run by an agent that did not build the screen, against the running app with realistic data, exercising every interactive state, checked rule by rule against rules.md. Use when asked to audit, review or "find what's wrong" with pages, and before finishing any page-level UI change.
---

# UX audit

You are the reviewer, not the builder. The builder already believes the screen is fine,
so your job is to find what the owner will find. Assume problems exist. In a past audit
the owner found 15 on four pages that three different agents had called done.

## Who runs it

- Run it in a **fresh agent** (a subagent) that did not write the code, with only this
  skill, the page list and the app URL. Don't pass it the builder's explanation of why the
  screen is designed that way.
- The builder may run `npm run ux-lint` and the rules themselves, but a page-level change
  is not done until an independent audit has passed.

## Steps

1. **Read `rules.md`** (next to this file) in full, plus the "Things the owner has already
   said they don't like" and "Design preferences" in `AGENTS.md`. Don't use the
   `avn-design` / `avn-ux` skills on this project.
2. **Run the app with realistic data** in a throwaway data dir (never real data):
   `scripts/benchmark.py generate --events 50000 --dir ~/temp/scratch/ux-audit`, then
   `AVN_DATA_DIR=~/temp/scratch/ux-audit PORT=8202 scripts/dev.sh`. You need enough
   games, players and parameters to hit the long-content cases.
3. **Run the automatic checks**: `cd web && AVN_WEB_URL=http://127.0.0.1:8202 npm run ux-lint`.
   Every failure is a finding. Don't argue with it. If a check is wrong, say so in the
   report and fix the check separately.
4. **Exercise every state** in "States every audit must exercise" (rules.md) on each page
   in scope, and take a screenshot of each state. Use the browser (Playwright MCP or the
   preview tools). Click things, don't only read the DOM.
5. **Go through the rules one at a time for each screenshot.** Then do one free pass as a
   senior product designer would: what would you circle in red? Check Nielsen's ten
   heuristics, especially consistency, recognition over recall, minimalist design, and
   visibility of system status.
6. **Verify each candidate.** Point to it in a screenshot or a DOM measurement. Drop
   anything you can't point to. Don't pad the list.
7. **Report** in this format, most severe first:

   | # | Sev | Rule | Page · state · width | What's wrong (one line) | Fix (one line) | Screenshot |
   |---|-----|------|----------------------|-------------------------|----------------|------------|

   Then list "New rules suggested": problems no rule covers yet, written as a rule plus a
   check, ready to paste into `rules.md`.

## What an audit is not

- Not a code review, and not a list of things that are fine.
- Not "consider maybe". Every finding names the rule (or "new"), the place and the fix.
- Not limited to the page you were pointed at. If a rule fails, check every page that
  shares the component.
