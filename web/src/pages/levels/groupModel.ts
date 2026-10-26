import { filterBody, type ActiveFilters } from '@/lib/filters';
import type { EventRule } from '@/lib/types';

export type GroupDraft = {
  entryLevel: string; exclusions: EventRule[]; excludePlayers: string;
  kind: 'level_duration' | 'event_count' | 'parameter'; level: string; event: EventRule;
  parameter: string; minutes: string; comparison: 'number' | 'equals'; split: string; value: string;
  outcomeKind: 'level' | 'event'; outcomeLevel: string; outcomeEvent: EventRule; hours: string;
};
export const blankGroupRule = (): EventRule => ({ event: '', param: '', op: 'eq', value: '' });
export const defaultGroupDraft = (): GroupDraft => ({ entryLevel: '1', exclusions: [], excludePlayers: '', kind: 'level_duration', level: '1', event: blankGroupRule(), parameter: '', minutes: '10', comparison: 'number', split: '', value: '', outcomeKind: 'level', outcomeLevel: '4', outcomeEvent: blankGroupRule(), hours: '24' });
export const groupDraftKey = (id: string): string => `avn-player-groups-draft-${id}`;
export const groupRunKey = (id: string): string => `avn-player-groups-run-${id}`;
const finite = (value: string): boolean => value.trim() !== '' && Number.isFinite(Number(value));
const levelOK = (value: string): boolean => finite(value) && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000;
export const cleanGroupRule = (rule: EventRule) => ({ event: rule.event, param: rule.param || '', op: rule.op || 'eq', value: rule.value || '' });
const ruleError = (rule: EventRule): string => !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(rule.event) ? 'Choose a valid event name.' : rule.param && ['gt', 'gte', 'lt', 'lte'].includes(rule.op || '') && !finite(rule.value || '') ? 'Compare the parameter with a finite number.' : '';

export function groupStepError(draft: GroupDraft, step: number): string {
  if (step === 0) {
    if (!finite(draft.hours) || Number(draft.hours) <= 0 || Number(draft.hours) > 720) return 'Enter an observation window between 0 and 720 hours.';
    if (draft.entryLevel !== '' && !levelOK(draft.entryLevel)) return 'Enter a valid entry level.';
    if (draft.excludePlayers.split(/[\n,]/).filter((id) => id.trim()).length > 200) return 'Exclude at most 200 player IDs.';
    if (draft.exclusions.length > 20) return 'Use at most 20 exclusion rules.';
    return draft.exclusions.map(ruleError).find(Boolean) || '';
  }
  if (step === 1) {
    if (draft.kind === 'level_duration') return levelOK(draft.level) ? '' : 'Enter a valid behavior level.';
    if (ruleError(draft.event)) return ruleError(draft.event);
    if (!finite(draft.minutes) || Number(draft.minutes) <= 0 || Number(draft.minutes) > 43200) return 'Enter a behavior window between 0 and 43,200 minutes.';
    if (draft.kind === 'parameter' && !draft.parameter.trim()) return 'Choose the parameter to compare.';
    return '';
  }
  if (step === 2) {
    if (draft.kind !== 'level_duration' && Number(draft.minutes) >= Number(draft.hours) * 60) return 'The behavior window must end before the observation window.';
    if (draft.kind === 'parameter' && draft.comparison === 'equals') return draft.value ? '' : 'Enter the value for group A.';
    return finite(draft.split) && (draft.kind === 'parameter' || Number(draft.split) >= 0) ? '' : 'Enter a finite numeric split.';
  }
  if (!finite(draft.hours) || Number(draft.hours) <= 0 || Number(draft.hours) > 720) return 'Enter an observation window between 0 and 720 hours.';
  if (draft.outcomeKind === 'level') {
    if (!levelOK(draft.outcomeLevel)) return 'Enter a valid outcome level.';
    if (draft.kind === 'level_duration' && Number(draft.outcomeLevel) <= Number(draft.level)) return 'Choose an outcome level after the behavior level.';
  } else if (ruleError(draft.outcomeEvent)) return ruleError(draft.outcomeEvent);
  if (draft.kind !== 'level_duration' && Number(draft.minutes) >= Number(draft.hours) * 60) return 'The behavior window must end before the observation window.';
  return '';
}

export function groupRequest(draft: GroupDraft, filters: ActiveFilters) {
  return {
    ...filterBody(filters),
    entry_level: draft.entryLevel === '' ? null : Number(draft.entryLevel),
    exclude_players: draft.excludePlayers.split(/[\n,]/).map((id) => id.trim()).filter(Boolean),
    exclude_events: draft.exclusions.map(cleanGroupRule),
    behavior: {
      kind: draft.kind, level: Number(draft.level), event: draft.kind === 'level_duration' ? null : cleanGroupRule(draft.event), parameter: draft.parameter,
      window_minutes: Number(draft.minutes), comparison: draft.comparison, split: draft.kind === 'parameter' && draft.comparison === 'equals' ? null : Number(draft.split), value: draft.value,
    },
    outcome: { kind: draft.outcomeKind, level: Number(draft.outcomeLevel), event: draft.outcomeKind === 'event' ? cleanGroupRule(draft.outcomeEvent) : null, window_hours: Number(draft.hours) },
  };
}
export type GroupRequest = ReturnType<typeof groupRequest>;
export type GroupAnswer = {
  definition: GroupRequest; as_of: string; minimum_players: number; interval_method: string;
  counts: { candidates: number; eligible: number; pending: number; excluded: number; outcome_before_group: number };
  exclusions: Array<{ reason: string; label: string; players: number }>; missing_reasons: Record<string, number>;
  groups: Array<{ id: string; label: string; players: number; reached: number; rate: number | null; interval: [number, number] | null; low_sample: boolean; examples: Array<{ player: string; reached: boolean; value: string | number | null }> }>;
  difference: { percentage_points: number; interval: [number, number]; includes_zero: boolean; method: string } | null;
};

/** Saved browser preferences are accepted only when their shape is complete and safe to render. */
export function savedGroupDraft(raw: unknown): GroupDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const draft = raw as GroupDraft;
  const defaults = defaultGroupDraft();
  if (Object.keys(defaults).some((key) => !Object.hasOwn(draft, key))) return null;
  for (const [key, value] of Object.entries(defaults)) if (typeof value === 'string' && typeof draft[key as keyof GroupDraft] !== 'string') return null;
  const validRule = (rule: unknown): rule is EventRule => !!rule && typeof rule === 'object' && ['event', 'param', 'op', 'value'].every((key) => typeof (rule as Record<string, unknown>)[key] === 'string');
  if (!Array.isArray(draft.exclusions) || !draft.exclusions.every(validRule) || !validRule(draft.event) || !validRule(draft.outcomeEvent)) return null;
  if (!['level_duration', 'event_count', 'parameter'].includes(draft.kind) || !['number', 'equals'].includes(draft.comparison) || !['level', 'event'].includes(draft.outcomeKind)) return null;
  return draft;
}
