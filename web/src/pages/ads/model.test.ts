import { describe, expect, it } from 'vitest';
import { money, share, words } from './model';

describe('Ads page model', () => {
  it('names formats and placements in words', () => {
    expect(words('AppOpen')).toBe('App open');
    expect(words('level_complete_x2')).toBe('Level complete x2');
    expect(words(null)).toBe('Not named');
  });

  it('writes money with two decimals and shares with one, and a dash for nothing', () => {
    expect(money(588.728)).toBe('$588.73');
    expect(money(null)).toBe('—');
    expect(share(0.7864)).toBe('78.6%');
    expect(share(null)).toBe('—');
  });
});
