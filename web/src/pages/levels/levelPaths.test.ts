import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveFilters } from '@/lib/filters';
import { storeSet } from '@/lib/store';
import { DRILL_PAGE, navigationKey } from './levelMath';
import { activeViewKey, drillPagePath, drillPath, drillQuery, isCompareView, levelsPath, levelsPrefetchPath, levelsQuery, listPath, releaseFacetsPath, releasePath, releasesKey, savedViewsKey, viewKey } from './levelPaths';

const game = { id: 'g1' };
const state: ActiveFilters = {
  range: { from: '2024-03-01', to: '2024-03-07', preset: 'custom' }, timezone: 'utc', hideTest: true, versionMode: 'all',
  environment: [], app_version: [], build: [], country: [], platform: [],
};
const params = (url: string): URLSearchParams => new URL(`http://x${url}`).searchParams;

beforeEach(() => localStorage.clear());

describe('keys kept in this browser', () => {
  it('uses the old names, one set per game', () => {
    expect(viewKey(game)).toBe('avn-levels-view-g1');
    expect(navigationKey(game)).toBe('avn-level-nav-g1');
    expect(savedViewsKey(game)).toBe('avn-level-views-g1');
    expect(activeViewKey(game)).toBe('avn-level-active-view-g1');
    expect(releasesKey(game)).toBe('avn-level-tools-g1');
  });
  it('treats "explore" as the old name of Compare releases', () => {
    expect(isCompareView('compare')).toBe(true);
    expect(isCompareView('explore')).toBe(true);
    expect(isCompareView('table')).toBe(false);
    expect(isCompareView(null)).toBe(false);
  });
});

describe('addresses the Levels page asks for', () => {
  it('opens the list at the game\'s levels section', () => {
    expect(listPath(game)).toBe('/games/g1/levels');
  });
  it('adds the scope only for new players', () => {
    expect(levelsQuery(state, 'first_session').get('scope')).toBe('first_session');
    expect(levelsQuery(state, 'all').has('scope')).toBe(false);
  });
  it('asks for the levels of the dates and filters', () => {
    const url = levelsPath(game, state, 'all');
    expect(url.startsWith('/v1/games/g1/insights/levels?')).toBe(true);
    expect(params(url).get('start')).toBe('2024-03-01');
    expect(params(url).get('end')).toBe('2024-03-07');
    expect(params(url).get('tz_offset')).toBe('0');
    expect(params(url).getAll('not_env')).toEqual(['editor', 'development', 'test', 'debug']);
  });
});

describe('the players behind a level', () => {
  it('names the level, group and order, and the last action only when one is picked', () => {
    const plain = drillQuery(state, 'all', 12, { group: 'left', sort: 'exit_at', lastAction: null });
    expect(plain.get('level')).toBe('12');
    expect(plain.get('group')).toBe('left');
    expect(plain.get('sort')).toBe('exit_at');
    expect(plain.has('last_action')).toBe(false);
    const picked = drillQuery(state, 'first_session', 12, { group: 'finished_stopped', sort: 'tries', lastAction: 'Pressed back' });
    expect(picked.get('last_action')).toBe('Pressed back');
    expect(picked.get('scope')).toBe('first_session');
  });
  it('is the players endpoint, and one page is DRILL_PAGE players from an offset', () => {
    expect(drillPath(game, state, 'all', 3, { group: 'kept_going', sort: 'exit_at', lastAction: null }).startsWith('/v1/games/g1/insights/levels/players?')).toBe(true);
    const page = drillPagePath(game, state, 'all', 3, { group: 'left', sort: 'exit_at', lastAction: null }, 100);
    expect(params(page).get('offset')).toBe('100');
    expect(params(page).get('limit')).toBe(String(DRILL_PAGE));
  });
});

describe('Compare releases requests', () => {
  it('asks for the releases the dates contain, with the same timezone', () => {
    const url = releaseFacetsPath(game, state);
    expect(url.startsWith('/v1/games/g1/insights/facets?')).toBe(true);
    expect(params(url).get('start')).toBe('2024-03-01');
    expect(params(url).get('tz_offset')).toBe('0');
  });
  it('replaces the app version with the release being compared', () => {
    const url = releasePath(game, { ...state, app_version: ['1.9'], environment: ['live'] }, '1.10');
    expect(params(url).getAll('version')).toEqual(['1.10']);
    expect(params(url).getAll('env')).toEqual(['live']);
    expect(params(url).has('not_env')).toBe(false);
  });
});

describe('the first request of the page', () => {
  it('is not sent while Compare releases is the open view', () => {
    storeSet(viewKey(game), 'compare');
    expect(levelsPrefetchPath(game)).toBeNull();
    storeSet(viewKey(game), 'explore');
    expect(levelsPrefetchPath(game)).toBeNull();
  });
  it('asks for the level table, with the new-players scope when that is remembered', () => {
    expect(levelsPrefetchPath(game)?.startsWith('/v1/games/g1/insights/levels?')).toBe(true);
    expect(levelsPrefetchPath(game)).not.toContain('scope=');
    storeSet(navigationKey(game), { sort: 'level', pageSize: '50', scope: 'first_session' });
    expect(levelsPrefetchPath(game)).toContain('scope=first_session');
  });
});
