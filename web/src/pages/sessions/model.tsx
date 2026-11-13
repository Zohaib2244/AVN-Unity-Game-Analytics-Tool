// The words and small sums of the Sessions page, and its one table with bars.
import type { ReactElement } from 'react';
import { duration, number, percentFixed } from '@/lib/format';
import type { SessionReport } from '@/lib/types';

export type TrendMeasure = 'median_seconds' | 'average_seconds' | 'sessions';
export const TRENDS: Array<{ value: TrendMeasure; label: string; title: string; note: string; tip: string; format: (value: number) => string }> = [
  { value: 'median_seconds', label: 'Median', title: 'Median session length', note: 'Finished sessions, by the day they started', tip: 'median', format: duration },
  { value: 'average_seconds', label: 'Average', title: 'Average session length', note: 'Finished sessions, by the day they started', tip: 'average', format: duration },
  { value: 'sessions', label: 'Sessions', title: 'Sessions per day', note: 'Each session counts once, on the day it started', tip: 'sessions', format: number },
];

/** The value of one measure on each day that has sessions; a day with no finished session has no length. */
export const trendValues = (report: Pick<SessionReport, 'days'>, measure: TrendMeasure): Record<string, number> => Object.fromEntries(report.days.map((day) => [day.day, day[measure] ?? 0]));

export const ENDINGS = [
  { key: 'background', label: 'Left the app' },
  { key: 'quit', label: 'Closed by the app' },
  { key: 'recovered', label: 'Recovered at next launch' },
  { key: 'inferred', label: 'Closed by the server, no end received' },
];

const LEAVES: Record<string, string> = { Ad: 'For an ad', Player: 'Player left', Purchase: 'For a purchase', Unknown: 'No reason given' };
export const leaveLabel = (cause: string): string => LEAVES[cause] ?? cause;

const REASONS: Record<string, string> = {
  UserRequested: 'Swiped away or force-stopped', LowMemory: 'Android closed it for memory', Crash: 'Crash', CrashNative: 'Native crash', Anr: 'App not responding',
  ExitSelf: 'The app closed itself', Signaled: 'Stopped by a signal', Freezer: 'Frozen by Android', Other: 'Other', Unknown: 'No reason given',
};
export const reasonLabel = (reason: string): string => REASONS[reason] ?? reason;

const IMPORTANCES: Record<string, string> = { Cached: 'In the background', Visible: 'Visible', Foreground: 'On screen' };
export const importanceLabel = (importance: string | null): string => (importance ? IMPORTANCES[importance] ?? importance : '—');

/** "None" is an answer (no ad was open); a missing field arrives as "unknown" and must not read like it. */
export const adLabel = (ad: string): string => (ad === 'None' ? 'No ad open' : ad === 'unknown' ? 'Unknown' : ad);

export const share = (part: number, total: number): string => (total ? percentFixed((100 * part) / total) : '—');

export function BarTable({ head, unit, rows, total }: { head: string; unit: string; rows: Array<{ label: string; value: number }>; total: number }): ReactElement {
  const peak = Math.max(1, ...rows.map((row) => row.value));
  return (
    <table className="breakdown">
      <thead><tr><th>{head}</th><th><span className="sr-only">Share bar</span></th><th className="num">{unit}</th><th className="num">Share</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.label}><td>{row.label}</td><td className="breakdown-bar"><span style={{ width: `${row.value ? Math.max(2, (100 * row.value) / peak) : 0}%` }} /></td><td className="num">{number(row.value)}</td><td className="num muted">{share(row.value, total)}</td></tr>)}</tbody>
    </table>
  );
}
