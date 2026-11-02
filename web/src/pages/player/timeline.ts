// Pure helpers for one player's raw timeline: sessions and gaps, parameter chips, noise rules, presets,
// highlight rules and the folding of repeated events. No React here, so the tests run on plain data.
import { type ConditionNode, conditionGroup, eventCondition, eventMatchesCondition, HIGHLIGHT_COLORS, highlightMatches, paramCondition } from '@/lib/conditions';
import type { TimelineHighlight, ValuePicks } from '@/lib/player-events';
import { duration } from '@/lib/format';
import type { JourneyEvent, SessionSummary } from '@/lib/types';

/**
 * The highlights worth one click, by what a game usually sends: an event-name pattern and, where the event
 * carries several kinds of thing, a parameter (name pattern) whose value (pattern) picks the kind. A preset is
 * offered only when this player's events contain it; colours are the highlight colours.
 */
const AD_KIND = /^format$|ad_?format|ad_?type|^type$/i; // the standard calls it FORMAT
export type HighlightPreset = { key: string; group: string; label: string; color: string; event: RegExp; param?: RegExp; value?: RegExp };
export const HIGHLIGHT_PRESETS: HighlightPreset[] = [
  { key: 'level-started', group: 'Levels', label: 'Level started', color: 'cyan', event: /^level/i, param: /^(state|stage|status|action)$/i, value: /^(start|started|begin|began)$/i },
  { key: 'level-completed', group: 'Levels', label: 'Level completed', color: 'green', event: /^level/i, param: /^(state|stage|status|action)$/i, value: /^(complete|completed|finish|finished|win|won|success)$/i },
  { key: 'level-failed', group: 'Levels', label: 'Level failed', color: 'pink', event: /^level/i, param: /^(state|stage|status|action)$/i, value: /^(fail|failed|lose|lost|defeat|defeated)$/i },
  { key: 'ad-interstitial', group: 'Ads', label: 'Interstitial ads', color: 'gold', event: /^ads?(_|$)/i, param: AD_KIND, value: /inter/i },
  { key: 'ad-rewarded', group: 'Ads', label: 'Rewarded ads', color: 'orange', event: /^ads?(_|$)/i, param: AD_KIND, value: /reward/i },
  { key: 'ad-app-open', group: 'Ads', label: 'App open ads', color: 'violet', event: /^ads?(_|$)/i, param: AD_KIND, value: /app_?open/i },
  { key: 'screens', group: 'Other', label: 'Screens', color: 'violet', event: /^screen/i },
  { key: 'economy', group: 'Other', label: 'Economy', color: 'gold', event: /^economy/i },
  { key: 'tutorial', group: 'Other', label: 'Tutorial', color: 'cyan', event: /^tutorial/i },
];
export const MAX_HIGHLIGHTS = 20;

/** Parameters you never read (random IDs, counters) are hidden by default; keys are matched case-insensitively. */
export const DEFAULT_HIDDEN_PARAMS = ['seq', 'attempt_id'];
export type ParamState = { hidden: string[]; showAll: boolean; group: boolean };
export const defaultParamState = (): ParamState => ({ hidden: [...DEFAULT_HIDDEN_PARAMS], showAll: false, group: false });

/** Long decimals (6.9673786) read as 2 decimals; the exact value stays in the tooltip. Strings, IDs and integers are untouched. */
export const chipValue = (value: unknown): string => (typeof value === 'number' && !Number.isInteger(value) ? String(Number(value.toFixed(2))) : typeof value === 'object' ? JSON.stringify(value) : String(value));
export const chipTitle = (value: unknown): string => (typeof value === 'object' ? JSON.stringify(value) : String(value));

/** "Session 1 · Pixel · Android OS 13": the one line a session_start folds into. */
export const sessionStartSummary = (params: Record<string, unknown>): string => {
  const pick = (key: string) => params[Object.keys(params).find((name) => name.toLowerCase() === key) ?? ''];
  const system = String(pick('os_version') ?? '').split(' / ')[0]!.split(' (')[0]!;
  return [pick('session_number') != null ? `Session ${pick('session_number')}` : '', pick('device_model'), system, pick('environment')].filter(Boolean).join(' · ') || 'Session details';
};

export type TimelineItem = JourneyEvent & { gap: number | null; index: number; session: number };
export type TimelineSession = { id: string; items: TimelineItem[] };

