// Dashboards open on the latest build unless someone chose otherwise (tests/test_frontend.py).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filterState } from './filters';

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
