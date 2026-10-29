// "Looking at": what the assistant is told about the page. Every chip except the game can be left out
// and put back; the scope line under each answer says which of them were used.
import type { ContextChip } from '@avn/ui';
import { PRESETS, resolveRange } from '@/components/DateRange';
import { DIMENSIONS, type DayRange, type Facets, type FilterState } from '@/lib/filters';
import { dimensionText, platformLabel, prettyDay, shortId } from '@/lib/format';
import { storeGet } from '@/lib/store';
import type { Game, NutBotContext, NutBotFunnel } from '@/lib/types';

export const NB_PAGES: Record<string, string> = { overview: 'Overview', funnels: 'Funnels', levels: 'Levels', players: 'Players', exports: 'Exports', dictionary: 'Event dictionary', 'event-setup': 'Event setup', keys: 'API keys', settings: 'Game settings' };

export const NB_SUGGESTIONS: Record<string, string[]> = {
  levels: ['Which level loses the most players, and what changed in the latest version?', 'Is level 12 hard or just slow?', 'Compare the last two releases on the early levels.', 'Where should I add a hint or a reward?'],
  funnels: ['Build a funnel from first open to level 10.', 'Where do players stop in my saved funnel?', 'What do players do between these two steps?', 'Which step lost the most players this week?'],
  players: ['Show me what a typical first session looks like.', 'Find players who reached level 10 but never purchased.', 'What did the players who left in session one do last?', 'Tell me about the open player.'],
  overview: ['How is the game doing this week compared with last week?', 'What changed since the last release?', 'Check that my events are arriving and described.', 'Where are players dropping off in the first 10 levels?'],
};
export const suggestionsFor = (section: string): string[] => NB_SUGGESTIONS[section] || NB_SUGGESTIONS.overview!;

export type PageContext = { game: Pick<Game, 'id' | 'name' | 'platform'> | null; section: string; filters: FilterState | null; player?: string | null };
export type Chip = { id: string; label: string; removable: boolean };

export const rangeText = (range: { from: string; to: string }): string => `${prettyDay(range.from)}${range.from === range.to ? '' : ` → ${prettyDay(range.to)}`}`;

/** The chips in order: game (fixed), page, range, filters, player. Nothing outside a game. */
export function contextChips({ game, section, filters, player }: PageContext): Chip[] {
  if (!game) return [];
  const active = filters ? DIMENSIONS.flatMap((dimension) => filters[dimension].map((value) => dimensionText(dimension, value))) : [];
  return [
    { id: 'game', label: `${game.name} · ${platformLabel(game.platform)}`, removable: false },
    { id: 'page', label: NB_PAGES[section] || section, removable: true },
    ...(filters?.range ? [{ id: 'range', label: rangeText(filters.range), removable: true }] : []),
    ...(active.length ? [{ id: 'filters', label: active.slice(0, 2).join(', ') + (active.length > 2 ? ` +${active.length - 2}` : ''), removable: true }] : []),
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

/** The context sent with a message: page, range, filters, the open player and the funnel being drafted. */
export function buildContext({ game, section, filters, player }: PageContext, off: ReadonlySet<string>): NutBotContext {
  const empty = { environments: [], app_versions: [], builds: [], countries: [], platforms: [] };
  let funnel: NutBotFunnel | null = game ? storeGet<NutBotFunnel & { steps?: NutBotFunnel['steps'] }>(`avn-funnel-draft-${game.id}`) : null;
  if (funnel?.steps?.length) funnel = { steps: funnel.steps.map(({ event, param, op, value, label }) => ({ event, param, op, value, label })).slice(0, 30), scope: funnel.scope, window_hours: funnel.window_hours };
  else funnel = null;
  return {
    page: off.has('page') ? undefined : section,
    range: filters?.range && !off.has('range') ? { from: filters.range.from, to: filters.range.to } : undefined,
    hide_test: filters?.hideTest ?? true,
    filters: off.has('filters') || !filters ? empty : { environments: filters.environment, app_versions: filters.app_version, builds: filters.build, countries: filters.country, platforms: filters.platform },
    player: off.has('player') ? undefined : player || undefined,
    funnel: funnel || undefined,
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
