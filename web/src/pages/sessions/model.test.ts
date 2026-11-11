import { describe, expect, it } from 'vitest';
import { adLabel, importanceLabel, reasonLabel, share, trendValues } from './model';

describe('sessions page words', () => {
  it('never reads a missing ad field as no ad', () => {
    expect(adLabel('None')).toBe('No ad open');
    expect(adLabel('unknown')).toBe('Unknown');
    expect(adLabel('Interstitial')).toBe('Interstitial');
  });
  it('explains exit reasons, keeping ones it has not met', () => {
    expect(reasonLabel('UserRequested')).toBe('Swiped away or force-stopped');
    expect(reasonLabel('NewReason')).toBe('NewReason');
    expect(importanceLabel(null)).toBe('—');
  });
  it('has no share of nothing', () => {
    expect(share(1, 0)).toBe('—');
    expect(share(1, 4)).toBe('25.0%'); // one decimal always, so a column of shares lines up
  });
  it('draws a day with no finished session as empty', () => {
    const days = [{ day: '2026-10-01', sessions: 2, average_seconds: null, median_seconds: null }, { day: '2026-10-02', sessions: 1, average_seconds: 30, median_seconds: 30 }];
    expect(trendValues({ days }, 'median_seconds')).toEqual({ '2026-10-01': 0, '2026-10-02': 30 });
    expect(trendValues({ days }, 'sessions')).toEqual({ '2026-10-01': 2, '2026-10-02': 1 });
  });
});
