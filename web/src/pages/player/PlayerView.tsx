// One player: summary, dates, then Raw events, Event Analysis or Player info. `?player=` opens it. From the
// Levels page it is a centred viewer over the level (no NutBot there: the dialog makes the page inert);
// from the Players list it is the page itself, so NutBot stays usable in its side panel.
// Previous / Next walk the list the player was opened from.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { DialogShell } from '@avn/ui';
import { useRead } from '@/api';
import { DateRange, resolveRange } from '@/components/DateRange';
import { QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { CopyButton } from '@/components/CopyButton';
import type { ActiveFilters, DayRange } from '@/lib/filters';
import { timezoneOffset } from '@/lib/filters';
import { analysisDate, duration, number, type Timezone } from '@/lib/format';
import { gameURL } from '@/lib/games';
import type { Game, PlayerStory } from '@/lib/types';
import { PlayerInformation } from './DeviceInfo';
import { RawTimeline } from './RawTimeline';

/** The players the viewer walks: how many there are, which one is open, and the player at a position. */
export type PlayerBrowse = { index: number; total: number; load: (position: number) => Promise<{ id: string } | undefined> };
type PlayerTab = 'raw' | 'analysis' | 'info';

/** Previous / Next over the list the player was opened from; the address follows the player shown. */
function BrowseBar({ browse, player }: { browse: PlayerBrowse; player: string }): ReactElement {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { toastError } = useNotify();
  const [index, setIndex] = useState(browse.index);
  const [browsing, setBrowsing] = useState(false);
  useEffect(() => { setIndex(browse.index); }, [browse]);
  const go = async (direction: number) => {
    if (browsing) return;
    const next = index + direction;
    if (next < 0 || next >= browse.total) return;
    setBrowsing(true);
    try {
      const found = await browse.load(next);
      if (!found) throw new Error('This player list changed. Go back to the list to refresh it.');
      setIndex(next);
      void navigate({ to: pathname, search: (previous: Record<string, unknown>) => ({ ...previous, player: found.id }), replace: true, resetScroll: false });
    } catch (error) {
      toastError(error);
    } finally {
      setBrowsing(false);
    }
  };
  return (
    <div className="player-browse" data-player={player}>
      <button type="button" className="button small-button" onClick={() => void go(-1)} disabled={browsing || index === 0}>‹ Previous</button>
      <span aria-live="polite">{browsing ? 'Loading player…' : `${number(index + 1)} of ${number(browse.total)}`}</span>
      <button type="button" className="button small-button" onClick={() => void go(1)} disabled={browsing || index >= browse.total - 1}>Next ›</button>
    </div>
  );
}

/** The player as a page of its own (the Players list): back to the list, the ID with its copy button, then the details. */
export function PlayerPage({ game, player, filters, browse, onBack }: { game: Game; player: string; filters: ActiveFilters; browse?: PlayerBrowse; onBack: () => void }): ReactElement {
  return (
    <section className="player-page" aria-label="Player details">
      <header className="player-page-head">
        <button type="button" className="button small-button" onClick={onBack}>← Players</button>
        <div className="player-view-identity">
          <span className="player-view-id mono">{player}</span>
          <CopyButton text={player} label="Copy player ID" done="Player ID copied." />
        </div>
        {browse ? <BrowseBar browse={browse} player={player} /> : null}
      </header>
      <div className="player-page-body"><PlayerDetails game={game} player={player} filters={filters} /></div>
    </section>
  );
}

export function PlayerViewer({ game, player, filters, browse, onClose }: { game: Game; player: string | null; filters: ActiveFilters; browse?: PlayerBrowse; onClose: () => void }): ReactElement {
  const open = player != null;
  // Radix retains the closing surface while it fades. Keep its contents steady until it unmounts.
  const snapshot = useRef({ player, browse });
  if (open) snapshot.current = { player, browse };
  const shownPlayer = player ?? snapshot.current.player;
  const shownBrowse = open ? browse : snapshot.current.browse;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (player && body.current) body.current.scrollTop = 0; }, [player]);

  // Radix has no Dialog.Trigger here: the row lives on the page and the URL controls opening.
  // Restore its focus after the dialog finishes handing focus back on close.
  const trigger = useRef<HTMLElement | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const remember = (event: MouseEvent | KeyboardEvent) => {
      if (open || !(event.target instanceof HTMLElement)) return;
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
      trigger.current = event.target.closest<HTMLElement>('a, button, [tabindex]') ?? event.target;
      origin.current = { x: window.scrollX, y: window.scrollY };
    };
    document.addEventListener('click', remember, true);
    document.addEventListener('keydown', remember, true);
    return () => { document.removeEventListener('click', remember, true); document.removeEventListener('keydown', remember, true); };
  }, [open]);
  useEffect(() => {
    let frame: number | undefined;
    const restore = () => { frame = requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
      const spot = origin.current;
      if (spot && (window.scrollX !== spot.x || window.scrollY !== spot.y)) window.scrollTo({ left: spot.x, top: spot.y, behavior: 'instant' });
    }); };
    const closing = document.querySelector<HTMLElement>('.player-view-dialog[data-state="closed"]');
    const animated = closing && getComputedStyle(closing).animationName === 'player-viewer-out';
    if (wasOpen.current && !open) {
      if (animated) closing.addEventListener('animationend', restore, { once: true });
      else restore();
    }
    wasOpen.current = open;
    return () => { closing?.removeEventListener('animationend', restore); if (frame != null) cancelAnimationFrame(frame); };
  }, [open]);

  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Player details" className="player-view-dialog">
      <div className="player-view">
        <header className="player-view-head">
          <div className="player-view-identity">
            <span className="player-view-id mono">{shownPlayer}</span>
            {shownPlayer ? <CopyButton text={shownPlayer} label="Copy player ID" done="Player ID copied." /> : null}
          </div>
          <div className="player-view-tools">
            <button type="button" className="button small-button player-view-close" onClick={onClose}>Close ×</button>
          </div>
          {shownBrowse && shownPlayer ? <BrowseBar browse={shownBrowse} player={shownPlayer} /> : null}
        </header>
        <div className="player-view-main">
          <div className="player-view-body" ref={body}>
            {shownPlayer ? <PlayerDetails game={game} player={shownPlayer} filters={filters} /> : null}
          </div>
        </div>
      </div>
    </DialogShell>
  );
}

