// The players behind one level: the three groups (quit during, quit after finishing, reached the next),
// what the quitting players did last (with a popover holding the exact last event), the list with
// Show more, CSV, and a link per player that opens their timeline at their last event on the level.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearch } from '@tanstack/react-router';
import { read, useRead } from '@/api';
import { QueryRegion, Skeleton, Spinner, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import type { ActiveFilters } from '@/lib/filters';
import { analysisDate, duration, number, platformLabel, shortId } from '@/lib/format';
import { gamePath } from '@/lib/games';
import { downloadCSV } from '@/lib/store';
import type { Game, LevelCause, LevelLastAction, LevelPlayer, LevelPlayersResult, LevelRow } from '@/lib/types';
import { afterReturning, CARRIED_ON_GROUPS, LEVEL_DRILL_GROUPS, lastDidDetails, lastDidLabel, levelDrillGroup, type DrillSort, type LevelDrillGroup, type LevelScope } from './levelMath';
import { showDrill } from '@/pages/nutbot/context';
import { drillPagePath, drillPath, type DrillState } from './levelPaths';

/* ─── "What they did last": the label, its popover and the group's chips ─── */
export function LastDidButton({ row, index, expanded, onPointerOver, onPointerOut, onFocus, onBlur, onClick }: { row: Pick<LevelPlayer, 'last_action'>; index: number; expanded?: boolean; onPointerOver?: (event: React.PointerEvent<HTMLButtonElement>) => void; onPointerOut?: (event: React.PointerEvent<HTMLButtonElement>) => void; onFocus?: (event: React.FocusEvent<HTMLButtonElement>) => void; onBlur?: () => void; onClick?: (event: MouseEvent<HTMLButtonElement>) => void }): ReactElement {
  return <button type="button" className="last-did" data-last-did={index} aria-haspopup="dialog" aria-expanded={expanded ? 'true' : 'false'} onPointerOver={onPointerOver} onPointerOut={onPointerOut} onFocus={onFocus} onBlur={onBlur} onClick={onClick}>{lastDidLabel(row)}</button>;
}

/** The popover's content: the last event sent in that session, when it came, and what they did right after the level. */
export function LastDidDetails({ row, level }: { row: Pick<LevelPlayer, 'last_action' | 'next_action' | 'last_event' | 'ending_known' | 'prev_exit_reason' | 'prev_exit_ad'>; level: number }): ReactElement {
  const details = lastDidDetails(row, level);
  return (
    <>
      <h3>{details.title}</h3>
      <dl>{details.lines.map((line) => <div key={line.label}><dt>{line.label}</dt><dd>{line.mono ? <span className="mono">{line.body}</span> : line.body}{line.before ? <span className="muted">{line.before}</span> : null}</dd></div>)}</dl>
    </>
  );
}

// Above the label when there is room, else below it; always inside the window.
function placePopover(pop: HTMLElement, anchor: HTMLElement): { top: number; left: number } {
  const box = anchor.getBoundingClientRect();
  const above = box.top - pop.offsetHeight - 8 >= 8;
  return { top: Math.round(above ? box.top - pop.offsetHeight - 8 : box.bottom + 8), left: Math.round(Math.max(8, Math.min(box.left, window.innerWidth - pop.offsetWidth - 8))) };
}

/** One popover for those labels, in the top layer (document body) so a scrolling table cannot clip it. */
export function LastDidPopover({ row, level, anchor, pinned }: { row: LevelPlayer; level: number; anchor: HTMLElement; pinned: boolean }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => { if (box.current) setPlace(placePopover(box.current, anchor)); }, [anchor, row]);
  return createPortal(
    <div ref={box} className="last-did-pop" role="dialog" aria-label="Last event details" data-pinned={pinned ? '' : undefined} style={{ top: place?.top ?? -9999, left: place?.left ?? 0 }}>
      <LastDidDetails row={row} level={level} />
    </div>,
    document.body,
  );
}

/**
 * How the group's players' sessions ended, counted by cause: every ending around one kind of ad is one chip, however it
 * ended. Pick a cause to list only those players and to see how it ended (during, after, failed to show, ...); pick one
 * of those to narrow further. Without causes (an older server) it lists each exact last action instead. Nothing for
 * players who carried on.
 */
