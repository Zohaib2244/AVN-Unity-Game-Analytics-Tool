// One bar per day (revenue per day, sessions per day). Bars keep their own width at any card size,
// and fewer than three days are said in words: a lone bar reads as a broken square, not a trend.
import type { ReactElement } from 'react';
import { shortDay } from '@/lib/format';

export type DayPoint = { day: string; value: number };

export function DayBars({ points, label, show, tone }: { points: DayPoint[]; label: string; show: (value: number) => string; tone?: 'info' | 'warn' }): ReactElement {
  if (points.length < 3) {
    return <p className="day-words">{points.map((point) => `${shortDay(point.day.slice(0, 10))}: ${show(point.value)}`).join(' · ')}</p>;
  }
  const top = Math.max(...points.map((point) => point.value), 0.000001);
  return (
    <div className="day-bars-wrap">
      <div className={`mini-bars${tone ? ` ${tone}` : ''}`} role="img" aria-label={`${label}, ${points.length} days, most ${show(top)}`}>
        {points.map((point) => <span key={point.day} className="mini-bar" title={`${shortDay(point.day.slice(0, 10))} · ${show(point.value)}`}><i style={{ height: `${Math.max(3, (100 * point.value) / top)}%` }} /></span>)}
      </div>
      <p className="small muted">{shortDay(points[0]!.day.slice(0, 10))} to {shortDay(points[points.length - 1]!.day.slice(0, 10))}</p>
    </div>
  );
}
