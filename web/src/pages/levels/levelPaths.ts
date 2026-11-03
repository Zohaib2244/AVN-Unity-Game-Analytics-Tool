// The addresses the Levels page asks for, and the ones the shell can start early (prefetch on hover).
import { resolveRange } from '@/components/DateRange';
import { filterQuery, filterState, timezoneOffset, type ActiveFilters } from '@/lib/filters';
import { gamePath, gameURL } from '@/lib/games';
import { storeGet } from '@/lib/store';
import type { Game } from '@/lib/types';
import { DRILL_PAGE, cleanNavigation, navigationKey, type DrillSort, type LevelDrillGroup, type LevelScope } from './levelMath';

type GameRef = Pick<Game, 'id'>;

/** Whether `?view=` asks for Compare releases ("explore" is its old name). */
export const isCompareView = (value: unknown): boolean => value === 'compare' || value === 'explore';

export const listPath = (game: GameRef): string => gamePath(game, 'levels');

export function levelsQuery(state: ActiveFilters, scope: LevelScope, excludeReturners = false): URLSearchParams {
  const query = filterQuery(state);
  if (excludeReturners) query.set('exclude_returners', 'true');
  if (scope === 'first_session') query.set('scope', 'first_session');
  return query;
}
export const levelsPath = (game: GameRef, state: ActiveFilters, scope: LevelScope, excludeReturners = false): string => `${gameURL(game)}/insights/levels?${levelsQuery(state, scope, excludeReturners)}`;

export const featuresPath = (game: GameRef, state: ActiveFilters, scope: LevelScope, excludeReturners = false): string => `${gameURL(game)}/insights/levels/features?${levelsQuery(state, scope, excludeReturners)}`;

/** Which players of a level are listed: the group, the order and, within a group, one last action, or one cause of ending (and how it ended). */
export type DrillState = { group: LevelDrillGroup; sort: DrillSort; lastAction: string | null; cause?: string | null; ending?: string | null };
export function drillQuery(state: ActiveFilters, scope: LevelScope, level: number, drill: DrillState, extra: Record<string, string | number> = {}, excludeReturners = false): URLSearchParams {
  const query = levelsQuery(state, scope, excludeReturners);
  query.set('level', String(level)); query.set('group', drill.group); query.set('sort', drill.sort);
  if (drill.lastAction != null) query.set('last_action', drill.lastAction);
  if (drill.cause != null) query.set('cause', drill.cause);
  if (drill.cause != null && drill.ending != null) query.set('ending', drill.ending);
  for (const [key, value] of Object.entries(extra)) query.set(key, String(value));
  return query;
}
export const drillPath = (game: GameRef, state: ActiveFilters, scope: LevelScope, level: number, drill: DrillState, extra: Record<string, string | number> = {}, excludeReturners = false): string => `${gameURL(game)}/insights/levels/players?${drillQuery(state, scope, level, drill, extra, excludeReturners)}`;
/** One page of a level's players, from `offset`. */
export const drillPagePath = (game: GameRef, state: ActiveFilters, scope: LevelScope, level: number, drill: DrillState, offset: number, excludeReturners = false): string => drillPath(game, state, scope, level, drill, { offset, limit: DRILL_PAGE }, excludeReturners);

/** The filters the page opens with, the way the page works them out, so a request can start before it opens. */
export function resolvedFilters(game: GameRef): ActiveFilters {
  const state = filterState(game);
  return { ...state, range: resolveRange(state.range?.preset || '30', state.range) };
}
/** The Levels page's first request: the page opens on Level Flow. */
export function levelsPrefetchPath(game: GameRef): string {
  const nav = cleanNavigation(storeGet(navigationKey(game)));
  return levelsPath(game, resolvedFilters(game), nav.scope, nav.excludeReturners);
}
/** The Overview's first request, for the same early start. */
export const overviewPrefetchPath = (game: GameRef): string => `${gameURL(game)}/insights/summary?${filterQuery(resolvedFilters(game))}`;

/* ─── Compare releases and saved views (all kept in this browser, per game) ─── */
export const savedViewsKey = (game: GameRef): string => `avn-level-views-${game.id}`;
export const activeViewKey = (game: GameRef): string => `avn-level-active-view-${game.id}`;
export const releasesKey = (game: GameRef): string => `avn-level-tools-${game.id}`;
/** The releases the dates contain, for the two selectors. */
export const releaseFacetsPath = (game: GameRef, state: ActiveFilters): string => `${gameURL(game)}/insights/facets?${new URLSearchParams({ start: state.range.from, end: state.range.to, tz_offset: String(timezoneOffset(state)) })}`;
/** One release's levels: the same dates and filters, with the app version replaced by this one. */
export const releasePath = (game: GameRef, state: ActiveFilters, version: string, excludeReturners = false, scope: LevelScope = 'all'): string => `${gameURL(game)}/insights/levels?${levelsQuery({ ...state, app_version: [version] }, scope, excludeReturners)}`;
