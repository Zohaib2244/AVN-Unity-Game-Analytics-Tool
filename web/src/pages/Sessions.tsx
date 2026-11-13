// How long sessions are, how they ended, why players left and whether the numbers can be trusted.
// Summary first: key numbers, then length per day beside how sessions ended, then the detail tables.
// One session is one row on the server (session_state.py), so nothing here counts raw session_end events.
import { Share } from '@/components/Share';
import { useState, type ReactElement } from 'react';
import { Segmented } from '@avn/ui';
import { useRead } from '@/api';
import { duration, number, plural, platformLabel, shortDay } from '@/lib/format';
import { filterQuery } from '@/lib/filters';
import { gameURL } from '@/lib/games';
import type { Game, SessionReport } from '@/lib/types';
import { FilterBar, useFilters } from '@/components/Filters';
import { Heading, Metric, QueryRegion, Skeleton } from '@/components/feedback';
import { NightScene } from '@/components/flavour';
import { DayChart } from './overview/DailyChart';
import { fillDays } from './overview/maths';
import { adLabel, BarTable, ENDINGS, importanceLabel, leaveLabel, reasonLabel, share, type TrendMeasure, TRENDS, trendValues } from './sessions/model';

export function SessionsPage({ game }: { game: Game }): ReactElement {
  const [state, onChange] = useFilters(game, true);
  const [trend, setTrend] = useState<TrendMeasure>('median_seconds');
  const path = `${gameURL(game)}/insights/sessions?${filterQuery(state)}`;
  const query = useRead<SessionReport>(path);
  return (
    <>
      <Heading title="Sessions" subtitle="How long players stay, how sessions end and why they left." />
      <FilterBar playerGroups game={game} state={state} onChange={onChange} />
      <QueryRegion query={query} path={path} skeleton={<Skeleton kind="stats" />}>
        {(report) => (report.sessions ? <Report report={report} trend={trend} onTrend={setTrend} range={state.range} /> : <div className="empty-scene"><NightScene /><p>No sessions started with these filters and days.</p></div>)}
      </QueryRegion>
    </>
  );
}

function Report({ report, trend, onTrend, range }: { report: SessionReport; trend: TrendMeasure; onTrend: (value: TrendMeasure) => void; range: { from: string; to: string } }): ReactElement {
  const chosen = TRENDS.find((item) => item.value === trend)!;
  const open = report.in_progress + report.waiting;
  const change = report.measure_change;
  const recent = report.changing_from <= range.to;
  const ended = ENDINGS.map(({ key, label }) => ({ label, value: report.ends[key] || 0 })).filter((row) => row.value);
  const stillOpen = [...(report.in_progress ? [{ label: 'In progress', value: report.in_progress }] : []), ...(report.waiting ? [{ label: 'May come back', value: report.waiting }] : [])];
  return (
    <>
      <div className="kpis">
        <Metric label="Sessions" value={number(report.sessions)} note={`${(report.sessions / Math.max(1, report.players)).toFixed(1)} per player${report.in_progress ? ` · ${number(report.in_progress)} in progress` : ''}`} />
        <Metric label="Median length" value={duration(report.median_seconds)} note={`${number(report.closed)} finished ${report.closed === 1 ? 'session' : 'sessions'}`} />
        <Metric label="Average length" value={duration(report.average_seconds)} note={`${duration(report.play_seconds)} played in total`} />
        <Metric label="Time away in ads" value={report.away_seconds ? <Share part={report.ad_away_seconds} whole={report.away_seconds} label={duration(report.ad_away_seconds)} /> : '—'} note={`of ${duration(report.away_seconds)} away`} />
      </div>
      <div className="split">
        <section className="panel">
          <div className="panel-header">
            <div><h2>{chosen.title}</h2><p>{chosen.note}</p></div>
            <div className="quiet-actions"><Segmented label="Measure" value={trend} onChange={onTrend} options={TRENDS.map(({ value, label }) => ({ value, label }))} /></div>
          </div>
          <div className="panel-body chart-wrap">
            <DayChart series={fillDays(trendValues(report, trend), range)} label={chosen.title} format={chosen.format} tip={chosen.tip} softFrom={report.changing_from} marker={change ? { day: change.day, label: `Measured differently from ${change.version}` } : undefined} />
            {recent ? <p className="help">From {shortDay(report.changing_from)} on, late events can still change this.</p> : null}
            {change ? <p className="help">Length changed how it is measured from version {change.version}, on {shortDay(change.day)}. A step there is the measurement, not the players.</p> : null}
          </div>
        </section>
        <section className="panel">
          <div className="panel-header"><h2>How sessions ended</h2></div>
          <BarTable head="Ending" unit="Sessions" rows={[...ended, ...stillOpen]} total={report.sessions} />
          {open ? <p className="help panel-body">Sessions still open leave the averages out until they finish.</p> : null}
        </section>
      </div>
      <div className="session-grid">
        <section className="panel"><div className="panel-header"><h2>Session length</h2></div><BarTable head="Length" unit="Sessions" rows={report.lengths.map(({ label, sessions }) => ({ label, value: sessions }))} total={report.closed} /></section>
        <section className="panel"><div className="panel-header"><h2>Why players left the app</h2></div>{report.leaves.length ? <BarTable head="Cause" unit="Trips" rows={report.leaves.map(({ cause, trips }) => ({ label: leaveLabel(cause), value: trips }))} total={report.leaves.reduce((sum, row) => sum + row.trips, 0)} /> : <p className="help panel-body">No trips to the background in these days.</p>}</section>
        <section className="panel"><div className="panel-header"><h2>Background trips per session</h2></div><BarTable head="Trips" unit="Sessions" rows={report.trips.map(({ label, sessions }) => ({ label, value: sessions }))} total={report.sessions} /></section>
        <section className="panel"><div className="panel-header"><h2>Time away</h2></div><BarTable head="Away for" unit="Returns" rows={report.aways.map(({ label, sessions }) => ({ label, value: sessions }))} total={report.aways.reduce((sum, row) => sum + row.sessions, 0)} /></section>
      </div>
      <PreviousRuns report={report} />
      <Quality report={report} />
    </>
  );
}

