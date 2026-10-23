import { describe, expect, it } from 'vitest';
import type { PlayerRow } from '@/lib/types';
import { metricLabel, metricValue, orderLabel, playerComparator, ruleSubject, rulesBody, usableRules, validSort, versionKey } from './rules';

describe('ruleSubject', () => {
  it('names the event, the parameter test when there is one', () => {
    expect(ruleSubject({ event: 'level_start', param: '', op: 'eq', value: '' })).toBe('level_start');
    expect(ruleSubject({ event: 'level_start', param: 'level', op: 'gte', value: '12' })).toBe('level_start · level ≥ 12');
    expect(ruleSubject({ event: 'purchase', param: 'sku', op: 'exists', value: 'x' })).toBe('purchase · sku');
  });
});

describe('metricLabel', () => {
  it('keeps a given label', () => expect(metricLabel({ event: 'a', param: '', op: 'eq', value: '', agg: 'sum', label: 'Spend' })).toBe('Spend'));
  it('says Highest / Lowest / Total of the parameter', () => {
    expect(metricLabel({ event: 'purchase', param: '', op: 'eq', value: '', agg: 'sum', of: 'price' })).toBe('Total price · purchase');
    expect(metricLabel({ event: 'level_end', param: 'score', op: 'exists', value: '', agg: 'max' })).toBe('Highest score · level_end');
    expect(metricLabel({ event: 'level_end', param: '', op: 'eq', value: '', agg: 'min' })).toBe('Lowest ? · level_end');
  });
  it('counts and first/last times read as "Times: …"', () => {
    expect(metricLabel({ event: 'ad_shown', param: '', op: 'eq', value: '' })).toBe('Times: ad_shown');
    expect(metricLabel({ event: 'ad_shown', param: 'format', op: 'eq', value: 'rewarded', agg: 'first' })).toBe('First time: ad_shown · format = rewarded');
    expect(metricLabel({ event: 'ad_shown', param: '', op: 'eq', value: '', agg: 'last' })).toBe('Last time: ad_shown');
  });
});

describe('metricValue', () => {
  const count = { event: 'a', param: '', op: 'eq', value: '', agg: 'count' as const };
  const last = { ...count, agg: 'last' as const };
  it('shows a dash for nothing', () => { expect(metricValue(count, null)).toBe('—'); expect(metricValue(last, undefined)).toBe('—'); });
  it('formats numbers', () => expect(metricValue(count, 12345)).toBe(new Intl.NumberFormat().format(12345)));
  it('formats first / last as a date', () => expect(metricValue(last, '2024-05-01T10:00:00Z', 'utc')).toMatch(/2024/));
});

describe('usableRules', () => {
  it('drops rules without an event and private keys, normalises the test', () => {
    expect(usableRules([
      { event: '', param: 'x', op: 'eq', value: '1' },
      { event: 'a', param: '', op: 'gt', value: '3', does: 'did', _draft: true } as never,
      { event: 'b', param: 'p', op: '', value: '2' },
      { event: 'c', param: 'p', op: 'exists', value: 'ignored', min_times: 3 },
    ])).toEqual([
      { event: 'a', param: '', op: 'eq', value: '', does: 'did' },
      { event: 'b', param: 'p', op: 'eq', value: '2' },
      { event: 'c', param: 'p', op: 'exists', value: '', min_times: 3 },
    ]);
  });
  it('rulesBody fills the defaults the server expects', () => {
    expect(rulesBody({ conditions: [{ event: 'a', param: '', op: 'eq', value: '' }], metrics: [{ event: 'b', param: '', op: 'eq', value: '' }] }))
      .toEqual({ conditions: [{ event: 'a', param: '', op: 'eq', value: '', does: 'did', min_times: 1 }], metrics: [{ event: 'b', param: '', op: 'eq', value: '', agg: 'count' }] });
  });
});

describe('sort options', () => {
  const metrics = rulesBody({ conditions: [], metrics: [{ event: 'a', param: '', op: 'eq', value: '', agg: 'first' }] }).metrics;
  it('falls back to last active when the column is gone', () => { expect(validSort('metric0', metrics)).toBe('metric0'); expect(validSort('metric1', metrics)).toBe('last_seen'); });
  it('words the order by what is sorted', () => {
    expect(orderLabel('last_seen', 'desc', [])).toBe('Newest first');
    expect(orderLabel('events', 'asc', [])).toBe('Lowest first');
    expect(orderLabel('playtime', 'desc', [])).toBe('Longest first');
    expect(orderLabel('metric0', 'asc', metrics)).toBe('Oldest first');
  });
});

describe('playerComparator', () => {
  const row = (player: string, patch: Partial<PlayerRow>): PlayerRow => ({ player, events: 1, sessions: 1, avg_session_seconds: 10, total_play_seconds: 10, first_seen: '2024-01-01T00:00:00Z', last_seen: '2024-01-02T00:00:00Z', platform: null, app_version: null, country: null, environment: null, has_user_id: 0, metrics: [], ...patch });
  it('sorts by the key, empty values last, then last active newest first, then the ID', () => {
    const rows = [row('b', { events: 2 }), row('a', { events: 2 }), row('c', { events: 5 }), row('d', { avg_session_seconds: null, events: 9, last_seen: '2024-03-01T00:00:00Z' }), row('e', { events: 2, last_seen: '2024-02-01T00:00:00Z' })];
    expect([...rows].sort(playerComparator('events', 'desc')).map((r) => r.player)).toEqual(['d', 'c', 'e', 'a', 'b']);
    expect([...rows].sort(playerComparator('events', 'asc')).map((r) => r.player)).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect([...rows].sort(playerComparator('session_length', 'asc')).map((r) => r.player)).toEqual(['e', 'a', 'b', 'c', 'd']);
  });
  it('orders versions by their numbers and metric columns by position', () => {
    expect(versionKey('1.10.2')).toEqual([1, 10, 2]);
    const rows = [row('a', { app_version: '1.9', metrics: [3] }), row('b', { app_version: '1.10', metrics: [null] }), row('c', { app_version: null, metrics: [7] })];
    expect([...rows].sort(playerComparator('version', 'desc')).map((r) => r.player)).toEqual(['b', 'a', 'c']);
    expect([...rows].sort(playerComparator('metric0', 'desc')).map((r) => r.player)).toEqual(['c', 'a', 'b']);
  });
});
