// Guided cohort comparisons: population → behavior → groups → outcome. Results keep their own definition.
import { Fragment, useMemo, useState, type ReactElement } from 'react';
import { Button } from '@avn/ui';
import { read, useRead } from '@/api';
import { facetsPath, FilterBar } from '@/components/Filters';
import { LoadError, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Field } from '@/components/forms';
import { filterQuery, type ActiveFilters, type Facets } from '@/lib/filters';
import { analysisDate, number, percent } from '@/lib/format';
import { gameURL } from '@/lib/games';
import { downloadCSV, storeGet, storeSet } from '@/lib/store';
import type { Catalog, Game } from '@/lib/types';
import { RuleFields, RuleList } from '../players/RuleList';
import { blankGroupRule, defaultGroupDraft, groupDraftKey, groupRequest, groupRunKey, groupStepError, savedGroupDraft, type GroupAnswer, type GroupDraft } from './groupModel';

import { GroupLibrary } from './GroupLibrary';
import { restoreSavedGroup, type SavedGroupItem, type SaveGroupIntent } from './groupLibrary';

const STEPS = ['Population', 'Behavior', 'Groups', 'Outcome'];
const EMPTY_CATALOG: Catalog = { events: [] };
const MISSING: Record<string, string> = { no_recorded_completion: 'No recorded completion', completion_without_start: 'Completion without a recorded start', no_recorded_parameter: 'No recorded parameter', non_numeric_value: 'First value is not numeric' };
const behaviorText = (draft: GroupDraft): string => draft.kind === 'level_duration' ? `Level ${draft.level} · first completion time` : draft.kind === 'event_count' ? `${draft.event.event || 'Choose event'} · count in first ${draft.minutes} min` : `${draft.event.event || 'Choose event'}.${draft.parameter || 'parameter'} · first value`;
const splitText = (draft: GroupDraft): string => draft.kind === 'parameter' && draft.comparison === 'equals' ? `Equals “${draft.value || '…'}” vs other values` : draft.split === '' ? 'Choose a split' : `≤ ${draft.split} vs > ${draft.split}${draft.kind === 'level_duration' ? ' seconds' : draft.kind === 'event_count' ? ' events' : ''}`;

