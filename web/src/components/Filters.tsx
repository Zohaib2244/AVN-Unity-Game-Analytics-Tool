// The filter bar at the top of every game dashboard: days, time zone, density, one "Filters" menu and
// chips for what is active. Remembered per game. `onChange(state)` runs on mount and after each change.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Popover, Segmented } from '@avn/ui';
import { useRead } from '@/api';
import { dimensionText, number, prettyDay } from '@/lib/format';
import { gameURL } from '@/lib/games';
import { DIMENSION_LABELS, MENU_DIMENSIONS, activeFilters, choiceOf, filterState, saveFilters, timezoneOffset, withChoice, type ActiveFilters, type Dimension, type DimensionChoice, type Facets, type FilterState } from '@/lib/filters';
import type { Game } from '@/lib/types';
import { DateRange, resolveRange } from './DateRange';
import { useNotify } from './feedback';
import { Ico, type IcoName } from './icons';
import { OptionList } from './OptionList';
import { POP } from '@/lib/motion';
import { isReleaseVersion, sortVersions } from '@/lib/versions';

/** The filter choices (and the latest and previous published builds) for a game and range. */
export const facetsPath = (game: Pick<Game, 'id'>, state: Pick<ActiveFilters, 'range' | 'timezone'>): string => `${gameURL(game)}/insights/facets?${new URLSearchParams({ start: state.range.from, end: state.range.to, tz_offset: String(timezoneOffset(state)) })}`;

const DIMENSION_ICONS: Record<Dimension, IcoName> = { environment: 'flask', app_version: 'tag', build: 'tag', country: 'globe', platform: 'phone' };

