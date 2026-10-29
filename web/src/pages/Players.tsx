// Players: a sortable list with custom event-based columns and "only players who…" rules. The rules are
// remembered per game (`avn-players-view-<id>`), edited in the drawer and always shown in the rule bar
// above the data. `?player=` shows one player as a page in place of the list (Back returns to it).
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Drawer } from '@avn/ui';
import { freshness, markFresh, refreshAll, useRead } from '@/api';
import { Empty, Heading, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { FilterBar, useFilters } from '@/components/Filters';
import { Ico } from '@/components/icons';
import { filterQuery } from '@/lib/filters';
import { number, relativeTime } from '@/lib/format';
import { gamePath, gameURL } from '@/lib/games';
import { storeGet, storeSet, useStorePushed } from '@/lib/store';
import type { Catalog, EventRule, Game, PlayerRow, PlayersResult } from '@/lib/types';
import { PlayerPage, type PlayerBrowse } from './player/PlayerView';
import { RuleList, paramKeys, ruleOptions } from '@/components/EventRule';
import { PlayerRuleBar } from './players/PlayerRuleBar';
import { PlayersTable } from './players/PlayersTable';
import { AGG_LABELS, PAGE_SIZE, metricLabel, orderLabel, rulesBody, sortOptions, validSort } from './players/rules';

type PlayersView = { sort: string; order: 'asc' | 'desc'; conditions: EventRule[]; metrics: EventRule[]; fold: Record<string, boolean> };
const EMPTY_CATALOG: Catalog = { events: [] };
const viewKey = (game: Pick<Game, 'id'>) => `avn-players-view-${game.id}`;
const loadView = (game: Pick<Game, 'id'>): PlayersView => ({ sort: 'last_seen', order: 'desc', conditions: [], metrics: [], fold: {}, ...(storeGet<Partial<PlayersView>>(viewKey(game)) || {}) });
const blankCondition = (catalog: Catalog): EventRule => ({ event: catalog.events[0]?.name || '', param: '', op: 'eq', value: '', does: 'did', min_times: 1 });
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
  const { toast } = useNotify();
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

  const catalogQuery = useRead<Catalog>(`${gameURL(game)}/insights/catalog?${filterQuery(filters)}`);
  const catalog = catalogQuery.data ?? EMPTY_CATALOG;
  const body = useMemo(() => rulesBody(view), [view]);
  const rulesJSON = body.conditions.length || body.metrics.length ? JSON.stringify(body) : '';
  const sort = validSort(view.sort, body.metrics);
  useEffect(() => { setOffset(0); }, [filters, search, sort, view.order, rulesJSON]);
  const playersPath = `${gameURL(game)}/insights/players?${filterQuery(filters)}&${new URLSearchParams({ search, offset: String(offset), sort, order: view.order, ...(rulesJSON ? { rules: rulesJSON } : {}) })}`;
  const players = useRead<PlayersResult>(playersPath);
  useEffect(() => { if (players.data) markFresh(); }, [players.data]);
  const total = players.data?.total ?? null;

  const reload = () => setOffset(0);
  const setSort = (key: string) => setView((v) => (v.sort === key ? { ...v, order: v.order === 'desc' ? 'asc' : 'desc' } : { ...v, sort: key, order: 'desc' }));
  const setConditions = (conditions: EventRule[]) => setView((v) => ({ ...v, conditions }));
  const setMetrics = (metrics: EventRule[]) => setView((v) => ({ ...v, metrics: metrics.map((rule) => (SUMMING.includes(rule.agg || '') && !rule.of ? { ...rule, of: paramKeys(catalog.events.find((item) => item.name === rule.event))[0] || '' } : rule)) }));
  const removeRule = (index: number) => {
    const removed = view.conditions[index]!;
    setConditions(view.conditions.filter((_, position) => position !== index)); reload();
    toast('Rule removed', { label: 'Undo', run: () => { setView((v) => ({ ...v, conditions: [...v.conditions.slice(0, index), removed, ...v.conditions.slice(index)] })); reload(); } }, 'info');
  };
  const removeMetric = (index: number) => {
    const removed = view.metrics[index]!;
    setMetrics(view.metrics.filter((_, position) => position !== index)); reload();
    toast('Column removed', { label: 'Undo', run: () => { setView((v) => ({ ...v, metrics: [...v.metrics.slice(0, index), removed, ...v.metrics.slice(index)] })); reload(); } }, 'info');
  };
  const clearRules = () => {
    const before = view.conditions;
    setConditions([]); reload();
    toast('Rules cleared', { label: 'Undo', run: () => { setView((v) => ({ ...v, conditions: [...v.conditions, ...before] })); reload(); } }, 'info');
  };
  const fold = (name: string) => setView((v) => ({ ...v, fold: { ...v.fold, [name]: !v.fold[name] } }));

  // Previous / Next on a player walk this page of players; Back returns to the list as it was.
  const open = useCallback((id: string, index: number, rows: PlayerRow[]) => {
    setBrowse({ index, total: rows.length, load: async (position: number) => (rows[position] ? { id: rows[position].player } : undefined) });
    void navigate({ to: gamePath(game, 'players'), search: { ...query, player: id }, resetScroll: false });
  }, [game, navigate, query]);
  const close = () => { setBrowse(undefined); const { player: _player, ...rest } = query; void navigate({ to: gamePath(game, 'players'), search: rest, resetScroll: false }); };

  const active = body.conditions.length + body.metrics.length;
  const options = sortOptions(body.metrics);
  if (player) return <PlayerPage game={game} player={player} filters={filters} browse={browse} onBack={close} />;
  return (
    <>
      <Heading title="Players" subtitle="A player uses user_id when available, otherwise device_id. Open one to read their events, sort the list, or add event-based columns." />
      <FilterBar game={game} state={filters} onChange={setFilters} context={players.data?.context || {}} />
      <PlayerRuleBar conditions={view.conditions} metrics={view.metrics} total={total} onEdit={() => setRulesOpen(true)} onRemoveRule={removeRule} onRemoveMetric={removeMetric} onClear={clearRules} />
      <section className="panel section-spacing">
        <div className="panel-header">
          <div><h2>Players <span className="count">{number(total ?? 0)}</span></h2></div>
          <div className="quiet-actions"><FreshStamp /><div className="search"><Ico name="search" size={16} /><input type="search" aria-label="Search players" placeholder="Search by user or install ID…" value={typed} onChange={(e) => setTyped(e.target.value)} /></div></div>
        </div>
        <div className="players-toolbar">
          <label className="inline-field">Sort by<select value={sort} onChange={(e) => { setView((v) => ({ ...v, sort: e.target.value })); reload(); }}>{options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <button type="button" className="button small-button" onClick={() => { setView((v) => ({ ...v, order: v.order === 'desc' ? 'asc' : 'desc' })); reload(); }}>{view.order === 'desc' ? '↓' : '↑'} {orderLabel(sort, view.order, body.metrics)}</button>
          <button type="button" className="button small-button rules-toggle" aria-haspopup="dialog" onClick={() => setRulesOpen(true)}><Ico name="funnel" size={14} /> Event rules {active ? <span className="count">{active}</span> : null}</button>
        </div>
        <QueryRegion query={players} path={`${gameURL(game)}/insights/players`} skeleton={<Skeleton kind="table" rows={8} columns={7} />}>
          {(data) => (data.players.length ? (
            <>
              <PlayersTable game={game} rows={data.players} metrics={body.metrics} sort={sort} order={view.order} timezone={filters.timezone} onSort={(key) => { setSort(key); reload(); }} onOpen={(id, index) => open(id, index, data.players)} />
              <div className="pager">
                <span className="small muted">{number(offset + 1)}–{number(offset + data.players.length)} of {number(data.total)}</span>
                <span><button type="button" className="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button> <button type="button" className="button" disabled={offset + data.players.length >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button></span>
              </div>
            </>
          ) : (
            <Empty title={search || body.conditions.length ? 'No matching players' : 'No players'}>{search || body.conditions.length ? 'Try another ID, or loosen the event rules.' : 'Pick other days or filters, or check that your game is sending events.'}</Empty>
          ))}
        </QueryRegion>
      </section>

      <Drawer open={rulesOpen} onClose={() => setRulesOpen(false)} title="Player rules" subtitle="Who to show, and extra columns">
        <div className="player-rules">
          <RuleSection title="Only show players who…" count={body.conditions.length} note={body.conditions.map((rule) => `${rule.does === 'didnt' ? 'never' : 'did'} ${rule.event}${rule.param ? ` (${rule.param})` : ''}`).join(' · ')} folded={!!view.fold.conditions} onToggle={() => fold('conditions')}>
            <p className="help">Every rule here must be true. For example: <em>Did</em> <code>POWERUP_CONSUMED</code> at least 3 times, or <em>Never did</em> <code>SETTINGS_OPENED</code>.</p>
            <RuleList rules={view.conditions} catalog={catalog} blank={blankCondition} addLabel="Add a condition" empty="No conditions yet." onChange={(rules) => { setConditions(rules); reload(); }}
              before={(rule, _index, set) => <select className="rule-verb" aria-label="Did or never did" value={rule.does === 'didnt' ? 'didnt' : 'did'} onChange={(e) => set({ does: e.target.value as 'did' | 'didnt' })}><option value="did">Did</option><option value="didnt">Never did</option></select>}
              after={(rule, _index, set) => (rule.does === 'didnt' ? null : <span className="rule-times">at least <input type="number" min={1} max={100000} aria-label="At least this many times" value={rule.min_times || 1} onChange={(e) => set({ min_times: Number(e.target.value) || 1 })} /> time{(rule.min_times || 1) === 1 ? '' : 's'}</span>)} />
          </RuleSection>
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
