// The filter bar at the top of every game dashboard: days, time zone, density, one "Filters" menu and
// chips for what is active. Remembered per game. `onChange(state)` runs on mount and after each change.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { MultiSelect, Popover, Segmented } from '@avn/ui';
import { useRead } from '@/api';
import { useTheme } from '@/app/theme';
import { dimensionText, number, prettyDay } from '@/lib/format';
import { gameURL } from '@/lib/games';
import { DIMENSIONS, DIMENSION_LABELS, activeFilters, filterState, saveFilters, timezoneOffset, type ActiveFilters, type Dimension, type Facets, type FilterState } from '@/lib/filters';
import type { Game } from '@/lib/types';
import { DateRange, resolveRange } from './DateRange';
import { useNotify } from './feedback';
import { Ico } from './icons';

/** The filter choices (and the latest and previous published builds) for a game and range. */
export const facetsPath = (game: Pick<Game, 'id'>, state: Pick<ActiveFilters, 'range' | 'timezone'>): string => `${gameURL(game)}/insights/facets?${new URLSearchParams({ start: state.range.from, end: state.range.to, tz_offset: String(timezoneOffset(state)) })}`;

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
  const chooseBuild = (mode: 'latest' | 'previous' | 'all') => onChange((s) => ({ ...s, versionMode: mode, app_version: mode === 'latest' ? [facets.latest_app_version].filter((v): v is string => !!v) : mode === 'previous' ? [facets.previous_app_version].filter((v): v is string => !!v) : [] }));

  const set = (patch: Partial<Omit<FilterState, 'range'>> & { range?: ActiveFilters['range'] }) => onChange((s) => ({ ...s, ...patch }));
  const setDimension = (dimension: Dimension, values: string[]) => onChange((s) => ({ ...s, [dimension]: values, ...(dimension === 'app_version' ? { versionMode: values.length ? 'custom' : 'all' } : {}) }));
  const remove = (dimension: Dimension, value: string) => {
    const before = state;
    setDimension(dimension, state[dimension].filter((item) => item !== value));
    toast(`Removed filter: ${DIMENSION_LABELS[dimension]} ${dimensionText(dimension, value)}`, { label: 'Undo', run: () => onChange(() => before) }, 'info');
  };
  const clear = (announce: boolean) => {
    const before = state;
    onChange((s) => ({ ...s, environment: [], app_version: [], build: [], country: [], platform: [], versionMode: 'all' }));
    if (announce) toast('Cleared all filters', { label: 'Undo', run: () => onChange(() => before) }, 'info');
  };
  const groups = useMemo(() => DIMENSIONS.map((dimension) => {
    const values = [...new Set([...(facets[dimension] || []).map((item) => item.value), ...state[dimension]])];
    const counts = Object.fromEntries((facets[dimension] || []).map((item) => [item.value, item.players]));
    return { label: DIMENSION_LABELS[dimension], dimension, options: values.map((value) => ({ value, label: dimensionText(dimension, value), count: counts[value] || 0 })) };
  }), [facets, state]);
  const value = Object.fromEntries(groups.map((group) => [group.label, state[group.dimension]]));
  const chips = DIMENSIONS.flatMap((dimension) => state[dimension].map((item) => ({ dimension, value: item })));
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
        {chips.map(({ dimension, value: item }) => (
          <button key={`${dimension}:${item}`} type="button" className="filter-chip" title="Remove this filter" onClick={() => remove(dimension, item)}>
            {DIMENSION_LABELS[dimension]}: {dimensionText(dimension, item)}{dimension === 'app_version' && state.versionMode === 'latest' ? ' (latest)' : dimension === 'app_version' && state.versionMode === 'previous' ? ' (previous)' : ''} <Ico name="close" size={11} />
          </button>
        ))}
        {hidden ? <span className="filter-note">Editor & development data hidden</span> : null}
        {chips.length > 1 ? <button type="button" className="filter-clear" onClick={() => clear(true)}>Clear all</button> : null}
      </div>
      <div className="analysis-context" aria-live="polite">
        <span>{parts.join(' · ')}</span>
        <span>
          {context?.low_sample ? <span className="sample-warning">Small sample: {number(context.players || 0)} of {number(context.minimum_players)} players</span> : null}
          {context?.excluded_events && hidden ? <button type="button" className="filter-clear" onClick={() => set({ hideTest: false })}>Include editor & development data</button> : null}
        </span>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchor={button} width={320} className="filter-pop">
        <div className="pop-scroll">
          <label className="opt"><input type="checkbox" className="cb-in" checked={state.hideTest} disabled={!!state.environment.length} onChange={(e) => set({ hideTest: e.target.checked })} /><span className="ot">Hide editor &amp; development data</span></label>
          <div className="pop-grp"><span className="eyebrow">App version</span></div>
          <label className="opt"><input type="checkbox" className="cb-in" checked={state.versionMode === 'latest'} disabled={!facets.latest_app_version} onChange={(e) => (e.target.checked ? set({ versionMode: 'latest', app_version: facets.latest_app_version ? [facets.latest_app_version] : [] }) : set({ versionMode: 'all', app_version: [] }))} /><span className="ot">Latest published build</span><span className="oc">{facets.latest_app_version || '—'}</span></label>
        </div>
        <MultiSelect groups={groups.map((group) => ({ label: group.label, options: group.options }))} value={value} onChange={(label, values) => { const group = groups.find((item) => item.label === label); if (group) setDimension(group.dimension, values); }} onClear={() => clear(false)} onDone={() => setOpen(false)} />
      </Popover>
    </>
  );
}
