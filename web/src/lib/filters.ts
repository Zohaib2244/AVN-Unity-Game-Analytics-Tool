// The dashboard filters: days + environment, version, build, country, platform. Remembered per game.
import { RULE_OPS } from './conditions';
import { localTimezoneOffset, type Timezone } from './format';
import { storeGet, storeSet } from './store';

export const MAX_STEPS = 100;
export const TEST_ENVIRONMENTS = ['editor', 'development', 'test', 'debug'];
export const DIMENSIONS = ['environment', 'app_version', 'build', 'country', 'platform'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DIMENSION_LABELS: Record<Dimension, string> = { environment: 'Environment', app_version: 'App version', build: 'Build', country: 'Country', platform: 'Device platform' };
/** The categories the Filters menu offers. Build (the bundle code) is left out: versions are what get compared. */
export const MENU_DIMENSIONS = ['environment', 'app_version', 'country', 'platform'] as const satisfies readonly Dimension[];
export const FILTER_KEYS: Record<Dimension, string> = { environment: 'env', app_version: 'version', build: 'build', country: 'country', platform: 'platform' };
export const OPERATORS = RULE_OPS;
export const operatorLabel = (op: string): string => OPERATORS.find(([key]) => key === op)?.[1] || '=';

export type DayRange = { from: string; to: string; preset?: string };
export type VersionMode = 'latest' | 'previous' | 'custom' | 'all';
export type FilterState = {
  range: DayRange | null; timezone: Timezone; hideTest: boolean; versionMode: VersionMode;
  environment: string[]; app_version: string[]; build: string[]; country: string[]; platform: string[];
  /** "Everything except": values kept out, per category (environments have their own "hide editor data"). */
  exclude?: Partial<Record<Dimension, string[]>>;
};
/** A filter state whose range has been chosen. */
export type ActiveFilters = FilterState & { range: DayRange };

/** The values kept out of a category (empty when it is not in "everything except" mode). */
export const excludedValues = (state: Pick<FilterState, 'exclude'>, dimension: Dimension): string[] => state.exclude?.[dimension] ?? [];
/** One category's choice: "only these" or "everything except", and the values. A category is one or the other. */
export type DimensionChoice = { mode: 'in' | 'not'; values: string[] };
export const choiceOf = (state: Pick<FilterState, 'exclude'> & Partial<Record<Dimension, string[]>>, dimension: Dimension): DimensionChoice => {
  const out = excludedValues(state, dimension);
  return out.length ? { mode: 'not', values: out } : { mode: 'in', values: state[dimension] ?? [] };
};
/** The state with one category set to a choice; the other side is emptied so the two never combine. */
export function withChoice<T extends FilterState>(state: T, dimension: Dimension, choice: DimensionChoice): T {
  const exclude = { ...state.exclude, [dimension]: choice.mode === 'not' ? choice.values : [] };
  return { ...state, [dimension]: choice.mode === 'in' ? choice.values : [], exclude };
}

export type Facets = Partial<Record<Dimension, Array<{ value: string; players: number }>>> & { latest_app_version?: string | null; previous_app_version?: string | null };

const key = (game: { id: string }) => `avn-filters-${game.id}`;

const cleanList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

export function filterState(game: { id: string }): FilterState {
  const saved = (storeGet<Partial<FilterState>>(key(game)) || {}) as Partial<FilterState>;
  return {
    range: saved.range || null,
    // Always local time: there is no switch for UTC any more, so a saved choice must not apply unseen.
    timezone: 'local',
    hideTest: saved.hideTest ?? true,
    // Builds can no longer be picked, so an old saved choice is dropped rather than left narrowing the numbers unseen.
    environment: saved.environment || [], app_version: saved.app_version || [], build: [], country: saved.country || [], platform: saved.platform || [],
    exclude: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, dimension === 'build' ? [] : cleanList(saved.exclude?.[dimension])])),
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
  for (const dimension of DIMENSIONS) if (dimension !== 'environment') excludedValues(state, dimension).forEach((value) => query.append(`not_${FILTER_KEYS[dimension]}`, value));
  return query;
}
export function filterBody(state: ActiveFilters) {
  return {
    start: state.range.from, end: state.range.to, timezone_offset_minutes: timezoneOffset(state),
    filters: {
      environments: state.environment, exclude_environments: state.hideTest && !state.environment.length ? TEST_ENVIRONMENTS : [],
      app_versions: state.app_version, builds: state.build, countries: state.country, platforms: state.platform,
      exclude_app_versions: excludedValues(state, 'app_version'), exclude_builds: excludedValues(state, 'build'),
      exclude_countries: excludedValues(state, 'country'), exclude_platforms: excludedValues(state, 'platform'),
    },
  };
}
/** How many categories narrow the numbers (what the Filters button counts). */
export const activeFilters = (state: FilterState): number => DIMENSIONS.filter((dimension) => state[dimension].length || excludedValues(state, dimension).length).length;
