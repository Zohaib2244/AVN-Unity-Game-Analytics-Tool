import { describe, expect, it, vi } from 'vitest';
import type { ActiveFilters } from '@/lib/filters';
import { defaultGroupDraft, groupRequest } from './groupModel';
import { restoreSavedGroup, savedDefinition, type SavedGroupItem } from './groupLibraryModel';

const filters: ActiveFilters = { range: { from: '2026-10-01', to: '2026-10-26', preset: '30' }, timezone: 'utc', hideTest: true, versionMode: 'latest', app_version: ['0.1.3'], environment: [], build: ['2'], country: ['PK'], platform: ['android'] };

describe('saved comparisons', () => {
  it('saves groups independently of the outcome and keeps complete shortcuts', () => {
    const draft = { ...defaultGroupDraft(), split: '70', outcomeLevel: '8', excludePlayers: 'emulator', exclusions: [{ event: 'session_start', param: 'test', op: 'eq' as const, value: 'true' }] };
    const groups = savedDefinition(draft, filters, 'groups');
    expect(groups.outcome).toBeNull();
    const check = savedDefinition(draft, filters, 'check');
    expect(check.outcome?.level).toBe(8);
    draft.outcomeLevel = '10';
    expect(check.outcome?.level).toBe(8);
    const item: SavedGroupItem = { id: 'one', name: 'Speed', kind: 'check', definition: check, updated_at: '' };
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    try {
      const restored = restoreSavedGroup(item);
      expect(restored.filters.range.to).toBe('2026-11-12');
      expect(restored.filters.range.from).toBe('2026-10-14');
      expect(restored.filters.versionMode).toBe('latest');
      expect(restored.draft.outcomeLevel).toBe('8');
      expect(restored.draft.excludePlayers).toBe('emulator');
      expect(restored.draft.exclusions).toEqual(draft.exclusions);
      expect(restored.filters.country).toEqual(['PK']);
      expect(groupRequest(restored.draft, restored.filters).behavior.split).toBe(70);
    } finally { vi.useRealTimers(); }
  });
  it('retains custom dates and categorical groups without inventing a numeric split', () => {
    const draft = { ...defaultGroupDraft(), kind: 'parameter' as const, event: { event: 'session_start', param: '', op: 'eq' as const, value: '' }, parameter: 'tier', comparison: 'equals' as const, value: 'low' };
    const definition = savedDefinition(draft, { ...filters, range: { ...filters.range, preset: 'custom' }, versionMode: 'custom' }, 'groups');
    const restored = restoreSavedGroup({ id: 'two', name: 'Tier', kind: 'groups', definition, updated_at: '' });
    expect(restored.filters.range.from).toBe('2026-10-01');
    expect(restored.filters.app_version).toEqual(['0.1.3']);
    expect(restored.draft.split).toBe('');
    expect(restored.draft.value).toBe('low');
    expect(restored.draft.hours).toBe('24');
  });
});
