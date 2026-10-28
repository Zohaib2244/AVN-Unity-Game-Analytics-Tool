// "Level by level": the table of every level with its scope, sort, display settings (columns, heat, flags),
// jump-to-level and paging, plus a Summary dialog (the levels worth a look and players remaining by level).
// A row or a level opens that level's page. Drops and quits are drawn against per-game flag thresholds.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { prefetch } from '@/api';
import { AnimatePresence, motion } from 'motion/react';
import { Empty, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Ico, type IcoName } from '@/components/icons';
import type { ActiveFilters } from '@/lib/filters';
import { duration, number } from '@/lib/format';
import { useStored } from '@/lib/store';
import { POP } from '@/lib/motion';
import { gamePath } from '@/lib/games';
import type { Game, LevelRow, LevelsResult } from '@/lib/types';
import { LEVEL_SCOPES, clampPage, levelDrillGroup, pageSizeOf, pageCount, sortLevels, type LevelNavigation, type LevelPageSize, type LevelScope, type LevelSort } from './levelMath';
import { drillPagePath } from './levelPaths';
import { HeatValue } from './LevelHeat';
import { LevelDisplayMenu } from './LevelDisplayMenu';
import { LevelSummary } from './LevelSummary';
import { cleanDisplay, displayKey, heatOf, type LevelDisplay } from './levelDisplay';
import { forgetSpot, rememberSpot, returnSpot, scrollBackTo } from './levelReturn';

const SORTS: Array<[LevelSort, string]> = [['level', 'Level order'], ['drop', 'Highest total drop'], ['failquit', 'Most failers who quit'], ['completion', 'Lowest completion'], ['tries', 'Most tries per player'], ['time', 'Slowest']];
const PAGE_SIZES: Array<[LevelPageSize, string]> = [['25', '25'], ['50', '50'], ['100', '100'], ['all', 'All']];

/** The drop to the next level as a link to the level: a heat cell or bar against the drop flag. */
function DropCell({ game, row, display }: { game: Game; row: LevelRow; display: LevelDisplay }): ReactElement {
  const transition = row.transition;
  if (!transition?.available) return <span className="muted" title="No starters here or no observed start for the next numbered level. The next level may not exist or may be unlogged.">—</span>;
  const net = transition.net_change ?? 0;
  const netText = net > 0 ? `net gain +${number(net)}` : net < 0 ? `net loss ${number(Math.abs(net))}` : 'no net change';
  return (
    <Link to={gamePath(game, 'levels')} search={{ level: String(row.level) }} className="level-drop-button" title={`${number(transition.total_drop)} players started this level but have no later start of level ${transition.next_level} by the end of these dates · ${netText} (filtered starter totals, includes players entering midway)`}>
      <HeatValue value={transition.drop_percent ?? 0} threshold={display.dropFlag} style={display.style} counts={display.counts} count={number(transition.total_drop)} title={`${number(transition.total_drop)} of ${number(row.started)} did not start level ${transition.next_level}`} />
    </Link>
  );
}

/** Of the players who failed this level, how many then left for good: failing and playing on is fine, failing and leaving is the problem. */
function FailQuitCell({ game, row, display }: { game: Game; row: LevelRow; display: LevelDisplay }): ReactElement {
  const transition = row.transition;
  if (!transition?.available) return <span className="muted" title="Needs a later level to tell who left.">—</span>;
  if (!transition.failed) return <span className="muted" title="Nobody failed this level in these days.">—</span>;
  return (
    <Link to={gamePath(game, 'levels')} search={{ level: String(row.level), group: 'failed_left' }} className="level-drop-button" title={`${number(transition.failed_left)} of ${number(transition.failed)} players who failed level ${row.level} did not pass it or play on. ${number(transition.failed_kept_playing)} failed and kept playing.`}>
      <HeatValue value={transition.fail_drop_percent ?? 0} threshold={display.quitFlag} style={display.style} counts={display.counts} count={`${number(transition.failed_left)}/${number(transition.failed)}`} title={`${number(transition.failed_left)} of ${number(transition.failed)} who failed then left`} />
    </Link>
  );
}

const Th = ({ icon, children, title }: { icon: IcoName; children: string; title?: string }): ReactElement => <th className="num" title={title}><Ico name={icon} size={13} className="th-ico" />{children}</th>;

type Props = {
  game: Game;
  filters: ActiveFilters;
  scope: LevelScope;
  nav: LevelNavigation;
  onNav: (patch: Partial<LevelNavigation>) => void;
  query: UseQueryResult<LevelsResult>;
  path: string;
  /** A jump requested from elsewhere (Compare releases): the table scrolls to and highlights that level. */
  jump: { level: number } | null;
  onJumped: () => void;
  onOpen: (level: number) => void;
};

