// Games home (avn-ux pages.md "Games home"): workspace totals, then a grid of game status cards with
// search, an Active / Archived / All filter and a sort, plus the dashed "Register a game" card.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { PixelField } from '@avn/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useSession } from '@/app/session';
import { lastBrowserPage } from '@/app/browserPage';
import { PLATFORM_ORDER, gameGroups, gamePath, type GameGroup } from '@/lib/games';
import { displayDate, number, platformLabel } from '@/lib/format';
import { Empty, Heading, LoadError, Metric, useNotify } from '@/components/feedback';
import { GameAvatar } from '@/components/GameAvatar';
import { Ico } from '@/components/icons';

export type HomeFilter = 'active' | 'archived' | 'all';
export type HomeSort = 'recent' | 'name' | 'events' | 'newest';
export type HomeListState = { query: string; filter: HomeFilter; sort: HomeSort };

const SORTERS: Record<HomeSort, (a: GameGroup, b: GameGroup) => number> = {
  newest: (a, b) => b.created_at.localeCompare(a.created_at),
  name: (a, b) => a.name.localeCompare(b.name),
  events: (a, b) => b.events - a.events,
  recent: (a, b) => (b.last_event || '').localeCompare(a.last_event || ''),
};

/** The groups the list shows for a search, an Active / Archived / All filter and a sort (pure). */
export function homeList(all: GameGroup[], state: HomeListState): GameGroup[] {
  const query = state.query.toLowerCase();
  return all
    .filter((group) => (state.filter === 'all' || (state.filter === 'archived') === group.archived) && `${group.name} ${group.variants.map((item) => item.bundle_id).join(' ')} ${group.notes}`.toLowerCase().includes(query))
    .sort(SORTERS[state.sort]);
}

/** The filter the page opens with: Active, unless every game is archived. */
export const initialHomeFilter = (all: GameGroup[]): HomeFilter => (all.length && all.every((group) => group.archived) ? 'all' : 'active');

const LIVE_MS = 600000;
let resumeToast: number | null = null;

export function GameCard({ group, canManage, totalsReady = true, totalsFailed = false }: { group: GameGroup; canManage: boolean; totalsReady?: boolean; totalsFailed?: boolean }): ReactElement {
  const missing = canManage ? PLATFORM_ORDER.filter((platform) => !group.variants.some((item) => item.platform === platform)) : [];
  const status = group.archived ? <span className="tag bad">Archived</span> : !totalsReady ? <span className="tag plain">{totalsFailed ? 'Unavailable' : 'Loading…'}</span> : Date.now() - new Date(group.last_event || 0).getTime() < LIVE_MS ? <span className="tag ok dot">Live</span> : <span className="tag plain">Quiet</span>;
  return (
    <article className={`game-card ${group.archived ? 'archived' : ''}`}>
      <div className="game-card-header"><GameAvatar name={group.name} games={group.variants} /><span>{status}</span></div>
      <h2><Link className="card-link" to={gamePath(group.primary)}>{group.name}</Link></h2>
      <p className="mono">{[...new Set(group.variants.map((item) => item.bundle_id))].join(' · ')}</p>
      {group.notes ? <p className="game-notes">{group.notes}</p> : null}
      <div className="card-variants">
        {group.variants.map((item) => <Link key={item.id} className={`pill ${item.archived_at ? 'bad' : ''}`} to={gamePath(item)} title={`Open the ${platformLabel(item.platform)} version`}>{platformLabel(item.platform)}{totalsReady ? ` · ${number(item.events)}` : ''}</Link>)}
        {missing.map((platform) => <Link key={platform} className="pill variant-add" to="/games/new" search={{ name: group.name, bundle_id: group.primary.bundle_id, platform }}>+ {platformLabel(platform)}</Link>)}
      </div>
      {group.archived ? null : <p className="card-dau" title="Daily active users: distinct player IDs with an event on that local day, editor and development data left out"><strong>{totalsReady ? number(group.dau_today) : '—'}</strong> DAU today <span>{totalsReady ? `· ${number(group.dau_yesterday)} yesterday` : totalsFailed ? '· Unavailable' : '· Loading…'}</span></p>}
      <div className="game-card-footer"><span>{totalsReady ? `${number(group.events)} events` : totalsFailed ? 'Totals unavailable' : 'Loading totals…'}</span><span>{group.archived ? 'Collection paused' : !totalsReady ? (totalsFailed ? 'Activity unavailable' : 'Loading activity…') : group.last_event ? `Last event ${displayDate(group.last_event)}` : 'Awaiting events'} <Ico name="arrow" size={12} /></span></div>
    </article>
  );
}

const RegisterButton = (): ReactElement => <Link className="button primary" to="/games/new"><Ico name="plus" size={15} /> Register game</Link>;

