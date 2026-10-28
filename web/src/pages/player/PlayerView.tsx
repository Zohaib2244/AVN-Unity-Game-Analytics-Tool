// A centred player viewer over the list: summary, dates, then Raw events, Event Analysis or Player info.
// `?player=` opens it; Previous / Next walk the original list, which keeps its place behind the viewer.
// NutBot: the dialog makes the page behind it inert, so the same conversation is drawn inside the viewer
// (its slot) beside the player on wide screens, or as a Player / NutBot switch on narrow ones.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { Button, DialogShell } from '@avn/ui';
import { useRead } from '@/api';
import { useNutBot } from '@/app/nutbot';
import { DateRange, resolveRange } from '@/components/DateRange';
import { QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import type { ActiveFilters, DayRange } from '@/lib/filters';
import { timezoneOffset } from '@/lib/filters';
import { analysisDate, duration, number, type Timezone } from '@/lib/format';
import { gameURL } from '@/lib/games';
import { copyText } from '@/lib/store';
import type { Game, PlayerStory } from '@/lib/types';
import { PlayerInformation } from './DeviceInfo';
import { RawTimeline } from './RawTimeline';

/** The players the viewer walks: how many there are, which one is open, and the player at a position. */
export type PlayerBrowse = { index: number; total: number; load: (position: number) => Promise<{ id: string } | undefined> };
type PlayerTab = 'raw' | 'analysis' | 'info';

export function PlayerViewer({ game, player, filters, browse, onClose }: { game: Game; player: string | null; filters: ActiveFilters; browse?: PlayerBrowse; onClose: () => void }): ReactElement {
  const open = player != null;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { toast, toastError } = useNotify();
  const [index, setIndex] = useState(browse?.index ?? 0);
  const [browsing, setBrowsing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const nutbot = useNutBot();
  const chatting = open && nutbot.usable && nutbot.open;
  // On a narrow viewer only one of the two shows; every player opening starts on the player.
  const [pane, setPane] = useState<'player' | 'chat'>('player');
  useEffect(() => { setIndex(browse?.index ?? 0); }, [browse]);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; setPane('player'); }, [player]);
  const askNutBot = () => { nutbot.setOpen(true); setPane('chat'); };

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
    const frame = wasOpen.current && !open ? requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
      const spot = origin.current;
      if (spot && (window.scrollX !== spot.x || window.scrollY !== spot.y)) window.scrollTo({ left: spot.x, top: spot.y, behavior: 'instant' });
    }) : null;
    wasOpen.current = open;
    return () => { if (frame != null) cancelAnimationFrame(frame); };
  }, [open]);

  const go = async (direction: number) => {
    if (!browse || browsing) return;
    const next = index + direction;
    if (next < 0 || next >= browse.total) return;
    setBrowsing(true);
    try {
      const found = await browse.load(next);
      if (!found) throw new Error('This player list changed. Close and reopen the group to refresh it.');
      setIndex(next);
      void navigate({ to: pathname, search: (previous: Record<string, unknown>) => ({ ...previous, player: found.id }), replace: true, resetScroll: false });
    } catch (error) {
      toastError(error);
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Player details"
      className={chatting ? 'with-nb' : undefined}
    >
      <div className={`player-view${chatting ? ` with-nb pane-${pane}` : ''}`}>
        <header className="player-view-head">
          <div className="player-view-identity">
            <span className="player-view-id mono">{player}</span>
            {player ? <Button variant="ghost" size="sm" aria-label="Copy player ID" title="Copy player ID" onClick={async () => { toast((await copyText(player)) ? 'Player ID copied.' : 'Select the player ID and copy it manually.'); }}><Ico name="copy" size={16} /></Button> : null}
          </div>
          <div className="player-view-tools">
            {nutbot.usable && !chatting ? <Button size="sm" onClick={askNutBot}>Ask NutBot</Button> : null}
            {chatting ? (
              <div className="segmented player-view-panes" role="group" aria-label="Show">
                <button type="button" aria-pressed={pane === 'player'} onClick={() => setPane('player')}>Player</button>
                <button type="button" aria-pressed={pane === 'chat'} onClick={() => setPane('chat')}>NutBot</button>
              </div>
            ) : null}
            <button type="button" className="button small-button player-view-close" onClick={onClose}>Close ×</button>
          </div>
          {browse && player ? (
            <div className="player-browse">
              <button type="button" className="button small-button" onClick={() => void go(-1)} disabled={browsing || index === 0}>‹ Previous</button>
              <span aria-live="polite">{browsing ? 'Loading player…' : `${number(index + 1)} of ${number(browse.total)}`}</span>
              <button type="button" className="button small-button" onClick={() => void go(1)} disabled={browsing || index >= browse.total - 1}>Next ›</button>
            </div>
          ) : null}
        </header>
        <div className="player-view-main">
          <div className="player-view-body" ref={body}>
            {player ? <PlayerDetails game={game} player={player} filters={filters} /> : null}
          </div>
          {chatting ? <div className="player-view-chat" ref={nutbot.setSlot} /> : null}
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
