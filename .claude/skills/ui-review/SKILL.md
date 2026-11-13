---
name: ui-review
description: Check a UI change in the running app before calling it done: build to the rules in ux-audit/rules.md, open the page with realistic data at three widths and in every interactive state, run the UX lint, then have an independent ux-audit pass. Use for any change to web/ pages, CSS or components, and when asked to review or polish a screen.
---

# UI review

A UI change is not done when tests pass. It is done when an agent that didn't build it
has looked at it and found nothing.

1. **Before building, read `.claude/skills/ux-audit/rules.md`** and the owner's lists in
   `AGENTS.md`. Don't use the `avn-design` / `avn-ux` skills on this project.
2. **Run the app with realistic data** (not three rows) in a throwaway data dir, never real
   data: `scripts/benchmark.py generate --events 50000 --dir ~/temp/scratch/ui-review`, then
   `AVN_DATA_DIR=~/temp/scratch/ui-review PORT=8202 scripts/dev.sh` (after
   `cd web && npm run build`).
3. **Exercise the states, not only the default.** Use the list in rules.md. For each
   dropdown or popover you touched: open it, scroll with it open, and open it near the
   bottom of the viewport. Check wide (1440), rail (900) and phone (390), in dark and light.
4. **Run `npm run ux-lint`** in `web/` against that server. Fix everything it reports.
5. **Compare with the approved prototype**, if there is one. List every difference. A
   difference you can't justify is a bug.
6. **For a page-level change, run an independent audit**: start a subagent with the
   `ux-audit` skill, scoped to the pages you changed and every page that shares their
   components. Fix its S1 and S2 findings, then audit again.
7. **Report what you looked at**: screens, states, widths, what the audit found, what you
   fixed, and what you left and why.
