// Pure helpers of the Levels page: which group a level opens on, the "what they did last" text,
// the players-remaining curve and heat strip maths, sorting and paging of the level table.
import { duration, number, percent } from '@/lib/format';
import type { ActiveFilters } from '@/lib/filters';
import type { LevelLastEvent, LevelPlayer, LevelRow } from '@/lib/types';

// Who is counted: everyone active in the dates, or new players within their first session.
export type LevelScope = 'all' | 'first_session';
export const LEVEL_SCOPES: Record<LevelScope, string> = { all: 'Everyone', first_session: 'New players · first session' };
export const isLevelScope = (value: unknown): value is LevelScope => value === 'all' || value === 'first_session';

// The players behind a level: where the drop splits, and who carried on.
export type LevelDrillGroup = 'left' | 'finished_stopped' | 'kept_going' | 'failed_left' | 'failed_kept_playing';
export const LEVEL_DRILL_GROUPS: Array<[LevelDrillGroup, string]> = [['left', 'Quit during level'], ['finished_stopped', 'Quit after finishing'], ['kept_going', 'Reached next level'], ['failed_left', 'Failed, then quit'], ['failed_kept_playing', 'Failed, kept playing']];
/** Groups of players who carried on, so there is no “what they did last” for them. */
export const CARRIED_ON_GROUPS: LevelDrillGroup[] = ['kept_going', 'failed_kept_playing'];

export type LevelSort = 'level' | 'drop' | 'failquit' | 'completion' | 'tries' | 'time';
export const LEVEL_SORTS: LevelSort[] = ['level', 'drop', 'failquit', 'completion', 'tries', 'time'];
export type LevelPageSize = '25' | '50' | '100' | 'all';
export const LEVEL_PAGE_SIZES: LevelPageSize[] = ['25', '50', '100', 'all'];
export type DrillSort = 'exit_at' | 'tries' | 'fails';
export const DRILL_PAGE = 50;

/** The sort, rows per page and scope of the level table, remembered per game (`avn-level-nav-<game>`). */
export type LevelNavigation = { sort: LevelSort; pageSize: LevelPageSize; scope: LevelScope };
export const navigationKey = (game: { id: string }): string => `avn-level-nav-${game.id}`;
export function cleanNavigation(saved: Partial<Record<keyof LevelNavigation, unknown>> | null | undefined): LevelNavigation {
  const sort = saved?.sort; const pageSize = saved?.pageSize; const scope = saved?.scope;
  return {
    sort: LEVEL_SORTS.includes(sort as LevelSort) ? (sort as LevelSort) : 'level',
    pageSize: LEVEL_PAGE_SIZES.includes(pageSize as LevelPageSize) ? (pageSize as LevelPageSize) : '50',
    scope: isLevelScope(scope) ? scope : 'all',
  };
}

// The tab a level opens on: the bigger of its two kinds of drop, else who carried on.
export function levelDrillGroup(row: { transition?: Pick<LevelRow['transition'] & object, 'left' | 'finished_stopped' | 'kept_going'> | null } | null | undefined): LevelDrillGroup {
  const value = row?.transition;
  if (!value) return 'left';
  if (value.left || value.finished_stopped) return value.finished_stopped > value.left ? 'finished_stopped' : 'left';
  return value.kept_going ? 'kept_going' : 'left';
}

/* ─── "What they did last" ─── */
// One short label per player; hovering or clicking it opens the exact last event above it.
export const lastDidLabel = (row: Pick<LevelPlayer, 'last_action'>): string => row.last_action || '—';

export type LastDidLine = { label: string; body: string; mono?: boolean; before?: string };
export type LastDidDetails = { title: string; lines: LastDidLine[] };
// The popover's text: the last event sent in that session, when it came, and what they did right after the level.
export function lastDidDetails(row: Pick<LevelPlayer, 'last_action' | 'next_action'> & { last_event?: LevelLastEvent | null }, level: number): LastDidDetails {
  const last = row.last_event;
  const lines: LastDidLine[] = [];
  if (last) {
    lines.push({ label: 'Last event in that session', body: last.text, mono: true, ...(last.after ? { before: `${duration(last.gap)} after ${last.after}` } : {}) });
    lines.push({ label: 'When', body: last.after_level == null ? `It was their last event on level ${level}` : `${duration(last.after_level)} after their last event on level ${level}` });
  }
  if (row.next_action && row.next_action !== row.last_action) lines.push({ label: `Right after level ${level}`, body: row.next_action });
  return { title: row.last_action || 'Unknown', lines };
}