/** What one category says on the bar: "Country is not Pakistan", "Platform is Android, iOS +1". */
export function choiceText(dimension: Dimension, choice: DimensionChoice): string {
  const names = choice.values.map((value) => dimensionText(dimension, value));
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** What the Filters menu edits: a copy, applied only when Done is pressed. */
type Draft = Pick<FilterState, 'hideTest' | 'environment' | 'app_version' | 'build' | 'country' | 'platform' | 'exclude' | 'versionMode'>;
const draftOf = (state: FilterState): Draft => ({ hideTest: state.hideTest, environment: state.environment, app_version: state.app_version, build: state.build, country: state.country, platform: state.platform, exclude: state.exclude, versionMode: state.versionMode });

/** One category, "only these" or "everything except"; a hand-picked version list is the 'custom' build mode. */
function choose<T extends Draft>(state: T, dimension: Dimension, next: DimensionChoice): T {
  const changed = withChoice(state, dimension, next);
  return dimension === 'app_version' ? { ...changed, versionMode: next.values.length ? 'custom' : 'all' } : changed;
}
/** Latest, previous or all builds. */
function chooseBuild<T extends Draft>(state: T, mode: 'latest' | 'previous' | 'all', facets: Facets): T {
  const wanted = mode === 'latest' ? facets.latest_app_version : mode === 'previous' ? facets.previous_app_version : null;
  return withChoice({ ...state, versionMode: mode }, 'app_version', { mode: 'in', values: wanted ? [wanted] : [] });
}

export type FilterContext = { anonymous_events?: number; excluded_events?: number; low_sample?: boolean; players?: number; minimum_players?: number };

/** Owns the filter state for a game page. Returns the active state (range resolved) and a setter. */
export function useFilters(game: Pick<Game, 'id'>): [ActiveFilters, (update: (state: ActiveFilters) => ActiveFilters) => void] {
  const [state, setState] = useState<ActiveFilters>(() => { const saved = filterState(game); return { ...saved, range: resolveRange(saved.range?.preset || '30', saved.range) }; });
  useEffect(() => { const saved = filterState(game); setState({ ...saved, range: resolveRange(saved.range?.preset || '30', saved.range) }); }, [game.id]);
  const update = useCallback((fn: (state: ActiveFilters) => ActiveFilters) => setState((previous) => { const next = fn(previous); saveFilters(game, next); return next; }), [game]);
  return [state, update];
}

export function FilterBar({ game, state, onChange, context, children }: { game: Pick<Game, 'id'>; state: ActiveFilters; onChange: (update: (state: ActiveFilters) => ActiveFilters) => void; context?: FilterContext; children?: ReactNode }): ReactElement {
  const { toast } = useNotify();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const facetsQuery = useRead<Facets>(facetsPath(game, state));
  const facets = facetsQuery.data ?? {};
  // On the default (latest build) the newest build is applied as soon as it is known; "Previous" does the same with the one before it.
  useEffect(() => {
    if ((state.versionMode !== 'latest' && state.versionMode !== 'previous') || !facetsQuery.data) return;
    const wanted = state.versionMode === 'latest' ? facetsQuery.data.latest_app_version : facetsQuery.data.previous_app_version;
    const builds = wanted ? [wanted] : [];
    if (builds.join() !== state.app_version.join()) onChange((s) => ({ ...s, app_version: builds }));
  }, [facetsQuery.data, state.versionMode, state.app_version, onChange]);
  const set = (patch: Partial<Omit<FilterState, 'range'>> & { range?: ActiveFilters['range'] }) => onChange((s) => ({ ...s, ...patch }));
  const removeCategory = (dimension: Dimension) => {
    const before = state;
    onChange((s) => choose(s, dimension, { mode: 'in', values: [] }));
    toast(`Removed filter: ${DIMENSION_LABELS[dimension]}`, { label: 'Undo', run: () => onChange(() => before) }, 'info');
  };
  const clear = (announce: boolean) => {
    const before = state;
    onChange((s) => ({ ...s, environment: [], app_version: [], build: [], country: [], platform: [], exclude: {}, versionMode: 'all' }));
    if (announce) toast('Cleared all filters', { label: 'Undo', run: () => onChange(() => before) }, 'info');
  };
  const [category, setCategory] = useState<Dimension>('country');
  const openOn = (dimension: Dimension) => { setCategory(dimension); setOpen(true); };
  const chips = MENU_DIMENSIONS.map((dimension) => ({ dimension, ...choiceOf(state, dimension) })).filter((chip) => chip.values.length);
  const active = activeFilters(state);
  const hidden = state.hideTest && !state.environment.length;
  const parts = [`${prettyDay(state.range.from)}${state.range.from === state.range.to ? '' : ` → ${prettyDay(state.range.to)}`}`, state.timezone === 'utc' ? 'UTC' : 'Local time', 'player ID = user_id, otherwise device_id'];
  if (context?.anonymous_events) parts.push(`${number(context.anonymous_events)} event${context.anonymous_events === 1 ? '' : 's'} without a player ID`);
  if (context?.excluded_events) parts.push(`${number(context.excluded_events)} event${context.excluded_events === 1 ? '' : 's'} outside active filters`);
  return (
    <>
      <div className="filter-bar">
        <DateRange compact value={state.range} onChange={(range) => set({ range })} />
        <div className="build-switch">
        <Segmented label="Build" value={state.versionMode} onChange={(mode) => { if (mode === 'latest' || mode === 'previous' || mode === 'all') onChange((s) => chooseBuild(s, mode, facets)); }}
          options={[
            { value: 'latest', label: facets.latest_app_version ? `Latest ${facets.latest_app_version}` : 'Latest' },
            ...(facets.previous_app_version || state.versionMode === 'previous' ? [{ value: 'previous' as const, label: facets.previous_app_version ? `Previous ${facets.previous_app_version}` : 'Previous' }] : []),
            { value: 'all', label: 'All builds' },
          ]} />
        </div>
        {children}
        <button ref={button} type="button" className="btn filters-open" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Ico name="funnel" size={14} /> Filters {active ? <span className="count">{active}</span> : null}</button>
      </div>
      <div className="filter-chips">
        <AnimatePresence initial={false} mode="popLayout">
          {chips.map((chip) => (
            <motion.span key={chip.dimension} layout className={`filter-chip${chip.mode === 'not' ? ' out' : ''}`} {...POP}>
              <button type="button" className="filter-chip-open" title={`Change ${DIMENSION_LABELS[chip.dimension].toLowerCase()} filter`} onClick={() => openOn(chip.dimension)}>
                <Ico name={chip.mode === 'not' ? 'ban' : DIMENSION_ICONS[chip.dimension]} size={13} />
                <span className="filter-chip-label">{DIMENSION_LABELS[chip.dimension]}</span>
                <em>{chip.mode === 'not' ? 'is not' : 'is'}</em>
                <span>{choiceText(chip.dimension, chip)}{chip.dimension === 'app_version' && chip.mode === 'in' && state.versionMode === 'latest' ? ' (latest)' : chip.dimension === 'app_version' && chip.mode === 'in' && state.versionMode === 'previous' ? ' (previous)' : ''}</span>
              </button>
              <button type="button" className="filter-chip-x" aria-label={`Remove ${DIMENSION_LABELS[chip.dimension]} filter`} title="Remove this filter" onClick={() => removeCategory(chip.dimension)}><Ico name="close" size={11} /></button>
            </motion.span>
          ))}
        </AnimatePresence>
        {hidden ? <span className="filter-note"><Ico name="shield" size={12} /> Editor & development data hidden</span> : null}
        {chips.length > 1 ? <button type="button" className="filter-clear" onClick={() => clear(true)}>Clear all</button> : null}
      </div>
      <div className="analysis-context" aria-live="polite">
        <span>{parts.join(' · ')}</span>
        <span>
          {context?.low_sample ? <span className="sample-warning">Small sample: {number(context.players || 0)} of {number(context.minimum_players)} players</span> : null}
          {context?.excluded_events && hidden ? <button type="button" className="filter-clear" onClick={() => set({ hideTest: false })}>Include editor & development data</button> : null}
        </span>
      </div>
      <Popover position="fixed" open={open} onClose={() => setOpen(false)} anchor={button} width={340} className="filter-pop">
        <FilterMenu state={state} facets={facets} initial={category} onDone={(draft) => { onChange((s) => ({ ...s, ...draft })); setOpen(false); }} />
      </Popover>
    </>
  );
}

/** The Filters menu. It edits a copy and applies it on Done; closing any other way leaves the filters as they were. */
function FilterMenu({ state, facets, initial, onDone }: { state: ActiveFilters; facets: Facets; initial: Dimension; onDone: (draft: Draft) => void }): ReactElement {
  const [draft, setDraft] = useState<Draft>(() => draftOf(state));
  const [category, setCategory] = useState<Dimension>(initial);
  // The mode shown for a category: what is ticked, or what was just picked while nothing is ticked yet.
  const [modes, setModes] = useState<Partial<Record<Dimension, 'in' | 'not'>>>({});
  const choice = (dimension: Dimension): DimensionChoice => { const picked = choiceOf(draft, dimension); return picked.values.length ? picked : { mode: modes[dimension] ?? 'in', values: [] }; };
  const options = useMemo(() => Object.fromEntries(MENU_DIMENSIONS.map((dimension) => {
    const values = [...new Set([...(facets[dimension] || []).map((item) => item.value), ...choiceOf(draft, dimension).values])];
    const counts = Object.fromEntries((facets[dimension] || []).map((item) => [item.value, item.players]));
    const ordered = dimension === 'app_version' ? sortVersions(values) : values;
    return [dimension, ordered.map((item) => ({ value: item, label: dimensionText(dimension, item), count: number(counts[item] || 0), ...(dimension === 'app_version' && !isReleaseVersion(item) ? { flag: 'not x.y.z', hint: 'Not written x.y.z, so it is never picked as the latest build' } : {}) }))];
  })), [facets, draft]);
  const current = choice(category);
  return (
    <>
      <div className="pop-scroll filter-sheet">
        <label className="opt"><input type="checkbox" className="cb-in" checked={draft.hideTest} disabled={!!draft.environment.length} onChange={(e) => setDraft((d) => ({ ...d, hideTest: e.target.checked }))} /><span className="ot">Hide editor &amp; development data</span></label>
        <div className="filter-tabs" role="tablist" aria-label="Filter by">
          {MENU_DIMENSIONS.map((dimension) => { const picked = choiceOf(draft, dimension); return (
            <button key={dimension} type="button" role="tab" aria-selected={category === dimension} className="filter-tab" onClick={() => setCategory(dimension)}>
              <Ico name={DIMENSION_ICONS[dimension]} size={13} /><span>{DIMENSION_LABELS[dimension].replace('Device platform', 'Platform').replace('App version', 'Version')}</span>
              {picked.values.length ? <i className={picked.mode === 'not' ? 'out' : ''}>{picked.mode === 'not' ? '≠' : ''}{picked.values.length}</i> : null}
            </button>
          ); })}
        </div>
        <motion.div key={category} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }}>
          <Segmented label={`${DIMENSION_LABELS[category]}: include or leave out`} value={current.mode}
            onChange={(mode) => { setModes((m) => ({ ...m, [category]: mode })); if (current.values.length) setDraft((d) => choose(d, category, { mode, values: current.values })); }}
            options={[{ value: 'in', label: 'Only these' }, { value: 'not', label: 'Everything except' }]} />
          {category === 'app_version' && current.mode === 'in' ? (
            <label className="opt"><input type="checkbox" className="cb-in" checked={draft.versionMode === 'latest'} disabled={!facets.latest_app_version} onChange={(e) => setDraft((d) => chooseBuild(d, e.target.checked ? 'latest' : 'all', facets))} /><span className="ot">Latest published build</span><span className="oc">{facets.latest_app_version || '—'}</span></label>
          ) : null}
          <OptionList key={`${category}-${current.mode}`} options={options[category] ?? []} selected={current.values} out={current.mode === 'not'} searchLabel={`Search ${DIMENSION_LABELS[category].toLowerCase()}`}
            onChange={(values) => setDraft((d) => choose(d, category, { mode: current.mode, values }))} />
        </motion.div>
      </div>
      <div className="pop-foot">
        <button type="button" className="filter-clear" disabled={!current.values.length} onClick={() => { setDraft((d) => choose(d, category, { mode: 'in', values: [] })); setModes((m) => ({ ...m, [category]: 'in' })); }}>Clear {DIMENSION_LABELS[category].toLowerCase()}</button>
        <button type="button" className="btn primary" onClick={() => onDone(draft)}>Done</button>
      </div>
    </>
  );
}
