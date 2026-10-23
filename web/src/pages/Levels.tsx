// Levels: where players stop, level by level. Three views: the level table (with a level page for
// ?level=N), and Compare releases. Filters, sorting, the players shown and chosen releases are remembered
// per game in this browser; the open view and level are in the address, so a link can copy them.
import { useMemo, useState, type ReactElement } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useRead } from '@/api';
import { resolveRange } from '@/components/DateRange';
import { FilterBar, useFilters } from '@/components/Filters';
import { Heading } from '@/components/feedback';
import { gamePath } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';
import type { Game, LevelsResult } from '@/lib/types';
import { LevelCompare } from './levels/LevelCompare';
import { LevelPage } from './levels/LevelPage';
import { LevelTable } from './levels/LevelTable';
import { cleanNavigation, navigationKey, type LevelNavigation, type ReleasePrefs, type SavedLevelView } from './levels/levelMath';
import { isCompareView, levelsPath, releasesKey, viewKey, type DrillState } from './levels/levelPaths';

export function LevelsPage({ game }: { game: Game }): ReactElement {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const [filters, updateFilters] = useFilters(game);
  const [nav, setNavState] = useState<LevelNavigation>(() => cleanNavigation(storeGet<Partial<LevelNavigation>>(navigationKey(game))));
  const setNav = (patch: Partial<LevelNavigation>) => setNavState((previous) => { const next = { ...previous, ...patch }; storeSet(navigationKey(game), next); return next; });
  const [prefs, setPrefsState] = useState<ReleasePrefs>(() => storeGet<ReleasePrefs>(releasesKey(game)) ?? {});
  const setPrefs = (next: ReleasePrefs) => { setPrefsState(next); storeSet(releasesKey(game), next); };
  const [jump, setJump] = useState<{ level: number } | null>(null);

  // ?level=12 opens that level's page; ?view=compare opens Compare releases (the view is also remembered).
  const pageLevel = search.level != null && Number.isInteger(Number(search.level)) ? Number(search.level) : null;
  const view: 'table' | 'compare' = pageLevel == null && isCompareView(search.view || storeGet<string>(viewKey(game))) ? 'compare' : 'table';

  const path = levelsPath(game, filters, nav.scope);
  const levels = useRead<LevelsResult>(path, { enabled: view === 'table' });
  // The players each level's drill has been opened on (group, sort) last; kept while the dates and filters stay.
  const memory = useMemo(() => new Map<number, DrillState>(), [path]);

  const listPath = gamePath(game, 'levels');
  const chooseView = (next: 'table' | 'compare') => {
    storeSet(viewKey(game), next);
    if (next === view && pageLevel == null) return;
    void navigate({ to: listPath, search: next === 'compare' ? { view: 'compare' } : {}, replace: true });
  };
  const openLevel = (level: number) => { void navigate({ to: listPath, search: { level: String(level) } }); };
  const jumpFromCompare = (level: number) => { setJump({ level }); chooseView('table'); };
  const restore = (saved: SavedLevelView) => {
    updateFilters(() => ({ ...saved.filters, range: resolveRange(saved.filters.range?.preset || '30', saved.filters.range) }));
    setNav(cleanNavigation(saved));
    setPrefs(saved.tools || {});
  };

  return (
    <>
      <Heading title="Levels" subtitle="Follow the same players from one level’s start to the next, with a breakdown of where progress stops." />
      <FilterBar game={game} state={filters} onChange={updateFilters} context={levels.data ? { anonymous_events: levels.data.context.anonymous_events } : {}} />
      <div className="range-modes route-tabs levels-views" role="group" aria-label="Levels view">
        <button type="button" aria-pressed={view === 'table'} onClick={() => chooseView('table')}>Level by level</button>
        <button type="button" aria-pressed={view === 'compare'} onClick={() => chooseView('compare')}>Compare releases</button>
      </div>
      {view === 'compare' ? (
        <LevelCompare game={game} filters={filters} nav={nav} prefs={prefs} onPrefs={setPrefs} onRestore={restore} onJump={jumpFromCompare} />
      ) : pageLevel != null ? (
        <LevelPage game={game} filters={filters} scope={nav.scope} level={pageLevel} query={levels} path={path} memory={memory} />
      ) : (
        <LevelTable key={path} game={game} filters={filters} scope={nav.scope} nav={nav} onNav={setNav} query={levels} path={path} jump={jump} onJumped={() => setJump(null)} onOpen={openLevel} />
      )}
    </>
  );
}
