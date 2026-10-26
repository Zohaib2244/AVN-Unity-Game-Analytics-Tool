import { resolveRange } from '@/components/DateRange';
import type { ActiveFilters } from '@/lib/filters';
import { blankGroupRule, defaultGroupDraft, groupRequest, type GroupDraft, type GroupRequest } from './groupModel';

export type SavedGroupDefinition = Omit<GroupRequest, 'outcome'> & {
  outcome: GroupRequest['outcome'] | null; window_hours: number;
  range_preset: string; version_mode: ActiveFilters['versionMode']; timezone: ActiveFilters['timezone']; hide_test: boolean;
};
export type SavedGroupItem = { id: string; name: string; kind: 'groups' | 'check'; definition: SavedGroupDefinition; updated_at: string };
export type SaveGroupIntent = { kind: SavedGroupItem['kind']; item?: SavedGroupItem; draft: GroupDraft; filters: ActiveFilters };

export function savedDefinition(draft: GroupDraft, filters: ActiveFilters, kind: SavedGroupItem['kind']): SavedGroupDefinition {
  const query = groupRequest(draft, filters);
  return { ...query, outcome: kind === 'check' ? query.outcome : null, window_hours: Number(draft.hours), range_preset: filters.range.preset || 'custom', version_mode: filters.versionMode, timezone: filters.timezone, hide_test: filters.hideTest };
}

export function restoreSavedGroup(item: SavedGroupItem): { draft: GroupDraft; filters: ActiveFilters } {
  const d = item.definition;
  const b = d.behavior;
  const o = d.outcome;
  return {
    draft: { ...defaultGroupDraft(), entryLevel: d.entry_level == null ? '' : String(d.entry_level), exclusions: d.exclude_events, excludePlayers: d.exclude_players.join('\n'), kind: b.kind, level: String(b.level), event: b.event || blankGroupRule(), parameter: b.parameter, minutes: String(b.window_minutes), comparison: b.comparison, split: b.split == null ? '' : String(b.split), value: b.value, hours: String(d.window_hours), ...(o ? { outcomeKind: o.kind, outcomeLevel: String(o.level), outcomeEvent: o.event || blankGroupRule() } : {}) },
    filters: { range: resolveRange(d.range_preset, { from: d.start, to: d.end }), timezone: d.timezone, hideTest: d.hide_test, versionMode: d.version_mode, environment: d.filters.environments, app_version: d.filters.app_versions, build: d.filters.builds, country: d.filters.countries, platform: d.filters.platforms },
  };
}
