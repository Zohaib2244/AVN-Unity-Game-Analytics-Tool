// Server status (avn-ux "server status" pattern): the machine, its live/quiet state, the key numbers,
// then event arrivals per day for one game (remembered in ?game=, as before).
import type { ReactElement } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { refreshAll } from '@/api';
import { useSession } from '@/app/session';
import { STATE_WORD, ago } from '@/app/IngestMeter';
import { freshest, useLive } from '@/app/live';
import { number, platformLabel } from '@/lib/format';
import { Activity } from '@/components/Activity';
import { Empty, Heading, LoadError, Metric } from '@/components/feedback';
import { MiniPC } from '@/components/flavour';
import { Ico } from '@/components/icons';
import { Heartbeat } from '@avn/ui';

export function StatusPage(): ReactElement {
  const { overview, overviewError, retryOverview } = useSession();
  const totalsReady = overview.totals_ready !== false;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const game = overview.games.find((item) => item.id === search.game) || overview.games[0];
  // The same words and the same read as the sidebar chip and the game cards, asked again every 30 seconds.
  const top = freshest([...useLive(overview.games).values()]);
  const live = top?.state === 'live';
  return (
    <>
      <Heading title="Server status" actions={<button type="button" className="button" onClick={() => void refreshAll()}><Ico name="refresh" size={14} /> Refresh</button>} />
      {overviewError ? <LoadError error={overviewError} onRetry={retryOverview} /> : null}
      <section className="panel">
        <div className="srv-top">
          <MiniPC />
          <div className="srv-state">
            <span className="row-wrap"><Heartbeat live={live} tick={top?.data?.last_event_at ?? undefined} count={overview.today ?? 0} label={top ? STATE_WORD[top.state] : 'Loading…'} /></span>
            <span className="muted">{top?.age != null ? `Last event ${ago(top.age)}` : top ? 'No events yet' : 'Checking…'}</span>
          </div>
        </div>
      </section>
      <div className="kpis">
        <Metric label="Registered games" value={number(overview.games.length)} note="Platform versions counted separately" />
        <Metric label="Events collected" value={totalsReady ? number(overview.events) : '—'} note="Safely stored, never double-counted" />
        <Metric label="Events today" value={totalsReady ? number(overview.today) : '—'} note={totalsReady ? `${number(overview.anonymous_today)} without a player ID · local time` : overviewError ? 'Totals unavailable' : 'Loading totals…'} />
        <Metric label="Players today" value={totalsReady ? number(overview.dau_today) : '—'} note="Unique player IDs · local time" />
      </div>
      <section className="panel">
        <div className="panel-header"><div><h2>Event arrivals</h2><p>Received by the server · choose any days · UTC</p></div></div>
        <div className="panel-body">
          {game ? (
            <>
              <div className="toolbar"><div className="game-select"><label htmlFor="selected-game">Game</label>
                <select id="selected-game" value={game.id} onChange={(event) => void navigate({ to: '/status', search: { game: event.target.value } })}>
                  {overview.games.map((item) => <option key={item.id} value={item.id}>{item.name} · {platformLabel(item.platform)}{item.archived_at ? ' · archived' : ''}</option>)}
                </select></div></div>
              <div id="arrivals"><Activity key={game.id} game={game} /></div>
            </>
          ) : <Empty title="No arrivals yet">Register a game and daily counts will appear here.</Empty>}
        </div>
      </section>
    </>
  );
}
