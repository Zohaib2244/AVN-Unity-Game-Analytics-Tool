// The Acquisition page's plain logic: goals, how a return compares with its goal, the answer above
// the table and the words for the cost service's state.
import type { AcquisitionReport, AcquisitionRow, CostState, ReturnGoal } from '@/lib/types';

export const VALUE_DAYS = [0, 1, 3, 7, 14, 30] as const;
export const TABLE_DAYS = [0, 1, 3, 7] as const;
export const RETENTION_DAYS = [1, 3, 7] as const;
/** Below this many players a number is shown faint: one player more or less moves it a lot. */
export const FEW = 30;
export const ALL_PAID = 'All paid';

export const money = (value: number | null | undefined, digits = 2): string => (value == null ? '—' : `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
export const pct = (value: number | null | undefined): string => (value == null ? '—' : `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}%`);
export const pct1 = (value: number | null | undefined): string => (value == null ? '—' : `${(value * 100).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

/** The goal set for exactly this day, if any. */
export const goalOn = (goals: ReturnGoal[], day: number): ReturnGoal | undefined => goals.find((goal) => goal.day === day);

/** good = at or over the goal; behind = under it; none = no goal that day or no number yet. */
export function tone(value: number | null | undefined, goal: ReturnGoal | undefined): 'good' | 'behind' | 'none' {
  if (value == null || !goal) return 'none';
  return value * 100 >= goal.percent ? 'good' : 'behind';
}

/** The latest day with a goal whose number exists for this row: what "on track" is judged by. */
export function judgedGoal(row: Pick<AcquisitionRow, 'return' | 'value_per_install'>, goals: ReturnGoal[]): { goal: ReturnGoal; value: number } | null {
  for (const goal of [...goals].sort((a, b) => b.day - a.day)) {
    const value = row.return[`day_${goal.day}`];
    if (value != null && (row.value_per_install[`day_${goal.day}`]?.players ?? 0) > 0) return { goal, value };
  }
  return null;
}

/** The latest day whose value rests on at least FEW players (else the latest with any). */
export function settledDay(row: Pick<AcquisitionRow, 'value_per_install'>, days: readonly number[] = TABLE_DAYS): number | null {
  const known = days.filter((day) => (row.value_per_install[`day_${day}`]?.players ?? 0) > 0);
  const solid = known.filter((day) => (row.value_per_install[`day_${day}`]?.players ?? 0) >= FEW);
  return solid.length ? solid[solid.length - 1]! : known.length ? known[known.length - 1]! : null;
}

/** The sentence above the sources table. */
export function answer(report: AcquisitionReport, goals: (name: string) => ReturnGoal[]): string {
  const paid = report.rows.filter((row) => row.paid && row.installs);
  if (!report.installs) return 'No player opened the game for the first time in these days.';
  if (!paid.length) return `${report.installs.toLocaleString()} installs, none from a paid campaign.`;
  const top = [...paid].sort((a, b) => b.installs - a.installs)[0]!;
  const day = settledDay(top);
  const value = day == null ? null : top.value_per_install[`day_${day}`]?.per_player;
  let text = `${top.value} brought ${pct(top.installs / report.installs)} of installs`;
  if (day != null && value != null) text += `; a player from it earned ${money(value)} by day ${day}`;
  const judged = judgedGoal(top, goals(top.value));
  if (judged) text += `, ${pct(judged.value)} of their cost against a day ${judged.goal.day} goal of ${judged.goal.percent}%`;
  else if (top.cost_per_install && day != null && top.return[`day_${day}`] != null) text += `, ${pct(top.return[`day_${day}`])} of their cost`;
  return `${text}.`;
}

/** What to say about cost, or null when it is there and fresh. */
export function costWords(cost: CostState): { kind: 'info' | 'warn'; text: string } | null {
  switch (cost.state) {
    case 'off': return { kind: 'info', text: 'Cost isn’t connected on this server, so there is no cost per install or return. Set AVN_COST_API_URL to add it.' };
    case 'no_app_id': return { kind: 'info', text: 'Cost needs this game’s AppsFlyer app ID (an iOS game’s is its store ID, such as id123456789).' };
    case 'not_allowed': return { kind: 'info', text: `Cost isn’t available for this game yet: the cost service doesn’t serve ${cost.app_id}.` };
    case 'failed': return { kind: 'warn', text: `Couldn’t reach the cost service just now (${cost.detail || 'no answer'}). Costs below are the last ones fetched.` };
    default: return null;
  }
}

/** Cleans what was typed into the goal editor: whole days 0–90, percentages above 0, one per day. */
export function cleanGoals(rows: Array<{ day: string | number; percent: string | number }>): ReturnGoal[] {
  const found = new Map<number, number>();
  for (const row of rows) {
    const day = Math.round(Number(row.day)); const percent = Number(row.percent);
    if (Number.isFinite(day) && day >= 0 && day <= 90 && Number.isFinite(percent) && percent > 0 && percent <= 1000) found.set(day, Math.round(percent * 10) / 10);
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([day, percent]) => ({ day, percent }));
}

/** Install days before the first player was seen here (the build sent no AVN events yet), and the rest. */
export function splitTracked<T extends { installs: number }>(days: T[]): { before: T[]; tracked: T[] } {
  const first = days.findIndex((row) => row.installs > 0);
  return first < 0 ? { before: days, tracked: [] } : { before: days.slice(0, first), tracked: days.slice(first) };
}
