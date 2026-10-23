// The pure parts of the Funnels page: step text, the funnel definition sent to the server, conversion
// and drop per step, the biggest drop, level steps, CSV rows and the journeys range. No DOM here.
import { MAX_STEPS, filterBody, operatorLabel, type ActiveFilters, type Dimension } from '@/lib/filters';
import type { FunnelDraft, FunnelResultRow, FunnelStep } from '@/lib/types';

export const blankStep = (event = ''): FunnelStep => ({ event, param: '', op: 'eq', value: '', label: '' });

/** The window options: hours (as the select value) and their label. */
export const WINDOWS: Array<[string, string]> = [['', 'Any time'], ['0.25', '15 minutes'], ['1', '1 hour'], ['24', '1 day'], ['168', '7 days'], ['720', '30 days']];
export const windowLabel = (hours: number | null | undefined): string => WINDOWS.find(([value]) => value === (hours ? String(hours) : ''))?.[1] || 'Any time';

/** A step as the result shows it: its name, or "event · param = value" (the operator spelt as a symbol). */
export const stepLabel = (step: Pick<FunnelStep, 'event' | 'param' | 'op' | 'value' | 'label'>): string =>
  step.label ? step.label : `${step.event}${step.param ? ` · ${step.param}${step.op === 'exists' || (step.value ?? '') === '' ? '' : ` ${operatorLabel(step.op)} ${step.value}`}` : ''}`;

/** The short name in the folded editor's note: the name, or "event · param=value". */
export const stepName = (step: FunnelStep): string => step.label || `${step.event}${step.param ? ` · ${step.param}${step.value ? `=${step.value}` : ''}` : ''}`;

/** A step in the journeys menus: "3. Started · level=2" (the name replaces the event, not the condition). */
export const journeyStepName = (step: FunnelStep, index: number): string => `${index + 1}. ${journeyStepPlain(step)}`;
export const journeyStepPlain = (step: FunnelStep): string => `${step.label || step.event}${step.param ? ` · ${step.param}${step.value ? `=${step.value}` : ''}` : ''}`;

/** The one-line note beside the folded editor. */
export function editorNote(steps: FunnelStep[]): string {
  const named = steps.filter((step) => step.event);
  return named.length ? `${named.length} step${named.length === 1 ? '' : 's'}: ${stepName(named[0]!)} → ${stepName(named[named.length - 1]!)}` : 'no steps yet';
}

export type Definition = { name: string; steps: FunnelStep[]; scope: 'player' | 'session'; window_hours: number | null };
/** What the server is asked: only steps with an event, conditions normalised. */
export function definition(draft: FunnelDraft): Definition {
  return {
    name: draft.name,
    steps: draft.steps.filter((step) => step.event).map(({ event, param, op, value, label }) => ({ event, param: param || '', op: param ? op || 'eq' : 'eq', value: param && op !== 'exists' ? value || '' : '', label: label || '' })),
    scope: draft.scope || 'player',
    window_hours: draft.window_hours || null,
  };
}

/** The body sent to the server for a run (and for the journeys, which pass no breakdown): filters, steps, count, window, breakdown. */
export function funnelBody(def: Definition, filters: ActiveFilters, breakdown: Dimension | '' = ''): Record<string, unknown> {
  return { ...filterBody(filters), steps: def.steps, scope: def.scope, ...(def.window_hours ? { window_hours: def.window_hours } : {}), ...(breakdown ? { breakdown } : {}) };
}

export const canAddStep = (steps: FunnelStep[]): boolean => steps.length < MAX_STEPS;

/** Conversion from first to last count, in percent (null when nobody did the first). */
export const conversion = (first: number, last: number): number | null => (first ? (100 * last) / first : null);

/** The share lost between a step and the one before, from the share that continued (one decimal, like the server). */
export const lostShare = (ofPrevious: number): number => Math.round((100 - ofPrevious) * 10) / 10;

/** Per step: the share that continued and the share lost from the previous step (null for step 1). */
export const dropPerStep = (rows: Array<Pick<FunnelResultRow, 'of_previous'>>): Array<{ continued: number; lost: number } | null> =>
  rows.map((row, index) => (index ? { continued: row.of_previous, lost: lostShare(row.of_previous) } : null));

/** The step where the largest share of players stops: the lowest "of previous" after a step somebody reached. -1 when no step loses anyone. */
export function biggestDrop(rows: Array<Pick<FunnelResultRow, 'players' | 'of_previous'>>): number {
  let worst: { index: number; rate: number } | null = null;
  rows.forEach((row, index) => {
    if (index && rows[index - 1]!.players && row.of_previous < 100 && (!worst || row.of_previous < worst.rate)) worst = { index, rate: row.of_previous };
  });
  return worst ? (worst as { index: number }).index : -1;
}

/** Bar width in percent of step 1: at least 1% when anyone reached the step, 0 when nobody did step 1. */
export const barWidth = (row: Pick<FunnelResultRow, 'players' | 'of_first'>, first: number): number => (first ? Math.max(row.of_first, row.players ? 1 : 0) : 0);

/** One step per level and key, in order: keys "Started, Completed" for levels 1–2 make Started 1, Completed 1, Started 2, Completed 2. */
export function levelSteps(event: string, keys: string[], from: number, to: number): FunnelStep[] {
  const added: FunnelStep[] = [];
  for (let level = from; level <= to; level++) for (const key of keys) added.push({ ...blankStep(event), param: key, value: String(level), label: `${key} ${level}` });
  return added;
}

/** The "Add level steps" form: validates and returns the new step list, or throws the message to show. */
export function addLevelSteps(current: FunnelStep[], values: { event: string; keys: string; from: string | number; to: string | number; replace: boolean }): FunnelStep[] {
  const keys = String(values.keys).split(',').map((key) => key.trim()).filter(Boolean);
  const from = Number(values.from), to = Number(values.to);
  if (!keys.length) throw new Error('Enter at least one key.');
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) throw new Error('Use whole numbers, with “to” at least “from”.');
  const added = levelSteps(values.event, keys, from, to);
  const base = values.replace ? [] : current;
  if (base.length + added.length > MAX_STEPS) throw new Error(`That makes ${base.length + added.length} steps. A funnel can have up to ${MAX_STEPS}.`);
  return [...base, ...added];
}

export function funnelCSV(rows: FunnelResultRow[]): Array<Array<string | number | null | undefined>> {
  const out: Array<Array<string | number | null | undefined>> = [['step', 'name', 'event', 'parameter', 'condition', 'value', 'players', 'percent_of_step_1', 'percent_of_previous', 'stopped_here', 'median_seconds_from_previous', 'p90_seconds_from_previous']];
  rows.forEach((row, index) => out.push([index + 1, row.label, row.event, row.param, row.param ? row.op : '', row.value, row.players, row.of_first, row.of_previous, row.dropped, row.time_from_previous?.median ?? '', row.time_from_previous?.p90 ?? '']));
  return out;
}

/** Keeps the journeys range inside the funnel: from is never the last step, to is after from. */
export function clampJourneyRange(from: number, to: number | null, count: number): { from: number; to: number } {
  const start = Math.min(Math.max(1, from), Math.max(1, count - 1));
  const end = Math.min(Math.max(to || count, start + 1), Math.max(count, 2));
  return { from: start, to: end };
}
