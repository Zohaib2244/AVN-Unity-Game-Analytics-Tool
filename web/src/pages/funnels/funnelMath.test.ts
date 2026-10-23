import { describe, expect, it } from 'vitest';
import { MAX_STEPS, type ActiveFilters } from '@/lib/filters';
import type { FunnelResultRow } from '@/lib/types';
import { addLevelSteps, barWidth, biggestDrop, blankStep, canAddStep, clampJourneyRange, conversion, definition, dropPerStep, editorNote, funnelBody, funnelCSV, journeyStepName, levelSteps, lostShare, stepLabel, stepName, windowLabel } from './funnelMath';

const row = (players: number, of_first: number, of_previous: number, extra: Partial<FunnelResultRow> = {}): FunnelResultRow =>
  ({ ...blankStep('level'), players, of_first, of_previous, time_from_previous: null, dropped: 0, dropped_sample: [], ...extra });

describe('step text', () => {
  it('names a step from its label, or event · param op value', () => {
    expect(stepLabel({ ...blankStep('level_start'), label: 'Level 1' })).toBe('Level 1');
    expect(stepLabel(blankStep('level_start'))).toBe('level_start');
    expect(stepLabel({ ...blankStep('level_start'), param: 'level', op: 'gte', value: '3' })).toBe('level_start · level ≥ 3');
    expect(stepLabel({ ...blankStep('level_start'), param: 'level', op: 'exists', value: '3' })).toBe('level_start · level');
    expect(stepLabel({ ...blankStep('level_start'), param: 'level', op: 'eq', value: '' })).toBe('level_start · level');
  });
  it('uses the short "param=value" form in notes and journeys', () => {
    const step = { ...blankStep('level_start'), param: 'level', op: 'eq', value: '2' };
    expect(stepName(step)).toBe('level_start · level=2');
    expect(stepName({ ...step, label: 'L2' })).toBe('L2');
    expect(journeyStepName({ ...step, label: 'L2' }, 2)).toBe('3. L2 · level=2');
    expect(editorNote([])).toBe('no steps yet');
    expect(editorNote([blankStep(''), step])).toBe('1 step: level_start · level=2 → level_start · level=2');
    expect(editorNote([blankStep('open'), step])).toBe('2 steps: open → level_start · level=2');
  });
  it('labels the finish window', () => {
    expect(windowLabel(null)).toBe('Any time');
    expect(windowLabel(0.25)).toBe('15 minutes');
    expect(windowLabel(168)).toBe('7 days');
  });
});

describe('definition', () => {
  it('drops steps without an event and normalises conditions', () => {
    const steps = [blankStep(''), { ...blankStep('a'), param: '', op: 'gt', value: 'x' }, { ...blankStep('b'), param: 'p', op: 'exists', value: 'ignored' }, { ...blankStep('c'), param: 'p', op: '', value: '1', naming: true }];
    const body = definition({ id: null, name: 'N', steps, scope: 'session', window_hours: 0 });
    expect(body).toEqual({ name: 'N', scope: 'session', window_hours: null, steps: [
      { event: 'a', param: '', op: 'eq', value: '', label: '' },
      { event: 'b', param: 'p', op: 'exists', value: '', label: '' },
      { event: 'c', param: 'p', op: 'eq', value: '1', label: '' },
    ] });
  });
});

describe('conversion and drops', () => {
  it('computes conversion, the lost share and the drop per step', () => {
    expect(conversion(200, 50)).toBe(25);
    expect(conversion(0, 0)).toBeNull();
    expect(lostShare(61.9)).toBe(38.1);
    expect(lostShare(100)).toBe(0);
    expect(dropPerStep([row(100, 100, 100), row(40, 40, 40), row(30, 30, 75)])).toEqual([null, { continued: 40, lost: 60 }, { continued: 75, lost: 25 }]);
  });
  it('flags the biggest drop: the lowest share continuing after a step someone reached', () => {
    expect(biggestDrop([row(100, 100, 100), row(40, 40, 40), row(30, 30, 75)])).toBe(1);
    expect(biggestDrop([row(100, 100, 100), row(90, 90, 90), row(30, 30, 33.3)])).toBe(2);
    expect(biggestDrop([row(100, 100, 100), row(100, 100, 100)])).toBe(-1);
    expect(biggestDrop([row(0, 0, 0), row(0, 0, 0)])).toBe(-1);
    expect(biggestDrop([row(10, 100, 100)])).toBe(-1);
  });
  it('gives every reached step a visible bar', () => {
    expect(barWidth(row(1, 0.2, 0.2), 500)).toBe(1);
    expect(barWidth(row(0, 0, 0), 500)).toBe(0);
    expect(barWidth(row(250, 50, 50), 500)).toBe(50);
    expect(barWidth(row(0, 0, 0), 0)).toBe(0);
  });
});

