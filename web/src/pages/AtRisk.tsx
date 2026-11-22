// At risk: players who have gone quiet for longer than they usually do (churn_risk.py on the server).
// A comparison with each player's own rhythm, not a prediction. The group is the same one the Players page
// can hold (chip "At risk"), and the list can be taken away as a CSV.
import type { ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { Segmented } from '@avn/ui';
import { useRead } from '@/api';
import { Share } from '@/components/Share';
import { Heading, Metric, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { DoraScene } from '@/components/flavour';
import { number, shortDay } from '@/lib/format';
import { useStored } from '@/lib/store';
import { gamePath, gameURL } from '@/lib/games';
import type { ChurnReport, ChurnState, Game } from '@/lib/types';
import { ago, earlyWords, groupSearch, habit, skipped, STATES, stateWord } from './risk/model';

type Report = Extract<ChurnReport, { available: true }>;
/** How many players the page lists; the whole group is in the CSV and on the Players page. */
const SHOWN = 50;

export function AtRiskPage({ game }: { game: Game }): ReactElement {
  // Kept per game, so coming Back from a player finds the same list.
  const [state, setState] = useStored<ChurnState>(`avn-risk-state-${game.id}`, 'slipping');
  const notify = useNotify();
  const path = `${gameURL(game)}/insights/churn-risk?state=${state}&limit=${SHOWN}`;
  const query = useRead<ChurnReport>(path);
  const download = async () => {
    const response = await fetch(`${gameURL(game)}/insights/churn-risk/export?state=${state}`, { credentials: 'same-origin' });
    if (!response.ok) { notify.toast('The list could not be downloaded.', null, 'error'); return; }
    const url = URL.createObjectURL(await response.blob());
    const anchor = Object.assign(document.createElement('a'), { href: url, download: `${game.bundle_id}-at-risk-${state}.csv` });
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const ready = query.data?.available === true;
  return (
    <>
      <Heading
        title="At risk"
        subtitle="Players who have been away longer than they usually are. A comparison with their own habit, not a prediction."
        actions={ready ? (
          <div className="quiet-actions">
            <Link className="btn sm" to={gamePath(game, 'players')} search={groupSearch(state)} title="The Players page counts only players active in the days it shows">Open in Players</Link>
            <button type="button" className="btn sm" onClick={() => void download()}>Download CSV</button>
          </div>
        ) : null}
      />
      <QueryRegion query={query} path={path} skeleton={<Skeleton kind="stats" />}>
        {(report) => (report.available ? <Answer game={game} report={report} state={state} onState={setState} /> : <div className="empty-scene"><DoraScene /><p>{report.note}</p></div>)}
      </QueryRegion>
    </>
  );
}

function Answer({ game, report, state, onState }: { game: Game; report: Report; state: ChurnState; onState: (value: ChurnState) => void }): ReactElement {
  const c = report.counts;
  return (
    <>
      <div className="kpis">
        <Metric label="Playing as usual" value={<Share part={c.steady} whole={c.measured} unit="players" />} note="of players with 3+ days played" />
        <button type="button" className="kpi-button" onClick={() => onState('slipping')} title="Show these players"><Metric label="Slipping" value={<Share part={c.slipping} whole={c.measured} unit="players" />} note="away 2× their usual gap" /></button>
        <button type="button" className="kpi-button" onClick={() => onState('gone')} title="Show these players"><Metric label="Gone" value={<Share part={c.gone} whole={c.measured} unit="players" />} note="away 5× their usual gap" /></button>
        <Metric label="Long gone" value={number(c.long_gone)} note="over 60 days, not in Gone" />
      </div>
      <section className="panel">
        <div className="panel-header">
          <h2>Players</h2>
          <Segmented<ChurnState> label="Show" value={state} onChange={onState} options={STATES.map(({ value, label }) => ({ value, label }))} />
        </div>
        {report.players.length ? (
          <div className="table-wrap">
            <table className="compact-table risk-table">
              <thead><tr><th>Player</th>{state === 'any' ? <th>Status</th> : null}<th className="num">Away</th><th>Usually plays</th><th className="num">Days played</th></tr></thead>
              <tbody>
                {report.players.map((row) => (
                  <tr key={row.player} title={row.words}>
                    <td data-label="Player">
                      <Link to={gamePath(game, 'players')} search={{ player: row.player }} className="row-title mono" title={row.player}>{row.player.length > 14 ? `${row.player.slice(0, 13)}…` : row.player}</Link>
                      {skipped(row) ? <span className="risk-note">{skipped(row)}</span> : null}
                    </td>
                    {state === 'any' ? <td data-label="Status">{stateWord(row.state)}</td> : null}
                    <td className="num" data-label="Away" title={`Last played ${shortDay(row.last_day)}`}>{ago(row.days_away)}</td>
                    <td data-label="Usually plays">{habit(row.usual_gap)}</td>
                    <td className="num" data-label="Days played">{number(row.days_played)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="help panel-body">Nobody is {state === 'any' ? 'quieter than usual' : state} right now.</p>}
        <p className="foot-note">As of {shortDay(report.as_of)} · a habit comparison, not a prediction{report.total > report.listed ? ` · ${number(report.listed)} of ${number(report.total)} shown, all are in the CSV` : ''}</p>
        {report.early_facts.map((fact) => <p key={fact.human} className="foot-note">{earlyWords(fact)}</p>)}
      </section>
    </>
  );
}
