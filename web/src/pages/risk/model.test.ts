import { describe, expect, it } from 'vitest';
import type { ChurnPlayer } from '@/lib/types';
import { ago, earlyWords, groupSearch, habit, skipped, stateWord } from './model';

const player = (missing?: string): ChurnPlayer => ({ player: 'p', state: 'gone', days_played: 5, usual_gap: 1, days_away: 9, ratio: 9, last_day: '2026-11-01', words: '', missing });

describe('At risk model', () => {
  it('says the habit and the time away in words', () => {
    expect(habit(1)).toBe('every day');
    expect(habit(2)).toBe('every 2 days');
    expect(habit(1.5)).toBe('every 1.5 days');
    expect(ago(0)).toBe('today');
    expect(ago(1)).toBe('1 day ago');
    expect(ago(9)).toBe('9 days ago');
    expect(stateWord('slipping')).toBe('Slipping');
  });

  it('builds the Players address for a whole group', () => {
    expect(groupSearch('slipping')).toEqual({ chip: '{"kind":"churn_risk","value":"slipping"}' });
  });

  it('says what a player skipped, once per fact at the foot of the list', () => {
    expect(skipped(player('Tutorial · Completed'))).toBe('Skipped “Tutorial · Completed” on day one');
    expect(skipped(player())).toBeNull();
    expect(earlyWords({ human: 'Tutorial · Completed', with_rate: 0.46, without_rate: 0.13 })).toBe('“Tutorial · Completed” on day one: 46% of players who had it came back on day 7, 13% of the rest.');
  });
});
