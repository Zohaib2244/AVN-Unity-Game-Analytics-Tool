// The filter bar at the top of every game dashboard: days, time zone, density, one "Filters" menu and
// chips for what is active. Remembered per game. `onChange(state)` runs on mount and after each change.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Popover, Segmented } from '@avn/ui';
import { useRead } from '@/api';
import { useTheme } from '@/app/theme';
import { dimensionText, number, prettyDay } from '@/lib/format';
import { gameURL } from '@/lib/games';
import { DIMENSION_LABELS, MENU_DIMENSIONS, activeFilters, choiceOf, filterState, saveFilters, timezoneOffset, withChoice, type ActiveFilters, type Dimension, type DimensionChoice, type Facets, type FilterState } from '@/lib/filters';
import type { Game } from '@/lib/types';
import { DateRange, resolveRange } from './DateRange';
import { useNotify } from './feedback';
import { Ico, type IcoName } from './icons';
import { OptionList } from './OptionList';
import { POP, SPRING, SWAP } from '@/lib/motion';

/** The filter choices (and the latest and previous published builds) for a game and range. */
export const facetsPath = (game: Pick<Game, 'id'>, state: Pick<ActiveFilters, 'range' | 'timezone'>): string => `${gameURL(game)}/insights/facets?${new URLSearchParams({ start: state.range.from, end: state.range.to, tz_offset: String(timezoneOffset(state)) })}`;

const DIMENSION_ICONS: Record<Dimension, IcoName> = { environment: 'flask', app_version: 'tag', build: 'tag', country: 'globe', platform: 'phone' };

