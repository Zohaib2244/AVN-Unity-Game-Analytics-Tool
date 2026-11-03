// How a raw event row reads. Events that follow the AVN events standard carry the same few parameters
// every time for a given event and STATE, so each row can show the same things in the same order:
// the level and STATE up front (every analysis event has them), then the parameters worth reading,
// then the IDs that tie events together (dimmed), while parameters that never change stay out of the way.
// An event the standard doesn't know keeps every parameter in the order it was sent.
import type { JourneyEvent } from '@/lib/types';

type Layout = { show: string[]; link?: string[]; hide?: string[] };
const words = (text: string): string[] => (text ? text.split(' ') : []);
const make = (show: string, link = '', hide = ''): Layout => ({ show: words(show), link: words(link), hide: words(hide) });

/** Keyed "EVENT|STATE". `show` is in reading order, `link` are the IDs, `hide` never change. */
const LAYOUTS: Record<string, Layout> = {
  'LEVEL_ANALYSIS|Started': make('ATTEMPT SOURCE BALLS_START RETRY_BONUS_BALLS IS_KING_LEVEL', 'ATTEMPT_ID', 'ENVIRONMENT PROGRESS_PCT SECONDS'),
  'LEVEL_ANALYSIS|Choice': make('ACTION METHOD', 'ATTEMPT_ID'),
  'LEVEL_ANALYSIS|Completed': make('SECONDS MOVES ATTEMPT POWERUPS_USED REVIVES ADS_SHOWN ITEM_UNLOCK', 'ATTEMPT_ID', 'PROGRESS_PCT'),
  'LEVEL_ANALYSIS|Failed': make('SECONDS MOVES ATTEMPT POWERUPS_USED REVIVES ADS_SHOWN', 'ATTEMPT_ID', 'PROGRESS_PCT'),
  'LEVEL_ANALYSIS|Left': make('REASON SECONDS ATTEMPT RECOVERED', 'ATTEMPT_ID', 'PROGRESS_PCT'),
  'AD_ANALYSIS|Show': make('FORMAT PLACEMENT', 'AD_ID', 'FALLBACK'),
  'AD_ANALYSIS|Closed': make('FORMAT PLACEMENT SECONDS_ON_SCREEN REWARDED', 'AD_ID', 'FALLBACK'),
  'AD_ANALYSIS|Failed': make('FORMAT PLACEMENT REASON', 'AD_ID'),
  'APP_ANALYSIS|Background': make('CAUSE IN_LEVEL SCREEN'),
  'APP_ANALYSIS|Foreground': make('CAUSE AWAY_SECONDS'),
  'APP_ANALYSIS|Launch': make('PREV_EXIT'),
  'SCREEN_ANALYSIS|Opened': make('SCREEN SOURCE'),
  'SCREEN_ANALYSIS|Closed': make('SCREEN SECONDS_OPEN CLOSED_BY'),
  'SCREEN_ANALYSIS|Interaction': make('SCREEN ACTION ITEM'),
  'ECONOMY_ANALYSIS|Earned': make('AMOUNT SOURCE DETAIL BALANCE', '', 'CURRENCY'),
  'ECONOMY_ANALYSIS|Spent': make('AMOUNT SOURCE DETAIL BALANCE', '', 'CURRENCY'),
  'POWERUP_ANALYSIS|Used': make('POWERUP TRIGGER SECONDS_INTO_LEVEL'),
  'POWERUP_ANALYSIS|Obtained': make('POWERUP AMOUNT SOURCE'),
  'TUTORIAL_ANALYSIS|Shown': make('TUTORIAL SECONDS'),
  'TUTORIAL_ANALYSIS|Completed': make('TUTORIAL SECONDS'),
  'TUTORIAL_ANALYSIS|Interrupted': make('TUTORIAL SECONDS'),
  'FTUE_ANALYSIS|Reached': make('STEP STEP_INDEX SECONDS_SINCE_LAUNCH'),
  'IAP_ANALYSIS|Clicked': make('PRODUCT SCREEN'),
  'PLAYER_ANALYSIS|Snapshot': make('HIGHEST_LEVEL BALANCE_COINS POWERUP_BOMB POWERUP_ROCKETS POWERUP_AUTO_SHOOT', '', 'ADS_REMOVED HAS_PURCHASED SUB_ACTIVE'),
  'DEVICE_ANALYSIS|Snapshot': make('TIER RAM_MB GPU_MB CPU_CORES QUALITY_LEVEL'),
};

/** Snapshots describe the player and the device, not something that happened: folded away by default. */
export const SNAPSHOT_EVENTS = ['PLAYER_ANALYSIS', 'DEVICE_ANALYSIS'];

/** The words on screen for an analysis event: LEVEL_ANALYSIS reads LEVEL; any other name is shown as sent. */
export const eventLabel = (name: string): string => name.replace(/_ANALYSIS$/, '');

export type EventShape = {
  /** The STATE parameter, when the event has one. */
  state: string | null;
  /** Parameters to read, in order. */
  show: Array<[string, unknown]>;
  /** IDs that tie events together (dimmed). */
  link: Array<[string, unknown]>;
  /** Parameters this event never changes: out of the way until asked for. */
  quiet: Array<[string, unknown]>;
  /** Whether the standard knows this event and STATE (otherwise `show` is every parameter as sent). */
  known: boolean;
};

const keyed = (params: Record<string, unknown>, key: string): [string, unknown] | null => {
  const found = Object.keys(params).find((name) => name.toUpperCase() === key);
  return found === undefined ? null : [found, params[found]];
};
const present = (entries: Array<[string, unknown] | null>): Array<[string, unknown]> => entries.filter((entry): entry is [string, unknown] => entry !== null && entry[1] != null && entry[1] !== '');

/** What one event shows, and in which order. */
export function shapeEvent(event: Pick<JourneyEvent, 'name' | 'params'>): EventShape {
  const state = keyed(event.params, 'STATE');
  const stateText = state && state[1] != null ? String(state[1]) : null;
  const layout = LAYOUTS[`${event.name}|${stateText ?? ''}`];
  if (!layout) return { state: null, show: Object.entries(event.params), link: [], quiet: [], known: false };
  const named = new Set(['STATE', 'LEVEL_NUMBER', ...layout.show, ...(layout.link ?? []), ...(layout.hide ?? [])]);
  const extras = Object.entries(event.params).filter(([key]) => !named.has(key.toUpperCase()));
  return {
    state: stateText,
    show: [...present(layout.show.map((key) => keyed(event.params, key))), ...extras],
    link: present((layout.link ?? []).map((key) => keyed(event.params, key))),
    quiet: present((layout.hide ?? []).map((key) => keyed(event.params, key))),
    known: true,
  };
}

/** The level of an event when it differs from the event before it in the same session; else null (the row carries nothing). */
export const levelChange = (level: number | null | undefined, before: number | null | undefined): number | null => (level != null && level !== before ? level : null);
