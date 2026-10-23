// A game's home: the briefing overview. Setup checklist, what changed, key numbers, activity per day
// beside "Needs a look", sections at a glance, daily active users, who's playing and top events.
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { Freshness, Segmented, Tag } from '@avn/ui';
import { freshness, markFresh, refreshAll, useRead } from '@/api';
import { addDays, daysBetween, number, percent, platformLabel, shortDay } from '@/lib/format';
import { DIMENSIONS, DIMENSION_LABELS, filterQuery, type Dimension } from '@/lib/filters';
import { gamePath, gameURL } from '@/lib/games';
import type { Game, OverviewMeasure, OverviewSummary } from '@/lib/types';
import { FilterBar, useFilters } from '@/components/Filters';
import { Heading, Metric, QueryRegion, Skeleton } from '@/components/feedback';
import { DoraScene, NightScene } from '@/components/flavour';
import { Ico } from '@/components/icons';
import { ActiveUsers } from './overview/ActiveUsers';
import { BreakdownTable } from './overview/BreakdownTable';
import { DailyChart } from './overview/DailyChart';
import { MappingNotice } from './overview/MappingNotice';
import { SectionTiles, SetupChecklist, useFacts } from './overview/Setup';
import { signed, toggleValue } from './overview/maths';

const MEASURES: Array<{ value: OverviewMeasure; label: string }> = [{ value: 'players', label: 'Players (DAU)' }, { value: 'sessions', label: 'Sessions' }, { value: 'events', label: 'Events' }];
const TABS = DIMENSIONS.map((key) => ({ value: key, label: DIMENSION_LABELS[key].replace('Device platform', 'Platform').replace('App version', 'Version') }));