export function PlayerGroups({ game, filters, onFilters, onOpenPlayer }: {
  game: Game; filters: ActiveFilters; onFilters: (update: (state: ActiveFilters) => ActiveFilters) => void;
  onOpenPlayer: (id: string, index: number, ids: string[]) => void;
}): ReactElement {
  const [draft, setDraftState] = useState<GroupDraft>(() => savedGroupDraft(storeGet(groupDraftKey(game.id))) ?? defaultGroupDraft());
  const [submitted, setSubmitted] = useState<GroupDraft | null>(() => savedGroupDraft(storeGet(groupRunKey(game.id))));
  const [step, setStep] = useState(() => submitted ? 3 : 0);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState(false);
  const [editorKind, setEditorKind] = useState<SavedGroupItem['kind']>('check');
  const [editing, setEditing] = useState<SavedGroupItem | undefined>();
  const [intent, setIntent] = useState<SaveGroupIntent | null>(null);
  const [runItem, setRunItem] = useState<SavedGroupItem | undefined>();
  const [opening, setOpening] = useState(false);
  const [runFilters, setRunFilters] = useState<ActiveFilters>(() => storeGet<ActiveFilters>(`${groupRunKey(game.id)}-filters`) || filters);
  const { toast, toastError } = useNotify();
  const update = (patch: Partial<GroupDraft>) => { setDraftState((before) => { const next = { ...before, ...patch }; storeSet(groupDraftKey(game.id), next); return next; }); setError(''); };
  const catalogPath = `${gameURL(game)}/insights/catalog?${filterQuery(filters)}`;
  const catalog = useRead<Catalog>(catalogPath);
  const choices = catalog.data ?? EMPTY_CATALOG;
  const path = `${gameURL(game)}/insights/player-groups`;
  const request = useMemo(() => submitted ? groupRequest(submitted, runFilters) : null, [submitted, runFilters]);
  const answer = useRead<GroupAnswer>(request ? path : null, { body: request ?? undefined });
  const changed = !!submitted && (JSON.stringify(draft) !== JSON.stringify(submitted) || JSON.stringify(filters) !== JSON.stringify(runFilters));
  const next = () => { const message = groupStepError(draft, step); if (message) { setError(message); return; } setStep(Math.min(3, step + 1)); setError(''); };
  const run = () => {
    for (let index = 0; index < 4; index++) { const message = groupStepError(draft, index); if (message) { setError(message); setStep(index); return; } }
    const nextDraft = structuredClone(draft);
    setSubmitted(nextDraft); storeSet(groupRunKey(game.id), nextDraft);
    setRunFilters(structuredClone(filters)); storeSet(`${groupRunKey(game.id)}-filters`, filters); setEditor(false); setRunItem(editing?.kind === 'check' ? editing : undefined);
    if (!changed && submitted) void answer.refetch();
  };
  const chooseStep = (index: number) => { if (index <= step || submitted) { setStep(index); setError(''); } else { const message = groupStepError(draft, step); if (message) setError(message); else setStep(index); } };
  const save = (kind: SavedGroupItem['kind']) => {
    for (let index = 0; index < (kind === 'groups' ? 3 : 4); index++) { const message = groupStepError(draft, index); if (message) { setError(message); setStep(index); return; } }
    setIntent({ kind, item: editing?.kind === kind ? editing : undefined, draft: structuredClone(draft), filters: structuredClone(filters) });
  };
  const openSaved = async (item: SavedGroupItem, edit: boolean) => {
    setOpening(true);
    try {
      const restored = restoreSavedGroup(item);
      if (restored.filters.versionMode === 'latest' || restored.filters.versionMode === 'previous') {
        const facets = await read<Facets>(facetsPath(game, restored.filters));
        const version = restored.filters.versionMode === 'latest' ? facets.latest_app_version : facets.previous_app_version;
        restored.filters.app_version = version ? [version] : [];
      } else if (restored.filters.versionMode === 'all') restored.filters.app_version = [];
      update(restored.draft); onFilters(() => restored.filters); setError('');
      setEditing(edit ? item : undefined); setEditorKind(edit ? item.kind : 'check');
      if (edit || item.kind === 'groups') { setStep(edit ? 0 : 3); setEditor(true); }
      else {
        setSubmitted(restored.draft); setRunFilters(restored.filters); setRunItem(item); setEditor(false);
        storeSet(groupRunKey(game.id), restored.draft); storeSet(`${groupRunKey(game.id)}-filters`, restored.filters);
        if (JSON.stringify(groupRequest(restored.draft, restored.filters)) === JSON.stringify(request)) void answer.refetch();
      }
    } catch (error) { toastError(error); } finally { setOpening(false); }
  };
  const startNew = (kind: SavedGroupItem['kind']) => { update(defaultGroupDraft()); setEditing(undefined); setEditorKind(kind); setStep(0); setEditor(true); };
  const ruleCatalogError = catalog.isError ? <LoadError error={catalog.error} onRetry={() => void catalog.refetch()} /> : null;

  return <>
    <GroupLibrary path={`${gameURL(game)}/insights/group-library`} intent={intent} onCloseSave={() => setIntent(null)} onSaved={(item) => { setIntent(null); setEditing(item); if (item.kind === 'groups') setEditor(false); else if (intent && JSON.stringify(intent.draft) === JSON.stringify(submitted) && JSON.stringify(intent.filters) === JSON.stringify(runFilters)) setRunItem(item); }} onNew={startNew} onUse={(item) => void openSaved(item, false)} onEdit={(item) => void openSaved(item, true)} busy={opening} />
    {editor ? <section className="panel group-builder" aria-label="Compare player groups setup">
      <div className="panel-header"><h2>{editing?.name || (editorKind === 'groups' ? 'New group' : 'New check')}</h2><Button onClick={() => setEditor(false)}>Close setup</Button></div>
      <div className="group-steps" role="group" aria-label="Comparison setup steps">{STEPS.slice(0, editorKind === 'groups' ? 3 : 4).map((label, index) => <button type="button" key={label} aria-current={step === index ? 'step' : undefined} onClick={() => chooseStep(index)}><span>{index + 1}</span>{label}</button>)}</div>
      <form className="panel-body group-step" noValidate onSubmit={(event) => { event.preventDefault(); if (editorKind === 'groups' && step === 2) save('groups'); else if (step < 3) next(); else run(); }}>
        <h3 aria-live="polite" tabIndex={-1}>{step + 1}. {STEPS[step]}</h3>
        {step === 0 ? <>
          <details className="group-help"><summary>About this setting</summary><p className="help">Dates select players first observed in this game. Version, build and country pick their starting state; follow-up continues across later updates. “New” means first observed in this dataset, not a verified install.</p></details>
          <FilterBar game={game} state={filters} onChange={onFilters} />
          <Field label="Within first (hours)" htmlFor="group-hours"><input id="group-hours" type="number" min="0.01" max="720" step="any" value={draft.hours} onChange={(event) => update({ hours: event.target.value })} /></Field>
          <div className="group-fields"><Field label="First recorded progression" htmlFor="group-entry"><select id="group-entry" value={draft.entryLevel === '' ? 'any' : 'level'} onChange={(event) => update({ entryLevel: event.target.value === 'any' ? '' : '1' })}><option value="level">Must start at a specific level</option><option value="any">Any first-observed player</option></select></Field>{draft.entryLevel !== '' ? <Field label="Entry level" htmlFor="group-entry-level"><input id="group-entry-level" type="number" min="0" max="1000000" value={draft.entryLevel} onChange={(event) => update({ entryLevel: event.target.value })} /></Field> : null}</div>
          <details className="group-exclusions"><summary>Exclude specific players or baseline events{draft.exclusions.length ? ` · ${draft.exclusions.length} rules` : ''}</summary><Field label="Excluded player IDs" htmlFor="group-excluded-ids" help="One per line, or separated by commas. For example, a known emulator or test install."><textarea id="group-excluded-ids" value={draft.excludePlayers} onChange={(event) => update({ excludePlayers: event.target.value })} /></Field><details className="group-help"><summary>About this setting</summary><p className="help">Exclude anyone matching one of these events before or at their first recorded progression. Later behavior cannot change the population.</p></details>{ruleCatalogError}<RuleList rules={draft.exclusions} catalog={choices} blank={() => blankGroupRule()} onChange={(exclusions) => update({ exclusions })} addLabel="Add exclusion" empty="No event exclusions." /></details>

        </> : step === 1 ? <>
          <div className="group-fields"><Field label="Early experience" htmlFor="group-behavior"><select id="group-behavior" value={draft.kind} onChange={(event) => update({ kind: event.target.value as GroupDraft['kind'], split: '' })}><option value="level_duration">Time to first level completion</option><option value="event_count">Event count or exposure</option><option value="parameter">Recorded parameter</option></select></Field>
          {draft.kind === 'level_duration' ? <Field label="Behavior level" htmlFor="group-behavior-level"><input id="group-behavior-level" type="number" min="0" max="1000000" value={draft.level} onChange={(event) => update({ level: event.target.value })} /></Field> : <Field label="Measure within first (minutes)" htmlFor="group-minutes"><input id="group-minutes" type="number" min="0.01" max="43200" step="any" value={draft.minutes} onChange={(event) => update({ minutes: event.target.value })} /></Field>}</div>
          {draft.kind === 'level_duration' ? <details className="group-help"><summary>About this setting</summary><p className="help">Elapsed time from the first recorded start to the first completion of this level, including retries and time away. Uncompleted levels remain visible outside groups A and B.</p></details> : <>{ruleCatalogError}<fieldset className="group-event-rule"><legend>Behavior event</legend><div className="rule-row"><RuleFields rule={draft.event} catalog={choices} set={(patch) => update({ event: { ...draft.event, ...patch } })} listId="group-behavior-values" /></div></fieldset>{draft.kind === 'parameter' ? <Field label="Parameter to compare" htmlFor="group-parameter"><input id="group-parameter" list="group-parameters" value={draft.parameter} maxLength={80} onChange={(event) => update({ parameter: event.target.value })} /><datalist id="group-parameters">{choices.events.find((item) => item.name === draft.event.event)?.params.map((param) => <option key={param.key} value={param.key} />)}</datalist></Field> : null}<details className="group-help"><summary>About this setting</summary><p className="help">{draft.kind === 'event_count' ? 'Count matching events in this fixed early window. Outcomes must occur after the window ends.' : 'Use the first recorded parameter value in the early window. Outcomes must occur after that value was recorded. Missing and nonnumeric values stay visible.'}</p></details></>}
        </> : step === 2 ? <>
          {draft.kind === 'parameter' ? <Field label="Compare values" htmlFor="group-comparison"><select id="group-comparison" value={draft.comparison} onChange={(event) => update({ comparison: event.target.value as 'number' | 'equals' })}><option value="number">Numeric split</option><option value="equals">One value versus other recorded values</option></select></Field> : null}
          {draft.kind === 'parameter' && draft.comparison === 'equals' ? <Field label="Group A value" htmlFor="group-value"><input id="group-value" maxLength={200} value={draft.value} onChange={(event) => update({ value: event.target.value })} /></Field> : <Field label={`Split at${draft.kind === 'level_duration' ? ' (seconds)' : draft.kind === 'event_count' ? ' (events)' : ''}`} htmlFor="group-split"><input id="group-split" type="number" step="any" min={draft.kind === 'parameter' ? undefined : '0'} value={draft.split} placeholder="Enter a split" onChange={(event) => update({ split: event.target.value })} /></Field>}
          <p className="group-split-description">{behaviorText(draft)} · {splitText(draft)}. {draft.kind === 'parameter' && draft.comparison === 'equals' ? 'Missing values form a separate group.' : 'Group A includes the split; group B is above it.'}</p>
          <details className="group-help"><summary>About this setting</summary><p className="help">The split is exploratory. Choosing it after looking at outcomes adds uncertainty; it is not an established optimum.</p></details>
        </> : <>
          <p className="group-split-description">{behaviorText(draft)} · {splitText(draft)} · first {draft.hours} h</p>
          <div className="group-fields"><Field label="Later outcome" htmlFor="group-outcome"><select id="group-outcome" value={draft.outcomeKind} onChange={(event) => update({ outcomeKind: event.target.value as 'level' | 'event' })}><option value="level">Start a later level</option><option value="event">Record an event</option></select></Field>{draft.outcomeKind === 'level' ? <Field label="Outcome level" htmlFor="group-outcome-level"><input id="group-outcome-level" type="number" min="0" max="1000000" value={draft.outcomeLevel} onChange={(event) => update({ outcomeLevel: event.target.value })} /></Field> : null}</div>
          {draft.outcomeKind === 'event' ? <>{ruleCatalogError}<fieldset className="group-event-rule"><legend>Outcome event</legend><div className="rule-row"><RuleFields rule={draft.outcomeEvent} catalog={choices} set={(patch) => update({ outcomeEvent: { ...draft.outcomeEvent, ...patch } })} listId="group-outcome-values" /></div></fieldset></> : null}
          <details className="group-help"><summary>About this setting</summary><p className="help">The clock starts at each player’s first observed event. Only players with a full {draft.hours}-hour observation window enter the comparison; recent players are still observing. Outcomes already reached before grouping are shown separately.</p></details>
        </>}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="group-step-actions"><Button type="button" disabled={step === 0} onClick={() => { setStep(step - 1); setError(''); }}>Previous</Button>{step === 2 ? <Button type="button" variant={editorKind === 'groups' ? 'primary' : 'default'} onClick={() => save('groups')}>Save groups</Button> : null}{editorKind === 'groups' && step === 2 ? null : step < 3 ? <Button type="submit" variant="primary">Next: {STEPS[step + 1]}</Button> : <><Button type="button" onClick={() => save('check')}>Save shortcut</Button><Button type="submit" variant="primary" loading={answer.isFetching} loadingLabel="Comparing…">Compare groups</Button></>}</div>
      </form>
    </section> : null}
    {editor && changed ? <p className="group-changed" role="status">Setup changed. Compare again to update the results below.</p> : null}
    {submitted && !editor ? <div className="group-current-actions"><Button onClick={() => { update(submitted); onFilters(() => structuredClone(runFilters)); setEditorKind('check'); setEditing(runItem); setStep(3); setEditor(true); }}>Edit current check</Button><Button onClick={() => setIntent({ kind: 'check', item: runItem, draft: submitted, filters: runFilters })}>Save shortcut</Button></div> : null}
    {submitted ? <QueryRegion query={answer} path={path} skeleton={<Skeleton rows={3} columns={4} />}>{(data) => <GroupResults data={data} timezone={runFilters.timezone} onOpenPlayer={onOpenPlayer} onExport={() => { exportGroups(data, game.name); toast('Comparison downloaded.'); }} />}</QueryRegion> : null}
  </>;
}