export function LastActions({ level, group, lastActions, causes, lastAction, cause, ending, onPick, onCause, onEnding }: {
  level: number; group: LevelDrillGroup; lastActions: LevelLastAction[] | undefined; causes?: LevelCause[]; lastAction: string | null; cause?: string | null; ending?: string | null;
  onPick?: (text: string | null) => void; onCause?: (key: string | null) => void; onEnding?: (key: string | null) => void;
}): ReactElement | null {
  if (CARRIED_ON_GROUPS.includes(group) || !lastActions?.length) return null;
  const label = group === 'came_back_later' ? 'Why they left' : 'How it ended';
  if (!causes?.length) {
    return (
      <div className="last-actions" role="group" aria-label={`What players did last on level ${level}`}>
        <span className="last-actions-label">{label}</span>
        {lastActions.map((item, index) => <button key={item.text} type="button" className="last-action" data-last-action={index} aria-pressed={lastAction === item.text} onClick={() => onPick?.(lastAction === item.text ? null : item.text)}>{item.text}<span className="drill-count">{number(item.players)}</span></button>)}
      </div>
    );
  }
  const chosen = causes.find((item) => item.key === cause);
  return (
    <div className="last-actions-grouped">
      <div className="last-actions" role="group" aria-label={`What players did last on level ${level}`}>
        <span className="last-actions-label">{label}</span>
        {causes.map((item, index) => <button key={item.key} type="button" className="last-action" data-last-cause={index} aria-pressed={cause === item.key} onClick={() => onCause?.(cause === item.key ? null : item.key)}>{item.label}<span className="drill-count">{number(item.players)}</span></button>)}
      </div>
      {chosen ? (
        <div className="last-actions last-endings" role="group" aria-label={`How ${chosen.label.toLowerCase()} endings went`}>
          <span className="last-actions-label">{number(chosen.left)} of {number(chosen.players)} told us how it ended</span>
          {chosen.endings.map((item, index) => <button key={item.key} type="button" className="last-action" data-last-ending={index} aria-pressed={ending === item.key} onClick={() => onEnding?.(ending === item.key ? null : item.key)}>{item.label}<span className="drill-count">{number(item.players)}</span></button>)}
        </div>
      ) : null}
    </div>
  );
}

