import { describe, expect, it } from 'vitest';
import type { LevelFeatureRow } from '@/lib/types';
import { chosenValue, cleanFeaturePrefs, dropCells, dropLevels, dropSummary, kindOf, occurrence, rowsWith, topValues, valueLabel } from './featureMath';

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
  it('treats an old remembered choice of both as stopping for good', () => {
    expect(cleanFeaturePrefs({ mode: 'drop', basis: 'both' as never }).basis).toBe('next');
  });
});

describe('dropping out, in plain numbers', () => {
  const ads = (players: number, dropped: number, left_session = dropped) => ({ ads: { Interstitial: { players, times: players, dropped, left_session, right_after: 0 } } });
  const rows = [
    row({ level: 1, started: 200, dropped: 20, things: ads(100, 20) }), // met 20%, not met 0%: +20
    row({ level: 2, started: 200, dropped: 40, things: ads(100, 10) }), // met 10%, not met 30%: -20
    row({ level: 3, started: 200, dropped: 20, things: ads(150, 15) }), // met 10%, not met 10%: 0
    row({ level: 4, started: 40, dropped: 10, things: ads(10, 5) }), // too few on one side
    row({ level: 5, started: 500, dropped: 50, low_sample: true, things: ads(250, 25) }), // flagged small
  ];

  it('marks the levels with enough players on both sides', () => {
    const levels = dropLevels(rows, 'ads', 'Interstitial', 'next');
    expect(levels.map((item) => item.reliable)).toEqual([true, true, true, false, false]);
    expect(levels[0]).toMatchObject({ level: 1, met: 100, withRate: 20, withoutRate: 0, gap: 20 });
    expect(levels[3]!.reliable).toBe(false); // only 10 who met it
    expect(levels[4]!.reliable).toBe(false); // the level is flagged as a small sample
  });

  it('adds the reliable levels up into one comparison and names where the gap is biggest', () => {
    const summary = dropSummary(rows, 'ads', 'Interstitial', 'next');
    // Levels 1-3 (600 starters): 350 met it and 45 of them left; 250 did not and 35 of them left.
    expect(summary).toMatchObject({ levels: 3, met: 350, metLeft: 45, notMet: 250, notMetLeft: 35 });
    expect(summary.withRate).toBeCloseTo(12.86, 1);
    expect(summary.withoutRate).toBe(14);
    expect(summary.gap).toBeCloseTo(-1.14, 1);
    expect(summary.higher.map((item) => item.level)).toEqual([1]);
    expect(summary.lower.map((item) => item.level)).toEqual([2]);
  });

  it('says nothing when no level has enough players, and skips levels where nobody started the next', () => {
    expect(dropSummary([rows[3]!], 'ads', 'Interstitial', 'next')).toMatchObject({ levels: 0, withRate: null, gap: null });
    const unavailable = dropLevels([row({ drop_available: false })], 'ads', 'Interstitial', 'next')[0]!;
    expect(unavailable).toMatchObject({ gap: null, reliable: false });
    expect(dropLevels([row({ drop_available: false })], 'ads', 'Interstitial', 'session')[0]!.gap).toBe(20);
  });
});
