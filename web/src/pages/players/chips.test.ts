import { describe, expect, it } from 'vitest';
import { blankChip, chipReady, chipWords, chipsFromSearch, groupParam, groupSummary, type Chip } from './chips';

describe('player group chips', () => {
  it('read as plain sentences', () => {
    expect(chipWords({ kind: 'campaign', values: ['D7 WW', 'HIT33'] })).toEqual(['came from', 'D7 WW or HIT33']);
    expect(chipWords({ kind: 'campaign', values: ['a', 'b', 'c', 'd'] })).toEqual(['came from', 'a, b or 2 more']);
    expect(chipWords({ kind: 'earned', min: 0.5, max: null })).toEqual(['earned', 'at least $0.50']);
    expect(chipWords({ kind: 'paid_back', min: 100, max: null })).toEqual(['paid back', 'at least 100% of their cost']);
    expect(chipWords({ kind: 'ad_format', values: ['Rewarded'] })).toEqual(['saw', 'a rewarded ad']);
    expect(chipWords({ kind: 'highest_level', min: 20, max: 40 })).toEqual(['reached level', '20 to 40']);
    expect(chipWords({ kind: 'last_seen', within_days: null, more_than_days: 3 })).toEqual(['not seen for', '3+ days']);
    expect(chipWords({ kind: 'event', event: 'SHOP', never: true })).toEqual(['never did', 'SHOP']);
  });

  it('only sends chips that say enough, without empty fields', () => {
    const chips: Chip[] = [blankChip('campaign'), { kind: 'campaign', values: ['C1'] }, blankChip('earned'), { kind: 'event', event: 'X', param: 'P', values: [] }];
    expect(chipReady(chips[0]!)).toBe(false);
    expect(chipReady(chips[3]!)).toBe(false);
    expect(JSON.parse(groupParam(chips))).toEqual([{ kind: 'campaign', values: ['C1'] }, { kind: 'earned', min: 0.5 }]);
    expect(groupParam([blankChip('campaign')])).toBe('');
  });

  it('summarises a group and turns "See these players" links into chips', () => {
    expect(groupSummary([{ kind: 'campaign', values: ['C1'] }, { kind: 'earned', min: 1, max: null }])).toBe('came from C1 · earned at least $1.00');
    expect(chipsFromSearch({ campaign: 'D7 WW' })).toEqual([{ kind: 'campaign', values: ['D7 WW'] }]);
    expect(chipsFromSearch({ install: 'paid' })).toEqual([{ kind: 'install_type', value: 'paid' }]);
    expect(chipsFromSearch({})).toEqual([]);
  });
});
