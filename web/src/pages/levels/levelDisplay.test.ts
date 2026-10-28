import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, HEAT_SPAN, barScale, cleanDisplay, heatOf, showCount } from './levelDisplay';

describe('cleanDisplay', () => {
  it('falls back to the defaults for nothing or nonsense', () => {
    expect(cleanDisplay(null)).toEqual(DEFAULT_DISPLAY);
    expect(cleanDisplay('x')).toEqual(DEFAULT_DISPLAY);
    expect(cleanDisplay({ columns: 4, style: 'pie', counts: 'sometimes', dropFlag: 'high' })).toEqual(DEFAULT_DISPLAY);
  });
  it('keeps valid choices and clamps the thresholds', () => {
    const shown = cleanDisplay({ columns: { finished: true, time: false, nope: true }, style: 'bar', counts: 'hover', dropFlag: 500, quitFlag: -3 });
    expect(shown.columns.finished).toBe(true);
    expect(shown.columns.time).toBe(false);
    expect(shown.columns.started).toBe(true);
    expect(Object.keys(shown.columns)).not.toContain('nope');
    expect(shown).toMatchObject({ style: 'bar', counts: 'hover', dropFlag: 60, quitFlag: 0 });
  });
});

describe('heatOf', () => {
  it('is plain at or under the threshold, and for missing values', () => {
    expect(heatOf(25, 25)).toEqual({ over: false, heat: 0, points: 0 });
    expect(heatOf(1, 25).over).toBe(false);
    expect(heatOf(null, 25).over).toBe(false);
  });
  it('grows with the points over the threshold and tops out', () => {
    expect(heatOf(25.1, 25).over).toBe(true);
    expect(heatOf(40, 25)).toMatchObject({ over: true, heat: 0.5, points: 15 });
    expect(heatOf(25 + HEAT_SPAN, 25).heat).toBe(1);
    expect(heatOf(100, 25).heat).toBe(1);
  });
  it('is measured against each metric’s own threshold', () => {
    expect(heatOf(12, 10).over).toBe(true);
    expect(heatOf(12, 25).over).toBe(false);
  });
});

describe('display helpers', () => {
  it('shows counts as chosen', () => {
    expect(showCount('flag', true)).toBe(true);
    expect(showCount('flag', false)).toBe(false);
    expect(showCount('always', false)).toBe(true);
    expect(showCount('hover', true)).toBe(false);
  });
  it('keeps the bar tick inside the track', () => {
    for (const threshold of [0, 5, 25, 60]) expect(threshold * barScale(threshold)).toBeLessThanOrEqual(50);
  });
});
