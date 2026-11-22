import { describe, expect, it } from 'vitest';
import type { SeparatorFinding } from '@/lib/types';
import { chipSearch, outcomeNoun, windowFor, windowsFor } from './model';

const finding = (chip?: Record<string, unknown>): SeparatorFinding => ({ kind: 'event', label: 'x', words: '', points: 10, interval: [1, 2], with: { reached: 1, players: 2, rate: 0.5 }, without: { reached: 1, players: 2, rate: 0.5 }, chip });

describe('Who stays model', () => {
  it('only offers as many days of play as come before the outcome', () => {
    expect(windowsFor('day_1')).toEqual([1]);
    expect(windowsFor('day_3')).toEqual([1, 2, 3]);
    expect(windowsFor('pays')).toEqual([1, 2, 3]);
  });

  it('keeps the chosen window when it still fits, else the longest that does', () => {
    expect(windowFor('day_7', 2)).toBe(2);
    expect(windowFor('day_1', 3)).toBe(1);
  });

  it('turns a finding with a chip into a Players address and one without into nothing', () => {
    expect(chipSearch(finding({ kind: 'event', event: 'X' }))).toEqual({ chip: '{"kind":"event","event":"X"}' });
    expect(chipSearch(finding())).toBeNull();
  });

  it('names the outcome in words', () => {
    expect(outcomeNoun('day_7')).toBe('Came back on day 7');
    expect(outcomeNoun('pays')).toBe('Paid');
  });
});