export function GameOverviewPage({ game }: { game: Game }): ReactElement {
  const [state, onChange] = useFilters(game);
  const [measure, setMeasure] = useState<OverviewMeasure>('players');
  const [dimension, setDimension] = useState<Dimension>('environment');
  const path = `${gameURL(game)}/insights/summary?${filterQuery(state)}`;
  const query = useRead<OverviewSummary>(path);
  const data = query.data;
  const facts = useFacts(game);
  const updated = useSyncExternalStore(freshness.subscribe, freshness.get, freshness.get);
  useEffect(() => { if (data) markFresh(); }, [data]);
  const loading = data === undefined && !query.isError;
  // A breakdown value clicked once filters to it; clicked again removes the filter. Picking builds by hand
  // means the dashboard no longer follows the latest build.
  const toggle = (key: Dimension, value: string) => onChange((s) => { const list = toggleValue(s[key], value); return { ...s, [key]: list, ...(key === 'app_version' ? { versionMode: list.length ? 'custom' : 'all' } : {}) }; });
  const active = data?.active;
  const context = data?.context;
  const looks = data ? [
    context?.low_sample ? { kind: 'warn' as const, tag: 'Sample', title: 'Small sample', note: `${number(data.players || 0)} of ${number(context.minimum_players)} players` } : null,
    context?.anonymous_events ? { kind: 'warn' as const, tag: 'Data', title: `${number(context.anonymous_events)} event${context.anonymous_events === 1 ? '' : 's'} without a player ID`, note: 'They do not count toward players.' } : null,
  ].filter((item) => item !== null) : [];
  return (
    <>
      <Heading title={game.name} subtitle={`${platformLabel(game.platform)} · ${game.bundle_id}`} actions={<Link className="button primary" to={gamePath(game, 'exports')}><Ico name="export" size={15} /> Export data</Link>} />
      {game.archived_at ? <div className="archived-banner"><Ico name="lock" size={18} /><div><strong>Archived.</strong> Collection is paused for this platform.</div><Link className="button" to={gamePath(game, 'settings')}>Game settings</Link></div> : null}
      <MappingNotice game={game} />
      <FilterBar game={game} state={state} onChange={onChange} context={data ? { ...data.context, players: data.players } : undefined} />
      {data ? <SetupChecklist game={game} data={data} facts={facts} /> : null}
      {data?.anomalies.length ? (
        <>
          <div className="strip-h"><span className="eyebrow">What changed · vs the preceding {daysBetween(state.range.from, state.range.to) + 1}-day period</span></div>
          <div className="insights">
            {data.anomalies.map((item) => <div key={item.metric} className="insight"><Tag kind="plain" dot>{item.direction === 'down' ? 'Down' : 'Up'}</Tag><b>{item.label} {signed(item.change_percent, percent)}</b><span className="s">{number(item.previous)} → {number(item.current)}</span></div>)}
          </div>
        </>
      ) : null}
      <QueryRegion query={query} path={path} skeleton={<Skeleton kind="stats" />}>
        {(summary) => {
          const a = summary.active || {};
          const change = (a.dau || 0) - (a.dau_previous || 0);
          return (
            <div className="kpis">
              <Metric label="Players" value={number(summary.players)} note={`${number(summary.new_players)} new · unique player IDs`} />
              <Metric label="Sessions" value={number(summary.sessions)} note={summary.players ? `${(summary.sessions / summary.players).toFixed(1)} per player` : 'with a player ID'} />
              <Metric label="Daily active" value={number(a.dau || 0)} note={summary.events ? <><span className={`d ${change < 0 ? 'down' : 'up'}`}>{signed(change, number)}</span> vs {shortDay(addDays(a.last_day, -1))}</> : 'no events yet'} />
              <Metric label="Stickiness" value={a.stickiness == null ? '—' : <>{a.stickiness}<small>%</small></>} note="avg DAU ÷ MAU" />
            </div>
          );
        }}
      </QueryRegion>
      <div className="split">
        <section className="panel">
          <div className="panel-header">
            <div><h2>Activity per day</h2></div>
            <div className="quiet-actions"><Freshness updatedAt={updated} refreshing={query.isFetching} onRefresh={() => void refreshAll()} /><Segmented label="Measure" value={measure} onChange={setMeasure} options={MEASURES} /></div>
          </div>
          <div className="panel-body chart-wrap">
            {loading ? <Skeleton kind="chart" /> : data ? (data.events ? <DailyChart days={data.days} range={state.range} measure={measure} /> : <div className="empty-scene"><NightScene /><p>No events with these filters and days.</p></div>) : null}
          </div>
        </section>
        <section className="panel">
          <div className="panel-header"><h2>Needs a look</h2></div>
          {data ? (looks.length
            ? looks.map((item) => <div key={item.tag} className="look"><Tag kind={item.kind}>{item.tag}</Tag><div><b>{item.title}</b><span className="s">{item.note}</span></div></div>)
            : <div className="empty-scene"><DoraScene /><p>Nothing needs a look in this range. Dora is asleep on the monitor.</p></div>) : null}
        </section>
      </div>
      {data ? <SectionTiles game={game} data={data} facts={facts} /> : null}
      {data?.events && active ? <ActiveUsers active={active} /> : null}
      <div className="section-grid overview-grid section-spacing">
        <section className="panel">
          <div className="panel-header"><h2>Who’s playing</h2><Segmented label="Break down by" value={dimension} onChange={setDimension} options={TABS} /></div>
          {loading ? <Skeleton rows={5} columns={3} /> : data ? <BreakdownTable dimension={dimension} rows={data.breakdowns[dimension] || []} total={data.players} chosen={state[dimension]} onToggle={toggle} /> : null}
        </section>
        <section className="panel">
          <div className="panel-header"><h2>Top events</h2><div className="quiet-actions"><span className="help">{data ? `${number(data.events)} events` : ''}</span><Link className="text-link" to={gamePath(game, 'dictionary')}>Dictionary <Ico name="arrow" size={13} /></Link></div></div>
          {loading ? <Skeleton rows={5} columns={3} /> : data ? (data.top_events.length
            ? <table className="compact-table"><thead><tr><th>Event</th><th className="num">Events</th><th className="num">Players</th></tr></thead><tbody>{data.top_events.slice(0, 10).map((row) => <tr key={row.name}><td className="mono">{row.name}</td><td className="num">{number(row.events)}</td><td className="num">{number(row.players)}</td></tr>)}</tbody></table>
            : <p className="help panel-body">No events.</p>) : null}
        </section>
      </div>
    </>
  );
}