describe('level steps', () => {
  it('adds one step per level and key, in order', () => {
    expect(levelSteps('level', ['Started', 'Completed'], 1, 2).map((step) => step.label)).toEqual(['Started 1', 'Completed 1', 'Started 2', 'Completed 2']);
    expect(levelSteps('level', ['Started'], 3, 3)[0]).toEqual({ event: 'level', param: 'Started', op: 'eq', value: '3', label: 'Started 3' });
  });
  it('validates the form and refuses more than MAX_STEPS', () => {
    expect(() => addLevelSteps([], { event: 'level', keys: ' , ', from: 1, to: 5, replace: true })).toThrow('Enter at least one key.');
    expect(() => addLevelSteps([], { event: 'level', keys: 'Started', from: 5, to: 1, replace: true })).toThrow('Use whole numbers, with “to” at least “from”.');
    expect(() => addLevelSteps([], { event: 'level', keys: 'Started', from: '1.5', to: 2, replace: true })).toThrow('Use whole numbers');
    expect(() => addLevelSteps([], { event: 'level', keys: 'Started, Completed', from: 1, to: 51, replace: true })).toThrow(`That makes 102 steps. A funnel can have up to ${MAX_STEPS}.`);
    expect(addLevelSteps([blankStep('open')], { event: 'level', keys: 'Started', from: 1, to: 2, replace: false })).toHaveLength(3);
    expect(addLevelSteps([blankStep('open')], { event: 'level', keys: 'Started', from: 1, to: 2, replace: true })).toHaveLength(2);
    expect(() => addLevelSteps([blankStep('open')], { event: 'level', keys: 'Started', from: 1, to: MAX_STEPS, replace: false })).toThrow(`A funnel can have up to ${MAX_STEPS}.`);
    expect(canAddStep(Array.from({ length: MAX_STEPS - 1 }, () => blankStep('a')))).toBe(true);
    expect(canAddStep(Array.from({ length: MAX_STEPS }, () => blankStep('a')))).toBe(false);
  });
});

describe('CSV and journeys', () => {
  it('writes the funnel as rows', () => {
    const rows = funnelCSV([row(10, 100, 100, { param: 'level', op: 'eq', value: '1', label: 'L1' }), row(5, 50, 50, { dropped: 5, time_from_previous: { count: 5, median: 12, average: 13, min: 1, max: 30, p90: 25 } })]);
    expect(rows[0]![0]).toBe('step');
    expect(rows[1]).toEqual([1, 'L1', 'level', 'level', 'eq', '1', 10, 100, 100, 0, '', '']);
    expect(rows[2]).toEqual([2, '', 'level', '', '', '', 5, 50, 50, 5, 12, 25]);
  });
  it('keeps the journeys range inside the funnel', () => {
    expect(clampJourneyRange(1, null, 4)).toEqual({ from: 1, to: 4 });
    expect(clampJourneyRange(9, 2, 4)).toEqual({ from: 3, to: 4 });
    expect(clampJourneyRange(2, 2, 4)).toEqual({ from: 2, to: 3 });
    expect(clampJourneyRange(1, null, 0)).toEqual({ from: 1, to: 2 });
  });
  it('builds the run body: filters, steps, count, window and breakdown only when set', () => {
    const filters = { range: { from: '2026-10-01', to: '2026-10-07' }, timezone: 'utc', hideTest: true, environment: [], app_version: [], build: [], country: [], platform: [], versionMode: 'all' } as unknown as ActiveFilters;
    const def = { name: 'N', scope: 'session' as const, window_hours: 24, steps: [{ event: 'a', param: '', op: 'eq', value: '', label: '' }] };
    const body = funnelBody(def, filters, 'country');
    expect(body).toMatchObject({ start: '2026-10-01', end: '2026-10-07', timezone_offset_minutes: 0, steps: def.steps, scope: 'session', window_hours: 24, breakdown: 'country' });
    expect(funnelBody({ ...def, window_hours: null }, filters)).not.toHaveProperty('window_hours');
    expect(funnelBody(def, filters)).not.toHaveProperty('breakdown');
  });
});
