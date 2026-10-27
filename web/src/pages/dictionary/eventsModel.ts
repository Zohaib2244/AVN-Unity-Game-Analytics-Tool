// Pure helpers of the events list on the Event dictionary page: the filter chips, the sorts, and what
// counts as "needs attention". Counts are for the selected days and filters, set by the server.
import type { DictionaryEvent } from '@/lib/types';

export type EventsFilter = 'all' | 'attention' | 'undescribed' | 'described' | 'mapped' | 'hidden' | 'quiet';
export type EventsSort = 'sent' | 'players' | 'attention' | 'last' | 'name';

/** Not described yet (and not a built-in one the SDK explains), has undescribed parameters, or a parameter that changes type. */
export const needsAttention = (item: DictionaryEvent): boolean =>
  (!item.described && !item.sdk && !!item.ever) || (item.defined && item.params_missing.length > 0) || item.type_conflicts.length > 0;

export const EVENT_FILTERS: Array<[EventsFilter, string, (item: DictionaryEvent) => boolean]> = [
  ['all', 'All', () => true],
  ['attention', 'Needs attention', needsAttention],
  ['undescribed', 'No description', (item) => !item.described && !item.sdk],
  ['described', 'Described', (item) => item.described],
  ['mapped', 'Mapped', (item) => item.definition.canonical.length > 0],
  ['hidden', 'Hidden', (item) => item.definition.hidden],
  ['quiet', 'Quiet or never sent', (item) => item.status !== 'active'],
];

const byName = (a: DictionaryEvent, b: DictionaryEvent): number => a.name.localeCompare(b.name);
export const EVENT_SORTS: Array<[EventsSort, string, (a: DictionaryEvent, b: DictionaryEvent) => number]> = [
  ['sent', 'Most sent', (a, b) => b.range.events - a.range.events || byName(a, b)],
  ['players', 'Most players', (a, b) => b.range.players - a.range.players || byName(a, b)],
  ['attention', 'Needs attention', (a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.range.events - a.range.events || byName(a, b)],
  ['last', 'Last sent', (a, b) => (b.ever?.last_seen || '').localeCompare(a.ever?.last_seen || '') || byName(a, b)],
  ['name', 'Name', byName],
];

export const isEventsFilter = (value: unknown): value is EventsFilter => EVENT_FILTERS.some(([key]) => key === value);
export const isEventsSort = (value: unknown): value is EventsSort => EVENT_SORTS.some(([key]) => key === value);

/** The events to list: the chosen chip, the search (name or description) and the sort. */
export function visibleEvents(events: DictionaryEvent[], filter: EventsFilter, sort: EventsSort, query: string): DictionaryEvent[] {
  const keep = EVENT_FILTERS.find(([key]) => key === filter)?.[2] ?? (() => true);
  const order = EVENT_SORTS.find(([key]) => key === sort)?.[2] ?? byName;
  const needle = query.trim().toLowerCase();
  return events.filter((item) => keep(item) && (!needle || `${item.name} ${item.definition.description}`.toLowerCase().includes(needle))).sort(order);
}

/** The next event after `name` in the list that still has no description, wrapping round; null when none is left. */
export function nextUndescribed(list: DictionaryEvent[], name: string): string | null {
  const here = list.findIndex((item) => item.name === name);
  const ordered = [...list.slice(here + 1), ...list.slice(0, Math.max(here, 0))];
  return ordered.find((item) => !item.described && !item.sdk && item.ever && item.name !== name)?.name ?? null;
}

/** The saved form of the settings kept per game in this browser (`avn-events-view-<game>`). */
export type EventsView = { filter: EventsFilter; sort: EventsSort };
export const eventsViewKey = (game: { id: string }): string => `avn-events-view-${game.id}`;
export function cleanEventsView(saved: Partial<Record<keyof EventsView, unknown>> | null | undefined): EventsView {
  return { filter: isEventsFilter(saved?.filter) ? saved.filter : 'all', sort: isEventsSort(saved?.sort) ? saved.sort : 'sent' };
}
