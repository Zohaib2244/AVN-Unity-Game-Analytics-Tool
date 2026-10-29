// The raw timeline's pure helpers, checked against the old player timeline (insights.js renderRawEvents,
// conditions.js, player-events.js): sessions and gaps, value chips, session summaries, folding, presets.
import { describe, expect, it } from 'vitest';
import { highlightMatches } from '@/lib/conditions';
import type { JourneyEvent } from '@/lib/types';
import {
  buildCatalog, chipTitle, chipValue, defaultParamState, foldRuns, highlightSummary, HIGHLIGHT_PRESETS, matchesFilter, newHighlight, parameterChooser,
  presetHighlight, repeatKey, sessionHasEvent, sessionLevels, sessionSeconds, sessionStartSummary, timelineSessions,
} from './timeline';

const ev = (name: string, session: string, client_ts: string, params: Record<string, unknown> = {}, level: number | null = null, event_id = `${name}-${client_ts}`): JourneyEvent => ({ event_id, name, session_id: session, client_ts, level, params });

describe('timelineSessions', () => {
  it('groups runs of one session_id in order and numbers them from 0', () => {
    const sessions = timelineSessions([
      ev('a', 's1', '2026-01-01T10:00:00Z'),
      ev('b', 's1', '2026-01-01T10:00:30Z'),
      ev('c', 's2', '2026-01-01T12:00:00Z'),
    ]);
    expect(sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(sessions[0]!.items.map((i) => i.session)).toEqual([0, 0]);
    expect(sessions[1]!.items[0]!.session).toBe(1);
  });

  it('gives each event its gap in seconds from the previous event, and null for the first', () => {
    const sessions = timelineSessions([ev('a', 's1', '2026-01-01T10:00:00Z'), ev('b', 's1', '2026-01-01T10:00:30Z'), ev('c', 's2', '2026-01-01T12:00:30Z')]);
    expect(sessions.flatMap((s) => s.items).map((i) => i.gap)).toEqual([null, 30, 7200]);
    expect(sessions.flatMap((s) => s.items).map((i) => i.index)).toEqual([0, 1, 2]);
  });

  it('keeps a session that comes back later as a new session', () => {
    const sessions = timelineSessions([ev('a', 's1', '2026-01-01T10:00:00Z'), ev('b', 's2', '2026-01-01T11:00:00Z'), ev('c', 's1', '2026-01-01T12:00:00Z')]);
    expect(sessions).toHaveLength(3);
  });

  it('computes the length of a session in seconds', () => {
    const [session] = timelineSessions([ev('a', 's1', '2026-01-01T10:00:00Z'), ev('b', 's1', '2026-01-01T10:02:00Z')]);
    expect(sessionSeconds(session!)).toBe(120);
  });
});

describe('sessionLevels', () => {
  it('reads one level, a range of levels, or none', () => {
    const level = (values: Array<number | null>) => timelineSessions(values.map((value, i) => ev('x', 's', `2026-01-01T10:00:0${i}Z`, {}, value)))[0]!;
    expect(sessionLevels(level([2, 2]))).toBe('level 2');
    expect(sessionLevels(level([1, null, 4]))).toBe('levels 1–4');
    expect(sessionLevels(level([null, null]))).toBe('no levels');
  });
});

describe('chipValue and chipTitle', () => {
  it('reads long decimals as two decimals and leaves strings, IDs and integers alone', () => {
    expect(chipValue(6.9673786)).toBe('6.97');
    expect(chipValue(12)).toBe('12');
    expect(chipValue('abc-123')).toBe('abc-123');
    expect(chipValue({ a: 1 })).toBe('{"a":1}');
  });

  it('shows the exact value in the tooltip', () => {
    expect(chipTitle(6.9673786)).toBe('6.9673786');
    expect(chipTitle([1, 2])).toBe('[1,2]');
  });
});

describe('sessionStartSummary', () => {
  it('reads the session_start line: session, device, system, environment, matched without case', () => {
    expect(sessionStartSummary({ session_number: 3, Device_Model: 'Pixel 7', os_version: 'Android OS 13 / API-33 (TQ3A)', environment: 'production' })).toBe('Session 3 · Pixel 7 · Android OS 13 · production');
  });

  it('falls back to "Session details" when nothing is known', () => {
    expect(sessionStartSummary({})).toBe('Session details');
  });
});

describe('foldRuns', () => {
  it('folds three or more identical neighbours into one run row', () => {
    const rows = foldRuns(['a', 'a', 'a', 'b'], (item) => item);
    expect(rows).toEqual([{ items: ['a', 'a', 'a'], run: true }, { items: ['b'], run: false }]);
  });

  it('keeps pairs as separate rows and never folds a null key', () => {
    expect(foldRuns(['a', 'a'], (item) => item).map((row) => row.items.length)).toEqual([1, 1]);
    expect(foldRuns(['a', 'a', 'a'], () => null).every((row) => !row.run)).toBe(true);
  });

  it('starts a new run when the key changes', () => {
    const rows = foldRuns(['a', 'a', 'a', 'b', 'b', 'b'], (item) => item);
    expect(rows.map((row) => row.run)).toEqual([true, true]);
  });
});

describe('repeatKey', () => {
  it('ignores hidden parameters unless every parameter is shown', () => {
    const event = ev('TICK', 's', '2026-01-01T10:00:00Z', { seq: 1, Level: 2 });
    expect(repeatKey(event, new Set(['seq']), false)).toBe('TICK|[["Level",2]]');
    expect(repeatKey(event, new Set(['seq']), true)).toBe('TICK|[["seq",1],["Level",2]]');
  });
});

describe('parameterChooser', () => {
  it('lists every parameter once, sorted, with the count of events that carry it and the hidden ones too', () => {
    const events = [ev('a', 's', '2026-01-01T10:00:00Z', { Level: 1, type: 'x' }), ev('b', 's', '2026-01-01T10:00:01Z', { level: 2 })];
    const chooser = parameterChooser(events, ['seq']);
    expect(chooser.map((p) => p.name)).toEqual(['level', 'seq', 'type']);
    expect(chooser[0]).toEqual({ name: 'level', key: 'level', count: 2 });
    expect(chooser[1]).toEqual({ name: 'seq', key: 'seq', count: 0 });
  });
});

describe('matchesFilter', () => {
  it('matches the event name or a parameter, without case, and trims the query', () => {
    const event = ev('AD_ANALYSIS', 's', '2026-01-01T10:00:00Z', { AD_TYPE: 'interstitial' });
    expect(matchesFilter(event, '  ad_analysis ')).toBe(true);
    expect(matchesFilter(event, 'INTERSTITIAL')).toBe(true);
    expect(matchesFilter(event, 'rewarded')).toBe(false);
    expect(matchesFilter(event, '   ')).toBe(true);
  });
});

describe('highlights', () => {
  it('offers levels as started, completed and failed, and ads by kind', () => {
    expect(HIGHLIGHT_PRESETS.map((p) => [p.key, p.group])).toEqual([
      ['level-started', 'Levels'], ['level-completed', 'Levels'], ['level-failed', 'Levels'],
      ['ad-interstitial', 'Ads'], ['ad-rewarded', 'Ads'], ['ad-app-open', 'Ads'],
      ['screens', 'Other'], ['economy', 'Other'], ['tutorial', 'Other'],
    ]);
  });

  it('a new highlight takes the next colour and the first event name', () => {
    const rule = newHighlight(6, 'LEVEL_START');
    expect(rule.label).toBe('Highlight 7');
    expect(rule.color).toBe('orange');
    expect(rule.conditions.conditions[0]).toEqual({ field: 'event', param: '', op: 'eq', value: 'LEVEL_START' });
  });

  const preset = (key: string) => HIGHLIGHT_PRESETS.find((item) => item.key === key)!;
  const played = [
    ev('LEVEL_ANALYSIS', 's1', '2026-01-01T10:00:00Z', { LEVEL_NUMBER: 1, STATE: 'Started' }, 1),
    ev('LEVEL_ANALYSIS', 's1', '2026-01-01T10:00:20Z', { LEVEL_NUMBER: 1, STATE: 'Completed' }, 1),
    ev('LEVEL_ANALYSIS', 's1', '2026-01-01T10:00:21Z', { ACTION: 'Next', STATE: 'Choice' }, 1),
    ev('AD_ANALYSIS', 's1', '2026-01-01T10:00:30Z', { AD_TYPE: 'interstitial', STAGE: 'shown' }),
    ev('AD_ANALYSIS', 's2', '2026-01-01T11:00:00Z', { AD_TYPE: 'rewarded', STAGE: 'shown' }),
  ];

  it('a level preset takes only the started, completed or failed events, not every level event', () => {
    const catalog = buildCatalog(played);
    const started = presetHighlight(preset('level-started'), catalog)!;
    expect(started).toMatchObject({ label: 'Level started', enabled: true });
    expect(played.filter((event) => highlightMatches(event, started)).map((event) => event.params.STATE)).toEqual(['Started']);
    const completed = presetHighlight(preset('level-completed'), catalog)!;
    expect(played.filter((event) => highlightMatches(event, completed)).map((event) => event.params.STATE)).toEqual(['Completed']);
    expect(highlightMatches(played[2]!, started)).toBe(false);
  });

  it('ads split into interstitial, rewarded and app open by their type', () => {
    const catalog = buildCatalog(played);
    const inter = presetHighlight(preset('ad-interstitial'), catalog)!;
    const rewarded = presetHighlight(preset('ad-rewarded'), catalog)!;
    expect(played.filter((event) => highlightMatches(event, inter)).map((event) => event.params.AD_TYPE)).toEqual(['interstitial']);
    expect(played.filter((event) => highlightMatches(event, rewarded)).map((event) => event.params.AD_TYPE)).toEqual(['rewarded']);
  });

  it('a preset is not offered when the player has none of it', () => {
    const catalog = buildCatalog(played);
    expect(presetHighlight(preset('level-failed'), catalog)).toBeNull();
    expect(presetHighlight(preset('ad-app-open'), catalog)).toBeNull();
    expect(presetHighlight(preset('economy'), catalog)).toBeNull();
    expect(presetHighlight(preset('screens'), buildCatalog([ev('SCREEN_OPEN', 's', '2026-01-01T10:00:00Z')]))).toMatchObject({ label: 'Screens' });
  });

  it('counts a highlight over the scoped events, its sessions and the share', () => {
    const all = timelineSessions(played).flatMap((s) => s.items);
    const rule = presetHighlight(preset('ad-interstitial'), buildCatalog(played))!;
    const rewarded = presetHighlight(preset('ad-rewarded'), buildCatalog(played))!;
    expect(highlightSummary(all, rule)).toEqual({ hits: 1, inSessions: 1, share: 20 });
    expect(highlightSummary(all.slice(0, 4), rewarded)).toEqual({ hits: 0, inSessions: 0, share: 0 });
  });

  it('knows which session holds the focused event', () => {
    const [session] = timelineSessions([ev('a', 's1', '2026-01-01T10:00:00Z', {}, null, 'focus-me')]);
    expect(sessionHasEvent(session!, 'focus-me')).toBe(true);
    expect(sessionHasEvent(session!, 'other')).toBe(false);
  });
});

describe('buildCatalog', () => {
  it('collects event names and up to 100 distinct values per parameter, as text', () => {
    const many = Array.from({ length: 150 }, (_, i) => ev('SHOW', 's', '2026-01-01T10:00:00Z', { n: i }));
    const catalog = buildCatalog([...many, ev('OTHER', 's', '2026-01-01T10:00:00Z', { type: 'x' })]);
    expect(catalog.events.map((e) => e.name)).toEqual(['SHOW', 'OTHER']);
    expect(catalog.events[0]!.params[0]!.values).toHaveLength(100);
    expect(catalog.events[0]!.params[0]!.values[0]).toBe('0');
  });
});

describe('defaults', () => {
  it('hides seq and attempt_id, shows clean noise, does not group, as the old timeline did', () => {
    expect(defaultParamState()).toEqual({ hidden: ['seq', 'attempt_id'], showAll: false, group: false });
  });
});