/** The sessions of a timeline, in order; a session is a run of events with the same session_id. The gap is seconds since the previous event. */
export function timelineSessions(events: JourneyEvent[]): TimelineSession[] {
  const sessions: TimelineSession[] = [];
  events.forEach((event, index) => {
    const previous = events[index - 1];
    const gap = previous ? (Date.parse(event.client_ts) - Date.parse(previous.client_ts)) / 1000 : null;
    if (!sessions.length || sessions[sessions.length - 1]!.id !== event.session_id) sessions.push({ id: event.session_id, items: [] });
    sessions[sessions.length - 1]!.items.push({ ...event, gap, index, session: sessions.length - 1 });
  });
  return sessions;
}

/** "Level 2", "Levels 1–4" or "No level played": the levels a session touched. */
export function sessionLevels(session: TimelineSession): string {
  const numbers = session.items.map((item) => item.level).filter((level): level is number => level != null);
  if (!numbers.length) return 'No level played';
  const low = Math.min(...numbers); const high = Math.max(...numbers);
  return low === high ? `Level ${low}` : `Levels ${low}–${high}`;
}

export const sessionSeconds = (session: TimelineSession): number => (Date.parse(session.items[session.items.length - 1]!.client_ts) - Date.parse(session.items[0]!.client_ts)) / 1000;

/** A session's length: the server's, else first to last event. Nothing to show when it is 0, never a "0s" session. */
export const sessionLength = (session: TimelineSession, state?: SessionSummary): number | null => {
  const seconds = state ? state.seconds : sessionSeconds(session);
  return seconds > 0 ? seconds : null;
};

const END_LABELS: Record<string, string> = { quit: 'Closed by the app', background: 'Left the app', recovered: 'Recovered at next launch', inferred: 'Closed by the server, no end received' };

/** The one end a session shows, however many session_end events it has. */
export const sessionEnding = (state?: SessionSummary): string | null => {
  if (!state) return null;
  if (state.status === 'open') return state.in_progress ? 'In progress' : 'May come back';
  return END_LABELS[state.end_reason ?? ''] ?? state.end_reason;
};

/** The word on a raw event that isn't what it seems: a background end that wasn't the session's, and a return with its time away. */
export function eventNote(item: TimelineItem, session: TimelineSession, state?: SessionSummary): string | null {
  if (item.name === 'session_end' && item.params.end_reason === 'background') {
    const last = session.items.filter((other) => other.name === 'session_end').pop();
    return item !== last || !state || state.status === 'open' || state.end_reason !== 'background' ? 'Provisional end' : 'Session end';
  }
  const away = item.params.AWAY_SECONDS;
  if (item.name !== 'APP_ANALYSIS' || item.params.STATE !== 'Foreground' || typeof away !== 'number') return null;
  const cause = item.params.CAUSE;
  const words = [`Away ${duration(away)}`, typeof cause === 'string' ? cause : ''];
  if (state && away > state.timeout_seconds) words.push('new session');
  return words.filter(Boolean).join(' · ');
}

export type Catalog = { events: Array<{ name: string; params: Array<{ key: string; values: string[] }> }> };
/** Every event name and up to 100 values per parameter, for the editors' suggestions. */
export function buildCatalog(events: JourneyEvent[]): Catalog {
  const byName = new Map<string, { name: string; params: Map<string, Set<string>> }>();
  events.forEach((event) => {
    if (!byName.has(event.name)) byName.set(event.name, { name: event.name, params: new Map() });
    const entry = byName.get(event.name)!;
    Object.entries(event.params).forEach(([key, value]) => { if (!entry.params.has(key)) entry.params.set(key, new Set()); if (entry.params.get(key)!.size < 100) entry.params.get(key)!.add(String(value)); });
  });
  return { events: [...byName.values()].map((event) => ({ name: event.name, params: [...event.params].map(([key, values]) => ({ key, values: [...values] })) })) };
}

/** The name a highlight shows: its label, or "Highlight n" when it has none. */
export const highlightName = (rule: { label?: string }, index: number): string => rule.label || `Highlight ${index + 1}`;

/** "+ Highlight": a new highlight on the first event name, colours in turn. */
export function newHighlight(count: number, firstEvent?: string): TimelineHighlight {
  return { label: `Highlight ${count + 1}`, color: HIGHLIGHT_COLORS[count % HIGHLIGHT_COLORS.length]![0], enabled: true, conditions: conditionGroup([eventCondition(firstEvent)]) };
}

