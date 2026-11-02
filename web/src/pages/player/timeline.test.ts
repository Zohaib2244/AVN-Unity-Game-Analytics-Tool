// The raw timeline's pure helpers, checked against the old player timeline (insights.js renderRawEvents,
// conditions.js, player-events.js): sessions and gaps, value chips, session summaries, folding, presets.
import { describe, expect, it } from 'vitest';
import { highlightMatches } from '@/lib/conditions';
import type { JourneyEvent, SessionSummary } from '@/lib/types';
import {
  buildCatalog, chipTitle, chipValue, defaultParamState, eventNote, foldRuns, highlightSummary, HIGHLIGHT_PRESETS, matchesFilter, narrowedHighlight, newHighlight, parameterGroups, pickableParams, picksSummary,
  presetHighlight, repeatKey, sessionEnding, sessionHasEvent, sessionLength, sessionLevels, sessionSeconds, sessionStartSummary, timelineSessions,
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
    expect(sessionLevels(level([2, 2]))).toBe('Level 2');
    expect(sessionLevels(level([1, null, 4]))).toBe('Levels 1–4');
    expect(sessionLevels(level([null, null]))).toBe('No level played');
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

describe('parameterGroups', () => {
  it('lists parameters under the event that carries them, and hidden ones nothing carries last', () => {
    const events = [ev('Level_Started', 's', '2026-01-01T10:00:00Z', { LEVEL: 1, type: 'x' }), ev('Ad_Shown', 's', '2026-01-01T10:00:01Z', { level: 2 }), ev('Level_Started', 's', '2026-01-01T10:00:02Z', { LEVEL: 2 })];
    const groups = parameterGroups(events, ['seq', 'type']);
    expect(groups.map((group) => group.event)).toEqual(['Ad_Shown', 'Level_Started', null]);
    expect(groups[1]!.params).toEqual([{ name: 'level', key: 'LEVEL', count: 2 }, { name: 'type', key: 'type', count: 1 }]);
    expect(groups[2]!.params.map((param) => param.name)).toEqual(['seq']);
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

describe('how a session reads', () => {
  const state = (over: Partial<SessionSummary> = {}): SessionSummary => ({ started_at: '', last_event_at: '', status: 'closed', closed_by: 'client', end_reason: 'background', in_progress: false, seconds: 120, away_seconds: 30, trips: 1, timeout_seconds: 1800, measured_old_way: false, ...over });
  const at = (second: number, name: string, params: Record<string, unknown>) => ({ event_id: `${second}`, name, session_id: 's', client_ts: new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString(), params });
  const session = timelineSessions([at(0, 'session_end', { end_reason: 'background' }), at(1, 'APP_ANALYSIS', { STATE: 'Foreground', CAUSE: 'Ad', AWAY_SECONDS: 30 }), at(2, 'session_end', { end_reason: 'background' })])[0]!;

  it('has one ending, whatever ended it', () => {
    expect(sessionEnding(state())).toBe('Left the app');
    expect(sessionEnding(state({ end_reason: 'quit' }))).toBe('Closed by the app');
    expect(sessionEnding(state({ end_reason: 'recovered' }))).toBe('Recovered at next launch');
    expect(sessionEnding(state({ end_reason: 'inferred' }))).toBe('Closed by the server, no end received');
    expect(sessionEnding(state({ status: 'open', end_reason: null, in_progress: true }))).toBe('In progress');
    expect(sessionEnding(state({ status: 'open', end_reason: null }))).toBe('May come back');
    expect(sessionEnding(undefined)).toBeNull();
  });

  it('labels every background end but the one that ended the session', () => {
    expect(eventNote(session.items[0]!, session, state())).toBe('Provisional end');
    expect(eventNote(session.items[2]!, session, state())).toBe('Session end');
    expect(eventNote(session.items[2]!, session, state({ status: 'open', end_reason: null }))).toBe('Provisional end');
    expect(eventNote(session.items[2]!, session, state({ end_reason: 'inferred' }))).toBe('Provisional end');
  });

  it('shows a return as time away, with its cause', () => {
    expect(eventNote(session.items[1]!, session, state())).toBe('Away 30s · Ad');
    expect(eventNote(session.items[1]!, session, state({ timeout_seconds: 10 }))).toBe('Away 30s · Ad · new session');
  });

  it('never shows a zero length', () => {
    expect(sessionLength(session, state({ seconds: 0 }))).toBeNull();
    expect(sessionLength(session, state())).toBe(120);
    expect(sessionLength(session)).toBe(2);
  });
});

describe('narrowing a ready-made highlight to picked values', () => {
  const ad = (STATE: string, FORMAT: string, PLACEMENT: string, id: string) => ev('AD_ANALYSIS', 's', '2026-01-01T10:00:00Z', { STATE, FORMAT, PLACEMENT, AD_ID: id, SECONDS_ON_SCREEN: 4.25 });
  const ads = [ad('Show', 'Interstitial', 'level_end', 'a'), ad('Closed', 'Interstitial', 'level_end', 'a'), ad('Show', 'Interstitial', 'home', 'b'), ad('Failed', 'Interstitial', 'home', 'c'), ad('Show', 'Rewarded', 'revive', 'd')];
  const inter = presetHighlight(HIGHLIGHT_PRESETS.find((item) => item.key === 'ad-interstitial')!, buildCatalog(ads))!;
  const marked = (picks: Record<string, string[]>) => ads.filter((event) => highlightMatches(event, narrowedHighlight(inter, picks))).length;

  it('reads the ad type from FORMAT, as the standard sends it', () => {
    expect(ads.filter((event) => highlightMatches(event, inter))).toHaveLength(4);
    expect(presetHighlight(HIGHLIGHT_PRESETS.find((item) => item.key === 'ad-app-open')!, buildCatalog(ads))).toBeNull();
  });

  it('takes any picked value of a parameter, and all the parameters picked', () => {
    expect(marked({})).toBe(4);
    expect(marked({ STATE: ['Show'] })).toBe(2);
    expect(marked({ STATE: ['Show', 'Closed'] })).toBe(3);
    expect(marked({ STATE: ['Show', 'Closed'], PLACEMENT: ['home'] })).toBe(1);
    expect(marked({ STATE: [] })).toBe(4);
  });

  it('adds nothing and remembers nothing when no value is picked', () => {
    expect(narrowedHighlight(inter, { STATE: [] })).toEqual({ ...inter, picks: undefined });
    expect(narrowedHighlight(inter, { STATE: ['Show'] }).picks).toEqual({ STATE: ['Show'] });
  });

  it('offers the values of what the highlight marks, not of IDs, measurements or what is already fixed', () => {
    const params = pickableParams(ads, inter, {});
    expect(params.map((param) => param.key).sort()).toEqual(['PLACEMENT', 'STATE']);
    expect(params.find((param) => param.key === 'STATE')!.values).toEqual([{ value: 'Show', count: 2 }, { value: 'Closed', count: 1 }, { value: 'Failed', count: 1 }]);
  });

  it('counts a value given the other picks, keeping a picked value that has none left', () => {
    const params = pickableParams(ads, inter, { PLACEMENT: ['home'], STATE: ['Closed'] });
    const state = params.find((param) => param.key === 'STATE')!;
    expect(state.values).toContainEqual({ value: 'Closed', count: 0 });
    expect(state.values).toContainEqual({ value: 'Show', count: 1 });
  });

  it('keeps level numbers, in order, though each appears once', () => {
    const levels = [3, 1, 2, 4, 5, 6, 7].map((level) => ev('LEVEL_ANALYSIS', 's', '2026-01-01T10:00:00Z', { STATE: 'Completed', LEVEL_NUMBER: level }));
    const done = presetHighlight(HIGHLIGHT_PRESETS.find((item) => item.key === 'level-completed')!, buildCatalog(levels))!;
    expect(pickableParams(levels, done, {})[0]!.values.map((item) => item.value)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('says on the chip what it is narrowed to', () => {
    expect(picksSummary(undefined)).toBe('');
    expect(picksSummary({ STATE: ['Show', 'Closed'] })).toBe('Show, Closed');
    expect(picksSummary({ STATE: ['Show', 'Closed'], PLACEMENT: ['home', 'revive'] })).toBe('Show, Closed +2');
  });
});
