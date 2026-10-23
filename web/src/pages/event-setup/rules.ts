// How a mapping rule reads: the operators it can use and the one-line text beside a mapped event.
import type { MappingPreview, MappingRule } from '@/lib/types';
import { number } from '@/lib/format';

export const MAPPING_OPERATORS: Array<[string, string]> = [['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['exists', 'exists']];
export const operatorText = (op: string): string => (MAPPING_OPERATORS.find(([key]) => key === op) || [op, op])[1];
export const ruleText = (rule: MappingRule): string => `${rule.app_version ? `version ${rule.app_version} · ` : 'all versions · '}${rule.param ? `when ${rule.param} ${operatorText(rule.op)}${rule.op === 'exists' ? '' : ` ${rule.value}`}` : 'every time'}${rule.number_param ? ` · level in ${rule.number_param}` : ''}`;
/** Two rules are the same mapping when every field agrees (the server compares them the same way). */
export const sameRule = (a: MappingRule, b: MappingRule): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The add form of a mapping card → the rule it saves (only the fields the chosen comparison uses). */
export const ruleFromForm = (action: string, form: { param: string; op: string; value: string; number_param: string; app_version: string }, needs: boolean): MappingRule => ({
  action,
  param: form.param,
  op: form.param ? form.op : 'eq',
  value: form.param && form.op !== 'exists' ? form.value.trim() : '',
  number_param: needs ? form.number_param : '',
  app_version: form.app_version,
});

/** The live preview under the add form, as parts (strong ones are the problems). */
export function previewBits(result: MappingPreview, needs: boolean): Array<{ text: string; strong: boolean }> {
  const bits = [{ text: `Matches ${number(result.events)} of its latest ${number(result.scanned)} events from ${number(result.players)} players`, strong: false }];
  if (needs && result.events) {
    bits.push(result.with_level_number
      ? { text: `level numbers found in ${number(result.with_level_number)} of them (levels ${number(result.levels.min)}–${number(result.levels.max)})`, strong: false }
      : { text: 'no level number found — choose the parameter that holds it', strong: true });
  }
  if (result.conflicting_events) bits.push({ text: `${number(result.conflicting_events)} also match another level action. Remove or narrow the overlapping rule.`, strong: true });
  return bits;
}
