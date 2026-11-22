import { describe, expect, it } from 'vitest';
import type { PerformanceBlock, PerformanceFinding, PerformanceReport, PerformanceRow } from '@/lib/types';
import { few, firstDimension, flagged, flaggedGroups, hasAds, hasExits, missing, topFindings, usable, valueName } from './model';

const row = (over: Partial<PerformanceRow> = {}): PerformanceRow => ({ value: 'x', players: 1, launches: 0, exit_total: 0, exit_bad: 0, bad_exit_rate: null, ad_total: 0, ad_bad: 0, ad_failure_rate: null, flags: [], ...over });
const block = (label: string, available: boolean): PerformanceBlock => ({ label, available, unknown_players: 0, groups: 1, rows: [] });
const finding = (dimension: PerformanceFinding['dimension'], value: string, measure: PerformanceFinding['measure'] = 'bad_exits'): PerformanceFinding => ({ dimension, label: dimension, value, measure, rate: 0.3, rest: 0.05, count: 9, total: 30, words: '', players: 5, same_as: [] });
const report = (findings: PerformanceFinding[], available: string[]): Extract<PerformanceReport, { available: true }> => ({
  available: true, summary: '', min_sample: 50, everyone: { players: 0, launches: 0, exit_total: 0, exit_bad: 0, ad_total: 0, ad_bad: 0 }, findings,
  dimensions: { country: block('Country', available.includes('country')), device_tier: block('Device tier', available.includes('device_tier')), ram_band: block('RAM', available.includes('ram_band')), os_version: block('OS version', available.includes('os_version')), device_model: block('Device model', available.includes('device_model')) },
});

describe('Performance model', () => {
  it('lists only dimensions with named groups, in a fixed order, and names the rest once', () => {
    const data = report([], ['device_model', 'country']);
    expect(usable(data)).toEqual(['country', 'device_model']);
    expect(missing(data)).toEqual(['Device tier', 'RAM', 'OS version']);
  });

  it('keeps a measure column only when some group has data for it', () => {
    expect(hasExits([row(), row({ exit_total: 3 })])).toBe(true);
    expect(hasAds([row(), row()])).toBe(false);
  });

  it('knows which measure a row is flagged on', () => {
    const flaggedRow = row({ flags: [{ measure: 'ad_failures', rate: 0.4, rest: 0.1, count: 8, total: 20, words: '' }] });
    expect(flagged(flaggedRow, 'ad_failures')).toBe(true);
    expect(flagged(flaggedRow, 'bad_exits')).toBe(false);
  });

  it('opens on the dimension of the biggest finding, else the first with data', () => {
    expect(firstDimension(report([finding('os_version', 'Android 12')], ['country', 'os_version']))).toBe('os_version');
    expect(firstDimension(report([], ['device_tier', 'os_version']))).toBe('device_tier');
    expect(firstDimension(report([finding('ram_band', 'under 3 GB')], ['country']))).toBe('country');
  });

  it('shows each group once, worst first, with a sentence per measure, up to the limit', () => {
    const list = [{ ...finding('device_tier', 'low'), words: 'a', same_as: ['RAM under 3 GB'] }, { ...finding('device_tier', 'low', 'ad_failures'), words: 'b', same_as: ['RAM under 3 GB', 'Country IN'] }, finding('country', 'IN'), finding('os_version', 'Android 12')];
    const groups = topFindings(list, 3);
    expect(groups.map((item) => item.key)).toEqual(['device_tier:low', 'country:IN', 'os_version:Android 12']);
    expect(groups[0]?.sentences).toEqual(['a', 'b']);
    expect(groups[0]?.same_as).toEqual(['RAM under 3 GB', 'Country IN']);
    expect(topFindings(list, 1)).toHaveLength(1);
  });

  it('counts the red groups across every way of cutting players up', () => {
    const data = report([], ['country', 'device_tier']);
    data.dimensions.country.rows = [row({ flags: [{ measure: 'bad_exits', rate: 0.3, rest: 0.05, count: 9, total: 30, words: '' }] }), row()];
    data.dimensions.device_tier.rows = [row({ flags: [{ measure: 'ad_failures', rate: 0.3, rest: 0.05, count: 9, total: 30, words: '' }] })];
    expect(flaggedGroups(data)).toBe(2);
  });

  it('names a country by its name, anything else as sent, and calls a small sample few', () => {
    expect(valueName('country', 'IN')).toContain('(IN)');
    expect(valueName('country', 'unknown')).toBe('unknown');
    expect(valueName('device_model', 'Pixel 8')).toBe('Pixel 8');
    expect(few(26, 50)).toBe(true);
    expect(few(0, 50)).toBe(false);
    expect(few(50, 50)).toBe(false);
  });
});