/* ─── Sorting and paging the level table ─── */
export function sortLevels(levels: LevelRow[], sort: LevelSort): LevelRow[] {
  const list = [...levels];
  const keys: Record<Exclude<LevelSort, 'level'>, (row: LevelRow) => number> = {
    drop: (row) => -(row.transition?.drop_percent ?? -1), failquit: (row) => -(row.transition?.fail_drop_percent ?? -1), completion: (row) => row.completion ?? 101,
    tries: (row) => -(row.tries_per_player ?? -1), time: (row) => -(row.median_seconds ?? -1),
  };
  return sort === 'level' ? list : list.sort((a, b) => keys[sort](a) - keys[sort](b));
}
export const pageSizeOf = (pageSize: LevelPageSize, total: number): number => (pageSize === 'all' ? Math.max(1, total) : Number(pageSize));
export const pageCount = (pageSize: LevelPageSize, total: number): number => Math.max(1, Math.ceil(total / pageSizeOf(pageSize, total)));
export const clampPage = (page: number, pageSize: LevelPageSize, total: number): number => Math.min(page, pageCount(pageSize, total) - 1);

/** The key numbers above the table: the largest drop, hardest and slowest level (small samples not ranked). */
export function levelHighlights(levels: LevelRow[]): { largestDrop: LevelRow | undefined; failQuit: LevelRow | undefined; hardest: LevelRow | undefined; slowest: LevelRow | undefined } {
  const largestDrop = levels.filter((row) => !row.low_sample && row.transition?.available).sort((a, b) => (b.transition!.drop_percent ?? 0) - (a.transition!.drop_percent ?? 0))[0];
  const failQuit = levels.filter((row) => !row.low_sample && row.transition?.fail_drop_percent != null).sort((a, b) => b.transition!.fail_drop_percent! - a.transition!.fail_drop_percent! || b.transition!.failed_left - a.transition!.failed_left)[0];
  const hardest = levels.filter((row) => !row.low_sample).sort((a, b) => (a.completion ?? 100) - (b.completion ?? 100))[0];
  const slowest = levels.filter((row) => row.median_seconds != null).sort((a, b) => b.median_seconds! - a.median_seconds!)[0];
  return { largestDrop, failQuit, hardest, slowest };
}

/* ─── Levels at a glance: players remaining by level and a heat strip ─── */
export type CurvePoint = { level: number; started: number; drop: number | null; x: number; y: number; big: boolean; flag: string | null; axis: boolean };
export type HeatCell = { level: number; bucket: number; title: string };
export type LevelCurve = {
  width: number; height: number; left: number; right: number;
  line: string; area: string; ticks: Array<{ value: number; y: number }>; points: CurvePoint[];
  steepest: number[]; heat: HeatCell[]; summary: string;
};
/** The drop to the next level that counts for the picture: only levels with enough players and a next level. */
export const levelDrop = (row: Pick<LevelRow, 'transition' | 'low_sample'>): number | null => (row.transition?.available && !row.low_sample ? row.transition.drop_percent : null);