export function HomePage(): ReactElement {
  const { me, overview, overviewError, retryOverview, workspace, canManageGames, workspaceName } = useSession();
  const totalsReady = overview.totals_ready !== false;
  const resume = lastBrowserPage(workspace, me.email || me.source, overview.games.map((game) => game.id));
  const navigate = useNavigate();
  const { toast, dismiss } = useNotify();
  const offered = useRef<string | null>(null);
  useEffect(() => {
    if (!resume || offered.current === resume) return;
    offered.current = resume;
    if (resumeToast != null) dismiss(resumeToast);
    resumeToast = toast('Continue where you left off?', { label: 'Continue', run: () => { void navigate({ href: resume }); } }, 'info');
  }, [resume, navigate, toast, dismiss]);
  const all = gameGroups(overview.games);
  const archivedCount = all.filter((group) => group.archived).length;
  const [state, setState] = useState<HomeListState>(() => ({ query: '', filter: initialHomeFilter(all), sort: 'recent' }));
  const groups = homeList(all, state);
  const filters: Array<[HomeFilter, string]> = [['active', `Active (${all.length - archivedCount})`], ['archived', `Archived (${archivedCount})`], ['all', `All (${all.length})`]];
  return (
    <>
      <Heading title={me.workspaces.length > 1 || me.is_admin ? `${workspaceName || 'Your'} games` : 'Your games'} subtitle="Pick a game to see its players, funnels, exports and settings." actions={canManageGames ? <RegisterButton /> : undefined} />
      {overviewError ? <LoadError error={overviewError} onRetry={retryOverview} /> : null}
      <div className="kpis" aria-label="Workspace totals" aria-busy={!totalsReady && !overviewError}>
        <Metric label="Games" value={number(all.length)} note={`${number(overview.games.length)} platform variant${overview.games.length === 1 ? '' : 's'}`} />
        <Metric label="Events collected" value={totalsReady ? number(overview.events) : '—'} note="Safely stored, never double-counted" />
        <Metric label="Events today" value={totalsReady ? number(overview.today) : '—'} note={totalsReady ? `${number(overview.anonymous_today)} without a player ID · local time` : overviewError ? 'Totals unavailable' : 'Loading totals…'} />
        <Metric label="Players today" value={totalsReady ? number(overview.dau_today) : '—'} note="Unique player IDs · local time, no editor data" />
      </div>
      {all.length ? (
        <div className="toolbar games-toolbar">
          <div className="search"><Ico name="search" size={16} /><input id="game-search" type="search" aria-label="Search games" placeholder="Search by name, bundle ID or notes…" value={state.query} onChange={(event) => setState({ ...state, query: event.target.value })} /></div>
          <div className="range-modes" role="group" aria-label="Show">{filters.map(([key, label]) => <button key={key} type="button" aria-pressed={state.filter === key} onClick={() => setState({ ...state, filter: key })}>{label}</button>)}</div>
          <div className="game-select"><label htmlFor="game-sort">Sort</label><select id="game-sort" value={state.sort} onChange={(event) => setState({ ...state, sort: event.target.value as HomeSort })}><option value="recent">Latest activity</option><option value="name">Name A–Z</option><option value="events">Most events</option><option value="newest">Newest first</option></select></div>
        </div>
      ) : null}
      <div id="game-results">
        {!all.length ? (
          <section className="panel">{canManageGames ? <Empty title="Good things begin with a first game" action={<RegisterButton />}>Create a game and we’ll generate its first API key.</Empty> : <Empty title="No games yet">You haven’t been given access to any games. Ask your team lead or the admin.</Empty>}</section>
        ) : groups.length ? (
          <div className="game-grid">
            {groups.map((group) => <GameCard key={group.primary.id} group={group} canManage={canManageGames} totalsReady={totalsReady} totalsFailed={!!overviewError} />)}
            {canManageGames ? <Link className="game-card add-card pxhost" to="/games/new"><PixelField /><span className="add-plus">+</span><strong>Register a game</strong><span>Add a platform or a new game</span></Link> : null}
          </div>
        ) : <section className="panel"><Empty title="No games found">Try another search or filter.</Empty></section>}
      </div>
      {!totalsReady || overview.events ? null : (
        <section className="panel section-spacing">
          <div className="panel-header"><div><h2>A simple start</h2><p>From your first event to your next idea.</p></div><Ico name="pulse" size={17} /></div>
          <ol className="steps">
            <li><span className={`step-number ${all.length ? 'done' : ''}`}>{all.length ? <Ico name="check" size={12} /> : '01'}</span><div><strong>Register your game</strong><p>A name, a platform, and a place for your events. Add the other platform later.</p></div></li>
            <li><span className="step-number">02</span><div><strong>Send your first event</strong><p>Use your game’s API key to start collecting.</p></div></li>
            <li><span className="step-number">03</span><div><strong>Turn data into direction</strong><p>Open the game for funnels and player journeys, or export the raw events.</p></div></li>
          </ol>
        </section>
      )}
    </>
  );
}