export function LevelTable({ game, filters, scope, nav, onNav, query, path, jump, onJumped, onOpen }: Props): ReactElement {
  const { toast } = useNotify();
  // Back from a level's page: the same page of levels, then the same scroll position once the rows are there.
  const [spot] = useState(() => returnSpot(game.id));
  const [page, setPage] = useState(spot?.page ?? 0);
  const returning = useRef(spot);
  const [highlight, setHighlight] = useState<{ level: number; token: number } | null>(null);
  const [jumpText, setJumpText] = useState('');
  const box = useRef<HTMLElement>(null);
  const data = query.data;
  const sorted = useMemo(() => (data ? sortLevels(data.levels, nav.sort) : []), [data, nav.sort]);
  const current = clampPage(page, nav.pageSize, sorted.length);
  const minimum = data?.context.minimum_players ?? 0;
  const [stored, setDisplay] = useStored<unknown>(displayKey(game), null);
  const display = useMemo(() => cleanDisplay(stored), [stored]);
  const [summary, setSummary] = useState(false);
  const flagged = data ? data.levels.filter((row) => heatOf(row.transition?.drop_percent, display.dropFlag).over && !row.low_sample).length : 0;
  const size = pageSizeOf(nav.pageSize, sorted.length);
  const pages = pageCount(nav.pageSize, sorted.length);

  const jumpTo = (level: number) => {
    if (!data) return;
    const index = sorted.findIndex((row) => row.level === level);
    if (index < 0) { toast('No data for that level in the current filters.'); return; }
    setPage(nav.pageSize === 'all' ? 0 : Math.floor(index / Number(nav.pageSize)));
    setHighlight({ level, token: Date.now() });
  };
  useEffect(() => { if (jump && data) { jumpTo(jump.level); onJumped(); } }, [jump, data]);
  useEffect(() => {
    if (!highlight) return;
    const row = box.current?.querySelector<HTMLElement>(`[data-level-row="${highlight.level}"]`);
    row?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    row?.querySelector<HTMLElement>('.level-toggle')?.focus({ preventScroll: true });
  }, [highlight]);

  useLayoutEffect(() => {
    if (!returning.current || !data?.levels.length) return;
    const { y } = returning.current;
    returning.current = null; forgetSpot(game.id);
    return scrollBackTo(y);
  }, [data, game.id]);

  const onJumpSubmit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); jumpTo(Number(jumpText)); };
  const openRow = (event: MouseEvent<HTMLTableRowElement>, level: number) => {
    if ((event.target as Element).closest('a, button')) return;
    onOpen(level);
  };

  const columns = display.columns;
  return (
    <section ref={box} className="panel levels-panel" onClickCapture={() => rememberSpot(game.id, { y: window.scrollY, page: current })}>
      <div className="panel-header">
        <div><h2 className="with-icon"><Ico name="chart" size={16} /> Level by level</h2></div>
        <div className="quiet-actions">
          <div className="segmented" role="group" aria-label="Which players">
            {(Object.entries(LEVEL_SCOPES) as Array<[LevelScope, string]>).map(([key, label]) => (
              <button key={key} type="button" aria-pressed={scope === key} onClick={() => { if (scope !== key) onNav({ scope: key }); }}><Ico name={key === 'all' ? 'users' : 'user-plus'} size={14} />{label}</button>
            ))}
          </div>
          <label className="inline-field icon-field"><Ico name="sort" size={14} /><span className="sr-only">Sort</span><select id="levels-sort" aria-label="Sort" value={nav.sort} onChange={(event) => { setPage(0); onNav({ sort: event.target.value as LevelSort }); }}>
            {SORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <LevelDisplayMenu display={display} onChange={setDisplay} />
          <button type="button" className="btn" disabled={!data?.levels.length} onClick={() => setSummary(true)}><Ico name="chart" size={14} /> Summary</button>
        </div>
      </div>
      <div className="levels-navigation">
        <form id="levels-jump-form" onSubmit={onJumpSubmit}>
          <label htmlFor="levels-jump" className="icon-field"><Ico name="search" size={14} /><span className="sr-only">Jump to level</span></label>
          <input id="levels-jump" type="number" min={0} max={1000000} required placeholder="Jump to level" value={jumpText} onChange={(event) => setJumpText(event.target.value)} />
          <button type="submit" className="button small-button">Go</button>
        </form>
        <span className="level-flags" title="Cells over these percentages are tinted: hotter the further over. Change them in Display.">
          <Ico name="flag" size={13} /> Flagging drops &gt; {display.dropFlag}%{columns.failquit ? ` · quits > ${display.quitFlag}%` : ''}
          <AnimatePresence initial={false} mode="popLayout">{flagged ? <motion.b key="n" className="level-flagged" {...POP}>{flagged} flagged</motion.b> : null}</AnimatePresence>
        </span>
        <div className="quiet-actions">
          <span id="levels-page-info" className="small muted" aria-live="polite">{data?.levels.length ? `${current * size + 1}–${Math.min((current + 1) * size, sorted.length)} of ${number(sorted.length)}` : data ? '0 levels' : ''}</span>
          <button type="button" className="button small-button icon-only" id="levels-previous-page" aria-label="Previous page" disabled={!data?.levels.length || current === 0} onClick={() => setPage(current - 1)}><Ico name="prev" size={14} /></button>
          <button type="button" className="button small-button icon-only" id="levels-next-page" aria-label="Next page" disabled={!data?.levels.length || current + 1 >= pages} onClick={() => setPage(current + 1)}><Ico name="next" size={14} /></button>
          <label className="inline-field"><span className="sr-only">Rows per page</span><select id="levels-page-size" aria-label="Rows per page" value={nav.pageSize} onChange={(event) => { setPage(0); onNav({ pageSize: event.target.value as LevelPageSize }); }}>
            {PAGE_SIZES.map(([key, label]) => <option key={key} value={key}>{label === 'All' ? 'All rows' : `${label} rows`}</option>)}
          </select></label>
        </div>
      </div>
      <QueryRegion query={query} path={path} skeleton={<Skeleton kind="table" rows={8} columns={6} />}>
        {(result) => {
          if (!result.levels.length) {
            return <Empty title="No level data yet">Levels are read from events that start, complete, fail or restart a level, like “Started level 5”. Send some, or name yours in the event dictionary.</Empty>;
          }
          return (
            <>
              <LevelSummary open={summary} onClose={() => setSummary(false)} levels={result.levels} minimum={minimum} dropFlag={display.dropFlag} quitFlag={display.quitFlag} firstSession={scope === 'first_session'} onJump={jumpTo} onOpen={onOpen} />
              <div className="table-wrap level-scroll levels-scroll" tabIndex={0} role="region" aria-label="Level results">
                <table className="levels-grid">
                  <thead><tr><th>Level</th>
                    {columns.started ? <Th icon="play">Started</Th> : null}
                    {columns.finished ? <Th icon="check">Finished</Th> : null}
                    {columns.drop ? <Th icon="trend" title="Players who started this level but did not later start the next numbered level ÷ players who started this level">Drop to next</Th> : null}
                    {columns.failquit ? <Th icon="exit" title="Of the players who failed this level, the share who then did not pass it or play on">Failed → quit</Th> : null}
                    {columns.tries ? <Th icon="refresh">Tries / player</Th> : null}
                    {columns.fails ? <Th icon="alert">Fails</Th> : null}
                    {columns.time ? <Th icon="clock">Median time</Th> : null}
                  </tr></thead>
                  <tbody>
                    {sorted.slice(current * size, (current + 1) * size).map((row) => (
                      <tr key={row.level} data-level-row={row.level} className={`${highlight?.level === row.level ? 'level-highlight' : ''}`}
                        onClick={(event) => openRow(event, row.level)}
                        onPointerOver={(event) => { if (event.pointerType === 'mouse') void prefetch(drillPagePath(game, filters, scope, row.level, { group: levelDrillGroup(row), sort: 'exit_at', lastAction: null }, 0)); }}>
                        <td className="level-number-cell">
                          <Link to={gamePath(game, 'levels')} search={{ level: String(row.level) }} className="level-toggle" aria-label={`Open the players behind level ${row.level}`}><Ico name="chevron" size={14} /></Link>
                          <strong>{row.level}</strong>
                          {row.low_sample ? <> <span className="level-sample-marker" role="img" aria-label={`Small sample: ${number(row.started)} of ${number(minimum)} players`} title={`Small sample: ${number(row.started)} players started; threshold is ${number(minimum)}`}>·</span></> : null}
                        </td>
                        {columns.started ? <td className="num">{number(row.started)}</td> : null}
                        {columns.finished ? <td className="num">{number(row.completed)}</td> : null}
                        {columns.drop ? <td className="num"><DropCell game={game} row={row} display={display} /></td> : null}
                        {columns.failquit ? <td className="num"><FailQuitCell game={game} row={row} display={display} /></td> : null}
                        {columns.tries ? <td className="num">{row.tries_per_player ?? '—'}</td> : null}
                        {columns.fails ? <td className="num">{number(row.fails)}{row.restarts ? <span className="muted small"> · {row.restarts} restart{row.restarts === 1 ? '' : 's'}</span> : null}</td> : null}
                        {columns.time ? <td className="num">{duration(row.median_seconds)}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </QueryRegion>
    </section>
  );
}
