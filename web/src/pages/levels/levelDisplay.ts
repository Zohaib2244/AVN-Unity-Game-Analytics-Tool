// What the level table shows and how it flags trouble: which columns, heat cell or bar, when player counts
// appear, and the drop / quit percentages above which a level is flagged. Remembered per game in this browser.
export type LevelColumn = 'started' | 'finished' | 'drop' | 'failquit' | 'tries' | 'fails' | 'time';
export const LEVEL_COLUMNS: Array<{ key: LevelColumn; label: string; note?: string }> = [
  { key: 'started', label: 'Started' }, { key: 'finished', label: 'Finished' }, { key: 'drop', label: 'Drop to next level' },
  { key: 'failquit', label: 'Failed → quit', note: 'per game' }, { key: 'tries', label: 'Tries per player' }, { key: 'fails', label: 'Fails' }, { key: 'time', label: 'Median time' },
];
export type DropStyle = 'cell' | 'bar';
export type CountsShown = 'flag' | 'hover' | 'always';
export type LevelDisplay = { columns: Record<LevelColumn, boolean>; style: DropStyle; counts: CountsShown; dropFlag: number; quitFlag: number };

export const DEFAULT_DISPLAY: LevelDisplay = {
  columns: { started: true, finished: true, drop: true, failquit: false, tries: false, fails: true, time: true },
  style: 'cell', counts: 'flag', dropFlag: 5, quitFlag: 10,
};
export const FLAG_RANGE = { drop: { min: 5, max: 60 }, quit: { min: 0, max: 50 } } as const;
export const displayKey = (game: { id: string }): string => `avn-level-display-${game.id}`;

const clamp = (value: unknown, min: number, max: number, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);
export function cleanDisplay(saved: unknown): LevelDisplay {
  const value = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof LevelDisplay, unknown>>;
  const columns = (value.columns && typeof value.columns === 'object' ? value.columns : {}) as Record<string, unknown>;
  return {
    columns: Object.fromEntries(LEVEL_COLUMNS.map(({ key }) => [key, typeof columns[key] === 'boolean' ? columns[key] : DEFAULT_DISPLAY.columns[key]])) as Record<LevelColumn, boolean>,
    style: value.style === 'bar' ? 'bar' : 'cell',
    counts: value.counts === 'hover' || value.counts === 'always' ? value.counts : 'flag',
    dropFlag: clamp(value.dropFlag, FLAG_RANGE.drop.min, FLAG_RANGE.drop.max, DEFAULT_DISPLAY.dropFlag),
    quitFlag: clamp(value.quitFlag, FLAG_RANGE.quit.min, FLAG_RANGE.quit.max, DEFAULT_DISPLAY.quitFlag),
  };
}

/** Percentage points over the threshold at which the heat is at its hottest. */
export const HEAT_SPAN = 30;
/** How far over its threshold a percentage is: not over → `over: false`; over → heat from 0 (just over) to 1 (HEAT_SPAN points over). */
export function heatOf(percent: number | null | undefined, threshold: number): { over: boolean; heat: number; points: number } {
  if (percent == null || !(percent > threshold)) return { over: false, heat: 0, points: 0 };
  const points = percent - threshold;
  return { over: true, heat: Math.min(1, points / HEAT_SPAN), points: Math.round(points * 10) / 10 };
}
/** The bar's scale: percent of the track per percentage point, so the threshold tick sits at a stable spot. */
export const barScale = (threshold: number): number => 100 / Math.max(60, threshold * 2);

/** Whether the counts under a drop show: only on flagged cells, always, or never (they are in the tooltip on hover). */
export const showCount = (counts: CountsShown, over: boolean): boolean => counts === 'always' || (counts === 'flag' && over);
