// The dashboard filters: days + environment, version, build, country, platform. Remembered per game.
import { RULE_OPS } from './conditions';
import { localTimezoneOffset, type Timezone } from './format';
import { storeGet, storeSet } from './store';

export const MAX_STEPS = 100;
export const TEST_ENVIRONMENTS = ['editor', 'development', 'test', 'debug'];
export const DIMENSIONS = ['environment', 'app_version', 'build', 'country', 'platform'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DIMENSION_LABELS: Record<Dimension, string> = { environment: 'Environment', app_version: 'App version', build: 'Build', country: 'Country', platform: 'Device platform' };
export const FILTER_KEYS: Record<Dimension, string> = { environment: 'env', app_version: 'version', build: 'build', country: 'country', platform: 'platform' };
export const OPERATORS = RULE_OPS;
export const operatorLabel = (op: string): string => OPERATORS.find(([key]) => key === op)?.[1] || '=';

export type DayRange = { from: string; to: string; preset?: string };
export type VersionMode = 'latest' | 'previous' | 'custom' | 'all';
export type FilterState = {
  range: DayRange | null; timezone: Timezone; hideTest: boolean; versionMode: VersionMode;
  environment: string[]; app_version: string[]; build: string[]; country: string[]; platform: string[];
};
/** A filter state whose range has been chosen. */
export type ActiveFilters = FilterState & { range: DayRange };

export type Facets = Partial<Record<Dimension, Array<{ value: string; players: number }>>> & { latest_app_version?: string | null; previous_app_version?: string | null };

const key = (game: { id: string }) => `avn-filters-${game.id}`;

export function filterState(game: { id: string }): FilterState {
  const saved = (storeGet<Partial<FilterState>>(key(game)) || {}) as Partial<FilterState>;
  return {
    range: saved.range || null,
    timezone: saved.timezone === 'utc' ? 'utc' : 'local',
    hideTest: saved.hideTest ?? true,
    environment: saved.environment || [], app_version: saved.app_version || [], build: saved.build || [], country: saved.country || [], platform: saved.platform || [],
    // Dashboards open on the newest published build by default; 'previous' (the build before it), 'custom' (picked builds) and 'all' are remembered.
    versionMode: (['latest', 'previous', 'custom', 'all'] as const).includes(saved.versionMode as VersionMode) ? (saved.versionMode as VersionMode) : saved.app_version?.length ? 'custom' : 'latest',
  };
}
export function saveFilters(game: { id: string }, state: FilterState): void { storeSet(key(game), state); }

export const timezoneOffset = (state: Pick<FilterState, 'timezone'>): number => (state.timezone === 'utc' ? 0 : localTimezoneOffset());

export function filterQuery(state: ActiveFilters): URLSearchParams {
  const query = new URLSearchParams({ start: state.range.from, end: state.range.to, tz_offset: String(timezoneOffset(state)) });
  if (state.hideTest && !state.environment.length) TEST_ENVIRONMENTS.forEach((value) => query.append('not_env', value));
  for (const dimension of DIMENSIONS) state[dimension].forEach((value) => query.append(FILTER_KEYS[dimension], value));
  return query;
}
export function filterBody(state: ActiveFilters) {
  return {
    start: state.range.from, end: state.range.to, timezone_offset_minutes: timezoneOffset(state),
    filters: {
      environments: state.environment, exclude_environments: state.hideTest && !state.environment.length ? TEST_ENVIRONMENTS : [],
      app_versions: state.app_version, builds: state.build, countries: state.country, platforms: state.platform,
    },
  };
}
export const activeFilters = (state: FilterState): number => DIMENSIONS.reduce((sum, dimension) => sum + state[dimension].length, 0);