/**
 * The highlight a preset makes for this player's events: its event names, and for a preset with a parameter
 * the values of that parameter that match, as the player's events spell them. Null when the player has
 * none of it (so it is not offered); a parameter the events never carry leaves the preset on the event alone.
 */
export function presetHighlight(preset: HighlightPreset, catalog: Catalog): TimelineHighlight | null {
  const events = catalog.events.filter((event) => preset.event.test(event.name));
  if (!events.length) return null;
  const names: ConditionNode[] = events.map((event) => eventCondition(event.name));
  const eventPart: ConditionNode = names.length === 1 ? names[0]! : { match: 'any', conditions: names };
  const tests: ConditionNode[] = [];
  if (preset.param && preset.value) {
    for (const event of events) {
      for (const param of event.params) {
        if (!preset.param.test(param.key)) continue;
        for (const value of param.values) if (preset.value.test(value)) tests.push({ ...paramCondition(param.key), value });
      }
    }
    const carriesParam = events.some((event) => event.params.some((param) => preset.param!.test(param.key)));
    if (carriesParam && !tests.length) return null;
  }
  const unique = tests.filter((test, index) => tests.findIndex((other) => JSON.stringify(other) === JSON.stringify(test)) === index);
  const conditions = unique.length ? [eventPart, unique.length === 1 ? unique[0]! : { match: 'any' as const, conditions: unique }] : [eventPart];
  return { label: preset.label, color: preset.color, enabled: true, conditions: { match: 'all', conditions } };
}

/** A ready-made highlight narrowed to picked values: any picked value of a parameter, and all the parameters picked. */
export function narrowedHighlight(base: TimelineHighlight, picks: ValuePicks): TimelineHighlight {
  const chosen = Object.entries(picks).filter(([, values]) => values.length);
  const tests = chosen.map(([key, values]): ConditionNode => {
    const nodes = values.map((value) => ({ ...paramCondition(key), value }));
    return nodes.length === 1 ? nodes[0]! : { match: 'any', conditions: nodes };
  });
  return { ...base, picks: chosen.length ? Object.fromEntries(chosen) : undefined, conditions: { ...base.conditions, conditions: [...base.conditions.conditions, ...tests] } };
}

const looksLikeAnId = (key: string, seen: Map<string, number>, occurrences: number): boolean => {
  if (/(^|_)id$/i.test(key) || DEFAULT_HIDDEN_PARAMS.includes(key.toLowerCase())) return true;
  if ([...seen.keys()].some((value) => value.length > 40)) return true;
  // A long run of values that never repeat is a measurement or an ID, unless it counts up (a level number).
  const counting = [...seen.keys()].every((value) => Number.isInteger(Number(value)));
  const decimals = [...seen.keys()].some((value) => !Number.isInteger(Number(value)) && Number.isFinite(Number(value)));
  return decimals || (!counting && seen.size >= 6 && seen.size === occurrences);
};

export type PickableParam = { key: string; values: Array<{ value: string; count: number }> };

/**
 * What a ready-made highlight can be narrowed by on this player: the parameters of the events it marks, with
 * their values and how many events each would leave given the other picks. A parameter with one value has nothing
 * to choose; IDs and measurements are left out. Picked values always stay, so they can be taken off again.
 */
export function pickableParams(events: JourneyEvent[], base: TimelineHighlight, picks: ValuePicks): PickableParam[] {
  const marked = events.filter((event) => eventMatchesCondition(event, base.conditions));
  const carried = new Map<string, number>();
  marked.forEach((event) => Object.keys(event.params).forEach((key) => carried.set(key, (carried.get(key) || 0) + 1)));
  const params = [...carried.keys()].flatMap((key) => {
    const { [key]: mine = [], ...others } = picks;
    const narrowed = narrowedHighlight(base, others).conditions;
    const seen = new Map<string, number>(mine.map((value) => [value, 0]));
    const all = new Set<string>();
    marked.forEach((event) => {
      if (!Object.hasOwn(event.params, key)) return;
      const value = String(event.params[key]);
      all.add(value);
      if (eventMatchesCondition(event, narrowed)) seen.set(value, (seen.get(value) || 0) + 1);
    });
    if (all.size < 2 || looksLikeAnId(key, seen, carried.get(key)!)) return [];
    const numeric = [...seen.keys()].every((value) => Number.isFinite(Number(value)));
    const values = [...seen].map(([value, count]) => ({ value, count })).sort((a, b) => (numeric ? Number(a.value) - Number(b.value) : b.count - a.count || (a.value < b.value ? -1 : 1)));
    return [{ key, values }];
  });
  return params.sort((a, b) => carried.get(b.key)! - carried.get(a.key)! || (a.key < b.key ? -1 : 1));
}

