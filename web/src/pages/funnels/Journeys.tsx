// Journeys: what players did between two funnel steps, in plain words. Runs on "Show journeys" (or when
// NutBot asked for it), then follows the funnel; a journey or an exit lists the players who took it.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { useRead } from '@/api';
import { CollapsiblePanel } from '@/components/Collapsible';
import { QueryRegion, Skeleton } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { displayDate, number, percent, shortId } from '@/lib/format';
import { gamePath, gameURL } from '@/lib/games';
import { downloadCSV, storeGet, storeSet } from '@/lib/store';
import type { Catalog, FunnelStep, Game, JourneyExit, JourneyItem, JourneyPlayersResult, JourneyStatus, JourneysResult } from '@/lib/types';
import { clampJourneyRange, journeyStepName, journeyStepPlain } from './funnelMath';

const JOURNEY_OUTCOMES: Record<JourneyStatus, [string, string]> = { reached: ['Reached the end', 'good'], stopped: ['Stopped', 'bad'], continued: ['Kept going', ''] };
const START_EXIT = '__start__';
const PAGE = 12;

type JourneyState = { from: number; to: number | null; ignore: string[]; span: 'session' | 'all'; view: 'journeys' | 'exits' };
type Target = { steps?: string[]; status?: JourneyStatus; exit?: string };
type Body = Record<string, unknown> & { route_from: number; route_to: number; ignore: string[]; span: string };
type PlayersOpen = { target: Target; title: string } | null;
/** What is on screen that must survive the panel being folded or unfolded (kept by the page, not by the panel). */
export type JourneysSession = { active: boolean; body: Body | null; players: PlayersOpen; outcomeFilter: 'all' | JourneyStatus; shown: number };
export const INITIAL_JOURNEYS: JourneysSession = { active: false, body: null, players: null, outcomeFilter: 'all', shown: PAGE };

function loadState(game: Game): JourneyState {
  const saved = (storeGet<Partial<JourneyState>>(`avn-journeys-${game.id}`) || {}) as Partial<JourneyState>;
  const state: JourneyState = { from: 1, to: null, ignore: [], span: 'session', view: 'journeys', ...saved };
  state.ignore = (Array.isArray(state.ignore) ? state.ignore : []).filter((name) => typeof name === 'string');
  return state;
}

export type JourneysPanelProps = {
  game: Game;
  /** The funnel's steps with an event (the ones being edited). */
  steps: FunnelStep[];
  catalog: Catalog;
  /** The funnel body (filters, steps, scope, window) the journeys are asked about. */
  query: () => Record<string, unknown>;
  /** Counts the funnel runs that finished; journeys follow them once shown. */
  runCount: number;
  panelsKey: number;
  session: JourneysSession;
  onSession: (patch: Partial<JourneysSession>) => void;
};

