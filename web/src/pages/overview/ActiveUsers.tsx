// Daily active users: DAU, WAU, MAU and stickiness counted back from the last day of the range, as a
// row of headline numbers without card chrome.
import type { ReactElement, ReactNode } from 'react';
import { addDays, number, prettyDay, shortDay, today } from '@/lib/format';
import type { OverviewActive } from '@/lib/types';
import { signed } from './maths';

/** A row of headline numbers without card chrome. */
export function Stats({ items }: { items: Array<[ReactNode, ReactNode, ReactNode?]> }): ReactElement {
  return <div className="stat-strip">{items.map(([label, value, note], index) => <div key={index} className="stat"><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong>{note ? <span className="stat-note">{note}</span> : null}</div>)}</div>;
}

export function ActiveUsers({ active }: { active: OverviewActive }): ReactElement {
  const trend = `${signed(active.dau - active.dau_previous, number)} vs ${shortDay(addDays(active.last_day, -1))}`;
  const tip = (text: string, label: string) => <span title={text}>{label}</span>;
  return (
    <section className="panel active-users">
      <div className="panel-header"><h2>Daily active users</h2><span className="help">DAU, WAU and MAU count back from {prettyDay(active.last_day)}, the last day of this range{active.last_day === today() ? ' (today, still in progress)' : ''}</span></div>
      <div className="panel-body">
        <Stats items={[
          [tip('Distinct players with at least one event on that day', 'DAU'), number(active.dau), trend],
          [tip('Average distinct players per day across the selected days, empty days count as 0', 'Average DAU'), number(active.avg_dau), `last 7 days ${number(active.avg_dau_7)}`],
          [tip('The day in the range with the most distinct players', 'Peak DAU'), number(active.peak_dau?.players || 0), active.peak_dau ? shortDay(active.peak_dau.day) : ''],
          [tip('Distinct players in the 7 days up to and including that day', 'WAU'), number(active.wau), '7 days'],
          [tip('Distinct players in the 30 days up to and including that day', 'MAU'), number(active.mau), '30 days'],
          [tip('Average DAU over the last 30 days divided by MAU: how much of the monthly audience plays on a typical day', 'Stickiness'), active.stickiness === null ? '—' : `${active.stickiness}%`, 'avg DAU ÷ MAU'],
        ]} />
      </div>
    </section>
  );
}