/** Mounted per opening, so each opening starts from the page's filters. */
function PlayerDetails({ game, player, filters }: { game: Game; player: string; filters: ActiveFilters }): ReactElement {
  const [range, setRange] = useState<DayRange>(() => resolveRange(filters.range.preset || '30', filters.range));
  const [timezone, setTimezone] = useState<Timezone>(filters.timezone);
  const [tab, chooseTab] = useState<PlayerTab>('raw');
  useEffect(() => { chooseTab('raw'); }, [player]);
  const storyPath = `${gameURL(game)}/insights/story?${new URLSearchParams({ start: range.from, end: range.to, player, tz_offset: String(timezoneOffset({ timezone })) })}`;
  const story = useRead<PlayerStory>(storyPath);

  return (
    <>
      <div className="filter-bar">
        <DateRange value={range} onChange={setRange} compact />
        <div className="segmented timezone-toggle" role="group" aria-label="Player event time zone">
          <button type="button" aria-pressed={timezone === 'local'} onClick={() => setTimezone('local')}>Local</button>
          <button type="button" aria-pressed={timezone === 'utc'} onClick={() => setTimezone('utc')}>UTC</button>
        </div>
      </div>
      <div className="analysis-context">{timezone === 'utc' ? 'UTC' : 'Local time'} · player ID = user_id, otherwise device_id</div>
      <QueryRegion query={story} path={storyPath} skeleton={<Skeleton kind="stats" />}>{(data) => <Stats data={data} timezone={timezone} />}</QueryRegion>
      <div className="range-modes route-tabs" role="group" aria-label="View">
        <button type="button" aria-pressed={tab === 'raw'} onClick={() => chooseTab('raw')}>Raw events</button>
        <button type="button" aria-pressed={tab === 'analysis'} onClick={() => chooseTab('analysis')}>Event Analysis</button>
        <button type="button" aria-pressed={tab === 'info'} onClick={() => chooseTab('info')}>Player info</button>
      </div>
      {tab === 'info' ? (
        <QueryRegion query={story} path={storyPath} skeleton={<Skeleton kind="table" rows={5} columns={2} />}>
          {(data) => <PlayerInformation game={game} player={player} data={data} timezone={timezone} />}
        </QueryRegion>
      ) : (
        <RawTimeline key={player} game={game} player={player} range={range} timezone={timezone} view={tab} onView={(next) => chooseTab(next)} />
      )}
    </>
  );
}

function Stats({ data, timezone }: { data: PlayerStory; timezone: Timezone }): ReactElement {
  const items: Array<[string, string, string]> = [
    ['Sessions', number(data.sessions), data.first_seen ? `${analysisDate(data.first_seen, timezone)} → ${analysisDate(data.last_seen, timezone)}` : ''],
    ['Events', number(data.events), ''],
    ['Play time', duration(data.total_play_seconds), data.average_session_seconds != null ? `${duration(data.average_session_seconds)} average session` : ''],
    ['Highest level', data.highest_level != null ? number(data.highest_level) : '—', ''],
  ];
  return (
    <div className="stat-strip">
      {items.map(([label, value, note]) => (
        <div className="stat" key={label}><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong>{note ? <span className="stat-note">{note}</span> : null}</div>
      ))}
    </div>
  );
}
