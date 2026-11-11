// The ingest meter at the bottom of the sidebar: one quiet line (a dot, the rate, how long since the last
// event) that opens a panel with the last 24 hours, the players sending now, the versions sending and the
// size of the data. The dot turns amber after 5 minutes with nothing and red after 30, so it is only loud when
// something is wrong. It follows the game open in the sidebar and updates every 30 seconds while the tab is open.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useRead } from '@/api';
import { gameURL } from '@/lib/games';
import type { Game, IngestMeterData } from '@/lib/types';

const POLL_MS = 30000;
export const QUIET_AFTER_SECONDS = 5 * 60;
export const STALE_AFTER_SECONDS = 30 * 60;

export type MeterState = 'live' | 'quiet' | 'stale' | 'empty';
/** live until 5 minutes without an event, quiet until 30, then stale; empty when nothing was ever received. */
export function meterState(ageSeconds: number | null): MeterState {
  if (ageSeconds == null) return 'empty';
  return ageSeconds < QUIET_AFTER_SECONDS ? 'live' : ageSeconds < STALE_AFTER_SECONDS ? 'quiet' : 'stale';
}
/** "4s ago", "8 min ago", "2 h ago", "3 d ago". */
export function ago(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return `${value}s ago`;
  if (value < 3600) return `${Math.floor(value / 60)} min ago`;
  if (value < 86400) return `${Math.floor(value / 3600)} h ago`;
  return `${Math.floor(value / 86400)} d ago`;
}
/** "1.4 GB", "812 MB", "40 KB". */
export function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
const STATE_WORD: Record<MeterState, string> = { live: 'Live', quiet: 'Quiet', stale: 'Nothing arriving', empty: 'No events yet' };
const number = (value: number): string => value.toLocaleString();

/** Seconds since the last event, counted from the server's clock at the time of the answer plus the time since. */
function useAge(data: IngestMeterData | undefined, answeredAt: number): number | null {
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick((count) => count + 1), 5000); return () => clearInterval(timer); }, []);
  if (!data?.last_event_at) return null;
  return (Date.parse(data.now) - Date.parse(data.last_event_at)) / 1000 + Math.max(0, (Date.now() - answeredAt) / 1000);
}

function Bars({ hourly }: { hourly: IngestMeterData['hourly'] }): ReactElement {
  const most = Math.max(1, ...hourly.map((item) => item.events));
  const width = 260 / hourly.length;
  return (
    <svg viewBox="0 0 260 44" className="ingest-bars" preserveAspectRatio="none" role="img" aria-label="Events received in each of the last 24 hours">
      {hourly.map((item, index) => { const height = Math.max(1.5, (item.events / most) * 42); return <rect key={item.hour} x={index * width + 1} y={44 - height} width={width - 2} height={height} rx="1.5" className={index === hourly.length - 1 ? 'now' : undefined}><title>{`${item.hour.slice(11)}:00 · ${number(item.events)} events`}</title></rect>; })}
    </svg>
  );
}

export function IngestMeter({ game }: { game: Game }): ReactElement {
  const query = useRead<IngestMeterData>(`${gameURL(game)}/health/live`, { refetchInterval: POLL_MS });
  const data = query.data;
  const age = useAge(data, query.dataUpdatedAt);
  const state = meterState(age);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open || !button.current) return;
    const box = button.current.getBoundingClientRect();
    // Beside the sidebar, its bottom edge level with the chip's, so the navigation stays visible.
    setPlace({ left: Math.max(8, Math.min(box.right + 10, window.innerWidth - 316)), bottom: Math.max(8, window.innerHeight - box.bottom) });
    const away = (event: Event) => { if (event.type === 'keydown' ? (event as KeyboardEvent).key === 'Escape' : !panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('keydown', away); document.addEventListener('pointerdown', away); window.addEventListener('resize', away);
    return () => { document.removeEventListener('keydown', away); document.removeEventListener('pointerdown', away); window.removeEventListener('resize', away); };
  }, [open]);

  if (!data) return <div className="ingest" aria-hidden="true" />;
  const word = STATE_WORD[state];
  return (
    <div className="ingest">
      <button type="button" ref={button} className={`ingest-chip ${state}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={`${word}. Ingest for ${game.name}`}>
        <span className="ingest-dot" aria-hidden="true" />
        <b>{word}</b>
        {state === 'live' ? <span className="ingest-rate">{data.per_minute}/min</span> : null}
        <span className="ingest-ago">{age == null ? '' : ago(age)}</span>
      </button>
      {open ? createPortal(
        <div ref={panel} className="ingest-pop" role="dialog" aria-label={`Ingest for ${game.name}`} style={{ left: place?.left ?? -9999, bottom: place?.bottom ?? 0 }}>
          <h3><span>Ingest · {game.name}</span><span className={`ingest-state is-${state}`}>{word}</span></h3>
          <div className="ingest-top">
            <div><b>{number(data.events_24h)}</b><span>events in 24 h</span></div>
            <div><b>{number(data.players_now)}</b><span>players in the last {data.recent_minutes} min</span></div>
          </div>
          <Bars hourly={data.hourly} />
          <div className="ingest-axis"><span>24 h ago</span><span>now</span></div>
          <dl>
            <dt>Last event</dt><dd>{age == null ? 'none yet' : ago(age)}</dd>
            <dt>Rate</dt><dd>{data.per_minute} events / min <small>(last {data.recent_minutes} min)</small></dd>
            {data.versions.length ? <><dt>Sending now</dt><dd>{data.versions.map((item) => `${item.version} · ${Math.round((100 * item.events) / Math.max(1, data.versions.reduce((sum, entry) => sum + entry.events, 0)))}%`).join(', ')}</dd></> : null}
            <dt>Stored</dt><dd>{size(data.stored_bytes)}</dd>
          </dl>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
