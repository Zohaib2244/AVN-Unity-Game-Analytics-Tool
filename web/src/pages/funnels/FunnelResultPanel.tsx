// The result: the headline sentence and key numbers first, then one bar per step with the players lost
// between steps (the lost share in the warning colour, the biggest drop flagged) and who stopped there.
// The breakdown panel splits every step by segment.
import type { ReactElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CollapsiblePanel } from '@/components/Collapsible';
import { Metric, QueryRegion, Skeleton } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { DIMENSION_LABELS } from '@/lib/filters';
import { dimensionText, displayDate, duration, number, percent, platformLabel, shortId } from '@/lib/format';
import { gamePath } from '@/lib/games';
import { downloadCSV } from '@/lib/store';
import type { FunnelResult, FunnelResultRow, Game, Times } from '@/lib/types';
import { barWidth, biggestDrop, conversion, funnelCSV, lostShare, stepLabel, windowLabel, type Definition } from './funnelMath';

export type FunnelResultPanelProps = {
  game: Game;
  query: UseQueryResult<FunnelResult>;
  path: string;
  /** What was run: undefined before the first run, null while the funnel has fewer than two steps. */
  submitted: Definition | null | undefined;
  range: { from: string; to: string };
  panelsKey: number;
};

const timingTitle = (times: NonNullable<Times>) => `${number(times.count)} players · average ${duration(times.average)} · fastest ${duration(times.min)} · slowest ${duration(times.max)}`;

export function FunnelResultPanel({ game, query, path, submitted, range, panelsKey }: FunnelResultPanelProps): ReactElement {
  const data = submitted ? query.data : undefined;
  const rows = data?.steps ?? [];
  const first = rows[0]?.players ?? 0;
  const last = rows[rows.length - 1];
  const note = !submitted ? 'Add at least two steps.' : !data ? ''
    : first ? `${submitted.scope === 'session' ? 'Each player’s best single session' : 'Each player, across all their sessions'}${submitted.window_hours ? ` · finished within ${windowLabel(submitted.window_hours)}` : ''} · hover times for averages`
      : 'Nobody did the first step with these filters and days.';
  const folded = data && last ? (first ? `${number(first)} started · ${number(last.players)} completed · ${percent(last.of_first)}` : 'nobody did step 1') : undefined;
  const csv = () => { if (data) downloadCSV(`${game.name}-${platformLabel(game.platform)}-funnel-${range.from}_${range.to}.csv`, funnelCSV(data.steps)); };
  const worst = biggestDrop(rows);
  return (
    <>
      <CollapsiblePanel key={panelsKey} game={game} name="result" className="section-spacing" note={folded}
        header={<div><h2>Result</h2><p id="funnel-note">{note}</p></div>}
        actions={data ? <button className="button small-button" type="button" id="funnel-csv" onClick={csv}><Ico name="export" size={14} /> CSV</button> : null}>
        {submitted === undefined ? <div className="panel-body" id="funnel-result"><p className="help">No result yet.</p></div> : submitted === null ? <div className="panel-body" id="funnel-result"><p className="help">Add at least two steps.</p></div> : (
          <QueryRegion query={query} path={path} skeleton={<div className="panel-body"><Skeleton kind="table" rows={5} columns={4} /></div>}>
            {(result) => (
              <>
                {result.steps[0]?.players ? <Summary data={result} /> : null}
                <div className={`panel-body ${result.steps.length > 15 ? 'many' : ''}`} id="funnel-result">
                  <ol className="funnel">
                    {result.steps.map((row, index) => (
                      <StepRow key={index} game={game} row={row} index={index} first={result.steps[0]?.players ?? 0} worst={index === worst} />
                    ))}
                  </ol>
                </div>
              </>
            )}
          </QueryRegion>
        )}
      </CollapsiblePanel>
    </>
  );
}