function exportGroups(data: GroupAnswer, name: string): void {
  downloadCSV(`${name}-player-groups.csv`, [
    ['Group', 'Players', 'Reached', 'Reached percent', '95% low percent', '95% high percent'],
    ...data.groups.map((group) => [group.label, group.players, group.reached, group.rate, group.interval?.[0], group.interval?.[1]]),
    ['As of', data.as_of], ['Definition', JSON.stringify(data.definition)],
    ['Pending', data.counts.pending], ['Excluded', data.counts.excluded], ['Outcome before grouping', data.counts.outcome_before_group],
    ...data.exclusions.map((item) => [item.label, item.players]),
    ...Object.entries(data.missing_reasons).map(([reason, count]) => [MISSING[reason] || reason, count]),
    ['Difference pp', data.difference?.percentage_points], ['Difference 95% low pp', data.difference?.interval[0]], ['Difference 95% high pp', data.difference?.interval[1]],
  ]);
}

function GroupResults({ data, timezone, onOpenPlayer, onExport }: { data: GroupAnswer; timezone: ActiveFilters['timezone']; onOpenPlayer: (id: string, index: number, ids: string[]) => void; onExport: () => void }): ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);
  const delta = data.difference;
  const shown = data.groups.find((group) => group.id === expanded);
  const query = data.definition;
  const activeFilters = [query.filters.app_versions?.length ? `Starting versions: ${query.filters.app_versions.join(', ')}` : 'All starting versions', ...Object.entries(query.filters).filter(([key, values]) => key !== 'app_versions' && values.length).map(([key, values]) => `${key.replaceAll('_', ' ')}: ${values.join(', ')}`)];
  const outcome = query.outcome.kind === 'level' ? `start level ${query.outcome.level}` : query.outcome.event?.event || 'outcome';
  const behavior = query.behavior.kind === 'level_duration' ? `Level ${query.behavior.level}: first start → first completion, including retries` : query.behavior.kind === 'event_count' ? `${query.behavior.event?.event}: count within first ${query.behavior.window_minutes} min` : `${query.behavior.event?.event}.${query.behavior.parameter}: first recorded value within ${query.behavior.window_minutes} min`;
  const eventRule = query.behavior.event;
  const behaviorFilter = eventRule?.param ? ` · only when ${eventRule.param} ${eventRule.op} ${eventRule.value}` : '';

  return <section className="panel group-results" aria-label="Player group comparison results">
    <div className="panel-header"><div><h2>Later progression by group</h2><p>{outcome} · within the first {query.outcome.window_hours} hours, after grouping</p></div><Button onClick={onExport}>Download CSV</Button></div>
    <div className="panel-body">
      <div className="group-result-definition">First observed {query.start} → {query.end} · UTC offset {query.timezone_offset_minutes >= 0 ? '+' : ''}{query.timezone_offset_minutes} min · {activeFilters.join(' · ')}</div>
      <p className="group-result-definition">{query.entry_level == null ? 'New players' : `New · first progression starts level ${query.entry_level}`} · {behavior}{behaviorFilter}</p>
      <div className="group-counts" aria-label="Population accounting"><span><b>{number(data.counts.eligible)}</b> eligible</span><span><b>{number(data.counts.pending)}</b> still observing</span><span><b>{number(data.counts.excluded)}</b> excluded</span>{data.counts.outcome_before_group ? <span><b>{number(data.counts.outcome_before_group)}</b> outcome before grouping · outside A/B</span> : null}</div>
      <div className="group-difference"><strong>{delta ? `${delta.percentage_points > 0 ? '+' : ''}${number(delta.percentage_points)} pp` : 'Not enough data'}</strong><span>A vs B · {delta ? `95% interval ${delta.interval[0]} to ${delta.interval[1]} pp. ${delta.includes_zero ? 'Direction is unclear with this sample.' : 'Observed difference; not proof of cause.'}` : 'Both comparison groups need players before a difference can be calculated.'}</span></div>
      <div className="table-wrap"><table className="compact-table group-comparison-table" role="table"><thead><tr><th>Group</th><th className="num">Reached / players</th><th className="num">Reached</th><th className="num">95% interval</th><th>Inspect</th></tr></thead><tbody>{data.groups.map((group) => <tr key={group.id} className={group.id === 'missing' ? 'group-missing' : undefined}><td>{group.label}{group.id === 'missing' ? <><small>Outside A/B · whole-window outcome</small>{data.missing_reasons.no_recorded_completion ? <small>{number(data.missing_reasons.no_recorded_completion)} players never recorded a completion</small> : null}</> : null}{group.low_sample ? <small>Small sample · fewer than {number(data.minimum_players)} players</small> : null}</td><td className="num" data-label="Reached / players">{number(group.reached)} / {number(group.players)}</td><td className="num" data-label="Reached">{group.rate == null ? '—' : percent(group.rate)}</td><td className="num" data-label="95% interval">{group.interval ? `${percent(group.interval[0])}–${percent(group.interval[1])}` : '—'}</td><td data-label="Inspect"><Button size="sm" disabled={!group.examples.length} aria-expanded={expanded === group.id} onClick={() => setExpanded(expanded === group.id ? null : group.id)}>{expanded === group.id ? 'Hide' : 'Players'}</Button></td></tr>)}</tbody></table></div>
      {shown ? <div className="group-examples"><h3>{shown.label} · player examples</h3><p className="help">First {shown.examples.length} of {number(shown.players)} players. Open a player to inspect their timeline.</p><div className="table-wrap"><table className="compact-table"><thead><tr><th>Player</th><th>Behavior value</th><th>Outcome</th></tr></thead><tbody>{shown.examples.map((player, index) => <tr key={player.player}><td><Button variant="ghost" size="sm" onClick={() => onOpenPlayer(player.player, index, shown.examples.map((item) => item.player))}><span className="mono">{player.player}</span></Button></td><td>{player.value == null ? 'Missing' : String(player.value)}</td><td>{player.reached ? 'Reached' : 'Not recorded'}</td></tr>)}</tbody></table></div></div> : null}
      <details className="group-accounting"><summary>Population exclusions and missing data</summary><dl>{data.exclusions.map((item) => <Fragment key={item.reason}><dt>{item.label}</dt><dd>{number(item.players)}</dd></Fragment>)}{Object.entries(data.missing_reasons).map(([reason, count]) => <Fragment key={reason}><dt>{MISSING[reason] || reason}</dt><dd>{number(count)}</dd></Fragment>)}</dl>{!data.exclusions.length && !Object.keys(data.missing_reasons).length ? <p className="help">No exclusions or missing behavior in this comparison.</p> : null}</details>
      <details className="group-methods"><summary>How timing and uncertainty are counted</summary><p className="help">pp = percentage points. {data.interval_method}; {delta?.method || 'Newcombe intervals for differences'}. Intervals describe sampling uncertainty, not bias from unmeasured differences. Each player belongs to one group. Outcomes before or at grouping are outside A/B; the missing-behavior row describes the full observation window.</p></details>
      <p className="help">Exploratory association, not evidence that changing the behavior will improve continuation. Time to completion includes retries and time away. Data received as of {analysisDate(data.as_of, timezone)}; late events can change these results.</p>
    </div>
  </section>;
}
