// One player's raw timeline (the old renderRawEvents): every event of the range, grouped by session, with
// highlights and their rules, parameter folds, the filter, and the Event Analysis tab over the same events.
// Events arrive page by page (insights/journey, one snapshot) until the whole range is in.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { elementScroll, observeElementOffset, observeElementRect, observeWindowOffset, observeWindowRect, useVirtualizer, windowScroll, type Virtualizer } from '@tanstack/react-virtual';
import { errorMessage, isAbort, read } from '@/api';
import { Popover, Tag } from '@avn/ui';
import { motion } from 'motion/react';
import { Ico } from '@/components/icons';
import { useNotify } from '@/components/feedback';
import type { DayRange } from '@/lib/filters';
import { timezoneOffset } from '@/lib/filters';
import { analysisDate, clock, duration, number, percent, type Timezone } from '@/lib/format';
import { conditionError, conditionGroup, eventCondition, eventMatchesCondition, HIGHLIGHT_COLORS, highlightMatchIndices, highlightMatches, highlightNavigationIndex, matchingConditionParams, paramCondition } from '@/lib/conditions';
import { gameURL } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';
import type { TimelineHighlight } from '@/lib/player-events';
import type { Game, JourneyEvent, JourneyPage, SessionSummary } from '@/lib/types';
import { useDisclosures } from './Disclosure';
import { EventAnalysis } from './EventAnalysis';
import { eventLabel, levelChange, shapeEvent, SNAPSHOT_EVENTS } from './eventLayout';
import { HighlightSetup } from './HighlightSetup';
import {
  buildCatalog, chipTitle, chipValue, DEFAULT_HIDDEN_PARAMS, defaultParamState, foldRuns, highlightName, highlightSummary, matchesFilter, MAX_HIGHLIGHTS,
  eventNote, type ParamState, parameterGroups, repeatKey, sessionEnding, sessionHasEvent, sessionLength, sessionLevels, sessionStartSummary, type TimelineItem, timelineSessions,
} from './timeline';

type Mode = 'highlight' | 'filter';
type Focus = { event: string; label: string };
/** One colour per kind of event, in order of how many the player has, so the same kind is the same colour in every session. */
const LANE_COLORS = ['var(--accent)', 'var(--info)', 'var(--ok)', 'var(--warn)', 'var(--done)', 'var(--new)', 'var(--bad)', 'var(--muted)'];
const joinClass = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ');
/** The name of the highlight a click on one value makes: the same click again finds and removes it. */
const quickLabel = (item: { name: string }, key: string, value: unknown): string => (key === 'STATE' ? `${eventLabel(item.name)} · ${String(value)}` : `${eventLabel(item.name)} · ${key} ${chipValue(value)}`);

