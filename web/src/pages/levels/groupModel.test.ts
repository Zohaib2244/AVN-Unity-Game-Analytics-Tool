import { describe, expect, it } from 'vitest';
import { defaultGroupDraft, groupRequest, groupStepError, savedGroupDraft } from './groupModel';
import type { ActiveFilters } from '@/lib/filters';

const filters: ActiveFilters = { range: { from: '2026-10-04', to: '2026-10-05' }, timezone: 'utc', hideTest: true, versionMode: 'custom', app_version: ['0.1.3'], environment: [], build: [], country: [], platform: [] };

describe('guided group comparison', () => {
  it('requires an explicit split and keeps a zero threshold valid for event exposure', () => {
    const draft = defaultGroupDraft();
    expect(groupStepError(draft, 0)).toBe('');
    expect(groupStepError(draft, 1)).toBe('');
    expect(groupStepError(draft, 2)).toContain('split');
    draft.kind = 'event_count'; draft.event.event = 'ad_show'; draft.split = '0';
    expect(groupStepError(draft, 2)).toBe('');
    expect(groupStepError(draft, 3)).toBe('');
    draft.minutes = '1440';
    expect(groupStepError(draft, 3)).toContain('before');
  });
  it('sends cohort filters, time windows, clean event rules and exclusions', () => {
    const draft = defaultGroupDraft();
    draft.split = '70'; draft.excludePlayers = 'emulator, test-device\nold-save';
    draft.exclusions = [{ event: 'session_start', param: 'model', op: 'contains', value: 'emulator' }];
    const body = groupRequest(draft, filters);
    expect(body.behavior.split).toBe(70);
    expect(body.filters.app_versions).toEqual(['0.1.3']);
    expect(body.filters.exclude_environments).toContain('editor');
    expect(body.exclude_players).toEqual(['emulator', 'test-device', 'old-save']);
    expect(body.outcome.window_hours).toBe(24);
    expect(body.timezone_offset_minutes).toBe(0);
    expect(body.exclude_events[0]).toEqual(draft.exclusions[0]);
  });
  it('requires a later level and a recorded value for categorical groups', () => {
    const draft = defaultGroupDraft(); draft.split = '70'; draft.outcomeLevel = '1';
    expect(groupStepError(draft, 3)).toContain('after');
    draft.kind = 'parameter'; draft.event.event = 'session_start'; draft.parameter = 'campaign'; draft.comparison = 'equals';
    expect(groupStepError(draft, 2)).toContain('value');
    draft.value = 'paid';
    expect(groupStepError(draft, 2)).toBe('');
    expect(groupRequest(draft, filters).behavior.split).toBeNull();
  });
  it('ignores corrupt browser preferences', () => {
    expect(savedGroupDraft(null)).toBeNull();
    expect(savedGroupDraft({ kind: 'parameter' })).toBeNull();
    expect(savedGroupDraft({ ...defaultGroupDraft(), exclusions: [null] })).toBeNull();
    expect(savedGroupDraft({ ...defaultGroupDraft(), kind: 'unknown' })).toBeNull();
    expect(savedGroupDraft(defaultGroupDraft())).toEqual(defaultGroupDraft());
  });
});