function Summary({ data }: { data: FunnelResult }): ReactElement {
  const rows = data.steps; const first = rows[0]!; const last = rows[rows.length - 1]!;
  return (
    <div className="panel-body funnel-stats" id="funnel-summary">
      <p className="funnel-headline"><strong>{percent(last.of_first)}</strong> of players who did “{stepLabel(first)}” went on to “{stepLabel(last)}”.</p>
      <div className="kpis">
        <Metric label="Started" value={number(first.players)} note="did step 1" />
        <Metric label="Completed" value={number(last.players)} note="reached the last step" />
        <Metric label="Conversion" value={percent(last.of_first)} note="first → last step" />
        <Metric label="Time to complete" value={data.time_to_complete ? duration(data.time_to_complete.median) : '—'} note={data.time_to_complete ? `median · 90% within ${duration(data.time_to_complete.p90)}` : 'nobody finished'} />
      </div>
    </div>
  );
}

/** The gap before a step (who continued, who was lost) and the step's bar, count and who stopped there. */
function StepRow({ game, row, index, first, worst }: { game: Game; row: FunnelResultRow; index: number; first: number; worst: boolean }): ReactElement {
  const times = row.time_from_previous;
  return (
    <>
      {index ? (
        <li className={`funnel-gap ${worst ? 'worst' : ''}`}>
          <span>{percent(row.of_previous)} continued · <span className="lost">{percent(lostShare(row.of_previous))} lost</span>{worst ? <> <strong className="gap-flag">Biggest drop</strong></> : null}</span>
          {times ? <span title={timingTitle(times)}>median {duration(times.median)} · 90% within {duration(times.p90)}</span> : null}
        </li>
      ) : null}
      <li className="funnel-row">
        <div className="funnel-label"><span className="step-number">{String(index + 1).padStart(2, '0')}</span><span>{stepLabel(row)}</span></div>
        <div className="funnel-bar" title={`${number(row.players)} players · ${percent(row.of_first)} of step 1`}><span style={{ width: `${barWidth(row, first)}%` }} /></div>
        <div className="funnel-numbers"><strong>{number(row.players)}</strong><span>{percent(row.of_first)}</span></div>
        {row.dropped ? (
          <details className="dropped">
            <summary>{number(row.dropped)} stopped here · see who</summary>
            <div className="dropped-list">
              {row.dropped_sample.map((item) => (
                <Link key={item.player} to={gamePath(game, 'players')} search={{ player: item.player }}><span className="mono">{shortId(item.player)}</span><span className="small muted">last step {displayDate(item.last_seen)}</span></Link>
              ))}
              {row.dropped > row.dropped_sample.length ? <p className="small muted">Showing the {row.dropped_sample.length} most recent of {number(row.dropped)}.</p> : null}
            </div>
          </details>
        ) : null}
      </li>
    </>
  );
}

/** The breakdown panel: the steps split by segment. The page shows it only when the run had a breakdown. */
export function Breakdown({ game, data }: { game: Game; data: FunnelResult }): ReactElement {
  const dimension = data.breakdown!;
  return (
    <CollapsiblePanel game={game} name="breakdown" className="section-spacing" id="breakdown-panel"
      header={<div><h2 id="breakdown-title">By {DIMENSION_LABELS[dimension].toLowerCase()}</h2><p>Players reaching each step, per segment · a player’s segment comes from their step 1 event</p></div>}>
      <div id="breakdown-result">
        {data.segments.length ? (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{DIMENSION_LABELS[dimension]}</th>{data.steps.map((row, index) => <th key={index} className="num" title={row.label || row.event}>{String(index + 1).padStart(2, '0')}</th>)}<th className="num">Conversion</th></tr></thead>
                <tbody>
                  {data.segments.map((segment) => {
                    const rate = conversion(segment.players[0] ?? 0, segment.players[segment.players.length - 1] ?? 0);
                    return <tr key={segment.value}><td>{dimensionText(dimension, segment.value)}</td>{segment.players.map((count, index) => <td key={index} className="num">{number(count)}</td>)}<td className="num"><strong>{rate == null ? '—' : percent(rate)}</strong></td></tr>;
                  })}
                </tbody>
              </table>
            </div>
            {data.segments_total > data.segments.length ? <p className="help panel-body">Showing the {data.segments.length} largest of {data.segments_total} segments.</p> : null}
          </>
        ) : <p className="help panel-body">No segments.</p>}
      </div>
    </CollapsiblePanel>
  );
}
