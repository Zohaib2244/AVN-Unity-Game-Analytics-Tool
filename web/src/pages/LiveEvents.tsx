// Live events: what the game is sending right now, newest first, for checking an SDK integration.
// Asks for new events every 2 seconds while the tab is visible and not paused; catches up when the tab
// comes back; says Paused or Offline (with the time of the last answer) rather than going quietly stale.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { request } from '@/api';
import { gameURL } from '@/lib/games';
import { clock, number, shortId } from '@/lib/format';
import { copyText } from '@/lib/store';
import type { Game } from '@/lib/types';
import { Empty, Heading, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { KEEP, POLL_MS, buildText, mergeLive, paramsText, sender, type LiveEvent, type LivePage } from './live/model';

type Status = 'starting' | 'live' | 'paused' | 'offline';

const NARROW = '(max-width: 640px)';
/** Whether the screen is phone-sized; follows rotation and resizing. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const query = matchMedia(NARROW);
    const change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return narrow;
}

export function LiveEventsPage({ game }: { game: Game }): ReactElement {
  const { toast } = useNotify();
  const [typed, setTyped] = useState('');
  const [player, setPlayer] = useState('');
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<Status>('starting');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const cursor = useRef<number | null>(null);
  const busy = useRef(false);
  // Bumped when the player filter or game changes: an answer to an older question is dropped.
  const generation = useRef(0);

  // A new player filter starts again from the newest events.
  useEffect(() => { const timer = setTimeout(() => setPlayer(typed.trim()), 400); return () => clearTimeout(timer); }, [typed]);
  useEffect(() => { generation.current += 1; busy.current = false; cursor.current = null; setEvents([]); setStatus('starting'); }, [player, game.id]);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const asked = generation.current;
    try {
      const query = new URLSearchParams({ limit: String(cursor.current == null ? 50 : 200) });
      if (cursor.current != null) query.set('after', String(cursor.current));
      if (player) query.set('player', player);
      const page = await request<LivePage>(`${gameURL(game)}/events/live?${query}`);
      if (asked !== generation.current) return;
      cursor.current = page.cursor;
      setEvents((shown) => mergeLive(shown, page.events));
      setCheckedAt(Date.now());
      setStatus('live');
    } catch {
      if (asked === generation.current) setStatus('offline'); // keeps asking: the next tick tries again
    } finally {
      if (asked === generation.current) busy.current = false;
    }
  }, [game, player]);

  useEffect(() => {
    if (paused) { setStatus('paused'); return undefined; }
    void poll();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void poll(); }, POLL_MS);
    const back = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', back);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', back); };
  }, [paused, poll]);

  const word = status === 'live' ? 'Live' : status === 'paused' ? 'Paused' : status === 'offline' ? 'Offline' : 'Connecting…';
  const since = checkedAt ? ` · last answer ${clock(new Date(checkedAt).toISOString())}` : '';
  // A build column only when the events shown come from more than one build (else it says the same on every row).
  const builds = [...new Set(events.map(buildText))];
  const narrow = useNarrow();
  const manyBuilds = builds.length > 1;
  const players = [...new Set(events.map(sender))];
  const manyPlayers = players.length > 1;
  // On a phone the player and build are read in the opened row, so the table keeps its width for the parameters.
  const playerColumn = manyPlayers && !narrow;
  const buildColumn = manyBuilds && !narrow;
  const columns = 4 + (playerColumn ? 1 : 0) + (buildColumn ? 1 : 0);
  const copy = async (item: LiveEvent) => { toast((await copyText(JSON.stringify(item, null, 2))) ? 'Event copied as JSON.' : 'Copy failed — your browser blocked clipboard access.'); };

  return (
    <>
      <Heading title="Live events" />
      <section className="panel live-panel">
        <div className="panel-header live-head">
          <div className="search"><Ico name="search" size={16} /><input type="search" aria-label="Only one player" placeholder="Only one player: user or device ID…" value={typed} onChange={(event) => setTyped(event.target.value)} /></div>
          <div className="quiet-actions">
            <span className={`live-state is-${status}`} role="status" title={since ? since.slice(3) : undefined}><span className="live-dot" aria-hidden="true" /><span>{word}{status === 'live' ? null : <span className="live-since">{since}</span>}</span></span>
            <button type="button" className="button" onClick={() => setPaused(!paused)}>{paused ? <><Ico name="play" size={14} /> Resume</> : 'Pause'}</button>
            <button type="button" className="button" disabled={!events.length} onClick={() => setEvents([])}><Ico name="close" size={14} /> Clear</button>
          </div>
        </div>
        {events.length ? (
          <div className="table-wrap">
            <table className="compact-table live-table">
              <thead><tr><th className="c-time" title="When the game says it happened, in your time. Rows are in the order the server received them, newest first.">Time</th><th className="c-event">Event</th>{playerColumn ? <th className="c-player">Player</th> : null}{buildColumn ? <th className="c-build">Build</th> : null}<th className="c-params">Parameters</th><th className="c-copy"><span className="sr-only">Copy</span></th></tr></thead>
              <tbody>
                {events.map((item) => (
                  <Fragment key={item.event_id}>
                  <tr className={`click${open === item.event_id ? ' picked' : ''}`} tabIndex={0} aria-expanded={open === item.event_id} onClick={() => setOpen(open === item.event_id ? null : item.event_id)} onKeyDown={(event) => { if (event.key === 'Enter') setOpen(open === item.event_id ? null : item.event_id); }}>
                    <td className="c-time">{clock(item.client_ts)}</td>
                    <td className="c-event"><b>{item.name}</b></td>
                    {playerColumn ? <td className="c-player" title={sender(item)}>{shortId(sender(item))}</td> : null}
                    {buildColumn ? <td className="c-build">{buildText(item)}</td> : null}
                    <td className="c-params live-params" title={paramsText(item.params)}>{paramsText(item.params) || <span className="muted">—</span>}</td>
                    <td className="c-copy"><button type="button" className="icon-button" aria-label="Copy as JSON" title="Copy as JSON" onClick={(event) => { event.stopPropagation(); void copy(item); }}><Ico name="copy" size={14} /></button></td>
                  </tr>
                  {open === item.event_id ? (
                    <tr className="live-detail">
                      <td colSpan={columns}>
                        <dl>
                          <dt>Player</dt><dd>{sender(item)}</dd>
                          <dt>Build</dt><dd>{buildText(item)}</dd>
                          <dt>Session</dt><dd>{item.session_id ?? '—'}</dd>
                          <dt>Received</dt><dd>{clock(item.server_ts)}</dd>
                        </dl>
                        <pre>{JSON.stringify(item.params, null, 2)}</pre>
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={status === 'offline' ? 'Can’t reach the server' : player ? 'Nothing from this ID yet' : 'Waiting for events'}
            action={player && status !== 'offline' ? <button type="button" className="button" onClick={() => setTyped('')}>Show every player</button> : undefined}>
            {status === 'offline' ? 'Still trying every 2 seconds.' : player ? 'Check the ID, or open the game on that device.' : 'Open the game on a test device; its events appear here.'}
          </Empty>
        )}
        {events.length ? <p className="foot-note">The newest {number(Math.min(events.length, KEEP))} events{manyPlayers ? '' : ` · all from ${players[0]}`}{manyBuilds ? '' : ` · build ${builds[0]}`} · click a row for every parameter.</p> : null}
      </section>
    </>
  );
}
