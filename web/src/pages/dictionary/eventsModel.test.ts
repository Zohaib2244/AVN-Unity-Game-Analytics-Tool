import { describe, expect, it } from 'vitest';
import type { DictionaryEvent } from '@/lib/types';
import { cleanEventsView, needsAttention, nextUndescribed, visibleEvents } from './eventsModel';

const event = (name: string, over: Partial<DictionaryEvent> = {}): DictionaryEvent => ({
  name, described: true, defined: true, sdk: false, status: 'active', similar: [], series: [], params_seen: 0, params_missing: [], type_conflicts: [],
  definition: { description: '', params: {}, labels: '', hidden: false, canonical: [] },
  ever: { events: 10, players: 3, first_seen: '2026-10-01T00:00:00Z', last_seen: '2026-10-20T00:00:00Z' },
  range: { events: 10, players: 3 }, ...over,
});

describe('events list', () => {
  it('flags events that are sent but undescribed, with undescribed parameters, or with a changing type', () => {
    expect(needsAttention(event('a'))).toBe(false);
    expect(needsAttention(event('b', { described: false, defined: false }))).toBe(true);
    expect(needsAttention(event('c', { described: false, sdk: true }))).toBe(false);
    expect(needsAttention(event('d', { params_missing: ['LEVEL'] }))).toBe(true);
    expect(needsAttention(event('e', { type_conflicts: ['LEVEL'] }))).toBe(true);
  });
  it('filters by chip, searches name and description, and sorts', () => {
    const list = [event('level_failed', { range: { events: 5, players: 2 }, definition: { description: 'Player lost', params: {}, labels: '', hidden: false, canonical: [] } }), event('ad_shown', { range: { events: 50, players: 9 }, described: false }), event('quiet', { status: 'stale', range: { events: 0, players: 0 } })];
    expect(visibleEvents(list, 'all', 'sent', '').map((item) => item.name)).toEqual(['ad_shown', 'level_failed', 'quiet']);
    expect(visibleEvents(list, 'undescribed', 'sent', '').map((item) => item.name)).toEqual(['ad_shown']);
    expect(visibleEvents(list, 'quiet', 'name', '').map((item) => item.name)).toEqual(['quiet']);
    expect(visibleEvents(list, 'all', 'name', 'LOST').map((item) => item.name)).toEqual(['level_failed']);
  });
  it('finds the next event without a description, wrapping round', () => {
    const list = [event('a', { described: false }), event('b'), event('c', { described: false })];
    expect(nextUndescribed(list, 'a')).toBe('c');
    expect(nextUndescribed(list, 'c')).toBe('a');
    expect(nextUndescribed([event('a'), event('b')], 'a')).toBeNull();
  });
  it('falls back to the defaults for a bad saved view', () => {
    expect(cleanEventsView({ filter: 'attention', sort: 'players' })).toEqual({ filter: 'attention', sort: 'players' });
    expect(cleanEventsView({ filter: 'drafts', sort: 5 })).toEqual({ filter: 'all', sort: 'sent' });
  });
});
