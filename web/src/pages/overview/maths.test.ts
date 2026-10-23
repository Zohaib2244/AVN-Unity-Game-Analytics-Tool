import { describe, expect, it } from 'vitest';
import { breakdownShares, chartGeometry, dailySeries, signed, toggleValue } from './maths';

describe('dailySeries', () => {
  it('fills every day of the range, missing days as 0, for the chosen measure', () => {
    const days = [{ day: '2026-10-01', players: 3, sessions: 5, events: 40 }, { day: '2026-10-03', players: 1, sessions: 1, events: 2 }];
    expect(dailySeries(days, { from: '2026-10-01', to: '2026-10-03' }, 'players')).toEqual([{ day: '2026-10-01', value: 3 }, { day: '2026-10-02', value: 0 }, { day: '2026-10-03', value: 1 }]);
    expect(dailySeries(days, { from: '2026-10-01', to: '2026-10-03' }, 'events').map((p) => p.value)).toEqual([40, 0, 2]);
  });
});

describe('chartGeometry', () => {
  it('draws grid lines at 0, half and the peak, and bars from the baseline', () => {
    const geometry = chartGeometry([{ day: 'a', value: 10 }, { day: 'b', value: 0 }, { day: 'c', value: 4 }]);
    expect(geometry.peak).toBe(10);
    expect(geometry.ticks).toEqual([0, 5, 10]);
    expect(geometry.bars[0]!.height).toBe(140);
    expect(geometry.bars[1]!.height).toBe(0);
    expect(geometry.bars[0]!.y + geometry.bars[0]!.height).toBe(148);
  });
  it('never divides by zero on an empty range', () => {
    const geometry = chartGeometry([]);
    expect(geometry.peak).toBe(1);
    expect(geometry.ticks).toEqual([0, 1]);
    expect(geometry.bars).toEqual([]);
  });
});

describe('breakdownShares', () => {
  const rows = [{ value: 'android', players: 80, events: 900 }, { value: 'ios', players: 20, events: 100 }, { value: 'web', players: 1, events: 1 }];
  it('shares are of the total players and bars are relative to the biggest row', () => {
    const shares = breakdownShares(rows, 100);
    expect(shares.map((row) => row.share)).toEqual([80, 20, 1]);
    expect(shares.map((row) => row.width)).toEqual([100, 25, 2]);
  });
  it('has no share without a total', () => {
    expect(breakdownShares(rows, 0).map((row) => row.share)).toEqual([null, null, null]);
  });
});

describe('toggleValue', () => {
  it('adds a value once and removes it the second time', () => {
    expect(toggleValue([], 'RO')).toEqual(['RO']);
    expect(toggleValue(['RO'], 'RO')).toEqual([]);
    expect(toggleValue(['RO'], 'DE')).toEqual(['RO', 'DE']);
  });
});

describe('signed', () => {
  it('prefixes gains with a plus and leaves losses and zero alone', () => {
    expect(signed(12, String)).toBe('+12');
    expect(signed(-3, String)).toBe('-3');
    expect(signed(0, String)).toBe('0');
  });
});
