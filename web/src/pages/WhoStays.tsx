// Who stays: what players who come back (or pay) did in their first days that the others didn't
// (separators.py on the server). Association, never cause. The two lists lead; each fact is a row
// with both rates, and a link to the players who have it.
import type { ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { Segmented } from '@avn/ui';
import { useRead } from '@/api';
import { Share } from '@/components/Share';
import { number } from '@/lib/format';
import { useStored } from '@/lib/store';
import { filterQuery } from '@/lib/filters';
import { gamePath, gameURL } from '@/lib/games';
import type { Game, SeparatorFinding, SeparatorOutcome, SeparatorReport } from '@/lib/types';
import { FilterBar, useFilters } from '@/components/Filters';
import { Heading, Metric, QueryRegion, Skeleton } from '@/components/feedback';
import { DoraScene } from '@/components/flavour';
import { chipSearch, OUTCOMES, outcomeNoun, WINDOW_LABELS, windowFor, windowsFor } from './stay/model';

type Report = Extract<SeparatorReport, { available: true }>;

export function WhoStaysPage({ game }: { game: Game }): ReactElement {
  const [filters, setFilters] = useFilters(game);
  // Kept per game, so coming Back from the Players page finds the same question.
  const [outcome, setOutcome] = useStored<SeparatorOutcome>(`avn-stay-outcome-${game.id}`, 'day_7');
  const [days, setDays] = useStored<number>(`avn-stay-window-${game.id}`, 1);
  const window = windowFor(outcome, days);
  const query = filterQuery(filters);
  query.set('outcome', outcome);
  query.set('window_days', String(window));
  const path = `${gameURL(game)}/insights/separators?${query}`;
  const read = useRead<SeparatorReport>(path);
  const windows = windowsFor(outcome);
  return (
    <>
      <Heading title="Who stays" subtitle="What new players who come back or pay did early that the others didn't. These go together; they don't prove a cause." />
      <FilterBar game={game} state={filters} onChange={setFilters}>
        <Segmented<SeparatorOutcome> label="Outcome" value={outcome} onChange={(next) => { setOutcome(next); setDays(windowFor(next, days)); }} options={OUTCOMES.map(({ value, label }) => ({ value, label }))} />
        <Segmented<string> label="Early play" value={String(window)} onChange={(next) => setDays(Number(next))} options={windows.map((value) => ({ value: String(value), label: WINDOW_LABELS[value] ?? `${value} days` }))} />
      </FilterBar>
      <QueryRegion query={read} path={path} skeleton={<Skeleton kind="stats" />}>
        {(report) => (report.available ? <Answer game={game} report={report} /> : <div className="empty-scene"><DoraScene /><p>{report.note}</p></div>)}
      </QueryRegion>
    </>
  );
}

function Answer({ game, report }: { game: Game; report: Report }): ReactElement {
  const clear = report.more_likely.length + report.less_likely.length;
  const verb = report.outcome === 'pays' ? 'pay' : 'come back';
  const noun = outcomeNoun(report.outcome);
  return (
    <>
      <div className="kpis kpis-two">
        <Metric label="New players" value={number(report.players)} note="whose day is over" />
        <Metric label={noun} value={<Share part={report.outcome_players} whole={report.players} unit="players" />} note="of those players" />
      </div>
      {clear ? (
        <div className={`stay-panels${report.more_likely.length && report.less_likely.length ? '' : ' one'}`}>
          <Findings game={game} title={`More likely to ${verb}`} items={report.more_likely} noun={noun} note />
          <Findings game={game} title={`Less likely to ${verb}`} items={report.less_likely} noun={noun} note={!report.more_likely.length} />
        </div>
      ) : <div className="empty-scene"><DoraScene /><p>Nothing they did early separates the two groups clearly.</p></div>}
    </>
  );
}

function Findings({ game, title, items, noun, note = false }: { game: Game; title: string; items: SeparatorFinding[]; noun: string; note?: boolean }): ReactElement | null {
  if (!items.length) return null;
  return (
    <section className="panel">
      <div className="panel-header"><h2>{title}</h2></div>
      <div className="table-wrap">
        <table className="compact-table stay-table">
          <thead><tr><th>Players who</th><th className="num">With it<span className="th-unit">{noun}</span></th><th className="num">Without it<span className="th-unit">{noun}</span></th><th><span className="sr-only">Players</span></th></tr></thead>
          <tbody>
            {items.map((item) => {
              const search = chipSearch(item);
              return (
                <tr key={item.label}>
                  <td>{item.label}</td>
                  <td className="num" data-label="With it"><Share part={item.with.reached} whole={item.with.players} unit="players" label={`${number(item.with.reached)} of ${number(item.with.players)}`} /></td>
                  <td className="num" data-label="Without it"><Share part={item.without.reached} whole={item.without.players} unit="players" label={`${number(item.without.reached)} of ${number(item.without.players)}`} /></td>
                  <td>{search ? <Link className="text-link" to={gamePath(game, 'players')} search={search} title="Opens the Players page with everyone who ever did this, not only new players on their first days">All who ever did this</Link> : <span className="muted" title="Players page groups can't say how many times, or when">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {note ? <p className="foot-note">These go together with it. They don't prove a cause.</p> : null}
    </section>
  );
}