function PreviousRuns({ report }: { report: SessionReport }): ReactElement {
  const { total, rows, formats } = report.previous_runs;
  return (
    <section className="panel session-detail">
      <div className="panel-header"><div><h2 title="Launches after the app stopped in the background · which ad was open · Android 11 and up">Why the previous run ended</h2></div></div>
      {rows.length ? (
        <div className="table-wrap">
          <table className="compact-table">
            <thead><tr><th>Reason</th><th>App was</th><th className="num">Launches</th><th className="num">Share</th>{formats.map((name) => <th key={name} className="num">{adLabel(name)}</th>)}</tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.reason}-${row.importance}`}><td>{reasonLabel(row.reason)}</td><td>{importanceLabel(row.importance)}</td><td className="num">{number(row.launches)}</td><td className="num muted">{share(row.launches, total)}</td>{formats.map((name) => <td key={name} className="num">{number(row.ads[name] || 0)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : <p className="help panel-body">No launches after a background stop in these days.</p>}
    </section>
  );
}

function Quality({ report }: { report: SessionReport }): ReactElement {
  return (
    <section className="panel session-detail">
      <div className="panel-header"><div><h2 title="Are sessions ending properly on each app version? The app should close more, the server guess less and ends should arrive in seconds.">Data quality</h2></div></div>
      <div className="table-wrap">
        <table className="compact-table">
          <thead><tr><th>Platform</th><th>Version</th><th className="num">Sessions</th><th className="num">Game reported the end</th><th className="num">Server guessed</th><th className="num">End arrives after</th><th className="num">Duplicates</th><th className="num">Rejected batches</th></tr></thead>
          <tbody>{report.quality.map((row) => <tr key={`${row.platform}-${row.app_version}`}><td>{platformLabel(row.platform)}</td><td className="mono">{row.app_version}</td><td className="num">{number(row.sessions)}</td><td className="num">{row.client_percent == null ? '—' : <Share part={row.client} whole={row.sessions} percent={row.client_percent} unit="sessions" />}</td><td className="num">{row.inferred_percent == null ? '—' : <Share part={row.inferred} whole={row.sessions} percent={row.inferred_percent} unit="sessions" />}</td><td className="num">{duration(row.median_end_delay)}</td><td className="num">{row.duplicate_percent == null || row.events == null ? '—' : <Share part={Math.round((row.events * row.duplicate_percent) / 100)} whole={row.events} percent={row.duplicate_percent} unit="events" />}</td><td className="num">{row.rejected == null ? '—' : number(row.rejected)}</td></tr>)}</tbody>
        </table>
      </div>
      {report.delivery.length ? (
        <div className="table-wrap session-delivery">
          <table className="compact-table">
            <thead><tr><th>Sent by</th><th className="num">{report.ingest_counts_available ? 'Events' : 'Events kept'}</th><th className="num">End arrives after</th></tr></thead>
            <tbody>{report.delivery.map((row) => <tr key={row.delivery}><td className="mono">{row.delivery}</td><td className="num">{number(row.events)}</td><td className="num">{duration(row.median_end_delay)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}
      <p className="help panel-body">{report.old_way ? `${plural(report.old_way, 'session')} in these days came from app versions that measure length the old way. ` : ''}{report.ingest_counts_available ? 'Duplicates, rejected batches and delivery are counted from the day this page was added.' : 'Duplicate and rejection totals are unavailable for these filters: refused batches have no player or country. Delivery counts show matching events kept.'}</p>
    </section>
  );
}
