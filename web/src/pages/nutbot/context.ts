// "Looking at": what the assistant is told about the page. Every chip except the game can be left out
// and put back; the scope line under each answer says which of them were used.
import type { ContextChip } from '@avn/ui';
import { PRESETS, resolveRange } from '@/components/DateRange';
import { DIMENSIONS, filterState, type DayRange, type Facets, type FilterState } from '@/lib/filters';
import { dimensionText, platformLabel, prettyDay, shortId } from '@/lib/format';
import type { Game, NutBotContext } from '@/lib/types';

/** What the page itself works with: the saved choices, with a preset like "Last 30 days" counted from today (the saved dates may be days old). */
export const currentFilters = (game: Pick<Game, 'id'>): FilterState => { const saved = filterState(game); return { ...saved, range: resolveRange(saved.range?.preset || '30', saved.range) }; };

/** The players listed on the open level page (which group, which last action), told by the level page itself. */
let drill: { level: number; group: string; last_action?: string } | null = null;
export const showDrill = (value: { level: number; group: string; last_action?: string } | null): void => { drill = value; };
const drillShown = (level: number): { group?: string; last_action?: string } => (drill && drill.level === level ? { group: drill.group, ...(drill.last_action ? { last_action: drill.last_action } : {}) } : {});

export const NB_PAGES: Record<string, string> = { overview: 'Overview', levels: 'Levels', players: 'Players', sessions: 'Sessions', exports: 'Exports', dictionary: 'Event dictionary', 'event-setup': 'Event setup', keys: 'API keys', settings: 'Game settings' };

export const NB_SUGGESTIONS: Record<string, string[]> = {
  levels: ['Which level loses the most players, and what changed in the latest version?', 'Is level 12 hard or just slow?', 'Compare the last two releases on the early levels.', 'Where should I add a hint or a reward?'],
  players: ['Show me what a typical first session looks like.', 'Find players who reached level 10 but never purchased.', 'What did the players who left in session one do last?', 'Tell me about the open player.'],
  overview: ['How is the game doing this week compared with last week?', 'What changed since the last release?', 'Check that my events are arriving and described.', 'Where are players dropping off in the first 10 levels?'],
};
export const suggestionsFor = (section: string): string[] => NB_SUGGESTIONS[section] || NB_SUGGESTIONS.overview!;

export type PageContext = { game: Pick<Game, 'id' | 'name' | 'platform'> | null; section: string; filters: FilterState | null; player?: string | null; level?: number | null };
export type Chip = { id: string; label: string; removable: boolean };

export const rangeText = (range: { from: string; to: string }): string => `${prettyDay(range.from)}${range.from === range.to ? '' : ` → ${prettyDay(range.to)}`}`;

/** The chips in order: game (fixed), page, range, filters, player. Nothing outside a game. */
export function contextChips({ game, section, filters, player, level }: PageContext): Chip[] {
  if (!game) return [];
  const active = filters ? DIMENSIONS.flatMap((dimension) => filters[dimension].map((value) => dimensionText(dimension, value))) : [];
  return [
    { id: 'game', label: `${game.name} · ${platformLabel(game.platform)}`, removable: false },
    { id: 'page', label: NB_PAGES[section] || section, removable: true },
    ...(filters?.range ? [{ id: 'range', label: rangeText(filters.range), removable: true }] : []),
    ...(active.length ? [{ id: 'filters', label: active.slice(0, 2).join(', ') + (active.length > 2 ? ` +${active.length - 2}` : ''), removable: true }] : []),
    ...(level != null && section === 'levels' ? [{ id: 'level', label: `Level ${level}`, removable: true }] : []),
    ...(player ? [{ id: 'player', label: `Player ${shortId(player)}`, removable: true }] : []),
  ];
}

/** The chips as the @avn/ui panel wants them (the left-out ones stay visible with a +). */
export const panelChips = (chips: Chip[], off: ReadonlySet<string>): ContextChip[] => chips.map((chip) => ({ id: chip.id, label: chip.label, fixed: !chip.removable, off: off.has(chip.id) }));

