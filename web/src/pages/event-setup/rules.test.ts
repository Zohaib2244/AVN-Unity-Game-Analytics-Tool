import { describe, expect, it } from 'vitest';
import { operatorText, previewBits, ruleFromForm, ruleText, sameRule } from './rules';

const rule = (patch = {}) => ({ action: 'level_completed', param: '', op: 'eq', value: '', number_param: '', app_version: '', ...patch });

describe('ruleText', () => {
  it('reads every time for an unconditional rule on all versions', () => {
    expect(ruleText(rule())).toBe('all versions · every time');
  });
  it('names the version, the comparison and the level parameter', () => {
    expect(ruleText(rule({ app_version: '1.4.2', param: 'STATE', op: 'eq', value: 'Completed', number_param: 'NUMBER' }))).toBe('version 1.4.2 · when STATE = Completed · level in NUMBER');
    expect(ruleText(rule({ param: 'score', op: 'gte', value: '10' }))).toBe('all versions · when score ≥ 10');
  });
  it('leaves the value out of an exists rule', () => {
    expect(ruleText(rule({ param: 'level', op: 'exists', value: 'ignored' }))).toBe('all versions · when level exists');
  });
  it('shows unknown operators as they are', () => {
    expect(operatorText('eq')).toBe('=');
    expect(operatorText('weird')).toBe('weird');
  });
  it('compares rules field by field', () => {
    expect(sameRule(rule({ param: 'a' }), rule({ param: 'a' }))).toBe(true);
    expect(sameRule(rule({ param: 'a' }), rule({ param: 'b' }))).toBe(false);
  });
});

describe('ruleFromForm', () => {
  it('keeps only the comparison fields the chosen parameter uses', () => {
    const base = { param: '', op: 'gte', value: ' 3 ', number_param: 'LEVEL', app_version: '' };
    expect(ruleFromForm('level_started', base, true)).toEqual({ action: 'level_started', param: '', op: 'eq', value: '', number_param: 'LEVEL', app_version: '' });
    expect(ruleFromForm('level_started', { ...base, param: 'STATE', value: ' Done ' }, false)).toEqual({ action: 'level_started', param: 'STATE', op: 'gte', value: 'Done', number_param: '', app_version: '' });
    expect(ruleFromForm('level_started', { ...base, param: 'STATE', op: 'exists' }, false).value).toBe('');
  });
});

describe('previewBits', () => {
  const result = { events: 4, scanned: 10, players: 2, with_level_number: 0, levels: { min: 1, max: 9 }, conflicting_events: 0, sample: null };
  it('says what matches and flags a missing level number on a level moment', () => {
    expect(previewBits(result, false)).toEqual([{ text: 'Matches 4 of its latest 10 events from 2 players', strong: false }]);
    expect(previewBits(result, true).at(-1)).toEqual({ text: 'no level number found — choose the parameter that holds it', strong: true });
    expect(previewBits({ ...result, with_level_number: 3 }, true)[1]).toEqual({ text: 'level numbers found in 3 of them (levels 1–9)', strong: false });
  });
  it('flags overlapping rules', () => {
    expect(previewBits({ ...result, conflicting_events: 2 }, false).at(-1)).toEqual({ text: '2 also match another level action. Remove or narrow the overlapping rule.', strong: true });
  });
});
