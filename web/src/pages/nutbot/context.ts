// "Looking at": what the assistant is told about the page. Every chip except the game can be left out
// and put back; the scope line under each answer says which of them were used.
import type { ContextChip } from '@avn/ui';
import { DIMENSIONS, type FilterState } from '@/lib/filters';
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

/** The line under an answer: which page filters it used. */
export function scopeLine(chips: Chip[], off: ReadonlySet<string>): string {
  const used = chips.filter((chip) => !off.has(chip.id) && ['range', 'filters'].includes(chip.id)).map((chip) => chip.label);
  return used.length ? `Same filters as the page · ${used.join(' · ')}` : 'No page filters applied';
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
