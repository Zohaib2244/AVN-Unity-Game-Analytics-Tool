---
name: ui-review
description: Check a UI change in the running app before calling it done: read avn-design, open the page with realistic data at three widths, compare with the approved prototype, run the self-check and fix what fails. Use for any change to web/ pages, CSS or components, and when asked to review or polish a screen.
---

# UI review

A UI change is not done when tests pass. It is done when you have looked at it.

1. **Read the design skill.** `avn-design`, then `ux/references/process.md` (the self-check) and the page pattern in `ux/references/pages.md`. Name the pattern the screen follows.
2. **Run the app with realistic data** (not three rows). Build the site (`cd web && npm run build`), then serve it against a throwaway data directory, never real data:
   - `scripts/benchmark.py generate --events 50000 --dir ~/temp/scratch/ui-review` (a synthetic game), or load a few hundred players of events into a scratch directory with the real ingest code (`tests/synthetic.py` shows how)
   - `AVN_DATA_DIR=~/temp/scratch/ui-review PORT=8202 scripts/dev.sh`
3. **Look at it** in the preview browser, at wide (about 1280), rail (about 800) and phone (about 390) widths: take screenshots, don't only read the DOM. `cd web && npm run e2e` takes the three-width screenshots for the main pages.
4. **Compare with the approved prototype**, if there is one. Put the two side by side and list every difference. The prototype is the spec; a difference you can't justify is a bug.
5. **Go through the checklist below** and fix what fails, including the screens that share the same CSS.
6. **Read it as someone who has never seen it.** For every number and column: does it say what it means in plain words? What is the one thing the page tells you, and is it the first thing you see? Primary information first and large; secondary information smaller, lower or behind a control; settings that rarely change away from the front.
7. **Report what you looked at**: which screens, which widths, what you changed, what you left and why.

## Checklist (on top of avn-design's self-check)

- Column headings line up with their cells (same alignment, same padding); numbers right-aligned and in a monospace face.
- Nothing is cut off: no clipped values, no "…" hiding the point of a cell, no text overlapping a control.
- Related things are grouped and the groups are clearly separate; unrelated things are not side by side just because there was room.
- One main thing per area: one accent-filled button, one headline number. If everything is emphasised, nothing is.
- Secondary and rarely used controls are quieter or collapsed; danger actions sit apart at the end.
- Empty, loading, error and "too little data" states each say something useful.
- Analytical screens lead with a plain-words answer and the few items that stand out, then the table.
- No horizontal page scroll at any width; tables scroll inside their own box.
- Dark and light both checked.
