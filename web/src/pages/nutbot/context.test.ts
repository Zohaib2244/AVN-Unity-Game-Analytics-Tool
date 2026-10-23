import { contextChips, scopeLine, buildContext, panelChips } from './context';
import type { FilterState } from '@/lib/filters';

const game = { id: 'g1', name: 'Blocks', platform: 'android' };
const filters: FilterState = { range: { from: '2026-10-01', to: '2026-10-07', preset: '7' }, timezone: 'local', hideTest: true, versionMode: 'custom', environment: [], app_version: ['1.2.0'], build: [], country: ['DE', 'FR', 'US'], platform: [] };

describe('context chips', () => {
  it('shows nothing outside a game', () => {
    expect(contextChips({ game: null, section: 'overview', filters: null })).toEqual([]);
  });
  it('shows game (fixed), page, range, filters and player on a game page', () => {
    const chips = contextChips({ game, section: 'levels', filters, player: 'player-0123456789abcdefghij' });
    expect(chips.map((chip) => chip.id)).toEqual(['game', 'page', 'range', 'filters', 'player']);
    expect(chips[0]).toEqual({ id: 'game', label: 'Blocks · Android', removable: false });
    expect(chips[1]!.label).toBe('Levels');
    expect(chips[3]!.label).toBe('1.2.0, Germany (DE) +2');
    expect(chips[4]!.label).toBe('Player player-0…efghij');
    expect(panelChips(chips, new Set(['range']))[2]).toMatchObject({ id: 'range', off: true, fixed: false });
    expect(panelChips(chips, new Set())[0]).toMatchObject({ id: 'game', fixed: true });
  });
  it('leaves out range and filters when the page has none', () => {
    const chips = contextChips({ game, section: 'event-setup', filters: { ...filters, range: null, app_version: [], country: [] } });
    expect(chips.map((chip) => chip.id)).toEqual(['game', 'page']);
    expect(chips[1]!.label).toBe('Event setup');
  });
  it('writes the scope line from the chips that are used', () => {
    const chips = contextChips({ game, section: 'levels', filters });
    expect(scopeLine(chips, new Set())).toMatch(/^Same filters as the page · .+ · 1\.2\.0, Germany \(DE\) \+2$/);
    expect(scopeLine(chips, new Set(['filters']))).toMatch(/^Same filters as the page · /);
    expect(scopeLine(chips, new Set(['range', 'filters']))).toBe('No page filters applied');
    expect(scopeLine(contextChips({ game, section: 'keys', filters: null }), new Set())).toBe('No page filters applied');
  });
  it('builds the context the server receives, honouring left-out chips', () => {
    const full = buildContext({ game, section: 'levels', filters, player: 'p1' }, new Set());
    expect(full).toMatchObject({ page: 'levels', range: { from: '2026-10-01', to: '2026-10-07' }, hide_test: true, player: 'p1', filters: { app_versions: ['1.2.0'], countries: ['DE', 'FR', 'US'], environments: [], builds: [], platforms: [] } });
    expect(full.funnel).toBeUndefined();
    const trimmed = buildContext({ game, section: 'levels', filters, player: 'p1' }, new Set(['page', 'range', 'filters', 'player']));
    expect(trimmed.page).toBeUndefined(); expect(trimmed.range).toBeUndefined(); expect(trimmed.player).toBeUndefined();
    expect(trimmed.filters).toEqual({ environments: [], app_versions: [], builds: [], countries: [], platforms: [] });
  });
});
