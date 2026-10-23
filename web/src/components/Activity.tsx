// Event activity for any days: a total, then one row per day with a relative bar. Used by Game settings
// and Server status. Counts come live from /health (never cached).
import { useState, type ReactElement } from 'react';
import { useRead } from '@/api';
import { addDays, number, prettyDay } from '@/lib/format';
import { gameURL } from '@/lib/games';
import type { DayRange } from '@/lib/filters';
import type { Game, Health } from '@/lib/types';
import { DateRange, resolveRange } from './DateRange';
import { QueryRegion, Skeleton } from './feedback';
import { NightScene } from './flavour';

export const healthPath = (game: Pick<Game, 'id'>, range: DayRange, basis = 'server_ts', extra = ''): string => `${gameURL(game)}/health?${new URLSearchParams({ period: 'custom', date: range.from, end_date: range.to, basis })}${extra ? `&${extra}` : ''}`;

export function RangeResult({ health, range }: { health: Health; range: DayRange }): ReactElement {
  const counts = new Map(health.days.map((day) => [day.day, day.events]));
  const days: Array<{ day: string; events: number }> = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) days.push({ day, events: counts.get(day) || 0 });
  const peak = Math.max(1, ...days.map((day) => day.events));
  const span = days.length;
  return (
    <>
      <div className="range-total"><strong>{number(health.total)}</strong><span>events · {prettyDay(range.from)}{span > 1 ? ` → ${prettyDay(range.to)}` : ''} · {span} day{span === 1 ? '' : 's'}</span></div>
      {health.total ? (
        <div className="table-wrap"><table><thead><tr><th>Day</th><th>Events</th><th><span className="sr-only">Relative volume</span></th></tr></thead><tbody>
          {days.map((day) => <tr key={day.day}><td>{day.day}</td><td>{number(day.events)}</td><td className="range-bar"><progress className="progress mini" max={peak} value={day.events} aria-label={`${day.events} events on ${day.day}`} /></td></tr>)}
        </tbody></table></div>
      ) : <div className="empty-scene"><NightScene /><p>No events in this range.</p></div>}
    </>
  );
}

export function Activity({ game, basis = 'server_ts' }: { game: Pick<Game, 'id'>; basis?: string }): ReactElement {
  const [range, setRange] = useState<DayRange>(() => resolveRange('7'));
  const query = useRead<Health>(healthPath(game, range, basis));
  return (
    <>
      <DateRange value={range} onChange={setRange} />
      <div className="range-result" aria-live="polite">
        <QueryRegion query={query} skeleton={<Skeleton kind="chart" />} note={false}>{(health) => <RangeResult health={health} range={range} />}</QueryRegion>
      </div>
    </>
  );
}