export function JourneysPanel({ game, steps, catalog, query, runCount, panelsKey, session, onSession }: JourneysPanelProps): ReactElement {
  const key = `avn-journeys-${game.id}`;
  const [state, setState] = useState<JourneyState>(() => loadState(game));
  const { outcomeFilter, shown, active, body, players } = session;
  const { from, to } = clampJourneyRange(state.from, state.to, steps.length);
  const persist = (next: JourneyState) => { setState(next); storeSet(key, { from: next.from, to: next.to, ignore: next.ignore, span: next.span, view: next.view }); };

  const latest = useRef({ steps, query, from, to, state });
  latest.current = { steps, query, from, to, state };
  const run = () => {
    const now = latest.current;
    if (now.steps.length < 2) { onSession({ active: true, players: null, body: null }); return; }
    onSession({ active: true, players: null, body: { ...now.query(), route_from: now.from, route_to: now.to, ignore: now.state.ignore, span: now.state.span }, outcomeFilter: 'all', shown: PAGE });
  };
  const changed = (next: JourneyState) => { persist(next); if (active) setTimeout(run, 0); };
  // After each funnel run: the journeys NutBot asked for, or a refresh of the ones on screen. Not on mount or
  // when the panel is only folded again (the count has not moved).
  const seen = useRef(runCount);
  useEffect(() => {
    if (runCount === seen.current) return;
    seen.current = runCount;
    if (storeGet(`avn-pending-journeys-${game.id}`)) { storeSet(`avn-pending-journeys-${game.id}`, null); run(); } else if (active) run();
  }, [runCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const path = `${gameURL(game)}/insights/journeys`;
  const journeysQuery = useRead<JourneysResult>(body ? path : null, { body: body ?? undefined });
  const startName = () => journeyStepPlain(steps[from - 1] ?? steps[0] ?? { event: '', param: '', op: 'eq', value: '', label: '' });
  const endName = () => journeyStepPlain(steps[to - 1] ?? steps[steps.length - 1] ?? { event: '', param: '', op: 'eq', value: '', label: '' });
  const exitText = (label: string) => (label === START_EXIT ? `Left right after “${startName()}”` : label);
  const showPlayers = (target: Target, title: string) => onSession({ players: { target, title } });

  return (
    <CollapsiblePanel key={panelsKey} game={game} name="journeys" className="section-spacing" id="journeys-panel"
      header={<div><h2>Journeys</h2><p>What players did between two steps, in plain words · click a journey to see who took it</p></div>}
      actions={<button className="button primary" type="button" id="journeys-run" onClick={run}><Ico name="funnel" size={14} /> Show journeys</button>}>
      <div className="panel-body">
        <div className="routes-controls">
          <label className="inline-field">From<select id="journeys-from" value={from} onChange={(e) => changed({ ...state, from: Number(e.target.value) })}>{steps.map((step, index) => <option key={index} value={index + 1}>{journeyStepName(step, index)}</option>)}</select></label>
          <label className="inline-field">To<select id="journeys-to" value={to} onChange={(e) => changed({ ...state, to: Number(e.target.value) })}>{steps.map((step, index) => <option key={index} value={index + 1} disabled={index + 1 <= from}>{journeyStepName(step, index)}</option>)}</select></label>
          <label className="inline-field">Look at<select id="journeys-span" value={state.span} onChange={(e) => changed({ ...state, span: e.target.value as JourneyState['span'] })}><option value="session">The session they started in</option><option value="all">All their sessions</option></select></label>
          <label className="inline-field">Hide<select id="journeys-ignore-add" value="" onChange={(e) => { if (e.target.value) changed({ ...state, ignore: [...state.ignore, e.target.value] }); }}><option value="">an event…</option>{catalog.events.filter((event) => !state.ignore.includes(event.name)).map((event) => <option key={event.name} value={event.name}>{event.name}</option>)}</select></label>
          <span id="journeys-ignore" className="chip-row">{state.ignore.map((name) => <span key={name} className="chip">{name} <button type="button" className="chip-x" aria-label={`Show ${name} again`} onClick={() => changed({ ...state, ignore: state.ignore.filter((item) => item !== name) })}>×</button></span>)}</span>
        </div>
        {!active ? <p className="help" id="journeys-intro">Pick where to start and end, then “Show journeys”. The steps come from your funnel above. Events are named from your event dictionary; fill in “How it reads in player stories” there to rename them in journeys.</p>
          : !body ? <p className="help" id="journeys-intro">Add at least two steps to your funnel first.</p> : (
            <QueryRegion query={journeysQuery} path={path} skeleton={<Skeleton kind="table" rows={5} columns={3} />}>
              {(data) => (
                <>
                  {data.started ? <div className="stat-strip" id="journeys-summary">
                    {([['Started', number(data.started), `did “${startName()}”`], ['Reached the end', number(data.reached), percent((100 * data.reached) / data.started)], ['Stopped', number(data.stopped), percent((100 * data.stopped) / data.started)], ['Kept going', number(data.continued), ''], ['Different journeys', number(data.distinct), '']] as Array<[string, string, string]>).map(([label, value, note]) => (
                      <div className="stat" key={label}><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong>{note ? <span className="stat-note">{note}</span> : null}</div>
                    ))}
                  </div> : null}
                  {!data.started ? <p className="help" id="journeys-intro">Nobody did the start step with these days and filters.</p> : (
                    <div id="journeys-views">
                      <div className="range-modes route-tabs" role="group" aria-label="How to view journeys">
                        <button type="button" aria-pressed={state.view === 'journeys'} onClick={() => persist({ ...state, view: 'journeys' })}>Journeys</button>
                        <button type="button" aria-pressed={state.view === 'exits'} onClick={() => persist({ ...state, view: 'exits' })}>Where players stop</button>
                      </div>
                      {state.view === 'journeys'
                        ? <JourneyList data={data} outcomeFilter={outcomeFilter} shown={shown} startName={startName()} endName={endName()} onFilter={(name) => onSession({ outcomeFilter: name, shown: PAGE })} onMore={() => onSession({ shown: shown + PAGE })} onPlayers={(item) => showPlayers({ steps: item.steps, status: item.status }, `Players on this journey: ${item.steps.join(' → ') || 'straight to the end'}`)} />
                        : <ExitList data={data} startName={startName()} endName={endName()} exitText={exitText} onPlayers={(item) => showPlayers({ exit: item.label }, `Players who ${exitText(item.label).replace(/^Left/, 'left')}`)} />}
                    </div>
                  )}
                </>
              )}
            </QueryRegion>
          )}
      </div>
      {players && body ? <JourneyPlayers game={game} body={body} target={players.target} title={players.title} /> : null}
    </CollapsiblePanel>
  );
}

const Outcome = ({ status }: { status: JourneyStatus }): ReactElement => { const [label, tone] = JOURNEY_OUTCOMES[status]; return <span className={`pill ${tone}`}>{label}</span>; };

function Chain({ item, startName, endName }: { item: JourneyItem; startName: string; endName: string }): ReactElement {
  return (
    <>
      <span className="route-step start" title="Start">{startName}</span>
      {item.steps.map((text, index) => <span key={index}><span className="route-arrow">→</span><span className="route-step" title={`Step ${index + 1}`}><i>{index + 1}</i>{text}</span></span>)}
      <span className="route-arrow">→</span>
      {item.status === 'reached' ? <span className="route-step end good">Reached: {endName}</span> : item.status === 'stopped' ? <span className="route-step end bad">Stopped here</span> : <span className="route-step end">… and kept going</span>}
    </>
  );
}

function JourneyList({ data, outcomeFilter, shown, startName, endName, onFilter, onMore, onPlayers }: { data: JourneysResult; outcomeFilter: 'all' | JourneyStatus; shown: number; startName: string; endName: string; onFilter: (name: 'all' | JourneyStatus) => void; onMore: () => void; onPlayers: (item: JourneyItem) => void }): ReactElement {
  const counts: Record<string, number> = { all: data.journeys.length };
  data.journeys.forEach((item) => { counts[item.status] = (counts[item.status] || 0) + 1; });
  const items = data.journeys.filter((item) => outcomeFilter === 'all' || item.status === outcomeFilter);
  const peak = Math.max(1, ...data.journeys.map((item) => item.percent));
  return (
    <div id="journeys-view-journeys">
      <div className="route-filters" role="group" aria-label="Filter journeys by outcome">
        {([['all', 'All journeys'], ['reached', 'Reached the end'], ['stopped', 'Stopped'], ['continued', 'Kept going']] as Array<['all' | JourneyStatus, string]>).map(([name, label]) => (
          <button key={name} type="button" aria-pressed={outcomeFilter === name} disabled={!counts[name]} onClick={() => onFilter(name)}>{label} <span className="count">{counts[name] || 0}</span></button>
        ))}
      </div>
      <ol className="route-cards">
        {items.length ? items.slice(0, shown).map((item, index) => (
          <li key={index} className={`route-card tone-${item.status}`}>
            <div className="route-card-head">
              <span className="route-rank">#{index + 1}</span><Outcome status={item.status} />
              <span className="route-count"><strong>{number(item.players)}</strong> player{item.players === 1 ? '' : 's'} · {percent(item.percent)}</span>
              <progress className="progress mini route-share" max={peak} value={item.percent} aria-label={`${percent(item.percent)} of players`} />
              <button type="button" className="button small-button" onClick={() => onPlayers(item)}>See players</button>
            </div>
            <div className="route-chain"><Chain item={item} startName={startName} endName={endName} /></div>
          </li>
        )) : <li className="help">No journeys with this outcome.</li>}
      </ol>
      {items.length > shown ? <div className="route-more"><button type="button" className="button" onClick={onMore}>Show {Math.min(PAGE, items.length - shown)} more ({number(items.length - shown)} left)</button></div> : null}
      {data.distinct > data.journeys.length ? <p className="help">Showing the {data.journeys.length} most common of {number(data.distinct)} different journeys. Hide noisy events above to merge similar ones.</p> : null}
    </div>
  );
}

function ExitList({ data, startName, endName, exitText, onPlayers }: { data: JourneysResult; startName: string; endName: string; exitText: (label: string) => string; onPlayers: (item: JourneyExit) => void }): ReactElement {
  if (!data.stopped) return <div id="journeys-view-exits"><p className="help">Nobody stopped between these steps: everyone either reached the end or was still playing.</p></div>;
  return (
    <div id="journeys-view-exits">
      <p className="help">The last thing {number(data.stopped)} player{data.stopped === 1 ? '' : 's'} did before they stopped, between “{startName}” and “{endName}”. Click one to see who they were.</p>
      <ol className="exit-list">
        {data.exits.map((item, index) => (
          <li key={index} className="exit-row">
            <span className="route-rank">#{index + 1}</span>
            <span className="exit-label"><span className={`route-step ${item.label === START_EXIT ? 'start' : ''}`}>{exitText(item.label)}</span></span>
            <progress className="progress mini exit-bar" max={100} value={item.percent_of_stopped} aria-label={`${percent(item.percent_of_stopped)} of those who stopped`} />
            <span className="exit-numbers"><strong>{number(item.players)}</strong> player{item.players === 1 ? '' : 's'}<br /><span className="small muted">{percent(item.percent)} of all · {percent(item.percent_of_stopped)} of stoppers</span></span>
            <button type="button" className="button small-button" onClick={() => onPlayers(item)}>See players</button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The players who took one journey or left at one exit; opens below the journeys and scrolls into view. */
function JourneyPlayers({ game, body, target, title }: { game: Game; body: Body; target: Target; title: string }): ReactElement {
  const wrap = useRef<HTMLDivElement>(null);
  const path = `${gameURL(game)}/insights/journeys/players`;
  const query = useRead<JourneyPlayersResult>(path, { body: { ...body, target } });
  useEffect(() => { wrap.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }, [target]);
  const data = query.data;
  const note = data ? `${number(data.total)} player${data.total === 1 ? '' : 's'}${data.total > data.players.length ? ` · showing the latest ${number(data.players.length)}` : ''} · open one to read their events` : '';
  return (
    <div id="journeys-players-wrap" ref={wrap}>
      <div className="panel-header">
        <div><h2 id="journeys-players-title">{title}</h2><p id="journeys-players-note">{note}</p></div>
        <button className="button small-button" type="button" id="journeys-players-csv" disabled={!data} onClick={() => { if (data) downloadCSV(`${game.name}-journey-players.csv`, [['player', 'outcome', 'what_they_did', 'last_event'], ...data.players.map((item) => [item.player, item.status, item.line, item.last_seen])]); }}><Ico name="export" size={14} /> CSV</button>
      </div>
      <div id="journeys-players" className="panel-body">
        <QueryRegion query={query} path={path} skeleton={<Skeleton kind="table" rows={5} columns={4} />}>
          {(result) => result.players.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Player</th><th>Outcome</th><th>What they did</th><th>Last event</th></tr></thead>
                <tbody>
                  {result.players.map((item) => (
                    <tr key={item.player}>
                      <td><Link className="mono" to={gamePath(game, 'players')} search={{ player: item.player }}>{shortId(item.player)}</Link></td>
                      <td><Outcome status={item.status} /></td>
                      <td className="route-cell">{item.line || '—'}</td>
                      <td className="small muted">{displayDate(item.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="help">Nobody.</p>}
        </QueryRegion>
      </div>
    </div>
  );
}