// The curve (the two steepest drops marked) and one heat cell per level, h0 (no next level) to h6 (the biggest drop).
export function levelCurve(levels: LevelRow[]): LevelCurve | null {
  const rows = levels.filter((row) => row.started != null);
  if (rows.length < 2) return null;
  const width = 800, height = 190, left = 40, right = 12, top = 18, bottom = 24;
  const peak = Math.max(1, ...rows.map((row) => row.started));
  const x = (index: number) => left + (index / (rows.length - 1)) * (width - left - right);
  const y = (value: number) => top + (height - top - bottom) * (1 - value / peak);
  const steepest = rows.filter((row) => levelDrop(row) != null).sort((a, b) => levelDrop(b)! - levelDrop(a)!).slice(0, 2).map((row) => row.level);
  const line = rows.map((row, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(row.started).toFixed(1)}`).join(' ');
  const every = Math.ceil(rows.length / 12);
  const ticks = [0, Math.round(peak / 2), peak].filter((value, index, list) => list.indexOf(value) === index).map((value) => ({ value, y: y(value) }));
  const maxDrop = Math.max(1, ...rows.map((row) => levelDrop(row) ?? 0));
  const first = rows[0]!; const last = rows[rows.length - 1]!;
  const summary = `Players remaining by level, from ${number(first.started)} at level ${first.level} to ${number(last.started)} at level ${last.level}${steepest.length ? `. Steepest drops after level ${steepest.join(' and ')}` : ''}.`;
  const points = rows.map((row, index) => {
    const big = steepest.includes(row.level);
    return { level: row.level, started: row.started, drop: levelDrop(row), x: Number(x(index).toFixed(1)), y: Number(y(row.started).toFixed(1)), big, flag: big ? `L${row.level} −${Math.round(levelDrop(row)!)}%` : null, axis: index % every === 0 || index === rows.length - 1 };
  });
  const heat = rows.map((row) => {
    const drop = levelDrop(row);
    return { level: row.level, bucket: drop == null ? 0 : Math.max(1, Math.ceil((drop / maxDrop) * 6)), title: `Level ${row.level} · ${number(row.started)} ${row.started === 1 ? 'player' : 'players'} · ${drop == null ? 'no next level yet' : `${percent(drop)} did not start the next`}` };
  });
  return { width, height, left, right, line, area: `${line} L${x(rows.length - 1)} ${y(0)} L${x(0)} ${y(0)}Z`, ticks, points, steepest, heat, summary };
}

/* ─── The level table's note ─── */
/** The line under "Level by level": what is counted for these players. */
export function levelsNote(scope: LevelScope): string {
  return (scope === 'first_session' ? 'New players only, within their first session. A drop is a first session that ended on the level.' : 'Counted from level start, complete, fail and restart events.') + ' Click a level to see the players behind it.';
}

/* ─── Compare releases ─── */
export type ReleasePrefs = { releaseA?: string; releaseB?: string };
/** Saved on this device as `avn-level-views-<game>[name]`: the filters, the remembered releases and the table settings. */
export type SavedLevelView = { filters: ActiveFilters; tools: ReleasePrefs; sort?: string; pageSize?: string; scope?: string };

/** The releases to pick from, newest first (numeric-aware, so 1.10 comes after 1.9). */
export function releaseChoices(versions: string[]): string[] {
  return [...versions].sort((first, second) => second.localeCompare(first, undefined, { numeric: true }));
}

/** The two releases compared: the remembered ones when still available, else the second newest (A) and the newest (B). Null when fewer than two. */
export function pickReleases(choices: string[], saved: ReleasePrefs): { a: string; b: string } | null {
  if (choices.length < 2) return null;
  return {
    a: saved.releaseA && choices.includes(saved.releaseA) ? saved.releaseA : choices[1]!,
    b: saved.releaseB && choices.includes(saved.releaseB) ? saved.releaseB : choices[0]!,
  };
}

/** "27.4% · 120" for a row's drop, or — when the next level has no data. */
export function dropText(row: LevelRow | undefined): string {
  return row?.transition?.drop_percent == null ? '—' : `${percent(row.transition.drop_percent)} · ${number(row.transition.total_drop)}${row.low_sample ? ' · small sample' : ''}`;
}

/** The change in drop from release A to B, in percentage points (one decimal), or null when either side has no drop. */
export function dropChange(first: LevelRow | undefined, second: LevelRow | undefined): number | null {
  const before = first?.transition?.drop_percent;
  const after = second?.transition?.drop_percent;
  return before == null || after == null ? null : Math.round((after - before) * 10) / 10;
}

/** The text and tone of the "Drop change · B vs A" cell. Small samples are muted, never red or green. */
export function dropChangeLabel(change: number | null, small: boolean): { tone: 'muted' | 'loss' | 'gain'; text: string } {
  if (change == null) return { tone: 'muted', text: 'Not comparable' };
  const tone = small ? 'muted' : change > 0 ? 'loss' : change < 0 ? 'gain' : 'muted';
  const sign = change > 0 ? '↑ +' : change < 0 ? '↓ −' : '';
  const word = change > 0 ? 'more drop' : change < 0 ? 'less drop' : 'unchanged';
  return { tone, text: `${sign}${Math.abs(change)} pp · ${word}${small ? ' · small sample' : ''}` };
}
