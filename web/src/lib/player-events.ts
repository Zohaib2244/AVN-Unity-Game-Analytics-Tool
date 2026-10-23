// Event Analysis for one player: counts over the exact paginated snapshot the raw timeline shows, grouped
// by event name, then by parameter value. Erasable TypeScript only (tests/test_player_events.py runs this
// file directly with Node), so: no enums, `import type` for types and an explicit `.ts` extension.
import { conditionGroup, eventCondition, paramCondition } from './conditions.ts';
import type { ConditionGroup } from './conditions.ts';

/** A highlight on the raw timeline: a named, coloured condition tree; `savedId` when it came from the game's saved rules. */
export type TimelineHighlight = { label: string; color: string; enabled: boolean; conditions: ConditionGroup; savedId?: string | null };

/** One raw event as the timeline keeps it: `session` is the session's position (0-based), `index` its place in the whole timeline. */
export type AnalysisEvent = {
  event_id?: string;
  name: string;
  session?: number;
  level?: number | null;
  client_ts?: string;
  params?: Record<string, unknown> | null;
  index?: number;
};
export type AnalysisValue = { value: unknown; token: string; count: number };
/** parameter key → the value chosen for it. */
export type AnalysisFilters = Map<string, { value: unknown; token: string }>;
export type AnalysisGroup = { name: string; items: Array<AnalysisEvent & { index: number }>; params: Map<string, Map<string, AnalysisValue>>; sessions: Set<number | undefined> };
export type PlayerEventAnalysis = { total: number; levels: number; groups: AnalysisGroup[] };

/** Values keep their type: the string "1" and the number 1 stay distinct. */
export const analysisValueKey = (value: unknown): string => JSON.stringify([typeof value, value]);

export function analysisMatchesFilters(event: AnalysisEvent, filters: AnalysisFilters, except: string | null = null): boolean {
  return [...filters].every(([key, value]) => key === except || (Object.hasOwn(event.params || {}, key) && analysisValueKey((event.params || {})[key]) === value.token));
}

/** The values of `parameter` among the events that satisfy the other filters, most common first. */
export function analysisParameterValues(items: AnalysisEvent[], filters: AnalysisFilters, parameter: string): AnalysisValue[] {
  const values = new Map<string, AnalysisValue>();
  for (const event of items) {
    if (!analysisMatchesFilters(event, filters, parameter) || !Object.hasOwn(event.params || {}, parameter)) continue;
    const value = (event.params || {})[parameter]; const token = analysisValueKey(value);
    if (!values.has(token)) values.set(token, { value, token, count: 0 });
    values.get(token)!.count++;
  }
  return [...values.values()].sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

/** Counts for the whole timeline or one session (`session` is the session position as a string). Never mutates `events`. */
export function playerEventAnalysis(events: AnalysisEvent[], session: string = 'all'): PlayerEventAnalysis {
  const scoped = events.flatMap((event, index) => (session === 'all' || String(event.session) === session ? [{ ...event, index }] : []));
  const groups = new Map<string, AnalysisGroup>();
  for (const event of scoped) {
    if (!groups.has(event.name)) groups.set(event.name, { name: event.name, items: [], params: new Map(), sessions: new Set() });
    const group = groups.get(event.name)!;
    group.items.push(event); group.sessions.add(event.session);
    for (const [key, value] of Object.entries(event.params || {})) {
      if (!group.params.has(key)) group.params.set(key, new Map());
      const values = group.params.get(key)!; const token = analysisValueKey(value);
      if (!values.has(token)) values.set(token, { value, token, count: 0 });
      values.get(token)!.count++;
    }
  }
  return {
    total: scoped.length,
    levels: new Set(scoped.map((event) => event.level).filter((level) => level != null)).size,
    groups: [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name)),
  };
}

/** The highlight "Highlight these events" makes: the event, narrowed by every chosen parameter value. */
export function analysisHighlightRule(name: string, filters: AnalysisFilters): TimelineHighlight {
  const details = [...filters].map(([key, value]) => `${key} = ${value.value}`).join(' · ');
  return {
    label: `${name}${details ? ` · ${details}` : ''}`.slice(0, 80), color: 'gold', enabled: true,
    conditions: conditionGroup([eventCondition(name), ...[...filters].map(([key, value]) => ({ ...paramCondition(key), value: String(value.value) }))]),
  };
}
