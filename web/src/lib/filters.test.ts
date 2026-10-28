// Dashboards open on the latest build unless someone chose otherwise (tests/test_frontend.py).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activeFilters, choiceOf, filterBody, filterQuery, filterState, withChoice, type ActiveFilters } from './filters';

const game = { id: 'g' };
// jsdom here has no localStorage; a map stands in for it.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key), clear: () => store.clear() });
const save = (value: unknown) => store.set('avn-filters-g', JSON.stringify(value));

describe('filterState', () => {
  beforeEach(() => store.clear());

  it('opens on the latest build when nothing was saved', () => {
    expect(filterState(game).versionMode).toBe('latest');
    save({ range: null, app_version: [] });
    expect(filterState(game).versionMode).toBe('latest');
  });

  it('remembers builds someone picked', () => {
    save({ app_version: ['1.2'], versionMode: 'custom' });
    expect(filterState(game).versionMode).toBe('custom');
    save({ app_version: ['1.2'] });
    expect(filterState(game).versionMode).toBe('custom');
  });

  it('remembers "all builds"', () => {
    save({ app_version: [], versionMode: 'all' });
    expect(filterState(game).versionMode).toBe('all');
  });

  it('remembers "the build before"', () => {
    save({ app_version: ['1.1'], versionMode: 'previous' });
    expect(filterState(game).versionMode).toBe('previous');
  });

  it('falls back to latest on an unknown mode', () => {
    save({ versionMode: 'nonsense' });
    expect(filterState(game).versionMode).toBe('latest');
  });

  it('keeps the other defaults', () => {
    const state = filterState(game);
    expect(state.timezone).toBe('local');
    expect(state.hideTest).toBe(true);
    expect(state.range).toBeNull();
    expect(state.environment).toEqual([]);
  });
});

describe('"everything except"', () => {
  beforeEach(() => store.clear());
  const base = (): ActiveFilters => ({ ...filterState(game), range: { from: '2026-10-01', to: '2026-10-07' }, hideTest: false });

  it('keeps a category either "only these" or "except", never both', () => {
    const only = withChoice(base(), 'country', { mode: 'in', values: ['PK', 'IN'] });
    expect(choiceOf(only, 'country')).toEqual({ mode: 'in', values: ['PK', 'IN'] });
    const except = withChoice(only, 'country', { mode: 'not', values: ['PK'] });
    expect(except.country).toEqual([]);
    expect(choiceOf(except, 'country')).toEqual({ mode: 'not', values: ['PK'] });
    expect(withChoice(except, 'country', { mode: 'in', values: ['US'] }).exclude?.country).toEqual([]);
  });

  it('sends exclusions as not_<key> in the query and exclude_* in the body', () => {
    const state = withChoice(withChoice(base(), 'country', { mode: 'not', values: ['PK'] }), 'platform', { mode: 'in', values: ['android'] });
    const query = filterQuery(state);
    expect(query.getAll('not_country')).toEqual(['PK']);
    expect(query.getAll('country')).toEqual([]);
    expect(query.getAll('platform')).toEqual(['android']);
    expect(filterBody(state).filters).toMatchObject({ exclude_countries: ['PK'], countries: [], platforms: ['android'], exclude_platforms: [] });
  });

  it('counts a category once, whichever way it narrows, and drops saved builds', () => {
    const state = withChoice(withChoice(base(), 'country', { mode: 'not', values: ['PK', 'IN'] }), 'platform', { mode: 'in', values: ['ios'] });
    expect(activeFilters(state)).toBe(2);
    save({ build: ['42'], exclude: { country: ['PK'], build: ['7'], platform: 'nope' } });
    const loaded = filterState(game);
    expect(loaded.build).toEqual([]);
    expect(loaded.exclude).toMatchObject({ country: ['PK'], build: [], platform: [] });
  });

  it('opens old saved filters with nothing excluded', () => {
    save({ country: ['DE'] });
    expect(choiceOf(filterState(game), 'country')).toEqual({ mode: 'in', values: ['DE'] });
  });
});