/** What one category says on the bar: "Country is not Pakistan", "Platform is Android, iOS +1". */
export function choiceText(dimension: Dimension, choice: DimensionChoice): string {
  const names = choice.values.map((value) => dimensionText(dimension, value));
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
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
  const { density, setDensity } = useTheme();
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
  const chooseBuild = (mode: 'latest' | 'previous' | 'all') => onChange((s) => withChoice({ ...s, versionMode: mode }, 'app_version', { mode: 'in', values: mode === 'latest' ? [facets.latest_app_version].filter((v): v is string => !!v) : mode === 'previous' ? [facets.previous_app_version].filter((v): v is string => !!v) : [] }));

  const set = (patch: Partial<Omit<FilterState, 'range'>> & { range?: ActiveFilters['range'] }) => onChange((s) => ({ ...s, ...patch }));
  // One category, "only these" or "everything except"; a hand-picked version list is the 'custom' build mode.
  const setChoice = (dimension: Dimension, choice: DimensionChoice) => onChange((s) => ({ ...withChoice(s, dimension, choice), ...(dimension === 'app_version' ? { versionMode: choice.mode === 'in' && choice.values.length ? 'custom' : choice.mode === 'not' && choice.values.length ? 'custom' : 'all' } : {}) }));
  const removeCategory = (dimension: Dimension) => {
    const before = state;
    setChoice(dimension, { mode: 'in', values: [] });
    setModes((m) => ({ ...m, [dimension]: 'in' }));
    toast(`Removed filter: ${DIMENSION_LABELS[dimension]}`, { label: 'Undo', run: () => onChange(() => before) }, 'info');
  };
  const clear = (announce: boolean) => {
    const before = state;
    onChange((s) => ({ ...s, environment: [], app_version: [], build: [], country: [], platform: [], exclude: {}, versionMode: 'all' }));
    setModes({});
    if (announce) toast('Cleared all filters', { label: 'Undo', run: () => onChange(() => before) }, 'info');
  };
  // The mode shown for a category: what is applied, or what was just picked while nothing is ticked yet.
  const [modes, setModes] = useState<Partial<Record<Dimension, 'in' | 'not'>>>({});
  const [category, setCategory] = useState<Dimension>('country');
  const choice = (dimension: Dimension): DimensionChoice => { const applied = choiceOf(state, dimension); return applied.values.length ? applied : { mode: modes[dimension] ?? 'in', values: [] }; };
  const openOn = (dimension: Dimension) => { setCategory(dimension); setOpen(true); };
  const options = useMemo(() => Object.fromEntries(MENU_DIMENSIONS.map((dimension) => {
    const values = [...new Set([...(facets[dimension] || []).map((item) => item.value), ...choiceOf(state, dimension).values])];
    const counts = Object.fromEntries((facets[dimension] || []).map((item) => [item.value, item.players]));
    return [dimension, values.map((item) => ({ value: item, label: dimensionText(dimension, item), count: number(counts[item] || 0) }))];
  })), [facets, state]);
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
        <Segmented label="Build" value={state.versionMode} onChange={(mode) => { if (mode === 'latest' || mode === 'previous' || mode === 'all') chooseBuild(mode); }}
          options={[
            { value: 'latest', label: facets.latest_app_version ? `Latest ${facets.latest_app_version}` : 'Latest' },
            ...(facets.previous_app_version || state.versionMode === 'previous' ? [{ value: 'previous' as const, label: facets.previous_app_version ? `Previous ${facets.previous_app_version}` : 'Previous' }] : []),
            { value: 'all', label: 'All builds' },
          ]} />
        </div>
        <Segmented label="Time zone" value={state.timezone} onChange={(timezone) => set({ timezone })} options={[{ value: 'local', label: 'Local' }, { value: 'utc', label: 'UTC' }]} />
        <div className="density-switch"><Segmented label="Row density" value={density} onChange={setDensity} options={[{ value: 'roomy', label: 'Roomy' }, { value: 'compact', label: 'Compact' }]} /></div>
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
        <div className="pop-scroll filter-sheet">
          <label className="opt"><input type="checkbox" className="cb-in" checked={state.hideTest} disabled={!!state.environment.length} onChange={(e) => set({ hideTest: e.target.checked })} /><span className="ot">Hide editor &amp; development data</span></label>
          <div className="filter-tabs" role="tablist" aria-label="Filter by">
            {MENU_DIMENSIONS.map((dimension) => { const applied = choiceOf(state, dimension); return (
              <button key={dimension} type="button" role="tab" aria-selected={category === dimension} className="filter-tab" onClick={() => setCategory(dimension)}>
                {category === dimension ? <motion.span layoutId="filter-tab-pill" className="filter-tab-pill" transition={SPRING} /> : null}
                <Ico name={DIMENSION_ICONS[dimension]} size={13} /><span>{DIMENSION_LABELS[dimension].replace('Device platform', 'Platform').replace('App version', 'Version')}</span>
                {applied.values.length ? <i className={applied.mode === 'not' ? 'out' : ''}>{applied.mode === 'not' ? '≠' : ''}{applied.values.length}</i> : null}
              </button>
            ); })}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={category} {...SWAP}>
              <Segmented label={`${DIMENSION_LABELS[category]}: include or leave out`} value={choice(category).mode}
                onChange={(mode) => { const now = choice(category); setModes((m) => ({ ...m, [category]: mode })); if (now.values.length) setChoice(category, { mode, values: now.values }); }}
                options={[{ value: 'in', label: 'Only these' }, { value: 'not', label: 'Everything except' }]} />
              {category === 'app_version' && choice(category).mode === 'in' ? (
                <label className="opt"><input type="checkbox" className="cb-in" checked={state.versionMode === 'latest'} disabled={!facets.latest_app_version} onChange={(e) => (e.target.checked ? chooseBuild('latest') : chooseBuild('all'))} /><span className="ot">Latest published build</span><span className="oc">{facets.latest_app_version || '—'}</span></label>
              ) : null}
              <OptionList key={`${category}-${choice(category).mode}`} options={options[category] ?? []} selected={choice(category).values} out={choice(category).mode === 'not'} searchLabel={`Search ${DIMENSION_LABELS[category].toLowerCase()}`}
                onChange={(values) => setChoice(category, { mode: choice(category).mode, values })} />
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="pop-foot">
          <button type="button" className="filter-clear" disabled={!choice(category).values.length} onClick={() => { setChoice(category, { mode: 'in', values: [] }); setModes((m) => ({ ...m, [category]: 'in' })); }}>Clear {DIMENSION_LABELS[category].toLowerCase()}</button>
          <button type="button" className="btn primary" onClick={() => setOpen(false)}>Done</button>
        </div>
      </Popover>
    </>
  );
}
