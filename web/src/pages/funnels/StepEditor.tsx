// The funnel's steps: one row per step (event, parameter, condition, value, an optional name), the actions
// under them and the options as chips. Refuses more than MAX_STEPS steps.
import type { ReactElement } from 'react';
import { Ico } from '@/components/icons';
import { RuleFields } from '@/components/EventRule';
import { DIMENSIONS, DIMENSION_LABELS, type Dimension } from '@/lib/filters';
import type { Catalog, FunnelScope, FunnelStep } from '@/lib/types';
import { WINDOWS, blankStep, canAddStep } from './funnelMath';

export type StepEditorProps = {
  steps: FunnelStep[];
  catalog: Catalog;
  onChange: (steps: FunnelStep[]) => void;
  /** "Clear" empties the steps and runs (so the result says what to do next). */
  onClear: () => void;
  onLevelSteps: () => void;
  onRun: () => void;
};

export function StepEditor({ steps, catalog, onChange, onClear, onLevelSteps, onRun }: StepEditorProps): ReactElement {
  const update = (index: number, patch: Partial<FunnelStep>) => onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const move = (index: number, by: number) => {
    const next = [...steps]; const to = index + by;
    [next[index], next[to]] = [next[to]!, next[index]!];
    onChange(next);
  };
  const add = () => { if (canAddStep(steps)) onChange([...steps, blankStep(steps[steps.length - 1]?.event || catalog.events[0]?.name)]); };
  return (
    <>
      <div id="funnel-steps">
        {steps.length ? steps.map((step, index) => (
            <div className="funnel-step" data-index={index} key={index}>
              <span className="step-number">{String(index + 1).padStart(2, '0')}</span>
              <RuleFields rule={step} catalog={catalog} set={(patch) => update(index, patch)} listId={`step-values-${index}`} name={`Step ${index + 1} `} fixed />
              <span className="step-tools">
                <button type="button" className="icon-button" aria-label="Name this step" title="Name this step" onClick={() => update(index, { naming: true })}><Ico name="edit" size={13} /></button>
                <button type="button" className="icon-button" aria-label="Move step up" disabled={!index} onClick={() => move(index, -1)}>↑</button>
                <button type="button" className="icon-button" aria-label="Move step down" disabled={index >= steps.length - 1} onClick={() => move(index, 1)}>↓</button>
                <button type="button" className="icon-button" aria-label="Remove step" onClick={() => onChange(steps.filter((_, i) => i !== index))}><Ico name="close" size={13} /></button>
              </span>
              {step.label || step.naming ? <input className="step-name" data-field="label" aria-label={`Step ${index + 1} name`} placeholder="Step name, e.g. Level 1 start" maxLength={80} value={step.label || ''} autoFocus={!!step.naming && !step.label} onChange={(e) => update(index, { label: e.target.value })} /> : null}
            </div>
        )) : <p className="help">No steps yet. Add one, or use “Level steps…” to add Started/Completed steps for a range of levels.</p>}
      </div>
      <div className="funnel-actions">
        <div className="quiet-actions">
          <button className="button small-button" type="button" disabled={!canAddStep(steps)} onClick={add}><Ico name="plus" size={14} /> Add step</button>
          <button className="button small-button" type="button" onClick={onLevelSteps}><Ico name="plus" size={14} /> Level steps…</button>
          <button className="button ghost small-button" type="button" onClick={onClear}>Clear</button>
        </div>
        <button className="button primary" type="button" onClick={onRun}>Run funnel</button>
      </div>
    </>
  );
}

/** The options as chips, always visible and highlighted when changed from the default. */
export function FunnelOptions({ scope, windowHours, breakdown, onScope, onWindow, onBreakdown }: { scope: FunnelScope; windowHours: number | null; breakdown: Dimension | ''; onScope: (scope: FunnelScope) => void; onWindow: (hours: number | null) => void; onBreakdown: (dimension: Dimension | '') => void }): ReactElement {
  return (
    <div className="funnel-more">
      <span className="eyebrow">Options</span>
      <div className="funnel-options option-chips">
        <label className={`inline-field ${scope === 'session' ? 'changed' : ''}`}>Count<select id="funnel-scope" value={scope} onChange={(e) => onScope(e.target.value as FunnelScope)}><option value="player">Per player, across sessions</option><option value="session">Within one session</option></select></label>
        <label className={`inline-field ${windowHours ? 'changed' : ''}`}>Finish within<select id="funnel-window" value={windowHours ? String(windowHours) : ''} onChange={(e) => onWindow(e.target.value ? Number(e.target.value) : null)}>{WINDOWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className={`inline-field ${breakdown ? 'changed' : ''}`}>Break down by<select id="funnel-breakdown" value={breakdown} onChange={(e) => onBreakdown(e.target.value as Dimension | '')}><option value="">Nothing</option>{DIMENSIONS.map((key) => <option key={key} value={key}>{DIMENSION_LABELS[key]}</option>)}</select></label>
      </div>
    </div>
  );
}
