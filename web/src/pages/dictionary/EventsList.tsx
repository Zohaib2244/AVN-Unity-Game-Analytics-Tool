// Every event the game sent or defined: how often, by how many players, what it means. A row opens that
// event's panel (Meaning: describe it and its parameters, Activity: per day, version, environment and
// country, Examples: the latest raw events). Counts are for the selected days and filters.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { useRead, write } from '@/api';
import { FilterBar, useFilters } from '@/components/Filters';
import { ConfirmDialog, Empty, LoadError, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { Sparkline } from '@/components/Sparkline';
import { conceptName } from '@/lib/concepts';
import { filterQuery } from '@/lib/filters';
import { agoText, analysisDate, countryText, fileSize, number } from '@/lib/format';
import { gamePath, gameURL } from '@/lib/games';
import { storeGet, storeSet, downloadCSV } from '@/lib/store';
import type { DictionaryData, DictionaryEvent, EventDetail, Game } from '@/lib/types';
import { DailyChart } from '../overview/DailyChart';
import { ruleText } from '../event-setup/rules';
import { EVENT_FILTERS, EVENT_SORTS, cleanEventsView, eventsViewKey, nextUndescribed, visibleEvents, type EventsFilter, type EventsSort } from './eventsModel';

type Tab = 'meaning' | 'activity' | 'examples';
const TABS: Array<[Tab, string]> = [['meaning', 'Meaning'], ['activity', 'Activity'], ['examples', 'Examples']];

function StatusPills({ item, staleDays }: { item: DictionaryEvent; staleDays: number }): ReactElement {
  return (
    <>
      {item.sdk && !item.described ? <span className="pill">Built in</span> : item.described ? <span className="pill good">Described</span> : <span className="pill bad">Needs a description</span>}
      {item.status === 'never' ? <> <span className="pill bad">Never received</span></> : item.status === 'stale' ? <> <span className="pill bad" title={`Last sent ${agoText(item.ever?.last_seen)}`}>Quiet {staleDays}+ days</span></> : null}
    </>
  );
}

/** The Meaning tab: the description, what each parameter means, how it reads in stories, hidden, save and delete. */
function Meaning({ game, item, detail, list, onSaved, onOpenNext }: { game: Game; item: DictionaryEvent; detail: ReturnType<typeof useRead<EventDetail>>; list: DictionaryEvent[]; onSaved: () => void; onOpenNext: (name: string) => void }): ReactElement {
  const { toast, toastError } = useNotify();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const definition = item.definition;
  const observed = detail.data?.params ?? [];
  const known = new Set(observed.map((param) => param.key));
  const rows = [
    ...observed.map((param) => ({ key: param.key, types: param.types, count: param.count, values: param.values, distinct: param.distinct, quiet: false })),
    ...Object.keys(definition.params).filter((key) => !known.has(key)).map((key) => ({ key, types: [] as string[], count: 0, values: [], distinct: 0, quiet: true })),
  ];
  const url = `${gameURL(game)}/dictionary/${encodeURIComponent(item.name)}`;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const next = (event.nativeEvent as SubmitEvent).submitter?.hasAttribute('data-save-next') ?? false;
    const data = new FormData(form);
    const params: Record<string, string> = {};
    for (const [key, value] of data) if (key.startsWith('param:') && typeof value === 'string' && value.trim()) params[key.slice(6)] = value.trim();
    // A parameter whose box is not on screen (the panel is still loading) keeps what it had.
    for (const [key, value] of Object.entries(definition.params)) if (!(key in params) && !form.querySelector(`[name="param:${CSS.escape(key)}"]`)) params[key] = value;
    const body = { description: String(data.get('description') ?? '').trim(), params, labels: String(data.get('labels') ?? '').trim(), hidden: data.get('hidden') === '1', canonical: definition.canonical };
    const after = next ? nextUndescribed(list, item.name) : null;
    setBusy(true);
    try {
      await write(url, { method: 'PUT', body: JSON.stringify(body) });
      toast(`${item.name} saved.`);
      onSaved();
      if (after) onOpenNext(after);
      else if (next) toast('Every event now has a description.');
    } catch (error) { toastError(error); } finally { setBusy(false); }
  };

  return (
    <form className="event-form" key={JSON.stringify(definition)} onSubmit={save}>
      <div className="field"><label htmlFor={`desc-${item.name}`}>What does this event mean?</label><textarea id={`desc-${item.name}`} name="description" rows={2} maxLength={4000} defaultValue={definition.description} placeholder="The player finished a level successfully." /></div>
      <div className="event-counts-as">
        <span className="small muted">Counts as</span>
        <div>{definition.canonical.length ? definition.canonical.map((rule, index) => <div key={index}><span className="pill good">{conceptName(rule.action)}</span> <span className="small muted">{ruleText(rule)}</span></div>) : <span className="muted">Nothing yet.</span>}</div>
        <Link className="button" to={gamePath(game, 'event-setup')} search={{ event: item.name }} hash="mappings"><Ico name="link" size={14} /> {definition.canonical.length ? 'Change mapping' : 'Map this event'}…</Link>
      </div>
      <h3 className="event-sub">Parameters</h3>
      {detail.isPending ? <Skeleton kind="table" rows={3} columns={4} /> : detail.isError ? <LoadError error={detail.error} onRetry={() => void detail.refetch()} /> : rows.length ? (
        <div className="table-wrap">
          <table className="compact-table event-params">
            <thead><tr><th>Parameter</th><th>Seen</th><th>Values</th><th>What it means</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td><code>{row.key}</code>{row.types.length ? <><br /><span className="small muted">{row.types.join(' / ')}{row.types.length > 1 ? ' — type changes' : ''}</span></> : null}</td>
                  <td className="num">{row.quiet ? <span className="muted small">not seen</span> : number(row.count)}</td>
                  <td className="small">{row.values.length ? <>{row.values.slice(0, 5).map((value) => <span key={value.value} className="pill" title={`${number(value.count)} times`}>{value.value || '(empty)'}</span>)}{row.distinct > row.values.length ? <span className="muted"> +{number(row.distinct - row.values.length)} more</span> : null}</> : <span className="muted">—</span>}</td>
                  <td><input name={`param:${row.key}`} aria-label={`What ${row.key} means`} maxLength={2000} defaultValue={definition.params[row.key] ?? ''} placeholder="What it holds" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="help">This event has not sent any parameters.</p>}
      <div className="field"><label htmlFor={`labels-${item.name}`}>How it reads in player stories <span className="muted">(optional)</span></label><textarea id={`labels-${item.name}`} name="labels" rows={2} maxLength={2000} defaultValue={definition.labels} placeholder="Started => Started level {Started}" /><p className="help">One rule per line: <code>parameter =&gt; text</code>. Use <code>*</code> for every time. The first rule that matches wins.</p></div>
      <label className="check-row"><input type="checkbox" name="hidden" value="1" defaultChecked={definition.hidden} /> Leave it out of player stories and journeys (noise)</label>
      <div className="modal-actions event-actions">
        {item.defined ? <button type="button" className="button danger-text" onClick={() => setConfirmDelete(true)}>Delete definition</button> : null}
        <button type="submit" className="button primary" disabled={busy}>Save</button>
        <button type="submit" className="button" data-save-next disabled={busy}>Save and next event without a description →</button>
      </div>
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete the definition of ${item.name}?`} danger label="Delete definition"
        message="Its description, parameter notes, story rule and mappings are removed. Collected events are not affected."
        onConfirm={async () => { await write(url, { method: 'DELETE' }); toast('Definition deleted.'); onSaved(); }} />
    </form>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ label: ReactElement | string; events: number; players: number; extra?: string }> }): ReactElement | null {
  if (!rows.length) return null;
  return (
    <div>
      <h3 className="event-sub">{title}</h3>
      <table className="compact-table"><tbody>{rows.map((row, index) => <tr key={index}><td>{row.label}</td><td className="num">{number(row.events)}</td><td className="num muted small">{number(row.players)} players</td>{row.extra ? <td className="muted small">{row.extra}</td> : null}</tr>)}</tbody></table>
    </div>
  );
}

function Activity({ detail, range }: { detail: ReturnType<typeof useRead<EventDetail>>; range: { from: string; to: string } }): ReactElement {
  if (detail.isPending) return <Skeleton kind="chart" />;
  if (detail.isError) return <LoadError error={detail.error} onRetry={() => void detail.refetch()} />;
  const data = detail.data;
  return (
    <>
      <h3 className="event-sub">All activity for this event</h3>
      {data.days.some((day) => day.events) ? <DailyChart days={data.days.map((day) => ({ day: day.day, events: day.events, players: 0, sessions: 0 }))} range={range} measure="events" /> : <p className="help">Not sent in these days.</p>}
      {data.missing_in_newest ? <p className="event-warning"><Ico name="pulse" size={15} /><span>The newest version in your data (<strong>{data.newest_version}</strong>) has not sent this event. If you expected it, check that build.</span></p> : null}
      <div className="event-breakdowns">
        <Breakdown title="App versions (all time)" rows={data.versions.map((row) => ({ label: <>{row.version}{row.version === data.newest_version ? <> <span className="pill">newest</span></> : null}</>, events: row.events, players: row.players, extra: `last ${agoText(row.last_seen)}` }))} />
        <Breakdown title="Environments" rows={data.environments.map((row) => ({ label: row.value, events: row.events, players: row.players }))} />
        <Breakdown title="Countries" rows={data.countries.map((row) => ({ label: row.value === 'unknown' ? 'unknown' : countryText(row.value), events: row.events, players: row.players }))} />
      </div>
    </>
  );
}

function Examples({ detail, timezone }: { detail: ReturnType<typeof useRead<EventDetail>>; timezone: 'local' | 'utc' }): ReactElement {
  if (detail.isPending) return <Skeleton kind="table" rows={4} columns={3} />;
  if (detail.isError) return <LoadError error={detail.error} onRetry={() => void detail.refetch()} />;
  if (!detail.data.samples.length) return <p className="help">No examples in these days and filters.</p>;
  return (
    <table className="compact-table event-examples">
      <thead><tr><th>When</th><th>Version</th><th>Environment</th><th>Parameters</th></tr></thead>
      <tbody>{detail.data.samples.map((sample, index) => <tr key={index}><td className="small muted">{analysisDate(sample.client_ts, timezone)}</td><td className="small">{sample.version || '—'}</td><td className="small">{sample.environment || '—'}</td><td><code className="small">{JSON.stringify(sample.params)}</code></td></tr>)}</tbody>
    </table>
  );
}

function EventPanel({ game, item, list, query, tab, onTab, onSaved, onOpenNext, filters }: { game: Game; item: DictionaryEvent; list: DictionaryEvent[]; query: string; tab: Tab; onTab: (tab: Tab) => void; onSaved: () => void; onOpenNext: (name: string) => void; filters: ReturnType<typeof useFilters>[0] }): ReactElement {
  const detail = useRead<EventDetail>(`${gameURL(game)}/insights/events/detail?${query}`);
  return (
    <div className="event-body" data-event-panel={item.name}>
      <div className="level-drill-head">
        <div className="segmented" role="group" aria-label={item.name}>{TABS.map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => onTab(key)}>{label}</button>)}</div>
        <span className="small muted">{item.ever ? `${number(item.ever.events)} events from ${number(item.ever.players)} players all time · first ${agoText(item.ever.first_seen)}` : 'Never received'}</span>
      </div>
      {item.similar.length ? <p className="help">Similar names: {item.similar.map((name) => <code key={name}>{name} </code>)}— a different spelling of the same event?</p> : null}
      {tab === 'meaning' ? <Meaning game={game} item={item} detail={detail} list={list} onSaved={onSaved} onOpenNext={onOpenNext} /> : tab === 'activity' ? <Activity detail={detail} range={filters.range} /> : <Examples detail={detail} timezone={filters.timezone} />}
    </div>
  );
}

export function EventsList({ game }: { game: Game }): ReactElement {
  const [filters, updateFilters] = useFilters(game);
  const [view, setViewState] = useState(() => cleanEventsView(storeGet(eventsViewKey(game))));
  const setView = (patch: Partial<typeof view>) => setViewState((previous) => { const next = { ...previous, ...patch }; storeSet(eventsViewKey(game), next); return next; });
  const [text, setText] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => { const wanted = new URLSearchParams(location.search).get('event'); return new Set(wanted ? [wanted] : []); });
  const [tabs, setTabs] = useState<Record<string, Tab>>({});
  const path = `${gameURL(game)}/insights/events?${filterQuery(filters)}`;
  const query = useRead<DictionaryData>(path);
  const data = query.data;
  const list = useMemo(() => (data ? visibleEvents(data.events, view.filter, view.sort, text) : []), [data, view, text]);
  const scrollTo = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollTo.current) return;
    document.querySelector(`[data-event-row="${CSS.escape(scrollTo.current)}"]`)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    scrollTo.current = null;
  }, [open, data]);

  const toggle = (name: string) => setOpen((previous) => { const next = new Set(previous); if (!next.delete(name)) next.add(name); return next; });
  const openNext = (name: string) => { scrollTo.current = name; setTabs((previous) => ({ ...previous, [name]: 'meaning' })); setOpen(new Set([name])); };
  const refresh = () => { void query.refetch(); };
  const detailQuery = (name: string) => { const params = filterQuery(filters); params.set('name', name); return params.toString(); };

  const exportCSV = () => {
    if (!data) return;
    downloadCSV(`${game.name}-events-${filters.range.from}_${filters.range.to}.csv`, [
      ['event', 'described', 'description', 'counts_as', 'hidden', 'sent_in_range', 'players_in_range', 'sent_all_time', 'first_seen', 'last_seen', 'parameters_seen', 'parameters_undescribed'],
      ...list.map((item) => [item.name, String(item.described), item.definition.description, item.definition.canonical.map((rule) => rule.action).join(' '), String(item.definition.hidden), item.range.events, item.range.players, item.ever?.events ?? 0, item.ever?.first_seen, item.ever?.last_seen, item.params_seen, item.params_missing.join(' ')]),
    ]);
  };

  return (
    <>
      <FilterBar game={game} state={filters} onChange={updateFilters} />
      <QueryRegion query={query} path={path} skeleton={<><Skeleton kind="stats" /><Skeleton kind="table" rows={8} columns={6} /></>}>
        {(result) => {
          const summary = result.summary;
          const inRange = result.events.reduce((sum, item) => sum + item.range.events, 0);
          return (
            <>
              <div className="kpis section-spacing">
                <div className="kpi"><div className="eyebrow">Events received</div><div className="k-v">{number(summary.received_total)}</div><div className="k-c">{number(inRange)} in the selected days · {number(summary.event_types)} event type{summary.event_types === 1 ? '' : 's'}</div></div>
                <div className="kpi"><div className="eyebrow">Described</div><div className="k-v">{number(summary.described)} of {number(summary.events)}</div><div className="k-c">{summary.events ? `${Math.round((100 * summary.described) / summary.events)}% have a description` : ''}</div></div>
                <div className="kpi"><div className="eyebrow">Need a description</div><div className="k-v">{number(summary.needs_description)}</div><div className="k-c">{summary.with_missing_params ? `${number(summary.with_missing_params)} more have undescribed parameters` : 'Built-in events are exempt'}</div></div>
                <div className="kpi"><div className="eyebrow">Quiet or never sent</div><div className="k-v">{number(summary.stale + summary.never_received)}</div><div className="k-c">no event in {result.stale_days}+ days, or never · {fileSize(summary.database_bytes)} on disk</div></div>
              </div>
              <section className="panel section-spacing">
                <div className="panel-header">
                  <div><h2>All events</h2><p>Counts are for the selected days and filters. Open an event to describe it.</p></div>
                  <div className="quiet-actions">
                    <label className="inline-field">Sort<select value={view.sort} onChange={(event) => setView({ sort: event.target.value as EventsSort })}>{EVENT_SORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
                    <button type="button" className="button" onClick={exportCSV}><Ico name="export" size={14} /> CSV</button>
                  </div>
                </div>
                <div className="toolbar events-toolbar">
                  <div className="search"><Ico name="search" size={16} /><input type="search" aria-label="Search events" placeholder="Search by event name or description…" value={text} onChange={(event) => setText(event.target.value)} /></div>
                  <div className="range-modes" role="group" aria-label="Show">
                    {EVENT_FILTERS.map(([key, label, keep]) => <button key={key} type="button" aria-pressed={view.filter === key} onClick={() => setView({ filter: key as EventsFilter })}>{label} <span className="drill-count">{number(result.events.filter(keep).length)}</span></button>)}
                  </div>
                </div>
                {!result.events.length ? <Empty title="No events yet">Events appear here as soon as your game sends them, and you can describe them right away.</Empty> : !list.length ? <Empty title="No events match">Try another search or filter.</Empty> : (
                  <div className="table-wrap">
                    <table className="events-grid">
                      <thead><tr><th>Event</th><th>Status</th><th className="num">Sent</th><th>Per day</th><th className="num">Players</th><th>Last sent</th><th>Understood as</th><th>Parameters</th></tr></thead>
                      <tbody>
                        {list.flatMap((item) => {
                          const isOpen = open.has(item.name);
                          const rows = [(
                            <tr key={item.name} data-event-row={item.name} className={isOpen ? 'event-open' : ''}>
                              <td className="event-name-cell"><button type="button" className="level-toggle" aria-expanded={isOpen} aria-label={`Open ${item.name}`} onClick={() => toggle(item.name)}><Ico name="chevron" size={14} /></button><code>{item.name}</code>{item.definition.hidden ? <> <span className="pill" title="Left out of player stories and journeys">Hidden</span></> : null}</td>
                              <td><StatusPills item={item} staleDays={result.stale_days} /></td>
                              <td className="num">{number(item.range.events)}</td>
                              <td><Sparkline values={item.series} label={`${item.name} per day`} /></td>
                              <td className="num">{number(item.range.players)}</td>
                              <td className="small muted">{agoText(item.ever?.last_seen)}</td>
                              <td>{item.definition.canonical.length ? item.definition.canonical.map((rule, index) => <span key={index} className="pill good" title={ruleText(rule)}>{conceptName(rule.action)}</span>) : <span className="muted">—</span>}</td>
                              <td>{item.params_seen ? <>{number(item.params_seen)}{item.defined && item.params_missing.length ? <> <span className="pill bad" title={item.params_missing.join(', ')}>{item.params_missing.length} undescribed</span></> : null}{item.type_conflicts.length ? <> <span className="pill bad" title={`Sent as both text and number: ${item.type_conflicts.join(', ')}`}>type changes</span></> : null}</> : <span className="muted">—</span>}</td>
                            </tr>
                          )];
                          if (isOpen) rows.push(<tr key={`${item.name}:panel`} className="event-detail-row"><td colSpan={8}><EventPanel game={game} item={item} list={list} query={detailQuery(item.name)} filters={filters} tab={tabs[item.name] ?? 'meaning'} onTab={(tab) => setTabs((previous) => ({ ...previous, [item.name]: tab }))} onSaved={refresh} onOpenNext={openNext} /></td></tr>);
                          return rows;
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          );
        }}
      </QueryRegion>
    </>
  );
}
