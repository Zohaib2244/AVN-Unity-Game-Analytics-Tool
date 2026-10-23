# Porting the admin website to React (@avn/ui)

The website moved from vanilla JS (no build) to the stack the avn-ux skill prescribes
(`~/.claude/skills/avn-design/ux/references/stack.md`): **React 18 + TypeScript + Vite, plain CSS,
Motion, `@avn/ui`, TanStack Query / Router / Table / Virtual, Radix (through `@avn/ui`), Vitest**.
This file is the brief for porting one page module. Read it fully before touching a page.

## Where things are

| Path | What |
|---|---|
| `src/main.tsx`, `src/app/App.tsx` | providers: QueryClient, ToastProvider (@avn/ui), SessionProvider, NutBotProvider, Router |
| `src/app/router.tsx` | routes (TanStack Router, code-based). Pages inside a game go through `src/app/GameSection.tsx`, which gives the page its `game` prop |
| `src/app/Shell.tsx` | the app shell (sidebar, top bar, tab bar, command palette, refresh/auto-refresh, bell, theme). Pages never draw their own shell |
| `src/app/session.tsx` | `useSession()` → `{ me, overview, workspace, chooseWorkspace, refresh, role, canManageGames, workspaceName, variantsOf(game) }` |
| `src/app/theme.ts` | `useTheme()` → `{ theme, palette, density, setTheme, toggleTheme, setPalette, setDensity }` |
| `src/app/nutbot.tsx` | `useNutBot()` (open/toggle/usable/ask) |
| `src/api/client.ts` | `request(path, options)` (the old `request`: retries, timeouts, messages), `ApiError`, `errorMessage`, `errorStatus`, `isAbort`, slow-load helpers |
| `src/api/queries.ts` | `useRead<T>(path \| null, { body?, enabled?, refetchInterval?, keepPrevious? })` (GET, or an analytics POST read when `body` is given; shared cache, shows the previous answer while a new one loads), `read<T>(path, body?)` (one-off, cached), `prefetch(path)`, `write<T>(path, options)` (any write; clears every cached read afterwards), `refreshAll()`, `queryClient` |
| `src/lib/format.ts` | `number, percent, displayDate, fileSize, platformLabel, plural, today, addDays, daysBetween, prettyDay, shortDay, clock, analysisDate, duration, relativeTime, agoText, countryName, countryText, dimensionText, shortId, propertyLabel, localTimezone, localTimezoneOffset` |
| `src/lib/games.ts` | `gameURL, gamePath, iconURL, variantsOf, gameGroups, sameGame, byPlatform, PLATFORM_ORDER, initials, withIcon, ROLE_LABELS, GAME_SECTIONS, iconFromFile` |
| `src/lib/filters.ts` | `FilterState/ActiveFilters, filterState(game), saveFilters, filterQuery(state) → URLSearchParams, filterBody(state), activeFilters, TEST_ENVIRONMENTS, DIMENSIONS, DIMENSION_LABELS, OPERATORS, operatorLabel, MAX_STEPS` |
| `src/lib/store.ts` | `storeGet/storeSet/storeRemove, useStored(key, initial), downloadCSV(name, rows), copyText(text)` |
| `src/lib/types.ts` | `Game, GameDetail, Me, Overview, Health, …` (add the shapes your page reads) |
| `src/components/feedback.tsx` | `Skeleton({kind,rows,columns})`, `Spinner`, `LoadingNote`, `LoadError({error,onRetry})`, `QueryRegion({query, path?, skeleton?, children: data => …})` (skeleton → error → content, with the "Updating… Showing previous results." line), `Empty({title, children, action})`, `Heading({title, subtitle, actions})`, `useNotify()` → `{ toast(message, action?, kind?, detail?), toastError(error) }` (same shape as the old `toast()`), `ConfirmDialog({open,onClose,title,message,label,danger?,onConfirm})`, `ConfirmDelete` + `DialogShell` (re-exported from @avn/ui), `DEFINITIONS`, `DefinedLabel`, `Metric({label,value,note})` |
| `src/components/forms.tsx` | `useSubmit(async (values, form) => …)` → `{ onSubmit, busy, error, setError }`, `FormError`, `Field` |
| `src/components/DateRange.tsx` | `DateRange({ value, onChange, compact?, label? })`, `PRESETS`, `resolveRange(preset, saved)`, `rangeText` (replaces flatpickr; uses @avn/ui `Calendar`) |
| `src/components/Filters.tsx` | `useFilters(game)` → `[state, update]` and `FilterBar({ game, state, onChange, context?, children? })`: the dashboard filter bar with chips (replaces `mountFilters`) |
| `src/components/Activity.tsx` | `Activity({ game, basis? })` (the per-day event table with a range), `healthPath(game, range, basis, extra)`, `RangeResult` |
| `src/components/GameAvatar.tsx` | `GameAvatar({ name, games, className?, size? })` |
| `src/components/icons.tsx` | `Ico({ name, size })`: the line icons the old pages used (`grid game key export book pulse settings server arrow plus search check shield logout copy file refresh sun moon funnel chevron link users edit close sparkle lock`) |
| `src/components/flavour.tsx` | `IsoBlocks, DoraScene, MiniPC, BootScreen` |
| `src/styles/` | CSS layers. `legacy.css` = the old `style.css`, `pages.css`, `briefing.css`, `shell.css`, `flavour.css` were copied as they were, so **the old class names still work**. Put rules a page needs that are not there yet in `src/styles/app.css` (roles only: `var(--bg)`, `var(--panel)`, `var(--accent)`, … never a raw colour, font or radius) |
| `node_modules/@avn/ui/README.md`, `dist/index.d.ts` | the shared components: `Button, Tag, Kpi, Kpis, Panel, EmptyState, Segmented, Delta, Sparkline, RollingNumber, Drawer, DialogShell, ConfirmDelete, Popover, MultiSelect, SingleSelect, Calendar, Definition, BarChart, SurvivalCurve, HeatStrip, FunnelHeadline, FunnelResult, CompareTable, SetupChecklist, Pipeline, StatusStrip, Insights/InsightCard, NeedsALook, Timeline, HighlightsBar, RuleBar, ConditionEditor, NutBotPanel, PromptBar, ThoughtLine, ToolCallChip, Block, StatusMark, SpringCheck, Lattice, Heartbeat, BranchList, CodeSlots, Stepper/Step, PixelField, DefinitionGroup, Icon, PixelIcon, cx, …` (`@avn/ui` 0.3.0; also `QueryRegion`, `useSubmit`/`Field`/`FormError`, `RememberedDetails`/`CollapsiblePanel`, `DailyTable`/`TrendLine`, `DateRange`: the shared versions of the helpers in src/components, use them for new pages). Prefer these over hand-rolled markup when the component fits; the CSS for them is already loaded |

