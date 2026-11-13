// Players: a sortable list with custom event-based columns and "only players who…" rules. The rules are
// remembered per game (`avn-players-view-<id>`), edited in the drawer and always shown in the rule bar
// above the data. `?player=` shows one player as a page in place of the list (Back returns to it).
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Drawer } from '@avn/ui';
import { freshness, markFresh, refreshAll, useRead } from '@/api';
import { Empty, Heading, QueryRegion, Skeleton } from '@/components/feedback';
import { FilterBar, useFilters } from '@/components/Filters';
import { Ico } from '@/components/icons';
import { filterQuery } from '@/lib/filters';
import { number, relativeTime } from '@/lib/format';
import { gamePath, gameURL } from '@/lib/games';
import { storeGet, storeSet, useStorePushed } from '@/lib/store';
import type { Catalog, EventRule, Game, PlayerRow, PlayersResult } from '@/lib/types';
import { PlayerPage, type PlayerBrowse } from './player/PlayerView';
import { RuleList, paramKeys, ruleOptions } from '@/components/EventRule';
import { GroupBar, GroupsMenu, libraryPath, type SavedChipGroup } from './players/Groups';
import { chipsFromSearch, groupParam, legacyChips, type Chip, type GroupCounts } from './players/chips';
import { ColumnsMenu, DEFAULT_COLUMNS } from './players/ColumnsMenu';
import { PlayersTable } from './players/PlayersTable';
import { AGG_LABELS, PAGE_SIZE, metricLabel, rulesBody, validSort } from './players/rules';

type PlayersView = { sort: string; order: 'asc' | 'desc'; conditions: EventRule[]; metrics: EventRule[]; fold: Record<string, boolean>; columns?: string[] };
const EMPTY_CATALOG: Catalog = { events: [] };
const viewKey = (game: Pick<Game, 'id'>) => `avn-players-view-${game.id}`;
const loadView = (game: Pick<Game, 'id'>): PlayersView => ({ sort: 'last_seen', order: 'desc', conditions: [], metrics: [], fold: {}, ...(storeGet<Partial<PlayersView>>(viewKey(game)) || {}) });
const blankMetric = (catalog: Catalog): EventRule => ({ event: catalog.events[0]?.name || '', param: '', op: 'eq', value: '', agg: 'count', of: '' });
const SUMMING = ['max', 'min', 'sum'];

function RuleSection({ title, count, note, folded, onToggle, children }: { title: string; count: number; note: string; folded: boolean; onToggle: () => void; children: ReactNode }): ReactElement {
  return (
    <section className={`rule-section${folded ? ' collapsed' : ''}`}>
      <button type="button" className="rule-section-toggle" aria-expanded={!folded} onClick={onToggle}>
        <span className="rule-chevron"><Ico name="chevron" size={15} /></span><span className="rule-section-title">{title}</span>
        {count ? <span className="count">{count}</span> : null}<span className="rule-section-note small muted">{note}</span>
      </button>
      {folded ? null : <div className="rule-section-body">{children}</div>}
    </section>
  );
}

function FreshStamp(): ReactElement {
  const updated = useSyncExternalStore(freshness.subscribe, freshness.get);
  return <button type="button" className="fresh" onClick={() => void refreshAll()} title="Refresh this page"><Ico name="refresh" size={13} /><span>Updated {relativeTime(updated)}</span></button>;
}