/** The line under an answer: which page filters it used, and the player it was about. Taken when the question is sent. */
export function scopeLine(chips: Chip[], off: ReadonlySet<string>): string {
  const used = chips.filter((chip) => !off.has(chip.id) && ['range', 'filters'].includes(chip.id)).map((chip) => chip.label);
  const player = chips.find((chip) => chip.id === 'player' && !off.has(chip.id));
  const line = used.length ? `Same filters as the page · ${used.join(' · ')}` : 'No page filters applied';
  return player ? `${line} · ${player.label}` : line;
}

/** The context sent with a message: page, range, filters, and the open player. */
export function buildContext({ section, filters, player, level }: PageContext, off: ReadonlySet<string>): NutBotContext {
  const empty = { environments: [], app_versions: [], builds: [], countries: [], platforms: [] };
  return {
    page: off.has('page') ? undefined : section,
    range: filters?.range && !off.has('range') ? { from: filters.range.from, to: filters.range.to } : undefined,
    hide_test: filters?.hideTest ?? true,
    filters: off.has('filters') || !filters ? empty : { environments: filters.environment, app_versions: filters.app_version, builds: filters.build, countries: filters.country, platforms: filters.platform },
    player: off.has('player') ? undefined : player || undefined,
    level: off.has('level') || level == null || section !== 'levels' ? undefined : { level, ...drillShown(level) },
  };
}

/** What the person changed in the @ list for the next question only: the page, the days, the versions. */
export type ContextEdit = { page?: string; range?: DayRange; versions?: string[] };

/** The page as the next question will see it: the edits laid over what the page shows. */
export function applyEdit(page: PageContext, edit: ContextEdit): PageContext {
  const filters = page.filters && (edit.range || edit.versions)
    ? { ...page.filters, range: edit.range ?? page.filters.range, ...(edit.versions ? { app_version: edit.versions } : {}) }
    : page.filters;
  return { ...page, section: edit.page ?? page.section, filters };
}

const VERSION_CHOICES = (facets: Facets | undefined): Array<{ id: string; label: string }> => [
  ...(facets?.latest_app_version ? [{ id: 'latest', label: `Latest build ${facets.latest_app_version}` }] : []),
  ...(facets?.previous_app_version ? [{ id: 'previous', label: `Previous build ${facets.previous_app_version}` }] : []),
  { id: 'all', label: 'All versions' },
];

/** The edit an @ choice makes: 'page' takes a page, 'range' a preset, 'filters' latest / previous / all versions. */
export function editFor(chip: string, option: string, facets: Facets | undefined, previous: ContextEdit): ContextEdit {
  if (chip === 'page') return { ...previous, page: option };
  if (chip === 'range') return { ...previous, range: resolveRange(option) };
  if (chip === 'filters') {
    const wanted = option === 'latest' ? facets?.latest_app_version : option === 'previous' ? facets?.previous_app_version : null;
    return { ...previous, versions: wanted ? [wanted] : [] };
  }
  return previous;
}

/** The chips with what the @ list can offer on each: what it is, and the values it can be changed to. */
export function editableChips(chips: Chip[], off: ReadonlySet<string>, edit: ContextEdit, facets: Facets | undefined): ContextChip[] {
  return panelChips(chips, off).map((chip) => {
    if (chip.id === 'page') return { ...chip, kind: 'Page', options: Object.entries(NB_PAGES).map(([id, label]) => ({ id, label })), choice: undefined };
    if (chip.id === 'range') return { ...chip, kind: 'Dates', options: PRESETS.map(([id, label]) => ({ id, label })), choice: edit.range?.preset };
    if (chip.id === 'filters') return { ...chip, kind: 'Version and filters', options: VERSION_CHOICES(facets) };
    if (chip.id === 'player') return { ...chip, kind: 'Player' };
    return chip;
  });
}
