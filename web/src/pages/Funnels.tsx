// Funnels: how many players get through each step and where they stop, the saved funnels, the journeys
// between two steps and the breakdown by segment. The draft is remembered per game (`avn-funnel-draft-<id>`),
// the folded panels per game (`avn-collapsed-<id>`), the journeys choices per game (`avn-journeys-<id>`).
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useRead } from '@/api';
import { Heading, useNotify } from '@/components/feedback';
import { FilterBar, useFilters } from '@/components/Filters';
import { filterQuery, type Dimension } from '@/lib/filters';
import { gameURL } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';
import type { Catalog, FunnelDraft, FunnelResult, Game } from '@/lib/types';
import { FunnelEditor } from './funnels/FunnelEditor';
import { Breakdown, FunnelResultPanel } from './funnels/FunnelResultPanel';
import { INITIAL_JOURNEYS, JourneysPanel, type JourneysSession } from './funnels/Journeys';
import { blankStep, definition, funnelBody, type Definition } from './funnels/funnelMath';

const EMPTY_CATALOG: Catalog = { events: [] };
/** The panels that "Collapse all" folds, in the old order. */
const FOLDABLE = ['editor', 'result', 'breakdown', 'journeys'];
const DEFAULT_DRAFT: FunnelDraft = { id: null, name: '', steps: [], scope: 'player', window_hours: null };

type Submitted = { definition: Definition; body: Record<string, unknown> };

const draftKey = (game: Pick<Game, 'id'>) => `avn-funnel-draft-${game.id}`;
function loadDraft(game: Pick<Game, 'id'>): FunnelDraft {
  const saved = storeGet<Partial<FunnelDraft>>(draftKey(game));
  return { ...DEFAULT_DRAFT, ...(saved || {}), steps: (saved?.steps || []).map((step) => ({ ...blankStep(), ...step })) };
}

export function FunnelsPage({ game }: { game: Game }): ReactElement {
  const { toastError } = useNotify();
  const [filters, setFilters] = useFilters(game);
  const [draft, setDraft] = useState<FunnelDraft>(() => loadDraft(game));
  const [breakdown, setBreakdownState] = useState<Dimension | ''>('');
  const breakdownRef = useRef<Dimension | ''>('');
  // undefined before the first run, null while the funnel has fewer than two steps, otherwise what was sent.
  const [submitted, setSubmitted] = useState<Submitted | null | undefined>(undefined);
  const lastBody = useRef('');
  const [runCount, setRunCount] = useState(0);
  const [panelsKey, setPanelsKey] = useState(0);
  const [collapseLabel, setCollapseLabel] = useState('Collapse all');
  const [journeys, setJourneys] = useState<JourneysSession>(INITIAL_JOURNEYS);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => { storeSet(draftKey(game), draft); }, [game, draft]);

  const resultPath = `${gameURL(game)}/insights/funnel`;
  const resultQuery = useRead<FunnelResult>(submitted ? resultPath : null, { body: submitted?.body, keepPrevious: false });

  // Runs the funnel with this draft. A run again with the same body (the "Run funnel" button) asks the server again.
  const submit = (next: FunnelDraft, force = false) => {
    const def = definition(next);
    if (def.steps.length < 2) { setSubmitted(null); return; }
    const body = funnelBody(def, filtersRef.current, breakdownRef.current);
    const json = JSON.stringify(body);
    setSubmitted({ definition: def, body });
    if (force && json === lastBody.current) void resultQuery.refetch();
    lastBody.current = json;
  };

  // The filters changed (or the page opened): the result follows them.
  const filterKey = filterQuery(filters).toString();
  useEffect(() => { submit(draftRef.current); }, [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const catalogQuery = useRead<Catalog>(`${gameURL(game)}/insights/catalog?${filterQuery(filters)}`);
  const catalog = catalogQuery.data ?? EMPTY_CATALOG;
  useEffect(() => { if (catalogQuery.error) toastError(catalogQuery.error); }, [catalogQuery.error]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new funnel starts with two steps on the first event of the catalog.
  const firstEvent = catalogQuery.data?.events[0]?.name;
  useEffect(() => {
    if (!firstEvent || draftRef.current.steps.length) return;
    const next = { ...draftRef.current, steps: [blankStep(firstEvent), blankStep(firstEvent)] };
    setDraft(next);
    submit(next);
  }, [firstEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each finished run lets the journeys follow it.
  const resultAt = resultQuery.dataUpdatedAt;
  useEffect(() => { if (resultQuery.data) setRunCount((count) => count + 1); }, [resultAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const onBreakdown = (dimension: Dimension | '') => { breakdownRef.current = dimension; setBreakdownState(dimension); };

  const collapseAll = () => {
    const key = `avn-collapsed-${game.id}`;
    const stored = storeGet<Record<string, boolean>>(key) || {};
    const collapse = FOLDABLE.some((name) => !stored[name]);
    storeSet(key, { ...stored, ...Object.fromEntries(FOLDABLE.map((name) => [name, collapse])) });
    setPanelsKey((count) => count + 1);
    setCollapseLabel(collapse ? 'Expand all' : 'Collapse all');
  };

  const result = resultQuery.data;
  return (
    <>
      <Heading title="Funnels" subtitle="How many players get through each step, and where they stop." actions={<button className="button small-button" type="button" onClick={collapseAll}>{collapseLabel}</button>} />
      <FilterBar game={game} state={filters} onChange={setFilters} context={result ? { ...result.context, players: result.steps[0]?.players ?? 0 } : undefined} />
      <FunnelEditor game={game} current={draft} setCurrent={setDraft} catalog={catalog} breakdown={breakdown} onBreakdown={onBreakdown}
        onRun={(next) => submit(next, true)} panelsKey={panelsKey} />
      <FunnelResultPanel game={game} query={resultQuery} path={resultPath} submitted={submitted === undefined || submitted === null ? submitted : submitted.definition} range={filters.range} panelsKey={panelsKey} />
      <JourneysPanel game={game} steps={draft.steps.filter((step) => step.event)} catalog={catalog} query={() => funnelBody(definition(draft), filters)}
        runCount={runCount} panelsKey={panelsKey} session={journeys} onSession={(patch) => setJourneys((session) => ({ ...session, ...patch }))} />
      {result?.breakdown ? <Breakdown key={`b${panelsKey}`} game={game} data={result} /> : null}
    </>
  );
}