export function PlayersPage({ game }: { game: Game }): ReactElement {
  const navigate = useNavigate();
  const query = useSearch({ strict: false }) as Record<string, string | undefined>;
  const player = query.player || null;
  const [filters, setFilters] = useFilters(game);
  const [view, setViewState] = useState<PlayersView>(() => loadView(game));
  const setView = useCallback((update: (view: PlayersView) => PlayersView) => setViewState((previous) => { const next = update(previous); storeSet(viewKey(game), next); return next; }), [game]);
  useStorePushed(viewKey(game), () => { setViewState(loadView(game)); setOffset(0); });
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [browse, setBrowse] = useState<PlayerBrowse | undefined>();
  useEffect(() => { const timer = setTimeout(() => setSearch(typed.trim()), 250); return () => clearTimeout(timer); }, [typed]);

  // The group being shown: a saved group (id) or unsaved chips; "See these players" links arrive as chips.
  const groupKey = `avn-players-group-${game.id}`;
  const [group, setGroupState] = useState<{ id: string | null; chips: Chip[] }>(() => {
    const linked = chipsFromSearch(query);
    if (linked.length) return { id: null, chips: linked };
    const saved = storeGet<{ id: string | null; chips: Chip[] }>(groupKey) ?? { id: null, chips: [] };
    const old = loadView(game).conditions.filter((rule) => rule.event);
    if (!old.length) return saved;
    return { id: null, chips: [...saved.chips, ...legacyChips(old)] };
  });
  const setGroup = (next: { id: string | null; chips: Chip[] }) => { setGroupState(next); storeSet(groupKey, next); };
  useEffect(() => { if (view.conditions.length && !chipsFromSearch(query).length) { storeSet(groupKey, group); setView((v) => ({ ...v, conditions: [] })); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useRead<GroupCounts>(`${gameURL(game)}/insights/player-group-counts?${filterQuery(filters)}`);
  const library = useRead<SavedChipGroup[]>(`${libraryPath(game)}?kind=players`);
  const savedGroup = group.id ? library.data?.find((item) => item.id === group.id) ?? null : null;
  const playerGroup = groupParam(group.chips);
  const catalogQuery = useRead<Catalog>(`${gameURL(game)}/insights/catalog?${filterQuery(filters)}`);
  const catalog = catalogQuery.data ?? EMPTY_CATALOG;
  const body = useMemo(() => rulesBody({ ...view, conditions: [] }), [view]);
  const rulesJSON = body.conditions.length || body.metrics.length ? JSON.stringify(body) : '';
  const sort = validSort(view.sort, body.metrics);
  useEffect(() => { setOffset(0); }, [filters, search, sort, view.order, rulesJSON, playerGroup]);
  const playersPath = `${gameURL(game)}/insights/players?${filterQuery(filters)}&${new URLSearchParams([['search', search], ['offset', String(offset)], ['sort', sort], ['order', view.order], ...(rulesJSON ? [['rules', rulesJSON]] : []), ...(playerGroup ? [['player_group', playerGroup]] : [])])}`;
  const players = useRead<PlayersResult>(playersPath);
  useEffect(() => { if (players.data) markFresh(); }, [players.data]);
  const total = players.data?.total ?? null;

  const reload = () => setOffset(0);
  const setSort = (key: string) => setView((v) => (v.sort === key ? { ...v, order: v.order === 'desc' ? 'asc' : 'desc' } : { ...v, sort: key, order: 'desc' }));
  const setMetrics = (metrics: EventRule[]) => setView((v) => ({ ...v, metrics: metrics.map((rule) => (SUMMING.includes(rule.agg || '') && !rule.of ? { ...rule, of: paramKeys(catalog.events.find((item) => item.name === rule.event))[0] || '' } : rule)) }));
  const fold = (name: string) => setView((v) => ({ ...v, fold: { ...v.fold, [name]: !v.fold[name] } }));

  // Previous / Next on a player walk this page of players; Back returns to the list as it was.
  const open = useCallback((id: string, index: number, rows: PlayerRow[]) => {
    setBrowse({ index, total: rows.length, load: async (position: number) => (rows[position] ? { id: rows[position].player } : undefined) });
    void navigate({ to: gamePath(game, 'players'), search: { ...query, player: id }, resetScroll: false });
  }, [game, navigate, query]);
  const close = () => { setBrowse(undefined); const { player: _player, ...rest } = query; void navigate({ to: gamePath(game, 'players'), search: rest, resetScroll: false }); };

  const shownColumns = view.columns ?? DEFAULT_COLUMNS;
  const shownSet = useMemo(() => new Set(shownColumns), [shownColumns]);
  if (player) return <PlayerPage game={game} player={player} filters={filters} browse={browse} onBack={close} />;
  return (
    <>
      <Heading title="Players" subtitle="Open a player to read their events." />
      <FilterBar game={game} state={filters} onChange={setFilters} context={players.data?.context || {}} />
      <div className="players-layout">
        <div className="players-main">
          <GroupBar key={group.id ?? 'new'} lead={<GroupsMenu counts={counts.data} countsError={counts.isError} items={library.data} selected={group.id} unsaved={group.id ? [] : group.chips} total={total} onSelect={(item) => setGroup(item ? { id: item.id, chips: item.definition.chips } : { id: null, chips: [] })} />} game={game} chips={group.chips} onChips={(chips) => setGroup({ ...group, chips })} saved={savedGroup} catalog={catalog} total={total}
            onSaved={(item) => setGroup({ id: item.id, chips: item.definition.chips })} onDeleted={() => setGroup({ id: null, chips: [] })} />
      <section className="panel players-panel">
        {/* One line: find a player, then how the list is ordered and what extra columns it has. The rule bar above carries the count. */}
        <div className="panel-header players-head">
          <h2 className="sr-only">Players</h2>
          <div className="search"><Ico name="search" size={16} /><input type="search" aria-label="Search players" placeholder="Search by player ID…" value={typed} onChange={(e) => setTyped(e.target.value)} /></div>
          <div className="quiet-actions">
            <FreshStamp />
            <ColumnsMenu shown={shownColumns} onChange={(columns) => setView((v) => ({ ...v, columns }))} custom={body.metrics.length} onAddCustom={() => setRulesOpen(true)} />
          </div>
        </div>
        <QueryRegion query={players} path={`${gameURL(game)}/insights/players`} skeleton={<Skeleton kind="table" rows={8} columns={7} />}>
          {(data) => (data.players.length ? (
            <>
              <PlayersTable game={game} rows={data.players} metrics={body.metrics} shown={shownSet} sort={sort} order={view.order} timezone={filters.timezone} onSort={(key) => { setSort(key); reload(); }} onOpen={(id, index) => open(id, index, data.players)} />
              <div className="pager">
                <span className="small muted">{number(offset + 1)}–{number(offset + data.players.length)} of {number(data.total)}</span>
                <span><button type="button" className="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button> <button type="button" className="button" disabled={offset + data.players.length >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button></span>
              </div>
            </>
          ) : (
            <Empty title={search || playerGroup ? 'No matching players' : 'No players'}>{search || playerGroup ? 'Try another ID, or loosen a condition of the group.' : 'Pick other days or filters, or check that your game is sending events.'}</Empty>
          ))}
        </QueryRegion>
      </section>
        </div>
      </div>

      <Drawer open={rulesOpen} onClose={() => setRulesOpen(false)} title="Extra columns" subtitle="Work out a number for each player from an event, and sort by it">
        <div className="player-rules">
          <RuleSection title="Add a column (and sort by it)" count={body.metrics.length} note={body.metrics.map(metricLabel).join(' · ')} folded={!!view.fold.metrics} onToggle={() => fold('metrics')}>
            <p className="help">Pick what to work out for each player, from an event: how many times, the highest, lowest or total of one of its parameters, or when it first or last happened.</p>
            <RuleList rules={view.metrics} catalog={catalog} blank={blankMetric} addLabel="Add a column" empty="No extra columns yet." onChange={(rules) => { setMetrics(rules); reload(); }}
              before={(rule, _index, set) => <select className="rule-verb" aria-label="What to show" value={rule.agg || 'count'} onChange={(e) => set({ agg: e.target.value as EventRule['agg'] })}>{Object.entries(AGG_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
              after={(rule, _index, set, current) => (SUMMING.includes(rule.agg || '') ? <label className="rule-times">of this parameter <select className="rule-param" aria-label="Which parameter" value={rule.of || rule.param || ''} onChange={(e) => set({ of: e.target.value })}>{ruleOptions(paramKeys(current.events.find((item) => item.name === rule.event)), rule.of || rule.param || '', 'pick…')}</select></label> : null)} />
          </RuleSection>
        </div>
      </Drawer>

    </>
  );
}
