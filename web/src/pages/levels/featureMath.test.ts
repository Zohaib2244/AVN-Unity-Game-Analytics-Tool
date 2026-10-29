import { describe, expect, it } from 'vitest';
import type { LevelFeatureRow } from '@/lib/types';
import { chosenValue, cleanFeaturePrefs, dropCells, kindOf, occurrence, rowsWith, topValues, valueLabel } from './featureMath';

const row = (over: Partial<LevelFeatureRow> = {}): LevelFeatureRow => ({
  level: 11, started: 100, dropped: 20, left_session: 30, drop_available: true, low_sample: false,
  things: { ads: { Interstitial: { players: 50, times: 70, dropped: 15, left_session: 20, right_after: 10 } } }, ...over,
});

describe('level features', () => {
  it('reads how many starters met a thing and how often', () => {
    expect(occurrence(row(), 'ads', 'Interstitial')).toEqual({ players: 50, share: 50, perPlayer: 1.4 });
    expect(occurrence(row(), 'ads', 'Rewarded')).toEqual({ players: 0, share: 0, perPlayer: null });
  });
  it('compares the drop of players who met it with those who did not', () => {
    const cells = dropCells(row(), 'ads', 'Interstitial');
    expect(cells.sides.next).toEqual({ with: 30, without: 10, difference: 20 });
    expect(cells.sides.session.with).toBe(40);
    expect(cells.sides.session.without).toBe(20);
    expect(cells.rightAfter).toEqual({ count: 10, ofDrops: 50 });
    expect(cells.overall).toEqual({ next: 20, session: 30 });
  });
  it('has no comparison when everyone, or nobody, met it', () => {
    const everyone = row({ things: { ads: { Interstitial: { players: 100, times: 100, dropped: 20, left_session: 30, right_after: 0 } } } });
    expect(dropCells(everyone, 'ads', 'Interstitial').sides.next.without).toBeNull();
    expect(dropCells(row(), 'ads', 'Rewarded').sides.next.with).toBeNull();
  });
  it('does not show a drop where the next level was never started by anyone', () => {
    expect(dropCells(row({ drop_available: false }), 'ads', 'Interstitial').overall.next).toBeNull();
  });
  it('keeps the choices sensible', () => {
    expect(kindOf('ads', 'placement')).toBe('ad_placement');
    expect(kindOf('fails', 'format')).toBe('fails');
    expect(valueLabel('level_complete_x2')).toBe('Level complete x2');
    expect(valueLabel('OutOfMoves')).toBe('OutOfMoves');
    expect(topValues(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(chosenValue(['a', 'b'], 'b')).toBe('b');
    expect(chosenValue(['a', 'b'], 'gone')).toBe('a');
    expect(chosenValue(undefined, 'x')).toBe('');
    expect(cleanFeaturePrefs({ mode: 'drop', subject: 'nope' as never, basis: 'session' })).toMatchObject({ mode: 'drop', subject: 'ads', basis: 'session' });
    expect(rowsWith([row(), row({ level: 12, things: {} })], 'ads', null).map((item) => item.level)).toEqual([11]);
  });
});
