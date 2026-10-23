// Pure helpers for one player's raw timeline: sessions and gaps, parameter chips, noise rules, presets,
// highlight rules and the folding of repeated events. No React here, so the tests run on plain data.
import { conditionGroup, eventCondition, HIGHLIGHT_COLORS, highlightMatches } from '@/lib/conditions';
import type { TimelineHighlight } from '@/lib/player-events';
import type { JourneyEvent } from '@/lib/types';

/** Quick highlights for the things studied most: [key, label, event-name pattern, fallback keyword, colour]. */
export const HIGHLIGHT_PRESETS: Array<[string, string, RegExp, string, string]> = [['levels', 'Levels', /^level/i, 'level', 'cyan'], ['screens', 'Screens', /^screen/i, 'screen', 'violet'], ['ads', 'Ads', /^ads?(_|$)/i, 'ad_', 'gold']];
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

/** "level 2", "levels 1–4" or "no levels": the levels a session touched. */
export function sessionLevels(session: TimelineSession): string {
  const numbers = session.items.map((item) => item.level).filter((level): level is number => level != null);
  if (!numbers.length) return 'no levels';
  const low = Math.min(...numbers); const high = Math.max(...numbers);
  return low === high ? `level ${low}` : `levels ${low}–${high}`;
}

export const sessionSeconds = (session: TimelineSession): number => (Date.parse(session.items[session.items.length - 1]!.client_ts) - Date.parse(session.items[0]!.client_ts)) / 1000;

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

/** A quick highlight ("+ Levels"): every event whose name matches the preset pattern, or a "contains" on the keyword when none does. */
export function presetHighlight(preset: (typeof HIGHLIGHT_PRESETS)[number], eventNames: string[]): TimelineHighlight {
  const [, label, pattern, keyword, color] = preset;
  const names = eventNames.filter((name) => pattern.test(name));
  const conditions = names.length ? names.map((name) => eventCondition(name)) : [{ ...eventCondition(keyword), op: 'contains' }];
  return { label, color, enabled: true, conditions: { match: 'any', conditions } };
}

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

/** Every parameter the player's events carry (grouped without case) plus the hidden ones, sorted, with counts. */
export function parameterChooser(events: JourneyEvent[], hidden: Iterable<string>): Array<{ name: string; key: string; count: number }> {
  const counts = new Map<string, { key: string; count: number }>();
  events.forEach((event) => Object.keys(event.params).forEach((key) => counts.set(key.toLowerCase(), { key, count: (counts.get(key.toLowerCase())?.count || 0) + 1 })));
  return [...new Set([...counts.keys(), ...hidden])].sort().map((name) => ({ name, key: counts.get(name)?.key || name, count: counts.get(name)?.count || 0 }));
}

/** The "Filter timeline" search: case-insensitive, over the event name and its parameters. */
export function matchesFilter(event: JourneyEvent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${event.name} ${JSON.stringify(event.params)}`.toLowerCase().includes(needle);
}

/** True when the session holds the event (the focused one gets a pill in the session picker). */
export const sessionHasEvent = (session: TimelineSession, eventId: string): boolean => session.items.some((item) => item.event_id === eventId);