/* ─── The drill ─── */
export function LevelDrill({ game, filters, scope, excludeReturners, level, row, memory, onOpenPlayer }: { game: Game; filters: ActiveFilters; scope: LevelScope; excludeReturners: boolean; level: number; row: LevelRow | undefined; memory: Map<number, DrillState>; onOpenPlayer?: (player: string, index: number, players: string[]) => void }): ReactElement {
  const { toastError } = useNotify();
  // A link from the table (?group=failed_left) opens that group; otherwise the group last used on this level, else the bigger drop.
  const asked = (useSearch({ strict: false }) as Record<string, string | undefined>).group;
  const requested = LEVEL_DRILL_GROUPS.find(([key]) => key === asked)?.[0];
  const [state, setStateRaw] = useState<DrillState>(() => (requested ? { ...(memory.get(level) ?? { sort: 'exit_at' as DrillSort }), group: requested, lastAction: null } : memory.get(level)) ?? { group: levelDrillGroup(row), sort: 'exit_at', lastAction: null });
  useEffect(() => { showDrill({ level, group: state.group, ...(state.lastAction ? { last_action: state.lastAction } : {}) }); return () => showDrill(null); }, [level, state.group, state.lastAction]);
  const setState = (patch: Partial<DrillState>) => setStateRaw((previous) => { const next = { ...previous, ...patch }; memory.set(level, next); return next; });
  const firstPath = drillPagePath(game, filters, scope, level, state, 0, excludeReturners);
  // A new group or sort waits for its own answer; the previous group's rows are not shown under its name.
  const first = useRead<LevelPlayersResult>(firstPath, { keepPrevious: false });
  // Pages after the first, kept only while the list they continue is the one shown.
  const [extra, setExtra] = useState<{ path: string; players: LevelPlayer[]; total: number | null }>({ path: firstPath, players: [], total: null });
  const [more, setMore] = useState<{ loading: boolean; error: unknown }>({ loading: false, error: null });
  const ticket = useRef(0);
  const showMore = async (loaded: number) => {
    const mine = ++ticket.current;
    setMore({ loading: true, error: null });
    try {
      const result = await read<LevelPlayersResult>(drillPagePath(game, filters, scope, level, state, loaded, excludeReturners));
      if (mine !== ticket.current) return;
      setExtra((previous) => (previous.path === firstPath ? { path: firstPath, players: [...previous.players, ...result.players], total: result.total } : { path: firstPath, players: result.players, total: result.total }));
      setMore({ loading: false, error: null });
    } catch (error) { if (mine === ticket.current) { setMore({ loading: false, error: null }); toastError(error); } }
  };

  // Hover or keyboard focus previews the last event; a click keeps it open until Escape or a click elsewhere.
  const [did, setDid] = useState<{ index: number; pinned: boolean; anchor: HTMLElement } | null>(null);
  const hideLastDid = useCallback(() => setDid(null), []);
  useEffect(() => {
    if (!did) return;
    const close = (event: Event) => {
      if (event.type === 'keydown' ? (event as KeyboardEvent).key === 'Escape' : event.type !== 'click' || !(event.target as Element | null)?.closest?.('.last-did, .last-did-pop')) hideLastDid();
    };
    document.addEventListener('keydown', close, true); document.addEventListener('click', close, true);
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close, true);
    return () => { document.removeEventListener('keydown', close, true); document.removeEventListener('click', close, true); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close, true); };
  }, [did, hideLastDid]);
  useEffect(() => hideLastDid, [firstPath, hideLastDid]);

  const exportCSV = async () => {
    try {
      const all = await read<LevelPlayersResult>(drillPath(game, filters, scope, level, state, { offset: 0, limit: 2000 }, excludeReturners));
      downloadCSV(`${game.name}-${platformLabel(game.platform)}-level-${level}-${state.group}${excludeReturners ? '-no-return' : ''}-${filters.range.from}_${filters.range.to}.csv`, [
        ['player', 'last_action', 'ending_known', 'prev_exit_reason', 'prev_exit_ad', 'away_seconds', 'passed_level', 'reached_next_level', 'next_action', 'last_event', 'last_event_after', 'last_event_gap_seconds', 'last_event_after_level_seconds', 'tries', 'fails', 'finished_level', 'last_on_level_utc', 'last_seen_utc', 'opened_game_later', 'app_version', 'session_seconds'],
        ...all.players.map((item) => [item.player, item.last_action, String(item.ending_known), item.prev_exit_reason, item.prev_exit_ad, item.away_seconds, item.passed == null ? undefined : String(item.passed), item.reached_next == null ? undefined : String(item.reached_next), item.next_action, item.last_event?.text, item.last_event?.after, item.last_event?.gap, item.last_event?.after_level, item.tries, item.fails, String(item.completed), item.exit_at, item.last_seen, String(item.came_back), item.app_version, item.session_seconds]),
      ]);
    } catch (error) { toastError(error); }
  };

  const quitting = !CARRIED_ON_GROUPS.includes(state.group);
  const returned = state.group === 'came_back_later';
  const counts: Record<string, number> | null = first.data?.counts ?? (row?.transition ? { left: row.transition.left, finished_stopped: row.transition.finished_stopped, kept_going: row.transition.kept_going, straight_on: row.transition.straight_on, came_back_later: row.transition.came_back_later, unknown_progress: row.transition.unknown_progress, failed_left: row.transition.failed_left, failed_kept_playing: row.transition.failed_kept_playing } : null);
  return (
    <div className="level-drill level-page-list" data-level-drill={level}>
      <div className="level-drill-head">
        <div className="segmented" role="group" aria-label={`Players on level ${level}`}>
          {LEVEL_DRILL_GROUPS.map(([key, label]) => <button key={key} type="button" data-drill-group={key} aria-pressed={state.group === key} onClick={() => { if (state.group !== key) setState({ group: key, lastAction: null, cause: null, ending: null }); }}>{excludeReturners && key === 'left' ? 'Stopped during level · no return' : excludeReturners && key === 'finished_stopped' ? 'Stopped after finishing · no return' : excludeReturners && key === 'failed_left' ? 'Failed · no return' : label}{counts ? <> <span className="drill-count">{number(counts[key])}</span></> : null}</button>)}
        </div>
        <div className="quiet-actions">
          <label className="inline-field icon-field"><Ico name="sort" size={14} /><span className="sr-only">Sort</span><select data-drill-sort aria-label="Sort players" value={state.sort} onChange={(event) => setState({ sort: event.target.value as DrillSort })}><option value="exit_at">Latest on this level</option><option value="tries">Most tries</option><option value="fails">Most fails</option></select></label>
          <button type="button" className="button" data-drill-csv onClick={exportCSV}><Ico name="export" size={14} /> CSV</button>
        </div>
      </div>
      {counts?.unknown_progress ? <p className="help">{number(counts.unknown_progress)} more {counts.unknown_progress === 1 ? 'player' : 'players'} in the drop started a later level without a start of level {level + 1}.</p> : null}
      {quitting && first.data?.no_ending ? <p className="help" data-no-ending>{number(first.data.no_ending)} of these {first.data.no_ending === 1 ? 'player has' : 'players have'} no known ending: they haven't returned, so “Last seen” is the last thing we heard, not why they left.</p> : null}
      {returned && excludeReturners ? <p className="help">Returners stay visible here and are excluded from drop counts, even if they have not reached the next level.</p> : returned && counts ? <p className="help">{number(counts.kept_going! - counts.straight_on!)} of them went on to reach level {level + 1}, so Drop doesn't count them.</p> : null}
      <LastActions level={level} group={state.group} lastActions={first.data?.last_actions} causes={first.data?.causes} lastAction={state.lastAction} cause={state.cause} ending={state.ending} onPick={(text) => setState({ lastAction: text })} onCause={(key) => setState({ cause: key, ending: null, lastAction: null })} onEnding={(key) => setState({ ending: key })} />
      <QueryRegion query={first} path={firstPath} skeleton={<Skeleton kind="table" rows={5} columns={8} />}>
        {(result) => {
          const players = extra.path === firstPath ? [...result.players, ...extra.players] : result.players;
          const total = extra.path === firstPath && extra.total != null ? extra.total : result.total;
          if (!players.length) return <p className="help">Nobody is in this group in the selected days and filters.</p>;
          // Columns that say the same thing on every row are left out: nobody came back in a no-return group, and one build needs no column.
          const showLater = !returned && players.some((item) => item.came_back);
          const showVersion = new Set(players.map((item) => item.app_version || '')).size > 1;
          return (
            <>
              <div className="table-wrap">
                <table className="compact-table">
                  <thead><tr><th>Player</th>{quitting ? <th title="Hover or click one to see the exact last event">{returned ? 'Why they left' : 'How it ended'}</th> : null}{returned ? <><th className="num">Away</th><th>Then</th></> : null}<th className="num">Tries</th><th className="num">Fails</th><th>Last on this level</th>{showLater ? <th className="col-secondary" title="Any later session by the end date">Opened the game later</th> : null}{showVersion ? <th className="col-secondary">Version</th> : null}<th className="num" title="The whole session they were last on this level in, not only the time on the level">Session length</th></tr></thead>
                  <tbody>
                    {players.map((item, index) => (
                      <tr key={item.player} data-player={item.player}>
                        <td><Link className="row-title" to={gamePath(game, 'levels')} search={(previous: Record<string, string | undefined>) => ({ ...previous, level: String(level), player: item.player })} onClick={(event: MouseEvent) => { if (onOpenPlayer && event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) { event.preventDefault(); onOpenPlayer(item.player, index, players.map((entry) => entry.player)); } }}><span className="mono">{shortId(item.player)}</span></Link></td>
                        {quitting ? <td className="small"><LastDidButton row={item} index={index} expanded={did?.index === index}
                          onPointerOver={(event) => { if (event.pointerType === 'mouse' && !did?.pinned) setDid({ index, pinned: false, anchor: event.currentTarget }); }}
                          onPointerOut={(event) => { if (event.pointerType === 'mouse' && !did?.pinned) hideLastDid(); }}
                          onFocus={(event) => { if (!did?.pinned && event.currentTarget.matches(':focus-visible')) setDid({ index, pinned: false, anchor: event.currentTarget }); }}
                          onBlur={() => { if (!did?.pinned) hideLastDid(); }}
                          onClick={(event) => { if (did?.index === index && did.pinned) hideLastDid(); else setDid({ index, pinned: true, anchor: event.currentTarget }); }} /></td> : null}
                        {returned ? <><td className="num">{duration(item.away_seconds)}</td><td className="small">{afterReturning(item, level)}</td></> : null}
                        <td className="num">{number(item.tries)}</td>
                        <td className="num">{number(item.fails)}</td>
                        <td className="small muted">{analysisDate(item.exit_at, filters.timezone)}</td>
                        {showLater ? <td className="col-secondary">{item.came_back ? <span className="pill good">came back</span> : <span className="small muted">—</span>}</td> : null}
                        {showVersion ? <td className="small col-secondary">{item.app_version || '—'}</td> : null}
                        <td className="num">{duration(item.session_seconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {did && players[did.index] && quitting ? <LastDidPopover row={players[did.index]!} level={level} anchor={did.anchor} pinned={did.pinned} /> : null}
              <div className="pager">
                <span className="small muted">{number(players.length)} of {number(total)}</span>
                {players.length < total ? <button type="button" className="button" data-drill-more disabled={more.loading} aria-busy={more.loading || undefined} onClick={() => showMore(players.length)}>{more.loading ? <Spinner label="Loading…" /> : 'Show more'}</button> : null}
              </div>
              <p className="foot-note">Session length is the whole session, not only this level{quitting ? <> · “Left” means the session’s end reached us, “Last seen” means it didn’t · point at one for the exact last event</> : null}.</p>
            </>
          );
        }}
      </QueryRegion>
    </div>
  );
}

