// The player drawer (the old inspector drawer opened from the Players list, insights.js renderJourney): one
// player's summary, the time range and time zone, then Raw events, Event Analysis or Player info. Opened by
// `?player=` (the drawer is open while a player is given); Previous / Next walk the page of players it was
// opened from. The list keeps its place behind it.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { Drawer } from '@avn/ui';
import { useRead } from '@/api';
import { DateRange, resolveRange } from '@/components/DateRange';
import { Heading, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import type { ActiveFilters, DayRange } from '@/lib/filters';
import { timezoneOffset } from '@/lib/filters';
import { analysisDate, duration, number, shortId, type Timezone } from '@/lib/format';
import { gameURL } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';
import type { Game, PlayerStory } from '@/lib/types';
import { PlayerInformation } from './DeviceInfo';
import { RawTimeline } from './RawTimeline';

/** The players the drawer walks: how many there are, which one is open, and the player at a position. */
export type PlayerBrowse = { index: number; total: number; load: (position: number) => Promise<{ id: string } | undefined> };
type PlayerTab = 'raw' | 'analysis' | 'info';
const TAB_KEY = (game: Pick<Game, 'id'>) => `avn-story-view-${game.id}`;

export function PlayerDrawer({ game, player, filters, browse, onClose }: { game: Game; player: string | null; filters: ActiveFilters; browse?: PlayerBrowse; onClose: () => void }): ReactElement {
  const open = player != null;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { toastError } = useNotify();
  const [index, setIndex] = useState(browse?.index ?? 0);
  const [browsing, setBrowsing] = useState(false);
  useEffect(() => { setIndex(browse?.index ?? 0); }, [browse]);

  // Closing hands focus back to whatever was clicked to open the drawer (the list row).
  const trigger = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const remember = (event: MouseEvent) => {
      if (open || !(event.target instanceof HTMLElement)) return;
      trigger.current = event.target.closest<HTMLElement>('a, button, [tabindex]') ?? event.target;
    };
    document.addEventListener('click', remember, true);
    return () => document.removeEventListener('click', remember, true);
  }, [open]);
  useEffect(() => {
    if (wasOpen.current && !open && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
    wasOpen.current = open;
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
      void navigate({ to: pathname, search: (previous: Record<string, unknown>) => ({ ...previous, player: found.id }), replace: true });
    } catch (error) {
      toastError(error);
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Player details"
      subtitle={player ? shortId(player) : undefined}
      headerExtra={browse && player ? (
        <div className="player-browse">
          <button type="button" className="button small-button" onClick={() => void go(-1)} disabled={browsing || index === 0}>‹ Previous</button>
          <span aria-live="polite">{browsing ? 'Loading player…' : `${number(index + 1)} of ${number(browse.total)}`}</span>
          <button type="button" className="button small-button" onClick={() => void go(1)} disabled={browsing || index >= browse.total - 1}>Next ›</button>
        </div>
      ) : undefined}
    >
      {player ? <PlayerDetails game={game} player={player} filters={filters} /> : null}
    </Drawer>
  );
}

/** Everything inside the drawer for one open player. Mounted per opening, so each opening starts from the page's filters. */
function PlayerDetails({ game, player, filters }: { game: Game; player: string; filters: ActiveFilters }): ReactElement {
  const [range, setRange] = useState<DayRange>(() => resolveRange(filters.range.preset || '30', filters.range));
  const [timezone, setTimezone] = useState<Timezone>(filters.timezone);
  const [tab, setTab] = useState<PlayerTab>(() => {
    const saved = storeGet<string>(TAB_KEY(game));
    return saved === 'info' || saved === 'analysis' ? saved : 'raw';
  });
  const chooseTab = (next: PlayerTab) => { setTab(next); storeSet(TAB_KEY(game), next); };
  const storyPath = `${gameURL(game)}/insights/story?${new URLSearchParams({ start: range.from, end: range.to, player, tz_offset: String(timezoneOffset({ timezone })) })}`;
  const story = useRead<PlayerStory>(storyPath);

  return (
    <>
      <Heading title="Player" subtitle={player} />
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