/** The events of the range for one player, page by page; the same snapshot throughout, so counts stay steady. */
type Journey = { events: JourneyEvent[]; complete: boolean; failure: string; states: Record<string, SessionSummary> };
function useJourney(base: string, player: string, range: DayRange, tzOffset: number, attempt: number): Journey {
  const [state, setState] = useState<Journey>({ events: [], complete: false, failure: '', states: {} });
  useEffect(() => {
    let cancelled = false;
    const events: JourneyEvent[] = [];
    let states: Record<string, SessionSummary> = {};
    let snapshot: number | string | null = null;
    let more = true;
    let shownAt = 0;
    setState({ events: [], complete: false, failure: '', states: {} });
    void (async () => {
      try {
        while (more && !cancelled) {
          const params = new URLSearchParams({ start: range.from, end: range.to, player, offset: String(events.length), tz_offset: String(tzOffset) });
          if (snapshot != null) params.set('snapshot', String(snapshot));
          const page = await read<JourneyPage>(`${base}/insights/journey?${params}`);
          if (cancelled) return;
          snapshot = page.snapshot;
          for (const event of page.events) events.push(event);
          states = page.sessions ?? states;
          more = page.truncated && page.events.length > 0;
          // A long timeline is shown a few times a second, not on every page: each show rebuilds the sessions.
          if (!more || Date.now() - shownAt > 600) { shownAt = Date.now(); setState({ events: events.slice(), complete: !more, failure: '', states }); }
        }
      } catch (error) {
        if (!cancelled && !isAbort(error)) setState((previous) => ({ ...previous, events: events.slice(), failure: `${errorMessage(error, 'The timeline could not load.')} · ${number(events.length)} events loaded; counts are incomplete. Reopen Raw events to retry.` }));
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
  const { events, complete, failure, states } = journey;
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

  // Which kinds of event the log shows; the game's snapshots (the player and the device, not something that happened) start folded away.
  const typesKey = `avn-timeline-event-types-${game.id}`;
  const [offTypes, setOffTypes] = useState<string[]>(() => storeGet<{ hidden?: string[] }>(typesKey)?.hidden ?? SNAPSHOT_EVENTS);
  const offSet = useMemo(() => new Set(offTypes), [offTypes]);
  const setTypes = (next: string[]) => { storeSet(typesKey, { hidden: next }); setOffTypes(next); };
  const typesButton = useRef<HTMLButtonElement>(null);
  const [typesOpen, setTypesOpen] = useState(false);
  // The row you clicked stays where it was on screen when the page above it changes (a highlight appearing).
  const place = useRef<{ el: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const held = place.current;
    if (!held) return;
    place.current = null;
    const shift = held.el.isConnected ? held.el.getBoundingClientRect().top - held.top : 0;
    if (shift) window.scrollBy({ top: shift, behavior: 'instant' });
  });
  // The last level an event named before each one in its session, so a row marks a level only where it changes.
  const levelBefore = useMemo(() => {
    const before: Array<number | null> = [];
    let last: number | null = null;
    let current = -1;
    for (const item of items) {
      if (item.session !== current) { current = item.session; last = null; }
      before.push(last);
      if (item.level != null) last = item.level;
    }
    return before;
  }, [items]);

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
  const typeOrder = useMemo(() => {
    const total = new Map<string, number>();
    items.forEach((item) => total.set(item.name, (total.get(item.name) ?? 0) + 1));
    return [...total].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name);
  }, [items]);
  const typeRank = useMemo(() => new Map(typeOrder.map((name, index) => [name, index])), [typeOrder]);
  const colorOf = (name: string): string => LANE_COLORS[Math.min(typeRank.get(name) ?? LANE_COLORS.length, LANE_COLORS.length - 1)]!;
  const selection = navSelection === 'all' || Number(navSelection) < rules.length ? navSelection : 'all';
  const validRules = rules.filter((rule) => rule.enabled !== false && !conditionError(rule.conditions));
  // Counted once per change of what is chosen, not on every render of a long timeline.
  const { scoped, typeCounts, matchIndices, counts } = useMemo(() => {
    const inScope = (index: number): boolean => shownSession === 'all' || items[index]?.session === Number(shownSession);
    const typeCounts = new Map<string, number>();
    items.forEach((item, index) => { if (inScope(index)) typeCounts.set(item.name, (typeCounts.get(item.name) ?? 0) + 1); });
    const shown = (index: number): boolean => inScope(index) && !offSet.has(items[index]!.name);
    const scoped = items.filter((_, index) => shown(index));
    const matchIndices = highlightMatchIndices(items, rules, selection).filter(shown);
    const counts = rules.map((rule) => (conditionError(rule.conditions) ? 0 : items.filter((item, index) => shown(index) && eventMatchesCondition(item, rule.conditions)).length));
    return { scoped, typeCounts, matchIndices, counts };
  }, [items, rules, selection, shownSession, offSet]);
  const focusIndex = focus ? items.findIndex((item) => item.event_id === focus.event) : -1;
  const lanes = typeOrder.filter((name) => typeCounts.has(name) && !offSet.has(name)).slice(0, 10);

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

  // After a jump: bring the row in (it may not exist yet, the list only draws what is on screen), focus it and pulse it once.
  useEffect(() => {
    if (!pulse) return;
    const at = flat.findIndex((row) => row.kind === 'event' && (row.item.index === pulse.index || row.run?.some((item) => item.index === pulse.index)));
    if (at < 0) return;
    virtual.scrollToIndex(at, { align: 'center' });
    let target: HTMLElement | null | undefined;
    const timer = window.setTimeout(() => {
      target = listRef.current?.querySelector<HTMLElement>(`[data-timeline-index="${pulse.index}"]`);
      if (!target) return;
      target.focus({ preventScroll: true });
      target.classList.add('jump-pulse');
    }, 120);
    const clear = window.setTimeout(() => target?.classList.remove('jump-pulse'), 950);
    return () => { window.clearTimeout(timer); window.clearTimeout(clear); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Click a value (or a STATE) to highlight every event that carries it; click it again to take it off.
  const quickHighlight = (el: HTMLElement, item: TimelineItem, key: string, value: unknown) => {
    place.current = { el, top: el.getBoundingClientRect().top };
    const label = quickLabel(item, key, value);
    const at = rules.findIndex((rule) => rule.label === label);
    if (at >= 0) { writeStore({ rules: rules.filter((_, index) => index !== at), mode: 'highlight' }); setCurrent(-1); return; }
    if (rules.length >= MAX_HIGHLIGHTS) { toast('Use at most 20 highlights.'); return; }
    const color = HIGHLIGHT_COLORS[rules.length % HIGHLIGHT_COLORS.length]![0];
    writeStore({ rules: [...rules, { label, color, enabled: true, conditions: conditionGroup([eventCondition(item.name), { ...paramCondition(key), value: String(value) }]) }], mode: 'highlight' });
    setCurrent(-1);
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

  const renderRow = (item: TimelineItem, run: TimelineItem[] | null, slot: { ref: (el: HTMLElement | null) => void; index: number; style: CSSProperties }): ReactElement => {
    const owner = sessions[item.session]!;
    const note = eventNote(item, owner, states[owner.id]);
    const hits = mode === 'highlight' ? rules.flatMap((rule, index) => (highlightMatches(item, rule) ? [{ rule, index }] : [])) : [];
    const lit = new Set(hits.flatMap(({ rule }) => matchingConditionParams(item, rule.conditions)));
    const shape = shapeEvent(item);
    const quiet: string[] = [];
    const chip = (key: string, value: unknown, kind: 'show' | 'link' | 'quiet'): ReactElement | null => {
      const off = kind === 'quiet' || (kind === 'show' && hidden.has(key.toLowerCase()));
      if (!paramState.showAll && off && !lit.has(key)) { quiet.push(key); return null; }
      const hit = hits.find(({ rule }) => matchingConditionParams(item, rule.conditions).includes(key));
      const picked = rules.some((rule) => rule.label === quickLabel(item, key, value));
      return (
        <span key={key} className={joinClass('chip', hit && `highlight-ink highlight-${hit.rule.color}`, off && 'chip-off', kind === 'link' && 'chip-link')}>
          <button type="button" className="chip-key" onClick={() => toggleHide(key)} title={off ? `Show ${key} again in clean view` : `Hide ${key} in every event`}>{key}</button>{' '}
          <button type="button" className={joinClass('chip-value', picked && 'on')} aria-pressed={picked} onClick={(event) => quickHighlight(event.currentTarget, item, key, value)} title={kind === 'link' ? `${chipTitle(value)} · highlight every event with this ID` : `${chipTitle(value)} · highlight every ${eventLabel(item.name)} event with this value`}>{kind === 'link' && typeof value === 'string' && value.length > 12 ? `${value.slice(0, 8)}…` : chipValue(value)}</button>
        </span>
      );
    };
    const chips = [
      ...shape.show.map(([key, value]) => chip(key, value, 'show')),
      ...shape.quiet.map(([key, value]) => chip(key, value, 'quiet')),
      ...shape.link.map(([key, value]) => chip(key, value, 'link')),
    ];
    const chipList = <>{chips}{quiet.length ? <button type="button" className="chip chip-more" onClick={() => setShowAll(true)} title={`Hidden: ${quiet.join(', ')}. Click to show all parameters.`}>+{quiet.length}</button> : null}</>;
    const level = levelChange(item.level, levelBefore[item.index]);
    const params = item.name === 'session_start' && Object.keys(item.params).length ? (
      <details className="chip-collapse" open={lit.size > 0 ? true : undefined}><summary>{sessionStartSummary(item.params)}</summary>{chipList}</details>
    ) : chipList;
    const last = run?.[run.length - 1];
    const focused = item.index === focusIndex;
    return (
      <li key={item.index} ref={slot.ref} data-index={slot.index} data-timeline-index={item.index} tabIndex={-1} style={{ '--c': colorOf(item.name), ...slot.style } as CSSProperties} className={joinClass(run && 'timeline-run', hits.length > 0 && `timeline-match highlight-${hits[0]!.rule.color}`, focused && 'timeline-focus', current === item.index && mode === 'highlight' && 'timeline-current')}>
        <time dateTime={item.client_ts}>{clock(item.client_ts, timezone)}</time>
        <span className={joinClass('journey-gap', item.gap != null && item.gap > 60 && 'long')}>{item.gap == null ? '' : `+${duration(item.gap)}`}</span>
        <span className="journey-lanes" aria-hidden="true">{lanes.map((name) => <i key={name} className={name === item.name ? 'dot' : undefined} style={{ '--lane': colorOf(name) } as CSSProperties} />)}</span>
        <span className="journey-name">
          <span title={item.name}>{eventLabel(item.name)}</span>
          {shape.state ? <button type="button" className={joinClass('state-badge', rules.some((rule) => rule.label === quickLabel(item, 'STATE', shape.state)) && 'on')} onClick={(event) => quickHighlight(event.currentTarget, item, 'STATE', shape.state)} title={`Highlight every ${eventLabel(item.name)} ${shape.state}`}>{shape.state}</button> : null}
          {level != null ? <span className="level-mark" title={`Level ${level}`}>L{level}</span> : null}
          {run ? <span className="chip chip-count" title={`${run.length} identical events in a row`}>×{run.length}</span> : null}
          {note ? <span className="event-note">{note}</span> : null}
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

  // The list is flat so only the rows on screen exist: a session heading, its events, and its closing line.
  type Row =
    | { kind: 'head'; key: string; name: string; index: number; session: (typeof sessions)[number]; open: boolean; count: number }
    | { kind: 'event'; key: string; item: TimelineItem; run: TimelineItem[] | null }
    | { kind: 'end'; key: string; session: (typeof sessions)[number] };
  const flat = useMemo(() => {
    const query = mode === 'filter' ? filterText : '';
    const out: Row[] = [];
    sessions.forEach((session, index) => {
      if (shownSession !== 'all' && index !== Number(shownSession)) return;
      const shown = session.items.filter((item) => !offSet.has(item.name) && matchesFilter(item, query));
      if (!shown.length) return;
      const name = `session-${session.id}-${index}`;
      const open = disclosures.isOpen(name, true);
      out.push({ kind: 'head', key: name, name, index, session, open, count: session.items.length });
      if (!open) return;
      for (const row of foldRuns(shown, (item) => (paramState.group && item.index !== focusIndex && !rules.some((rule) => highlightMatches(item, rule)) ? repeatKey(item, hidden, paramState.showAll) : null))) {
        out.push({ kind: 'event', key: `e${row.items[0]!.index}`, item: row.items[0]!, run: row.run ? row.items : null });
      }
      if (sessionEnding(states[session.id])) out.push({ kind: 'end', key: `${name}-end`, session });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, shownSession, offSet, mode, filterText, paramState, rules, focusIndex, disclosures.isOpen, states]);

  // Rows scroll with the page, or with the dialog the player is open in.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const box = listRef.current;
    if (!box) return;
    let parent = box.parentElement;
    while (parent && parent !== document.body && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    const found = parent && parent !== document.body && parent !== document.documentElement ? parent : null;
    if (found !== scroller) setScroller(found);
    const top = found ? box.getBoundingClientRect().top - found.getBoundingClientRect().top + found.scrollTop : box.getBoundingClientRect().top + window.scrollY;
    if (Math.abs(top - scrollMargin) > 1) setScrollMargin(top);
  });
  const virtual = useVirtualizer({
    count: flat.length,
    getScrollElement: () => (scroller ?? window) as unknown as HTMLElement,
    observeElementRect: ((instance: Virtualizer<HTMLElement, Element>, callback: (rect: { width: number; height: number }) => void) => (scroller ? observeElementRect(instance, callback) : observeWindowRect(instance as never, callback))) as typeof observeElementRect,
    observeElementOffset: ((instance: Virtualizer<HTMLElement, Element>, callback: (offset: number, scrolling: boolean) => void) => (scroller ? observeElementOffset(instance, callback) : observeWindowOffset(instance as never, callback))) as typeof observeElementOffset,
    scrollToFn: ((offset: number, options: { adjustments?: number; behavior?: ScrollBehavior }, instance: Virtualizer<HTMLElement, Element>) => (scroller ? elementScroll(offset, options, instance) : windowScroll(offset, options, instance as never))) as typeof elementScroll,
    estimateSize: (index) => (flat[index]?.kind === 'head' ? 56 : flat[index]?.kind === 'end' ? 40 : 40),
    overscan: 14,
    scrollMargin,
    getItemKey: (index) => flat[index]?.key ?? index,
  });

  const renderSessions = (): ReactElement => {
    if (!flat.length) return <p className="help">{events.length ? 'No events match the filter.' : complete ? 'No events from this player in these days.' : 'Loading events…'}</p>;
    return (
      <ol className="journey-events journey-virtual" style={{ height: virtual.getTotalSize(), '--lanes-w': `${lanes.length * 9 + 4}px` } as CSSProperties}>
        {virtual.getVirtualItems().map((slot) => {
          const row = flat[slot.index]!;
          const place = { ref: virtual.measureElement as (el: HTMLElement | null) => void, index: slot.index, style: { transform: `translateY(${slot.start - scrollMargin}px)` } as CSSProperties };
          if (row.kind === 'event') return renderRow(row.item, row.run, place);
          if (row.kind === 'end') {
            const state = states[row.session.id];
            return (
              <li key={row.key} ref={place.ref} data-index={slot.index} style={place.style} className="vrow-end">
                <p className="session-end-marker"><Tag kind={state?.end_reason === 'inferred' ? 'warn' : 'plain'}>{sessionEnding(state)}</Tag>{state?.status === 'closed' ? <time dateTime={state.last_event_at}>{clock(state.last_event_at, timezone)}</time> : null}</p>
              </li>
            );
          }
          const { session, index } = row;
          const start = session.items[0]!.client_ts;
          const gap = session.items[0]!.gap;
          const state = states[session.id];
          return (
            <li key={row.key} ref={place.ref} data-index={slot.index} style={place.style} className="vrow-head">
              <button type="button" className="journey-session-head" aria-expanded={row.open} onClick={() => disclosures.set(row.name, !row.open)}>
                <strong>Session {index + 1}</strong>
                {sessions.length < 2 ? <span>{analysisDate(start, timezone)} · Play time {duration(sessionLength(session, state))}{state?.away_seconds ? ` · Away ${duration(state.away_seconds)}` : ''} · {number(row.count)} events</span> : <span>{number(row.count)} events</span>}
                {gap == null || sessions.length > 1 ? null : <span className="session-gap">{duration(gap)} after previous session</span>}
                {state?.measured_old_way ? <span title="This app version only reported its end at the next launch, so this length is less exact.">Measured the old way</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    );
  };

  const sessionPicker = (): ReactElement | null => {
    if (sessions.length < 2) return null;
    return (
      <>
        <label className="compact-session-picker">Session<select value={shownSession} onChange={(event) => { const next = event.target.value; setShownSession(next); if (current >= 0 && !inSession(next, current)) setCurrent(-1); }}><option value="all">All {number(sessions.length)} sessions</option>{sessions.map((session, index) => <option key={session.id + index} value={index}>Session {index + 1} · {analysisDate(session.items[0]!.client_ts, timezone)}</option>)}</select></label>
        <span className="session-picker-label" id={pickerLabel}>Sessions</span>
        <div className="session-chips" role="group" aria-labelledby={pickerLabel}>
          <button type="button" className="session-chip" aria-pressed={shownSession === 'all'} onClick={() => setShownSession('all')}>{shownSession === 'all' ? <motion.i layoutId="session-bar" className="session-bar" aria-hidden="true" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}<strong>All sessions</strong><span>{number(sessions.length)} sessions</span></button>
          {sessions.map((session, index) => {
            const first = session.items[0]!.client_ts;
            const gap = session.items[0]!.gap;
            return (
              <button key={session.id + index} type="button" className="session-chip" aria-pressed={shownSession === String(index)} onClick={() => { setShownSession(String(index)); if (current >= 0 && !inSession(String(index), current)) setCurrent(-1); }}>
                {shownSession === String(index) ? <motion.i layoutId="session-bar" className="session-bar" aria-hidden="true" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}
                <strong>Session {index + 1}{focus && sessionHasEvent(session, focus.event) ? <>{' '}<span className="pill">{focus.label}</span></> : null}</strong>
                <span className="session-chip-lines">
                  <span>{analysisDate(first, timezone)}</span>
                  <span><b>Length</b> {duration(sessionLength(session, states[session.id]))}</span>
                  {states[session.id]?.away_seconds ? <span><b>Away</b> {duration(states[session.id]!.away_seconds)}</span> : null}
                  <span><b>Played</b> {sessionLevels(session)}</span>
                  {sessionEnding(states[session.id]) ? <span><b>Ended</b> {sessionEnding(states[session.id])}</span> : null}
                  {gap == null ? null : <span><b>Came back</b> {duration(gap)} later</span>}
                </span>
              </button>
            );
          })}
        </div>
      </>
    );
  };

  // How much of the timeline each highlight covers, and where along it the matches fall.
  const activeRules = useMemo(() => rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.enabled !== false && !conditionError(rule.conditions)), [rules]);
  const summaryHidden = analysis || mode !== 'highlight' || !activeRules.length || !scoped.length;
  const { sessionCount, summaries, ticks } = useMemo(() => {
    if (summaryHidden) return { sessionCount: 0, summaries: [] as Array<ReturnType<typeof highlightSummary>>, ticks: [] as Array<{ item: TimelineItem; position: number; rule: TimelineHighlight }> };
    const all = scoped.flatMap((item, position) => {
      const hit = activeRules.find(({ rule }) => highlightMatches(item, rule));
      return hit ? [{ item, position, rule: hit.rule }] : [];
    });
    // The strip holds at most 600 marks, spread along the whole timeline.
    const step = Math.max(1, Math.ceil(all.length / 600));
    return { sessionCount: new Set(scoped.map((item) => item.session_id)).size, summaries: activeRules.map(({ rule }) => highlightSummary(scoped, rule)), ticks: all.filter((_, at) => at % step === 0) };
  }, [summaryHidden, scoped, activeRules]);
  const position = matchIndices.indexOf(current);
  const navHidden = analysis || mode !== 'highlight' || !validRules.length;
  const [displayQuery, setDisplayQuery] = useState('');
  // The popover fits the room under its button: if there is little, the button is first brought near the top.
  const [displayHeight, setDisplayHeight] = useState(480);
  const openDisplay = () => {
    if (typesOpen) { setTypesOpen(false); return; }
    const button = typesButton.current;
    if (button) {
      let room = window.innerHeight - button.getBoundingClientRect().bottom - 16;
      if (room < 260) { window.scrollBy({ top: button.getBoundingClientRect().top - 120, behavior: 'instant' }); room = window.innerHeight - button.getBoundingClientRect().bottom - 16; }
      setDisplayHeight(Math.max(200, Math.min(room, Math.round(window.innerHeight * 0.6), 520)));
    }
    setTypesOpen(true);
  };
  useEffect(() => { if (!typesOpen) setDisplayQuery(''); }, [typesOpen]);
  const hiddenCount = offTypes.filter((name) => typeCounts.has(name)).length + hidden.size;
  const typeRows = useMemo(() => [...typeCounts].filter(([name]) => `${name} ${eventLabel(name)}`.toLowerCase().includes(displayQuery.trim().toLowerCase())).sort((a, b) => b[1] - a[1]), [typeCounts, displayQuery]);
  // The parameter list is only built while the popover is open: a long timeline has hundreds of them.
  const paramGroups = useMemo(() => {
    if (!typesOpen) return [];
    const needle = displayQuery.trim().toLowerCase();
    return parameterGroups(events, hidden)
      .map((group) => ({ ...group, params: group.params.filter((param) => !needle || `${group.event ?? ''} ${param.key}`.toLowerCase().includes(needle)) }))
      .filter((group) => group.params.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typesOpen, events, paramState.hidden, displayQuery]);

  return (
    <section className="panel raw-timeline">
      <div className="panel-header">
        <div>
          <h2>{analysis ? 'Event analysis' : 'Timeline'}</h2>
          <p role="status">{analysis ? 'What this player called, and how often · counts follow the session selected below' : `${number(events.length)} events${complete ? '' : ' so far · loading the rest…'}`}</p>
        </div>
        <div className="segmented" role="group" aria-label="Timeline mode" hidden={analysis}>
          <button type="button" aria-pressed={mode === 'highlight'} onClick={() => setMode('highlight')}>Highlight</button>
          <button type="button" aria-pressed={mode === 'filter'} onClick={() => setMode('filter')}>Filter</button>
        </div>
      </div>
      <p className="timeline-focus-note panel-body" role="status" hidden={analysis || !focus}>
        {focus ? (focusIndex >= 0 ? <><span>{focus.label} is marked in the timeline.</span><button type="button" className="button small-button" onClick={() => jumpTo(focusIndex)}>Go to it</button></> : <span>{complete ? `${focus.label} is not in these dates.` : `Finding ${focus.label.toLowerCase()}…`}</span>) : null}
      </p>
      <div className="highlight-summary panel-body" hidden={summaryHidden}>
        <div className="highlight-cards">
          {(summaryHidden ? [] : activeRules).map(({ rule, index }, at) => {
            const summary = summaries[at]!;
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
            
          </div>
          <div className="param-bar" hidden={analysis}>
            <HighlightSetup game={game} rules={rules} catalog={catalog} events={events} counts={counts} complete={complete} freshRule={freshRule} disclosures={disclosures} hidden={analysis || mode !== 'highlight'} commit={commit} />
            <button type="button" ref={typesButton} className="button small-button types-button" aria-haspopup="dialog" aria-expanded={typesOpen} onClick={openDisplay}>Display{hiddenCount ? <span className="small muted"> · {number(hiddenCount)} hidden</span> : null}</button>
            <Popover position="fixed" open={typesOpen} onClose={() => setTypesOpen(false)} anchor={typesButton} width={340} className="types-pop display-pop">
              <div className="display-pop-body" role="group" aria-label="What the timeline shows" style={{ maxHeight: displayHeight }}>
                <div className="display-pop-search"><Ico name="search" size={16} /><input type="search" autoFocus aria-label="Search event types and parameters" placeholder="Search events and parameters…" value={displayQuery} onChange={(event) => setDisplayQuery(event.target.value)} /></div>
                <div className="pop-scroll display-pop-scroll">
                  <label className="check-row"><input type="checkbox" checked={paramState.showAll} onChange={(event) => setShowAll(event.target.checked)} /> Show every parameter</label>
                  <label className="check-row" htmlFor={groupId}><input id={groupId} type="checkbox" checked={paramState.group} onChange={(event) => updateParams((state) => ({ ...state, group: event.target.checked }))} /> Group repeated events</label>
                  <div className="pop-grp"><span className="eyebrow">Event types</span></div>
                  {typeRows.length ? typeRows.map(([name, count]) => (
                    <label key={name} className="check-row types-row"><input type="checkbox" checked={!offSet.has(name)} onChange={(event) => setTypes(event.target.checked ? offTypes.filter((item) => item !== name) : [...offTypes, name])} /> <span title={name}>{eventLabel(name)}</span> <span className="small muted">{number(count)}</span></label>
                  )) : <p className="help">No event type matches.</p>}
                  <div className="pop-grp"><span className="eyebrow">Parameters</span></div>
                  {paramGroups.length ? paramGroups.map((group) => (
                    <section key={group.event ?? 'other'} className="param-group">
                      <h4>{group.event ? eventLabel(group.event) : 'Hidden, not on any event here'}</h4>
                      {group.params.map(({ name, key, count }) => (
                        <label key={name} className="check-row"><input type="checkbox" checked={!hidden.has(name)} onChange={(event) => toggleParam(name, event.target.checked)} /> <code>{key}</code> {group.event ? <span className="small muted">{number(count)}</span> : null}</label>
                      ))}
                    </section>
                  )) : <p className="help">No parameter matches.</p>}
                </div>
                <div className="pop-grp types-foot"><button type="button" className="button small-button" onClick={() => { setTypes(SNAPSHOT_EVENTS); resetParams(); }}>Reset</button><button type="button" className="button small-button" onClick={() => setTypes([])}>Show all types</button></div>
              </div>
            </Popover>
          </div>
            <div className="toolbar" hidden={analysis || mode !== 'filter'}>
              <div className="search"><Ico name="search" size={16} /><input ref={searchRef} id={searchId} type="search" aria-label="Filter events" placeholder="Filter by event or parameter…" value={filterText} onChange={(event) => setFilterText(event.target.value)} /></div>
            </div>
          </div>
          {failure && !analysis ? <p className="help panel-body error" role="alert">{failure}</p> : null}
          {analysis ? (
            <EventAnalysis events={items} session={shownSession} complete={complete} failure={failure} timezone={timezone} onJump={jumpFromAnalysis} onHighlight={highlightFromAnalysis} onRetry={() => setAttempt((count) => count + 1)} />
          ) : (
            <div className="panel-body" id="journey" ref={listRef}><div className="journey-swap" key={shownSession}>{renderSessions()}</div></div>
          )}
        </div>
      </div>
    </section>
  );
}
