// "Level by level": the summary numbers, the players-remaining curve, and the table of every level with
// its sort, scope, rows per page, jump-to-level and paging. A row or a level opens that level's page.
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { prefetch } from '@/api';
import { Empty, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import type { ActiveFilters } from '@/lib/filters';
import { duration, number, percent } from '@/lib/format';
import { gamePath } from '@/lib/games';
import type { Game, LevelRow, LevelsResult } from '@/lib/types';
import { LEVEL_SCOPES, clampPage, levelHighlights, levelsNote, levelDrillGroup, pageSizeOf, pageCount, sortLevels, type LevelNavigation, type LevelPageSize, type LevelScope, type LevelSort } from './levelMath';
import { drillPagePath } from './levelPaths';
import { LevelViz } from './LevelViz';

const SORTS: Array<[LevelSort, string]> = [['level', 'Level order'], ['drop', 'Highest total drop'], ['completion', 'Lowest completion'], ['tries', 'Most tries per player'], ['time', 'Slowest']];
const PAGE_SIZES: Array<[LevelPageSize, string]> = [['25', '25'], ['50', '50'], ['100', '100'], ['all', 'All']];

/** The drop to the next level as a link to the level, with the net change under it. */
function DropCell({ game, row }: { game: Game; row: LevelRow }): ReactElement {
  const transition = row.transition;
  if (!transition?.available) return <span className="muted" title="No starters here or no observed start for the next numbered level. The next level may not exist or may be unlogged.">— Not enough data</span>;
  const net = transition.net_change ?? 0;
  return (
    <>
      <Link to={gamePath(game, 'levels')} search={{ level: String(row.level) }} className="level-drop-button" title={`Players who started this level but have no later start of level ${transition.next_level} by the end of these dates`}>
        <span className={`pill ${transition.total_drop ? 'bad' : 'good'}`}>↓ {percent(transition.drop_percent ?? 0)} drop · {number(transition.total_drop)}</span>
      </Link>
      <small className={`level-net ${net > 0 ? 'gain' : net < 0 ? 'loss' : ''}`} title="Separate comparison of filtered starter totals; includes players entering midway">
        {net > 0 ? '↑ Net gain +' : net < 0 ? '↓ Net loss ' : 'No net change '}{net ? number(Math.abs(net)) : ''}
      </small>
    </>
  );
}

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
  const [page, setPage] = useState(0);
  const [highlight, setHighlight] = useState<{ level: number; token: number } | null>(null);
  const [jumpText, setJumpText] = useState('');
  const box = useRef<HTMLElement>(null);
  const data = query.data;
  const sorted = useMemo(() => (data ? sortLevels(data.levels, nav.sort) : []), [data, nav.sort]);
  const current = clampPage(page, nav.pageSize, sorted.length);
  const minimum = data?.context.minimum_players ?? 0;
  const sample = !!data?.levels.some((row) => row.low_sample);
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

  const onJumpSubmit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); jumpTo(Number(jumpText)); };
  const openRow = (event: MouseEvent<HTMLTableRowElement>, level: number) => {
    if ((event.target as Element).closest('a, button')) return;
    onOpen(level);
  };

  return (
    <section ref={box} className="panel levels-panel">
      <div className="panel-header">
        <div><h2>Level by level</h2><p id="levels-note">{levelsNote(scope)}{sample ? <> <span className="level-sample-legend"><span className="level-sample-marker" aria-hidden="true">·</span> Small sample: fewer than {number(minimum)} players started.</span></> : null}</p></div>
        <div className="quiet-actions">
          <div className="segmented" role="group" aria-label="Which players">
            {(Object.entries(LEVEL_SCOPES) as Array<[LevelScope, string]>).map(([key, label]) => (
              <button key={key} type="button" aria-pressed={scope === key} onClick={() => { if (scope !== key) onNav({ scope: key }); }}>{label}</button>
            ))}
          </div>
          <label className="inline-field">Sort<select id="levels-sort" value={nav.sort} onChange={(event) => { setPage(0); onNav({ sort: event.target.value as LevelSort }); }}>
            {SORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
        </div>
      </div>
      <div className="levels-navigation">
        <form id="levels-jump-form" onSubmit={onJumpSubmit}>
          <label htmlFor="levels-jump">Jump to level</label>
          <input id="levels-jump" type="number" min={0} max={1000000} required placeholder="e.g. 120" value={jumpText} onChange={(event) => setJumpText(event.target.value)} />
          <button type="submit" className="button small-button">Go</button>
        </form>
        <label className="inline-field">Rows<select id="levels-page-size" value={nav.pageSize} onChange={(event) => { setPage(0); onNav({ pageSize: event.target.value as LevelPageSize }); }}>
          {PAGE_SIZES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <div className="quiet-actions">
          <button type="button" className="button small-button" id="levels-previous-page" disabled={!data?.levels.length || current === 0} onClick={() => setPage(current - 1)}>← Previous</button>
          <span id="levels-page-info" className="small muted" aria-live="polite">{data?.levels.length ? `${current * size + 1}–${Math.min((current + 1) * size, sorted.length)} of ${number(sorted.length)} levels` : data ? '0 levels' : ''}</span>
          <button type="button" className="button small-button" id="levels-next-page" disabled={!data?.levels.length || current + 1 >= pages} onClick={() => setPage(current + 1)}>Next →</button>
        </div>
      </div>
      <QueryRegion query={query} path={path} skeleton={<><Skeleton kind="stats" /><Skeleton kind="table" rows={8} columns={7} /></>}>
        {(result) => {
          if (!result.levels.length) {
            return <Empty title="No level data yet">Levels are read from events that start, complete, fail or restart a level, like “Started level 5”. Send some, or name yours in the event dictionary.</Empty>;
          }
          const { largestDrop, hardest, slowest } = levelHighlights(result.levels);
          const first = result.levels[0]!; const last = result.levels[result.levels.length - 1]!;
          return (
            <>
              <div className="kpis">
                <div className="kpi"><div className="eyebrow">Levels seen</div><div className="k-v">{number(result.levels.length)}</div><div className="k-c">{`level ${first.level} to ${last.level}`}</div></div>
                <div className="kpi"><div className="eyebrow">Largest total drop</div><div className="k-v">{largestDrop ? `Level ${largestDrop.level}` : '—'}</div><div className="k-c">{largestDrop ? `${percent(largestDrop.transition?.drop_percent ?? 0)} did not start level ${largestDrop.level + 1}${scope === 'first_session' ? ' in their first session' : ''}` : `needs at least ${number(minimum)} players`}</div></div>
                <div className="kpi"><div className="eyebrow">Hardest level</div><div className="k-v">{hardest ? `Level ${hardest.level}` : '—'}</div><div className="k-c">{hardest ? `${percent(hardest.completion ?? 0)} of players finish it` : `needs at least ${number(minimum)} players`}</div></div>
                <div className="kpi"><div className="eyebrow">Slowest level</div><div className="k-v">{slowest ? `Level ${slowest.level}` : '—'}</div><div className="k-c">{slowest ? `median ${duration(slowest.median_seconds)}` : ''}</div></div>
              </div>
              <LevelViz levels={result.levels} onOpen={onOpen} />
              <div className="table-wrap level-scroll levels-scroll" tabIndex={0} role="region" aria-label="Level results">
                <table className="levels-grid">
                  <thead><tr><th>Level</th><th className="num">Start</th><th className="num">Finish</th><th className="num" title="Players who started this level but did not later start the next numbered level ÷ players who started this level">Drop · start → start</th><th className="num">Tries / player</th><th className="num">Fails</th><th className="num">Median time</th></tr></thead>
                  <tbody>
                    {sorted.slice(current * size, (current + 1) * size).map((row) => (
                      <tr key={row.level} data-level-row={row.level} className={`${highlight?.level === row.level ? 'level-highlight ' : ''}${row.completion != null && !row.low_sample && row.completion < 60 ? 'level-hard' : ''}`}
                        onClick={(event) => openRow(event, row.level)}
                        onPointerOver={(event) => { if (event.pointerType === 'mouse') void prefetch(drillPagePath(game, filters, scope, row.level, { group: levelDrillGroup(row), sort: 'exit_at', lastAction: null }, 0)); }}>
                        <td className="level-number-cell">
                          <Link to={gamePath(game, 'levels')} search={{ level: String(row.level) }} className="level-toggle" aria-label={`Open the players behind level ${row.level}`}><Ico name="chevron" size={14} /></Link>
                          <strong>{row.level}</strong>
                          {row.low_sample ? <> <span className="level-sample-marker" role="img" aria-label={`Small sample: ${number(row.started)} of ${number(minimum)} players`} title={`Small sample: ${number(row.started)} players started; threshold is ${number(minimum)}`}>·</span></> : null}
                        </td>
                        <td className="num">{number(row.started)}</td>
                        <td className="num">{number(row.completed)}</td>
                        <td className="num"><DropCell game={game} row={row} /></td>
                        <td className="num">{row.tries_per_player ?? '—'}</td>
                        <td className="num">{number(row.fails)}{row.restarts ? <span className="muted small"> · {row.restarts} restart{row.restarts === 1 ? '' : 's'}</span> : null}</td>
                        <td className="num">{duration(row.median_seconds)}</td>
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
