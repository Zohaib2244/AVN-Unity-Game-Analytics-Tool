// The pure sums behind the overview: the per-day series the chart draws, breakdown shares and bar
// widths, and toggling a breakdown value as a filter. No DOM, so they are tested directly.
import { addDays } from '@/lib/format';
import type { DayRange } from '@/lib/filters';
import type { OverviewBreakdownRow, OverviewDay, OverviewMeasure } from '@/lib/types';

export type DayPoint = { day: string; value: number };

/** One point per day of the range (missing days count 0), for `measure`. */
export function dailySeries(days: OverviewDay[], range: Pick<DayRange, 'from' | 'to'>, measure: OverviewMeasure): DayPoint[] {
  const all: string[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) all.push(day);
  const values = Object.fromEntries(days.map((day) => [day.day, day[measure]]));
  return all.map((day) => ({ day, value: values[day] || 0 }));
}

export const CHART = { width: 800, height: 170, left: 40, bottom: 22, top: 8 } as const;

/** Where the bars, grid lines and labels of the daily chart go, in viewBox units. */
export function chartGeometry(series: DayPoint[]) {
  const { width, height, left, bottom, top } = CHART;
  const peak = Math.max(1, ...series.map((item) => item.value));
  const plot = width - left - 4;
  const step = plot / Math.max(1, series.length);
  const bar = Math.max(1, Math.min(28, step - 2));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / peak);
  const ticks = [0, Math.round(peak / 2), peak].filter((value, index, list) => list.indexOf(value) === index);
  const labelEvery = Math.ceil(series.length / 8);
  const bars = series.map((item, index) => {
    const x = left + index * step + (step - bar) / 2;
    const h = Math.max(item.value ? 2 : 0, height - bottom - y(item.value));
    return { day: item.day, value: item.value, x, y: height - bottom - h, width: bar, height: h, rx: Math.min(4, bar / 2), hitX: left + index * step, labelX: left + index * step + step / 2, labelled: index % labelEvery === 0 };
  });
  return { peak, step, bar, y, ticks, bars };
}

export type ShareRow = OverviewBreakdownRow & { share: number | null; width: number };

/** Each row's share of `total` (null when there is no total) and its bar width against the biggest row. */
export function breakdownShares(rows: OverviewBreakdownRow[], total: number): ShareRow[] {
  const peak = Math.max(1, ...rows.map((row) => row.players));
  return rows.map((row) => ({ ...row, share: total ? (100 * row.players) / total : null, width: Math.max(2, (100 * row.players) / peak) }));
}

/** A breakdown value clicked once filters to it; clicked again removes the filter. */
export const toggleValue = (list: string[], value: string): string[] => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

/** "+12" / "-3" / "0": a change with its sign. */
export const signed = (change: number, format: (n: number) => string): string => `${change > 0 ? '+' : ''}${format(change)}`;
