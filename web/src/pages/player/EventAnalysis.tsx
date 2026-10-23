// Event Analysis: what this player called and how often, over the exact snapshot the raw timeline shows.
// Expand an event for parameter counts and the individual calls; narrow by parameter values; jump to the
// raw timeline or turn the selection into a highlight.
import { useMemo, useState, type ReactElement } from 'react';
import { analysisDate, number, type Timezone } from '@/lib/format';
import { analysisHighlightRule, analysisMatchesFilters, analysisParameterValues, playerEventAnalysis, type AnalysisFilters, type TimelineHighlight } from '@/lib/player-events';
import type { TimelineItem } from './timeline';

const PAGE = 50;
const VALUE_PAGE = 20;
const leading = (key: string) => Number(!/type|stage|state|action/i.test(key));

export function EventAnalysis({ events, session, complete, failure, timezone, onJump, onHighlight, onRetry }: { events: TimelineItem[]; session: string; complete: boolean; failure: string; timezone: Timezone; onJump: (index: number) => void; onHighlight: (rule: TimelineHighlight) => void; onRetry: () => void }): ReactElement {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [parameter, setParameter] = useState('');
  const [filters, setFilters] = useState<AnalysisFilters>(() => new Map());
  const [limit, setLimit] = useState(PAGE);
  const [valueLimit, setValueLimit] = useState(VALUE_PAGE);
  const data = useMemo(() => playerEventAnalysis(events, session), [events, session]);
  const suffix = failure ? ' · incomplete: timeline loading failed' : complete ? '' : ' · loading remaining events; counts are partial';
  const groups = data.groups.filter((group) => group.name.toLowerCase().includes(search.trim().toLowerCase()));
  const group = data.groups.find((item) => item.name === selected);
  const pick = (name: string) => { setSelected(selected === name ? null : name); setParameter(''); setFilters(new Map()); setLimit(PAGE); setValueLimit(VALUE_PAGE); };
  const changeFilters = (next: AnalysisFilters) => { setFilters(next); setLimit(PAGE); };

  let detail: ReactElement | null = null;
  if (group) {
    const keys = [...group.params.keys()].sort((a, b) => leading(a) - leading(b) || a.localeCompare(b));
    const chosenKey = keys.includes(parameter) ? parameter : keys[0] || '';
    const values = analysisParameterValues(group.items, filters, chosenKey);
    const occurrences = group.items.filter((event) => analysisMatchesFilters(event, filters));
    detail = (
      <section className="analysis-event-detail">
        <div className="panel-header"><div><h3>{group.name}</h3><p>{number(group.items.length)} calls · {number(group.sessions.size)} session{group.sessions.size === 1 ? '' : 's'}{complete ? '' : ' · partial counts'}</p></div><button type="button" className="button small-button" onClick={() => setSelected(null)}>Close event</button></div>
        {keys.length ? (
          <>
            <label className="analysis-parameter">Break down by parameter<select value={chosenKey} onChange={(e) => { setParameter(e.target.value); setLimit(PAGE); setValueLimit(VALUE_PAGE); }}>{keys.map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
            <p className="help">Select a value, then choose another parameter to narrow it further. Counts include the other selected details.</p>
            <div className="analysis-values">
              {values.slice(0, valueLimit).map((value) => (
                <button type="button" className="analysis-value" key={value.token} aria-pressed={value.token === filters.get(chosenKey)?.token} onClick={() => {
                  const next = new Map(filters);
                  if (next.get(chosenKey)?.token === value.token) next.delete(chosenKey); else next.set(chosenKey, value);
                  changeFilters(next);
                }}><code>{JSON.stringify(value.value)}</code><strong>{number(value.count)}</strong></button>
              ))}
            </div>
            {values.length > valueLimit ? <button type="button" className="button small-button" onClick={() => setValueLimit(valueLimit + VALUE_PAGE)}>Show more values</button> : null}
          </>
        ) : <p className="help">This event has no parameters.</p>}
        <div className="analysis-filter-chips">{[...filters].map(([key, value]) => <button type="button" className="button small-button" key={key} onClick={() => { const next = new Map(filters); next.delete(key); changeFilters(next); }}>{key} = {JSON.stringify(value.value)} ×</button>)}</div>
        <div className="analysis-occurrence-head"><h3>{number(occurrences.length)} matching occurrences{complete ? '' : ' so far'}</h3>{filters.size ? <button type="button" className="button small-button" onClick={() => changeFilters(new Map())}>Clear details</button> : null}<button type="button" className="button small-button" onClick={() => onHighlight(analysisHighlightRule(group.name, filters))}>Highlight these events</button></div>
        <div className="analysis-occurrences">
          {occurrences.slice(0, limit).map((event) => (
            <div className="analysis-occurrence" key={event.index}>
              <div><strong>{analysisDate(event.client_ts, timezone)}</strong><span className="small muted">Session {number((event.session ?? 0) + 1)} · {Object.entries(event.params || {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(' · ') || 'No parameters'}</span></div>
              <button type="button" className="button small-button" onClick={() => onJump(event.index)}>Show in raw events</button>
            </div>
          ))}
        </div>
        {occurrences.length > limit ? <button type="button" className="button small-button" onClick={() => setLimit(limit + PAGE)}>Show more occurrences ({number(occurrences.length - limit)} left)</button> : null}
      </section>
    );
  }

  return (
    <div className="panel-body" id="event-analysis">
      <p className="help">Expand an event for parameter counts and individual calls. Use type and action together to distinguish ad shows from requests or rewards.</p>
      <div className="analysis-toolbar">
        <div className="analysis-totals" role="status" aria-live="polite">{number(data.total)} calls · {number(data.groups.length)} unique events · {number(data.levels)} unique mapped levels{suffix}</div>
        <label className="analysis-search">Find an event<input type="search" value={search} placeholder="Event name…" onChange={(e) => setSearch(e.target.value)} /></label>
      </div>
      {failure ? <div><p className="error" role="alert">{failure}</p><button type="button" className="button small-button" onClick={onRetry}>Retry loading events</button></div> : null}
      {groups.length ? (
        <div className="table-wrap"><table className="event-analysis-table"><thead><tr><th>Event</th><th className="num">Calls</th><th className="num">Sessions</th><th>First / last call</th></tr></thead><tbody>
          {groups.map((item) => <tr key={item.name}><td><button type="button" className="event-analysis-name" aria-expanded={selected === item.name} onClick={() => pick(item.name)}>{item.name}</button></td><td className="num">{number(item.items.length)}</td><td className="num">{number(item.sessions.size)}</td><td className="small muted">{analysisDate(item.items[0]!.client_ts, timezone)}<br />{analysisDate(item.items[item.items.length - 1]!.client_ts, timezone)}</td></tr>)}
        </tbody></table></div>
      ) : <p className="help">{search ? 'No event names match your search.' : complete ? 'No events in this session and date range.' : 'Loading events…'}</p>}
      {detail}
    </div>
  );
}
