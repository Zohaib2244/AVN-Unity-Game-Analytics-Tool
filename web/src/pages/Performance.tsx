// Performance: where crashes and ad failures cluster (segment_performance.py on the server).
// The answer first (the groups that stand out, in words), then one table per way of cutting players up
// (country, device tier, RAM, OS version, model). A group is flagged only when its sample is large enough.
import { useState, type ReactElement } from 'react';
import { Segmented } from '@avn/ui';
import { useRead } from '@/api';
import { Share } from '@/components/Share';
import { number, plural } from '@/lib/format';
import { filterQuery } from '@/lib/filters';
import { gameURL } from '@/lib/games';
import type { Game, PerformanceDimension, PerformanceReport } from '@/lib/types';
import { FilterBar, useFilters } from '@/components/Filters';
import { Heading, Metric, QueryRegion, Skeleton } from '@/components/feedback';
import { DoraScene } from '@/components/flavour';
import { few, firstDimension, flagged, flaggedGroups, hasAds, hasExits, missing, SHORT_LABELS, topFindings, usable, valueName } from './performance/model';

type Report = Extract<PerformanceReport, { available: true }>;

export function PerformancePage({ game }: { game: Game }): ReactElement {
  const [filters, setFilters] = useFilters(game);
  const path = `${gameURL(game)}/insights/performance?${filterQuery(filters)}`;
  const query = useRead<PerformanceReport>(path);
  return (
    <>
      <Heading title="Performance" subtitle="Where crashes and ads that fail to show cluster by country and device." />
      <FilterBar game={game} state={filters} onChange={setFilters} />
      <QueryRegion query={query} path={path} skeleton={<Skeleton kind="stats" />}>
        {(report) => (report.available ? <Answer report={report} /> : <div className="empty-scene"><DoraScene /><p>Nothing to compare: no app launches or ads in these days.</p></div>)}
      </QueryRegion>
    </>
  );
}

function Answer({ report }: { report: Report }): ReactElement {
  const [chosen, setChosen] = useState<PerformanceDimension | null>(null);
  const options = usable(report);
  const dimension = chosen && options.includes(chosen) ? chosen : firstDimension(report);
  const block = report.dimensions[dimension];
  const everyone = report.everyone;
  const groups = topFindings(report.findings);
  const red = flaggedGroups(report);
  const rows = block?.rows ?? [];
  const exits = hasExits(rows);
  const adColumn = hasAds(rows);
  const absent = missing(report);
  return (
    <>
      <div className="kpis">
        <Metric label="Players" value={number(everyone.players)} note="with launches or ads" />
        <Metric label="Bad exits" value={everyone.exit_total ? <Share part={everyone.exit_bad} whole={everyone.exit_total} unit="launches" /> : '—'} note={everyone.exit_total ? 'launches after a crash or kill' : 'the game sends no previous-exit reasons'} />
        <Metric label="Ads that fail to show" value={everyone.ad_total ? <Share part={everyone.ad_bad} whole={everyone.ad_total} unit="ads" /> : '—'} note={everyone.ad_total ? 'ads asked for that had none' : 'the game sends no ad requests'} />
        <Metric label="Standing out" value={number(red)} note={red ? `${red === 1 ? 'group is' : 'groups are'} clearly worse than the rest` : 'no group is clearly worse'} />
      </div>
      <div className="split perf-split">
        <section className="panel">
          <div className="panel-header">
            <h2>Where it breaks</h2>
            {options.length > 1 ? <Segmented<PerformanceDimension> label="Group by" value={dimension} onChange={setChosen} options={options.map((value) => ({ value, label: SHORT_LABELS[value] }))} /> : null}
          </div>
          {rows.length ? (
            <div className="table-wrap">
              <table className="compact-table perf-table">
                <thead><tr><th>{block.label}</th><th className="num perf-players">Players</th>{exits ? <th className="num" title="Launches whose previous run ended in a crash, an ANR or the system killing the game">Bad exits<span className="th-unit">of launches</span></th> : null}{adColumn ? <th className="num" title="Ads asked for that had none to show">Ads failing<span className="th-unit">of ads asked</span></th> : null}</tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.value}>
                      <td title={valueName(dimension, row.value)}>{dimension === 'country' && row.value !== 'unknown' ? <abbr className="cc" title={valueName(dimension, row.value)}>{row.value}</abbr> : row.value}</td>
                      <td className="num perf-players">{number(row.players)}</td>
                      {exits ? <td className={`num${flagged(row, 'bad_exits') ? ' hot' : ''}${few(row.exit_total, report.min_sample) ? ' few' : ''}`}>{row.exit_total ? <Share part={row.exit_bad} whole={row.exit_total} unit="launches" /> : '—'}</td> : null}
                      {adColumn ? <td className={`num${flagged(row, 'ad_failures') ? ' hot' : ''}${few(row.ad_total, report.min_sample) ? ' few' : ''}`}>{row.ad_total ? <Share part={row.ad_bad} whole={row.ad_total} unit="ads" /> : '—'}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="help panel-body">Nothing to compare in these days.</p>}
          <p className="foot-note" title={`A group is flagged when it is at least 3 points and 1.5 times worse than everyone else, with ${report.min_sample}+ launches or ads.`}>
            Red = clearly worse than everyone else · faint = under {report.min_sample}, too few to judge
            {block && block.groups > rows.length ? ` · ${number(rows.length)} of ${number(block.groups)} shown` : ''}
            {block?.unknown_players ? ` · ${plural(block.unknown_players, 'player')} unknown` : ''}
            {absent.length ? ` · ${absent.join(', ')} not sent` : ''}
          </p>
        </section>
        <section className="panel">
          <div className="panel-header"><h2>Needs a look</h2></div>
          {groups.length
            ? groups.map((group) => (
                <div key={group.key} className="look perf-look">
                  <div><span className="perf-kind">{group.label}</span><b>{valueName(group.dimension, group.value)}</b>{group.sentences.map((sentence) => <span key={sentence} className="s">{sentence}</span>)}{group.same_as.length ? <span className="s dim">Same players: {group.same_as.join(' · ')}</span> : null}</div>
                </div>
              ))
            : <div className="empty-scene"><DoraScene /><p>No country or device stands out. Dora is asleep on the monitor.</p></div>}
        </section>
      </div>
    </>
  );
}