The originals being ported are in `../../legacy-static/` (outside git): `app.js`, `insights.js`, `events.js`, … They
are the source of truth for behaviour and copy. Port faithfully: the same words, the same states, the same
remembered preferences (localStorage keys), the same endpoints and query parameters.

## Rules

1. **One React component per page**, exported with the name the stub in `src/pages/` already has (`HomePage`,
   `FunnelsPage({ game })`, …). Pages inside a game receive `game: Game` and are remounted when the game or
   section changes. Split big pages into files under `src/pages/<name>/` if you like, keeping the stub's export.
2. **Data through `useRead` / `write`**, never `fetch` directly (exception: binary downloads such as exports).
   A page region waits with `<QueryRegion query={q} path={path} skeleton={<Skeleton …/>}>{data => …}</QueryRegion>`.
   After a write, call `write()` (it clears the cache) and, when the overview changes (games, icons, thresholds),
   also `await session.refresh()`.
3. **Links are `<Link to=… search=…>` from `@tanstack/react-router`**; programmatic navigation is `useNavigate()`.
   State that "copy link to this view" should keep (view, level, player, range when the old code put it in the
   URL) lives in search params (`useSearch({ strict: false })`); everything else stays in localStorage with the
   old keys (`storeGet/storeSet`).
4. **No `innerHTML`, no inline `style=` with colours.** Markup is JSX; the CSP forbids inline styles only in
   markup, so React `style={{ width: … }}` for bar widths is fine (the old code set `data-width`).
5. **Dialogs** are `DialogShell` (Radix) or `ConfirmDialog`/`ConfirmDelete`; **drawers** are `@avn/ui` `Drawer`;
   **popovers** are `@avn/ui` `Popover` with a ref to the button. Reversible actions happen at once and the toast
   offers Undo; permanent ones ask for the name (`ConfirmDelete`).
6. **Animation**: only through `motion/react` or the `@avn/ui` components (which already respect reduced
   motion). Animate opacity and transform only; play once.
7. **Tests**: every pure helper the old Python tests exercised (`tests/test_frontend.py`,
   `tests/test_conditions.py`, `tests/test_player_events.py` read the old JS by text) gets a Vitest test next to
   it (`src/**/x.test.ts(x)`), covering the same assertions. Components with behaviour get a Testing Library test.
   Run `npm run typecheck && npm test` from `web/`; both must pass. Do not run `npm run build` (it empties
   `avn_analytics/static/`; the integrator builds).
8. **Accessibility carries over**: every column header has text (`<span className="sr-only">`), `aria-pressed`
   only on buttons, `aria-current="page"` on the active link, every state has a word next to its colour, 44px
   touch targets on phones (the CSS already does this for the old class names).
9. Words: keep the old copy exactly. Pages follow the avn-ux pattern they already follow (briefing overview,
   list, settings, …): summary before detail, one accent-filled button per area.
10. Don't touch files outside your page's folder except `src/lib/types.ts` (add types), `src/styles/app.css`
    (append rules) and `src/lib/*.ts` **only to add** small shared helpers the old code had (say so in your report).