/** "Show, Closed" or "Show, Closed +2": the picks of a highlight, on its chip, so nothing narrows it unseen. */
export const picksSummary = (picks: ValuePicks | undefined): string => {
  const values = Object.values(picks ?? {}).flat();
  return values.slice(0, 2).join(', ') + (values.length > 2 ? ` +${values.length - 2}` : '');
};

/** How many events a highlight takes, in how many sessions, and its share of the scoped events. */
export function highlightSummary(scoped: TimelineItem[], rule: TimelineHighlight): { hits: number; inSessions: number; share: number } {
  const hits = scoped.filter((event) => highlightMatches(event, rule));
  return { hits: hits.length, inSessions: new Set(hits.map((event) => event.session_id)).size, share: scoped.length ? (100 * hits.length) / scoped.length : 0 };
}

/**
 * Runs of 3 or more consecutive items with the same key fold into one row (the "×N" rows); anything else is
 * its own row. A `null` key never folds (highlighted and focused events always stay visible).
 */
export function foldRuns<T>(items: T[], keyOf: (item: T) => string | null): Array<{ items: T[]; run: boolean }> {
  const rows: Array<{ items: T[]; run: boolean }> = [];
  for (let start = 0; start < items.length;) {
    const key = keyOf(items[start]!);
    let end = start + 1;
    if (key !== null) while (end < items.length && keyOf(items[end]!) === key) end++;
    if (end - start >= 3) rows.push({ items: items.slice(start, end), run: true });
    else for (let index = start; index < end; index++) rows.push({ items: [items[index]!], run: false });
    start = end;
  }
  return rows;
}

/** The key two events share when they are "identical" for folding: name plus the parameters that are shown. */
export function repeatKey(event: JourneyEvent, hidden: ReadonlySet<string>, showAll: boolean): string {
  const shown = Object.entries(event.params).filter(([key]) => showAll || !hidden.has(key.toLowerCase()));
  return `${event.name}|${JSON.stringify(shown)}`;
}

/** The parameters of the player's events under the event that carries them, events and parameters sorted. A parameter several events carry is listed under each (ticking it is one choice); hidden ones no event carries are listed last. */
export function parameterGroups(events: JourneyEvent[], hidden: Iterable<string>): Array<{ event: string | null; params: Array<{ name: string; key: string; count: number }> }> {
  const byEvent = new Map<string, Map<string, { key: string; count: number }>>();
  events.forEach((event) => Object.keys(event.params).forEach((key) => {
    const params = byEvent.get(event.name) ?? new Map<string, { key: string; count: number }>();
    byEvent.set(event.name, params);
    const name = key.toLowerCase();
    params.set(name, { key, count: (params.get(name)?.count || 0) + 1 });
  }));
  const groups: Array<{ event: string | null; params: Array<{ name: string; key: string; count: number }> }> = [...byEvent.keys()].sort().map((event) => ({ event, params: [...byEvent.get(event)!].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, { key, count }]) => ({ name, key, count })) }));
  const known = new Set(groups.flatMap((group) => group.params.map((param) => param.name)));
  const rest = [...new Set(hidden)].filter((name) => !known.has(name)).sort().map((name) => ({ name, key: name, count: 0 }));
  return rest.length ? [...groups, { event: null, params: rest }] : groups;
}

/** The "Filter timeline" search: case-insensitive, over the event name and its parameters. */
export function matchesFilter(event: JourneyEvent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${event.name} ${JSON.stringify(event.params)}`.toLowerCase().includes(needle);
}

/** True when the session holds the event (the focused one gets a pill in the session picker). */
export const sessionHasEvent = (session: TimelineSession, eventId: string): boolean => session.items.some((item) => item.event_id === eventId);
