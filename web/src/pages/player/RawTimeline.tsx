// One player's raw timeline (the old renderRawEvents): every event of the range, grouped by session, with
// highlights and their rules, parameter folds, the filter, and the Event Analysis tab over the same events.
// Events arrive page by page (insights/journey, one snapshot) until the whole range is in.
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { errorMessage, isAbort, read } from '@/api';
import { Ico } from '@/components/icons';
import { useNotify } from '@/components/feedback';
import type { DayRange } from '@/lib/filters';
import { timezoneOffset } from '@/lib/filters';
import { analysisDate, clock, duration, number, percent, type Timezone } from '@/lib/format';
import { conditionError, eventMatchesCondition, highlightMatchIndices, highlightMatches, highlightNavigationIndex, matchingConditionParams } from '@/lib/conditions';
import { gameURL } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';
import type { TimelineHighlight } from '@/lib/player-events';
import type { Game, JourneyEvent, JourneyPage } from '@/lib/types';
import { Disclosure, useDisclosures } from './Disclosure';
import { EventAnalysis } from './EventAnalysis';
import { HighlightSetup } from './HighlightSetup';
import {
  buildCatalog, chipTitle, chipValue, DEFAULT_HIDDEN_PARAMS, defaultParamState, foldRuns, highlightName, highlightSummary, matchesFilter, MAX_HIGHLIGHTS,
  type ParamState, parameterChooser, repeatKey, sessionHasEvent, sessionLevels, sessionSeconds, sessionStartSummary, type TimelineItem, timelineSessions,
} from './timeline';

type Mode = 'highlight' | 'filter';
type Focus = { event: string; label: string };
const joinClass = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ');

/** The events of the range for one player, page by page; the same snapshot throughout, so counts stay steady. */
function useJourney(base: string, player: string, range: DayRange, tzOffset: number, attempt: number): { events: JourneyEvent[]; complete: boolean; failure: string } {
  const [state, setState] = useState<{ events: JourneyEvent[]; complete: boolean; failure: string }>({ events: [], complete: false, failure: '' });
  useEffect(() => {
    let cancelled = false;
    let events: JourneyEvent[] = [];
    let snapshot: number | string | null = null;
    let more = true;
    setState({ events: [], complete: false, failure: '' });
    void (async () => {
      try {
        while (more && !cancelled) {
          const params = new URLSearchParams({ start: range.from, end: range.to, player, offset: String(events.length), tz_offset: String(tzOffset) });
          if (snapshot != null) params.set('snapshot', String(snapshot));
          const page = await read<JourneyPage>(`${base}/insights/journey?${params}`);
          if (cancelled) return;
          snapshot = page.snapshot;
          events = [...events, ...page.events];
          more = page.truncated && page.events.length > 0;
          setState({ events, complete: !more, failure: '' });
        }
      } catch (error) {
        if (!cancelled && !isAbort(error)) setState((previous) => ({ ...previous, failure: `${errorMessage(error, 'The timeline could not load.')} · ${number(events.length)} events loaded; counts are incomplete. Reopen Raw events to retry.` }));
      }
    })();
    return () => { cancelled = true; };
  }, [base, player, range.from, range.to, tzOffset, attempt]);
  return state;
}

export type RawTimelineProps = { game: Game; player: string; range: DayRange; timezone: Timezone; view: 'raw' | 'analysis'; onView: (view: 'raw' | 'analysis') => void };

