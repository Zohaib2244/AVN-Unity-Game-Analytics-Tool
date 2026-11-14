# UX rules

Every rule can be checked. A rule is checked either automatically (**auto**: the DOM or a
measurement decides) or by eye (**look**: on a screenshot of a named state). Each rule
cites the complaint that produced it. When the owner raises a new complaint, add a rule
here, with a check, before you fix the screen (see "Adding a rule" at the end).

Severity, for audits: **S1** wrong or broken (stale data, a control that doesn't work, a
hidden number) · **S2** slows the owner down or misleads (redundant text, inconsistent
behaviour, missing search) · **S3** polish (stray lines, uneven heights).

---

## R1 Say it once, and say little

- **R1.1 No repeated label in one region.** The same words must not appear twice in a
  sidebar, toolbar, panel header or card. (*Sidebar showed "Workspace [Work ▾]" and right
  under it a "Workspace" section heading.*) **auto**: identical visible text twice inside
  one landmark/panel.
- **R1.2 No subtitles.** Page titles and panel titles stand alone. No description line
  under them ("What ads earn, whether they show…", "Which offers players take…"). People
  don't read them. If a term needs explaining, put a definition tooltip on the term or the
  column header. **auto**: a text block directly after an `h1`/`h2`/panel title.
- **R1.3 No help paragraphs.** UI text is labels, values and at most one short line (≤ 12
  words) where the owner can't continue without it, e.g. an empty state saying what to
  click. Explanations of how a feature works ("Saved groups are shared with everyone who
  can open this game. Counts use…") are deleted, or go in a tooltip. **auto**: visible text
  blocks over 12 words outside dialogs and NutBot.
- **R1.4 One measure, one name; one fact, one place.** Don't show the date range, build,
  count or panel title twice on one screen. **look**.

## R2 Every visual difference means something

- **R2.1 No unexplained emphasis.** A tint, badge, icon, bold value or coloured cell must
  either be explained by the header or a one-word legend, or be removed. Default is
  neutral. (*An added custom column had shaded cells for no reason. Change cells were tinted
  red at random-looking thresholds.*) **auto**: cells in one column with differing
  backgrounds; a column whose background differs from its neighbours. **look**: can you say
  why each emphasised thing is emphasised?
- **R2.2 Every cell in a column has the same shape.** Same parts, same alignment, one value
  per cell. A second value (a count, a trend) gets its own column or a tooltip, never an
  icon and a number squeezed in on some rows only. (*`7 ↘ 6.4%` on some rows and `2.9%` on
  others.*) **auto**: compare the child structure and text pattern of cells in a column.
- **R2.3 Colour has one job.** Status colours mean state. The accent marks the one main
  action or the active item. **look**.
- **R2.4 A percentage shows what it is a share of.** Every percentage has its count beside it
  (players, sessions, events, installs) or the money for a revenue share: the count first,
  muted, then the percentage, through the shared `Share` component (`components/Share.tsx`).
  Never a bare percentage, never the count only on hover (phones have no hover). The tooltip
  says it whole ("412 of 1,426 players"). **auto** (a cell or tile whose only number is a %).

## R3 Same thing, same component, same behaviour

- **R3.1 Every column behaves the same.** If one header sorts on click, they all do,
  including columns the owner added. Added columns can also be hidden, moved and removed
  like built-in ones. (*Couldn't sort by the added column the way Level or Earned sort.*)
  **auto**: every `th` either has `aria-sort` and a click handler, or none do.
- **R3.2 What one table can do, comparable tables can do.** Levels has a Display tab for
  choosing columns, so Players and every other dense table get the same control, in the same
  place. **look**: compare table toolbars across pages.
- **R3.3 One popover, one menu, one pill, one dropdown.** Every floating surface uses the
  shared component and looks like the others: same radius, border, padding, header style and
  shadow. (*The Live pill and its popover looked like a separate product.*) **auto** (code):
  no hand-rolled `position: fixed/absolute` floating panels outside the shared components.
  **look**: put the open surfaces side by side.
- **R3.4 Controls in one row match.** Same height, same baseline, same visual weight. A
  select beside a segmented control is the same height as the control. (*The "then by:
  Nothing ▾" select was taller than the Format/Network/… switch.*) **auto**: the heights of
  interactive elements whose vertical centres are within 4 px of each other differ by
  ≤ 1 px.

## R4 Pickers and floating things

- **R4.1 Long lists can be searched.** Any dropdown, menu or picker with more than 7
  options opens with a search field that already has focus, and typing filters the list.
  Native `<select>` is only for ≤ 7 fixed options. (*Event and parameter dropdowns in Extra
  columns: 20+ parameters, no search.*) **auto**: open every listbox/menu and count the
  options; if there are more than 7, it needs a text input.
- **R4.2 Floating things stay put.** A popover stays attached to its trigger, inside the
  viewport and above sticky headers, through scrolling and resizing, or it closes on scroll.
  (*With the filter popover open, scrolling slid it under the top bar, half cut off.*)
  **auto**: open it, scroll 400 px, check that its box is inside the viewport, that
  `elementFromPoint` at its corners hits the popover, and that it is within 8 px of its
  trigger (or has closed).

- **R4.3 A chooser is a bounded popover, not a page.** A menu or chooser never grows past
  about 60% of the viewport height (and never wider than its content needs): it scrolls
  inside itself, the page behind doesn't scroll while the pointer is over it
  (`overscroll-behavior: contain`), and Esc and a click outside close it. It never pushes
  the data down or covers it so the data can't be reached. A chooser with more than 12
  items has a search field, and items are grouped and collapsible. (*"Choose parameters"
  opened 100+ checkboxes across the whole Raw events view; scrolling moved the events behind
  it, not the list.*) **auto**: open it, check its height ≤ 60% of the viewport; wheel over
  it and assert `window.scrollY` doesn't change; press Esc and assert it closed.
- **R4.4 One way to choose what's shown.** Choosing columns, parameters or event types is
  the same control everywhere: a **Display** popover (search, groups, Reset) beside the
  table. Not a disclosure, a dialog and a checkbox row on different pages. **look**.

## R5 Space goes to data and to what is used

- **R5.1 No permanent space for empty or rarely used features.** A feature with nothing in
  it (no saved groups yet) is a toolbar control (`Groups ▾`), not a panel or column. (*The
  Groups panel took a whole column to say "No saved groups yet".*) **auto**: a panel whose
  only content is empty-state or help text.
- **R5.2 Columns earn their place.** Every default column answers something the owner
  decides with. Columns that don't (Last event on Players) are removed or hidden by
  default. The column chooser (R3.2) handles the rest. **look**: for each column, what
  decision does it inform?
- **R5.6 Data starts in the top half of the first screen.** A page's tools share one line.
  Anything that chooses what to show (parameters, event types, grouping, noise) goes in one
  Display menu, not four rows of mixed buttons, disclosures and checkboxes. (*Raw events:
  seven rows of controls before the first event.*) **auto**: at 1440×900 the first data
  row starts above y = 450.
- **R5.7 One scope per screen.** Controls that don't affect the current tab are hidden, not
  shown with a note saying they don't apply. (*Summary: the date picker and "In these days"
  are still shown above "All time · not limited to the days chosen above".*) **look**.
- **R5.3 The create action never moves.** "Register a game", "New group" and similar sit in
  the page toolbar, reachable without scrolling however long the list gets. Never as the
  last card in a grid. (*Register a game sank to the bottom as games were added.*) **auto**:
  with 30+ items, the create control is inside the first viewport.
- **R5.4 Cards show what the owner acts on.** No identifiers that are only for setup
  (bundle IDs) on summary cards. Games cards: events, players, storage used. The page top:
  totals across games, storage included. **look**.

## R6 Hierarchy

- **R6.1 One thing leads.** Each screen and each panel has one most important element, set
  visibly larger or heavier. Peers are equal, and nothing else competes with the leader.
  **look**: blur the screenshot (squint test). The thing you still see first should be the
  page's answer, not a settings card or a toolbar.
- **R6.2 Figures use the number face, titles keep the pixel face.** Values line up
  (right-aligned, tabular, one decimal, same precision down the column). **auto**:
  alignment and decimals per column.

## R7 Live means live

- **R7.1 Live data keeps updating.** Anything marked Live, or showing "x ago", updates on
  schedule for as long as the tab is open, catches up as soon as the tab regains focus, and
  never stops after an error. If it can't update, it says "Paused" or "Offline" with the time
  of the last update. It is never silently stale. Live pages (Games, the Live pill, Server
  status) poll. (*Games page and the Live pill went quiet after a few minutes while events
  were still arriving.*) **auto**: a long test keeps the page open 10+ minutes (using a fake
  clock where possible), sends events, and asserts the numbers change and requests keep
  firing.

## R8 Nothing broken-looking

- **R8.1 No stray lines.** No double borders, partial borders, or bars above and below a
  segmented control or toolbar. (*Stray top and bottom bars around the Format/Network/…
  switch.*) **look** at a 2× zoomed screenshot of every toolbar.
- **R8.2 Nothing clipped, overlapping or hidden under sticky elements.** **auto**: text
  elements with `scrollWidth > clientWidth` (unless they show a tooltip with the full
  value); `elementFromPoint` at the centre of each visible control returns that control.
- **R8.3 No nested scroll on wide screens.** A box that scrolls inside a page that also
  scrolls is only allowed for the table body. **auto**.
- **R8.4 Ad blockers don't hide it.** No class or id that looks like an ad (`ad-…`, `ads-…`,
  `…-ad`, `advert…`, `sponsor…`): blockers such as uBlock and AdBlock hide them, and the
  page silently loses panels. (*The whole Ads widget block vanished for the owner because
  EasyList hides `.ad-widgets`.*) Ad pages use the `money-` prefix. **auto**: EasyList's
  generic hiding rules are run against every page, and a unit test rejects ad-like names.

## R9 Builders build complete conditions

- **R9.1 Anywhere a condition is built, it can be a full condition.** Event plus any number
  of parameter tests (AND), using the shared `RuleFields`. A custom column can count "ads
  where FORMAT = Interstitial and REWARDED = true". **look**: try two parameter tests in
  every condition editor.

## R10 Data the game doesn't send, and data that says nothing

- **R10.1 "Not sent" replaces zeros.** If the game doesn't send something (revenue, load
  times, creative IDs), show it once, as one quiet line ("Revenue: not sent by this
  build"). Never show `$0.00` KPIs, an empty table with headers, or a panel that only says
  it's empty. (*Ads: two `$0.00` KPIs, an empty Revenue table and an empty "Ads players
  leave on" panel, each taking up space.*) **auto**: a KPI equal to 0 while its source says
  `available: false`; a table with headers and no rows.
- **R10.2 A column that says the same on every row is removed.** All `—`, all `0`, all
  `not sent`, or a whole grid of `·` (Loads that worked, Load time, Held by your rules,
  Revenue on Rewarded placements, Return, the Cohorts return grid). Mention it once in the
  footnote if it matters. **auto**: every cell in a column has the same text.
- **R10.3 One placeholder for no value.** `—` everywhere. Not `·`, `–`, `cost 0` or a blank
  in different tables. **auto**.
- **R10.4 The same finding appears once.** "89 rewarded ads had none ready" appeared in a
  KPI, in Needs a look, and as a red 89 in a table. Show it in one place and let the others
  link to it. **look**.

## R11 Every number leads to its players

- **R11.1 Click a number, see the players.** Every count, rate or money value that comes
  from players (KPI tiles, table cells, chart bars, cohort cells, Needs-a-look items) opens
  Players filtered to exactly those players, as a `player_group` chip the owner can save.
  The cursor and hover show that it is clickable, and the filter carries the page's dates,
  build and filters. (*"I want it linked to players."*) **auto**: every numeric cell in a
  players-derived table is a link, or the table has a row action "See players".
- **R11.3 On one player's page, numbers lead to their events.** Every number in Summary
  (ads seen, a network's ads, a hard level, coins spent) opens Raw events with exactly
  those events highlighted and the first one in view.
- **R11.2 And back.** The Players chip names where it came from ("Rewarded · no ad ready ·
  15 Oct–13 Nov"), and Back returns to the same scroll position on the source page.

## R13 Big data stays fast

- **R13.1 Long lists are virtualized.** Any list or table that can pass about 200 rows
  (timeline events, players, levels, sessions in the rail) renders only the rows on screen
  (TanStack Virtual). Jump-to and highlight navigation scroll by index, not by
  `querySelector`. **auto**: with 20,000 events, fewer than 500 rows in the DOM; scrolling
  holds 60 fps (no long tasks over 50 ms in a Performance trace).
- **R13.2 Loading more doesn't redraw everything.** Pages of data append without
  rebuilding the whole view, the page is usable while the rest loads, and scroll position
  never jumps. Per-row work (highlight matching, counts) is computed once per change, not
  on every render. **auto**: interaction latency under 100 ms while loading.

## R12 Pick the widget for the question

Each panel answers one question with the widget made for that kind of question. The
widgets are shared components, so the same kind of answer looks the same on every page
(Ads, Acquisition, Player summary, Overview). Don't build a one-off panel.

| Question | Widget |
|---|---|
| How much, and is it moving? | **KPI tile**: one number, change since the previous period, sparkline, click → players |
| Which ones matter most? | **Ranked bar list**: label, bar, value; top 5 to 8, then "Show all" |
| Where do we lose them? | **Flow / funnel**: steps with the loss between them (wanted → loaded → shown → rewarded) |
| How does it change over time? | **Trend**: line or bars by day, with the build releases marked |
| How do groups of players age? | **Cohort heatmap**: install day × day N, coloured against the goal, cells too small to trust faded |
| What needs attention? | **Findings list**: the 1 to 3 things that stand out, each with "See players" |
| What exactly is in it? | **Dense table**: column chooser, every column sortable, numbers link to players |
| Who is this one player? | **Player summary strip**: earned, cost, paid back, sessions, last seen, plus a timeline |

A page leads with its findings and KPIs, then shows the widgets for the questions it
answers. A dense table comes last, or sits behind a tab. **look**: name the question each
panel answers. If two panels answer the same question, or a panel answers none, cut it.

---

## States every audit must exercise

Most of the problems above only appear after an interaction. A default-state screenshot
isn't enough. For each page:

1. Default, at wide (1440), rail (900) and phone (390), dark and light.
2. Every dropdown, menu, popover and picker **open**. Then open **and scrolled 400 px**.
   Then open near the bottom of the viewport.
3. Long content: 30+ games, 150+ players, 20+ parameters, long names.
4. Empty (a fresh data dir), loading (throttle the network) and error (stop the server).
5. After using the page's builder: add a custom column, add a group, sort by each header.
6. Hover every pill, badge and chart mark that has a tooltip.
7. Left open 10 minutes with events arriving (R7.1).

## Adding a rule

When the owner complains about something:

1. Write the general rule, not the instance. "Workspace is written twice" becomes R1.1.
2. Give it a check: **auto** if a script can decide it (then add it to `web/e2e/ux-lint.spec.ts`),
   otherwise **look** with the state to look at.
3. Quote the complaint in italics as the example.
4. Then fix every screen it applies to, not only the one shown.
