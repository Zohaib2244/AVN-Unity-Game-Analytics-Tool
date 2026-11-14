import { describe, expect, it } from 'vitest';
import type { AcquisitionReport, AcquisitionRow } from '@/lib/types';
import { answer, cleanGoals, costWords, judgedGoal, settledDay, tone, splitTracked } from './model';

const row = (value: string, installs: number, perPlayer: Record<number, [number, number]>, cpi: number | null): AcquisitionRow => ({
  value, installs, paid: value !== 'Organic', retention: {},
  value_per_install: Object.fromEntries(Object.entries(perPlayer).map(([day, [players, money]]) => [`day_${day}`, { players, per_player: money }])),
  cost: null, service_installs: null, sdk_installs: null, cost_per_install: cpi, seen_share: null, seen_share_all: null,
  return: Object.fromEntries(Object.entries(perPlayer).map(([day, [, money]]) => [`day_${day}`, cpi ? money / cpi : null])),
});

describe('Acquisition page model', () => {
  it('colours a return only on a day that has a goal', () => {
    expect(tone(0.8, { day: 7, percent: 75 })).toBe('good');
    expect(tone(0.5, { day: 7, percent: 75 })).toBe('behind');
    expect(tone(0.5, undefined)).toBe('none');
  });

  it('judges a row by its latest goal day that has a number', () => {
    const d7 = row('D7 WW', 100, { 0: [100, 0.1], 3: [80, 0.2], 7: [0, 0] }, 0.4);
    expect(judgedGoal(d7, [{ day: 3, percent: 40 }, { day: 7, percent: 75 }])).toEqual({ goal: { day: 3, percent: 40 }, value: 0.5 });
    expect(settledDay(d7)).toBe(3);
  });

  it('answers with the biggest paid source, what a player earned and the goal', () => {
    const report = { installs: 200, rows: [row('D7 WW', 150, { 0: [150, 0.14], 1: [150, 0.18] }, 0.4), row('Organic', 50, { 0: [50, 0.05] }, null)] } as unknown as AcquisitionReport;
    expect(answer(report, () => [{ day: 1, percent: 40 }])).toBe('D7 WW brought 75% of installs; a player from it earned $0.18 by day 1, 45% of their cost against a day 1 goal of 40%.');
  });

  it('keeps one goal per day, within range, in day order', () => {
    expect(cleanGoals([{ day: '7', percent: '75' }, { day: 3, percent: 40 }, { day: 7, percent: 80 }, { day: 400, percent: 10 }, { day: 1, percent: 0 }])).toEqual([{ day: 3, percent: 40 }, { day: 7, percent: 80 }]);
  });

  it('says why cost is missing', () => {
    expect(costWords({ state: 'not_allowed', app_id: 'com.x' })!.text).toContain('com.x');
    expect(costWords({ state: 'ok' })).toBeNull();
  });
});

describe('splitTracked', () => {
  it('folds the days before anyone was seen here, keeps later empty days', () => {
    const days = [{ day: 'a', installs: 0 }, { day: 'b', installs: 0 }, { day: 'c', installs: 3 }, { day: 'd', installs: 0 }, { day: 'e', installs: 2 }];
    const { before, tracked } = splitTracked(days);
    expect(before.map((row) => row.day)).toEqual(['a', 'b']);
    expect(tracked.map((row) => row.day)).toEqual(['c', 'd', 'e']);
  });
  it('puts everything before when nobody was seen', () => {
    expect(splitTracked([{ installs: 0 }])).toEqual({ before: [{ installs: 0 }], tracked: [] });
  });
});