export function RawTimeline({ game, player, range, timezone, view, onView }: RawTimelineProps): ReactElement {
  const { toast } = useNotify();
  const base = gameURL(game);
  const [attempt, setAttempt] = useState(0);
  const journey = useJourney(base, player, range, timezoneOffset({ timezone }), attempt);
  const { events, complete, failure } = journey;
  const sessions = useMemo(() => timelineSessions(events), [events]);
  const items = useMemo(() => sessions.flatMap((session) => session.items), [sessions]);
  const catalog = useMemo(() => buildCatalog(events), [events]);
  const analysis = view === 'analysis';
  const disclosures = useDisclosures(`avn-raw-disclosures-${game.id}-${player}`);
  const searchId = useId();
  const groupId = useId();
  const navId = useId();
  const pickerLabel = useId();

  // Highlights and parameter choices are remembered per game, in this browser.
  const highlightKey = `avn-highlights-${game.id}`;
  const paramKey = `avn-timeline-params-${game.id}`;
  const [store, setStore] = useState<{ rules: TimelineHighlight[]; mode: Mode }>(() => {
    const saved = storeGet<{ rules?: TimelineHighlight[]; mode?: Mode }>(highlightKey) || {};
    return { rules: saved.rules || [], mode: saved.mode || 'highlight' };
  });
  const { rules, mode } = store;
  const writeStore = (next: { rules: TimelineHighlight[]; mode: Mode }) => { storeSet(highlightKey, next); setStore(next); };
  const [paramState, setParamState] = useState<ParamState>(() => ({ ...defaultParamState(), ...(storeGet<Partial<ParamState>>(paramKey) || {}) }));
  const updateParams = (change: (state: ParamState) => ParamState) => setParamState((previous) => { const next = change(previous); storeSet(paramKey, next); return next; });
  const hidden = new Set(paramState.hidden);

  const [shownSession, setShownSession] = useState('all');
  const [current, setCurrent] = useState(-1);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [freshRule, setFreshRule] = useState(-1);
  const [filterText, setFilterText] = useState('');
  const [navSelection, setNavSelection] = useState('all');
  const [pulse, setPulse] = useState<{ index: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const jumpedFor = useRef<string | null>(null);

  const inSession = (session: string, index: number): boolean => session === 'all' || items[index]?.session === Number(session);
  const visible = (index: number): boolean => inSession(shownSession, index);
  const scoped = items.filter((_, index) => visible(index));
  const focusIndex = focus ? items.findIndex((item) => item.event_id === focus.event) : -1;
  const selection = navSelection === 'all' || Number(navSelection) < rules.length ? navSelection : 'all';
  const validRules = rules.filter((rule) => rule.enabled !== false && !conditionError(rule.conditions));
  const matchIndices = highlightMatchIndices(items, rules, selection).filter(visible);
  const counts = rules.map((rule) => (conditionError(rule.conditions) ? 0 : items.filter((item, index) => visible(index) && eventMatchesCondition(item, rule.conditions)).length));

  const commit = (next: TimelineHighlight[], fresh?: number) => {
    writeStore({ rules: next, mode });
    setCurrent(-1);
    if (fresh !== undefined) setFreshRule(fresh);
  };
  const setMode = (next: Mode) => writeStore({ rules, mode: next });

  const jumpTo = (index: number) => {
    const item = items[index];
    if (!item) return;
    if (!visible(index)) setShownSession(String(item.session));
    setCurrent(index);
    disclosures.set(`session-${sessions[item.session]!.id}-${item.session}`, true);
    setPulse({ index });
  };

  // After a jump lands in the DOM: focus it, centre it and pulse it once.
  useEffect(() => {
    if (!pulse) return;
    const target = listRef.current?.querySelector<HTMLElement>(`[data-timeline-index="${pulse.index}"]`);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center' });
    target.classList.add('jump-pulse');
    const timer = window.setTimeout(() => target.classList.remove('jump-pulse'), 800);
    return () => window.clearTimeout(timer);
  }, [pulse]);

  // An event picked from Event Analysis (or a level) waits for the whole timeline, then is brought into view.
  useEffect(() => {
    if (complete && focus && focusIndex >= 0 && !analysis && jumpedFor.current !== focus.event) {
      jumpedFor.current = focus.event;
      jumpTo(focusIndex);
    }
  });

  // J / K step through highlights and / jumps to the filter. Ignored while typing or inside a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || analysis || document.querySelector('dialog[open]:not(.player-dialog)')) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;
      if (event.key === '/' && mode === 'filter') { event.preventDefault(); searchRef.current?.focus(); return; }
      if (mode !== 'highlight' || (event.key !== 'j' && event.key !== 'k') || !matchIndices.length) return;
      event.preventDefault();
      jumpTo(highlightNavigationIndex(matchIndices, current, event.key === 'j'));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const jumpFromAnalysis = (index: number) => {
    const item = items[index];
    if (!item) return;
    setFocus({ event: item.event_id, label: 'Selected from Event Analysis' });
    jumpedFor.current = item.event_id;
    onView('raw');
    writeStore({ rules, mode: 'highlight' });
    jumpTo(index);
  };
  const highlightFromAnalysis = (rule: TimelineHighlight) => {
    if (rules.length >= MAX_HIGHLIGHTS) { toast('Use at most 20 highlights.'); return; }
    onView('raw');
    writeStore({ rules: [...rules, rule], mode: 'highlight' });
    setFreshRule(rules.length);
    setCurrent(-1);
    disclosures.set('highlight-setup', true);
  };

  const toggleHide = (key: string) => {
    const lower = key.toLowerCase();
    if (hidden.has(lower)) { updateParams((state) => ({ ...state, hidden: state.hidden.filter((name) => name !== lower) })); return; }
    updateParams((state) => ({ ...state, hidden: [...state.hidden.filter((name) => name !== lower), lower], showAll: false }));
    toast(`Hid ${key} in every event.`, { label: 'Undo', run: () => updateParams((state) => ({ ...state, hidden: state.hidden.filter((name) => name !== lower) })) });
  };
  const setShowAll = (showAll: boolean) => updateParams((state) => ({ ...state, showAll }));
  const toggleParam = (name: string, shown: boolean) => updateParams((state) => ({ ...state, hidden: shown ? state.hidden.filter((item) => item !== name) : [...state.hidden.filter((item) => item !== name), name] }));
  const resetParams = () => updateParams((state) => ({ ...state, hidden: [...DEFAULT_HIDDEN_PARAMS], showAll: false }));

  const renderRow = (item: TimelineItem, run: TimelineItem[] | null): ReactElement => {
    const hits = mode === 'highlight' ? rules.flatMap((rule, index) => (highlightMatches(item, rule) ? [{ rule, index }] : [])) : [];
    const lit = new Set(hits.flatMap(({ rule }) => matchingConditionParams(item, rule.conditions)));
    const quiet: string[] = [];
    const chips = Object.entries(item.params).map(([key, value]) => {
      const off = hidden.has(key.toLowerCase());
      if (!paramState.showAll && off && !lit.has(key)) { quiet.push(key); return null; }
      const hit = hits.find(({ rule }) => matchingConditionParams(item, rule.conditions).includes(key));
      return (
        <span key={key} className={joinClass('chip', hit && `highlight-ink highlight-${hit.rule.color}`, off && 'chip-off')}>
          <button type="button" className="chip-key" onClick={() => toggleHide(key)} title={off ? `Show ${key} again in clean view` : `Hide ${key} in every event`}>{key}</button>{' '}
          <span title={chipTitle(value)}>{chipValue(value)}</span>
        </span>
      );
    });
    const chipList = <>{chips}{quiet.length ? <button type="button" className="chip chip-more" onClick={() => setShowAll(true)} title={`Hidden: ${quiet.join(', ')}. Click to show all parameters.`}>+{quiet.length}</button> : null}</>;
    const params = item.name === 'session_start' && Object.keys(item.params).length ? (
      <details className="chip-collapse" open={lit.size > 0 ? true : undefined}><summary>{sessionStartSummary(item.params)}</summary>{chipList}</details>
    ) : chipList;
    const last = run?.[run.length - 1];
    const focused = item.index === focusIndex;
    return (
      <li key={item.index} data-timeline-index={item.index} tabIndex={-1} className={joinClass(run && 'timeline-run', hits.length > 0 && `timeline-match highlight-${hits[0]!.rule.color}`, focused && 'timeline-focus', current === item.index && mode === 'highlight' && 'timeline-current')}>
        <time dateTime={item.client_ts}>{clock(item.client_ts, timezone)}</time>
        <span className={joinClass('journey-gap', item.gap != null && item.gap > 60 && 'long')}>{item.gap == null ? '' : `+${duration(item.gap)}`}</span>
        <span className="journey-name">
          {item.name}
          {run ? <span className="chip chip-count" title={`${run.length} identical events in a row`}>×{run.length}</span> : null}
          {focused && focus ? <span className="highlight-tag focus-tag">{focus.label}</span> : null}
          {hits.map(({ rule, index }) => <span key={index} className={`highlight-tag highlight-${rule.color}`}>{highlightName(rule, index)}</span>)}
        </span>
        <span className="journey-params">
          {params}
          {last ? <span className="small muted">{clock(item.client_ts, timezone)}–{clock(last.client_ts, timezone)} · {duration((Date.parse(last.client_ts) - Date.parse(item.client_ts)) / 1000)}</span> : null}
        </span>
      </li>
    );
  };

  const renderSessions = (): ReactElement => {
    const query = mode === 'filter' ? filterText : '';
    const sections = sessions.flatMap((session, index) => {
      if (shownSession !== 'all' && index !== Number(shownSession)) return [];
      const shown = session.items.filter((item) => matchesFilter(item, query));
      return shown.length ? [{ session, index, shown }] : [];
    });
    if (!sections.length) return <p className="help">{events.length ? 'No events match the filter.' : complete ? 'No events from this player in these days.' : 'Loading events…'}</p>;
    return (
      <>
        {sections.map(({ session, index, shown }, position) => {
          const start = session.items[0]!.client_ts;
          const end = session.items[session.items.length - 1]!.client_ts;
          const gap = session.items[0]!.gap;
          const name = `session-${session.id}-${index}`;
          const rows = foldRuns(shown, (item) => (paramState.group && item.index !== focusIndex && !rules.some((rule) => highlightMatches(item, rule)) ? repeatKey(item, hidden, paramState.showAll) : null));
          return (
            <Fragment key={name}>
              {position > 0 ? <div className="session-break" role="separator" aria-label={`Session break before session ${index + 1}`}><span aria-hidden="true">Session break</span></div> : null}
              <Disclosure name={name} disclosures={disclosures} defaultOpen className="journey-session" summaryClassName="journey-session-head" summary={<><strong>Session {index + 1}</strong><span>{analysisDate(start, timezone)} · {duration((Date.parse(end) - Date.parse(start)) / 1000)} · {number(session.items.length)} events</span>{gap == null ? null : <span className="session-gap">{duration(gap)} after previous session</span>}</>}>
                <ol className="journey-events">{rows.map((row) => renderRow(row.items[0]!, row.run ? row.items : null))}</ol>
              </Disclosure>
            </Fragment>
          );
        })}
      </>
    );
  };

  const sessionPicker = (): ReactElement | null => {
    if (sessions.length < 2) return null;
    return (
      <>
        <label className="compact-session-picker">Session<select value={shownSession} onChange={(event) => { const next = event.target.value; setShownSession(next); if (current >= 0 && !inSession(next, current)) setCurrent(-1); }}><option value="all">All {number(sessions.length)} sessions</option>{sessions.map((session, index) => <option key={session.id + index} value={index}>Session {index + 1} · {analysisDate(session.items[0]!.client_ts, timezone)}</option>)}</select></label>
        <span className="session-picker-label" id={pickerLabel}>Sessions</span>
        <div className="session-chips" role="group" aria-labelledby={pickerLabel}>
          <button type="button" className="session-chip" aria-pressed={shownSession === 'all'} onClick={() => setShownSession('all')}><strong>All sessions</strong><span>{number(sessions.length)} sessions</span></button>
          {sessions.map((session, index) => {
            const first = session.items[0]!.client_ts;
            return (
              <button key={session.id + index} type="button" className="session-chip" aria-pressed={shownSession === String(index)} onClick={() => { setShownSession(String(index)); if (current >= 0 && !inSession(String(index), current)) setCurrent(-1); }}>
                <strong>Session {index + 1}{focus && sessionHasEvent(session, focus.event) ? <>{' '}<span className="pill">{focus.label}</span></> : null}</strong>
                <span>{analysisDate(first, timezone)} · {duration(sessionSeconds(session))} · {sessionLevels(session)}</span>
              </button>
            );
          })}
        </div>
      </>
    );
  };

  // How much of the timeline each highlight covers, and where along it the matches fall.
  const activeRules = rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.enabled !== false && !conditionError(rule.conditions));
  const summaryHidden = analysis || mode !== 'highlight' || !activeRules.length || !scoped.length;
  const sessionCount = new Set(scoped.map((item) => item.session_id)).size;
  const ticks = scoped.flatMap((item, position) => {
    const hit = activeRules.find(({ rule }) => highlightMatches(item, rule));
    return hit ? [{ item, position, rule: hit.rule }] : [];
  }).slice(0, 3000);
  const position = matchIndices.indexOf(current);
  const navHidden = analysis || mode !== 'highlight' || !validRules.length;

  return (
    <section className="panel raw-timeline">
      <div className="panel-header">
        <div>
          <h2>{analysis ? 'Event Analysis' : 'Timeline'}</h2>
          <p>{analysis ? 'What this player called, and how often · counts follow the session selected below' : `Every event, grouped by session · times in ${timezone === 'utc' ? 'UTC' : 'your local time'} · the gap is the time since the previous event`}</p>
        </div>
        <div className="segmented" role="group" aria-label="Timeline mode" hidden={analysis}>
          <button type="button" aria-pressed={mode === 'highlight'} onClick={() => setMode('highlight')}>Highlight timeline</button>
          <button type="button" aria-pressed={mode === 'filter'} onClick={() => setMode('filter')}>Filter timeline</button>
        </div>
      </div>
      <p className="timeline-focus-note panel-body" role="status" hidden={analysis || !focus}>
        {focus ? (focusIndex >= 0 ? <><span>{focus.label} is marked in the timeline.</span><button type="button" className="button small-button" onClick={() => jumpTo(focusIndex)}>Go to it</button></> : <span>{complete ? `${focus.label} is not in these dates.` : `Finding ${focus.label.toLowerCase()}…`}</span>) : null}
      </p>
      <HighlightSetup game={game} rules={rules} catalog={catalog} counts={counts} complete={complete} freshRule={freshRule} disclosures={disclosures} hidden={analysis || mode !== 'highlight'} commit={commit} />
      <div className="highlight-summary panel-body" hidden={summaryHidden}>
        <div className="highlight-cards">
          {activeRules.map(({ rule, index }) => {
            const summary = highlightSummary(scoped, rule);
            return (
              <div key={index} className={`highlight-card highlight-${rule.color}`}>
                <div className="highlight-card-head"><span className="highlight-dot" aria-hidden="true" /><span className="highlight-card-name">{highlightName(rule, index)}</span><strong>{number(summary.hits)}</strong></div>
                <div className="highlight-bar" aria-hidden="true"><i style={{ width: `${Math.max(summary.share, summary.hits ? 1.5 : 0)}%` }} /></div>
                <span className="small muted">{percent(summary.share)} of {number(scoped.length)} events · in {number(summary.inSessions)} of {number(sessionCount)} session{sessionCount === 1 ? '' : 's'}</span>
              </div>
            );
          })}
        </div>
        <div className="highlight-map" role="group" aria-label="Where highlights fall in this player's timeline">
          <span className="small muted">Start</span>
          <div className="highlight-track">
            {ticks.map(({ item, position: at, rule }) => (
              <button key={item.index} type="button" className={`highlight-tick highlight-${rule.color}`} style={{ left: `${scoped.length > 1 ? (100 * at) / (scoped.length - 1) : 0}%` }} onClick={() => jumpTo(item.index)} aria-label={`Go to ${item.name}, event ${item.index + 1}`} title={`${item.name} · event ${item.index + 1}`} />
            ))}
          </div>
          <span className="small muted">Latest</span>
        </div>
      </div>
      <div className="tl-layout">
        <aside className="tl-rail" hidden={sessions.length < 2} aria-label="Sessions">{sessionPicker()}</aside>
        <div className="tl-main">
          <div className="tl-toolbar" hidden={analysis}>
          <div className="tl-nav" hidden={navHidden}>
            <label htmlFor={navId}>Navigate</label>
            <select id={navId} value={selection} onChange={(event) => { setNavSelection(event.target.value); setCurrent(-1); }}>
              <option value="all">All highlights</option>
              {rules.map((rule, index) => <option key={index} value={index}>{highlightName(rule, index)}</option>)}
            </select>
            <div className="highlight-navigation-buttons" role="group" aria-label="Navigate matching events">
              <button type="button" className="button" title="Shortcut: K" disabled={!matchIndices.length} onClick={() => jumpTo(highlightNavigationIndex(matchIndices, current, false))}>← Previous</button>
              <button type="button" className="button" title="Shortcut: J" disabled={!matchIndices.length} onClick={() => jumpTo(highlightNavigationIndex(matchIndices, current, true))}>Next →</button>
            </div>
            <span role="status" aria-live="polite">{`${position < 0 ? '0' : number(position + 1)} / ${number(matchIndices.length)} matching events${complete ? '' : ' · loading timeline…'}`}</span>
            <span className="small muted">Keys: J next · K previous</span>
          </div>
          <div className="param-bar" hidden={analysis}>
            <div className="segmented" role="group" aria-label="Parameters shown">
              <button type="button" aria-pressed={!paramState.showAll} onClick={() => setShowAll(false)}>Hide noise</button>
              <button type="button" aria-pressed={paramState.showAll} onClick={() => setShowAll(true)}>Show all</button>
            </div>
            <Disclosure name="param-chooser" disclosures={disclosures} className="param-chooser" summary={<>Choose parameters <span className="small muted">{number(hidden.size)} hidden</span></>}>
              <div className="param-list">
                <p className="help">Untick parameters you never read. Clicking a parameter name in the timeline hides it too. Remembered for this game in this browser; a parameter used by a highlight stays visible.</p>
                <div className="param-grid">
                  {parameterChooser(events, hidden).map(({ name, key, count }) => (
                    <label key={name} className="check-row"><input type="checkbox" checked={!hidden.has(name)} onChange={(event) => toggleParam(name, event.target.checked)} /> <code>{key}</code> <span className="small muted">{number(count)}</span></label>
                  ))}
                </div>
                <button type="button" className="button small-button" onClick={resetParams}>Reset to default</button>
              </div>
            </Disclosure>
            <label className="check-row" htmlFor={groupId}><input id={groupId} type="checkbox" checked={paramState.group} onChange={(event) => updateParams((state) => ({ ...state, group: event.target.checked }))} /> Group repeated events</label>
          </div>
            <div className="toolbar" hidden={analysis || mode !== 'filter'}>
              <div className="search"><Ico name="search" size={16} /><input ref={searchRef} id={searchId} type="search" aria-label="Filter events" placeholder="Filter by event or parameter…" value={filterText} onChange={(event) => setFilterText(event.target.value)} /></div>
            </div>
          </div>
          <p className={joinClass('help panel-body', failure && 'error')} role="status" hidden={analysis}>
            {failure || `${number(events.length)} events ${complete ? 'in the full selected date range' : 'loaded · loading the rest of the timeline…'}`}
          </p>
          {analysis ? (
            <EventAnalysis events={items} session={shownSession} complete={complete} failure={failure} timezone={timezone} onJump={jumpFromAnalysis} onHighlight={highlightFromAnalysis} onRetry={() => setAttempt((count) => count + 1)} />
          ) : (
            <div className="panel-body" id="journey" ref={listRef}>{renderSessions()}</div>
          )}
        </div>
      </div>
    </section>
  );
}
