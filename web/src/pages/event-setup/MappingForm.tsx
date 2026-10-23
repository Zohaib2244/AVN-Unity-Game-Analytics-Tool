// The add form under a mapping card: which event, when (optionally) a parameter matches, and where the level
// number is. It previews what the rule would match, 250 ms after the last change.
import { useEffect, useState, type ReactElement } from 'react';
import { request } from '@/api';
import { gameURL } from '@/lib/games';
import { number } from '@/lib/format';
import type { Game, MappingConcept, MappingEvent, MappingPreview, MappingRule, MappingsData } from '@/lib/types';
import { useNotify } from '@/components/feedback';
import { useSubmit } from '@/components/forms';
import { Ico } from '@/components/icons';
import { MAPPING_OPERATORS, previewBits, ruleFromForm } from './rules';

export type FormState = { event: string; param: string; op: string; value: string; number_param: string; app_version: string };
type Line = { bits?: Array<{ text: string; strong: boolean }>; text?: string; result?: MappingPreview };

/** A suggestion or a saved event's guess for this concept, as the form's fields. */
export const fieldsOf = (rule: MappingRule): Partial<FormState> => ({ param: rule.param, op: rule.op, value: rule.value, number_param: rule.number_param, app_version: rule.app_version });

export function MappingForm({ game, data, concept, state, rules, onChange, onClose, onSaved, save }: {
  game: Game; data: MappingsData; concept: MappingConcept; state: FormState; rules: MappingRule[];
  onChange: (next: FormState) => void; onClose: () => void; onSaved: () => void;
  save: (event: string, rules: MappingRule[]) => Promise<unknown>;
}): ReactElement {
  const { toast } = useNotify();
  const key = concept.key;
  const info: MappingEvent = data.events.find((item) => item.name === state.event) ?? { name: '', events: 0, defined: false, params: [], suggestions: [] };
  const params = info.params;
  const examples = params.find((param) => param.key === state.param)?.examples ?? [];
  const rule = ruleFromForm(key, state, concept.needs);
  const body = JSON.stringify({ event: state.event, rule });

  // The preview: the server counts what this rule would match, after the person stops typing.
  const [line, setLine] = useState<Line | null>(null);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      const asked = JSON.parse(body) as { event: string; rule: MappingRule };
      if (!asked.event) { setLine({ text: 'This game has not sent any events yet.' }); return; }
      if (asked.rule.param && asked.rule.op !== 'exists' && !asked.rule.value) { setLine({ text: 'Add a value to compare with.' }); return; }
      try {
        const result = await request<MappingPreview>(`${gameURL(game)}/mappings/preview`, { method: 'POST', body });
        if (alive) setLine({ bits: previewBits(result, concept.needs), result });
      } catch (problem) { if (alive) setLine({ text: problem instanceof Error ? problem.message : 'Couldn’t check this mapping.' }); }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [body, game, concept.needs]);

  const { onSubmit, busy, error } = useSubmit(async () => {
    if (rule.param && rule.op !== 'exists' && !rule.value) throw new Error('Add a value to compare with.');
    await save(state.event, [...rules, rule]);
    toast(`${state.event} now counts as ${concept.label.toLowerCase()}.`);
    onSaved();
  });

  /** Picking an event starts from its own guess for this concept, as the old form did. */
  const pickEvent = (name: string) => {
    const guess = data.events.find((item) => item.name === name)?.suggestions.find((item) => item.action === key);
    onChange({ ...state, event: name, param: '', op: 'eq', value: '', number_param: '', ...(guess ? fieldsOf(guess) : {}) });
  };
  const pickParam = (name: string) => {
    const guess = info.suggestions.find((item) => item.action === key && item.param === name);
    onChange({ ...state, param: name, op: guess?.op || 'eq', value: guess?.value || '', number_param: guess?.number_param || state.number_param });
  };

  return (
    <form className="mapping-form" data-mapping-form={key} onSubmit={onSubmit}>
      <h3 className="event-sub">Add a mapping for “{concept.label}”</h3>
      <p className="help">Applies to {state.app_version ? state.app_version : 'all versions'} across all analytics pages.</p>
      <div className="mapping-fields">
        <div className="field"><label>Which event?</label>
          <select name="event" aria-label="Which event?" value={state.event} onChange={(e) => pickEvent(e.target.value)}>
            {data.events.map((item) => <option key={item.name} value={item.name}>{item.name} · {number(item.events)} sent{item.defined ? '' : ' · not described'}</option>)}
          </select>
        </div>
        <div className="field"><label>Only when… <span className="muted">(optional)</span></label>
          <div className="mapping-condition">
            <select name="param" aria-label="Parameter" value={state.param} onChange={(e) => pickParam(e.target.value)}>
              <option value="">Every time it is sent</option>
              {params.map((param) => <option key={param.key} value={param.key}>{param.key}</option>)}
            </select>
            {state.param ? (
              <>
                <select name="op" aria-label="Comparison" value={state.op} onChange={(e) => onChange({ ...state, op: e.target.value })}>
                  {MAPPING_OPERATORS.map(([op, text]) => <option key={op} value={op}>{text}</option>)}
                </select>
                {state.op === 'exists' ? null : (
                  <>
                    <input name="value" aria-label="Comparison value" value={state.value} list={`mapping-values-${key}`} placeholder="value" autoComplete="off" onChange={(e) => onChange({ ...state, value: e.target.value })} />
                    <datalist id={`mapping-values-${key}`}>{examples.map((value) => <option key={value} value={value} />)}</datalist>
                  </>
                )}
              </>
            ) : null}
          </div>
        </div>
        {concept.needs ? (
          <div className="field"><label>The level number is in</label>
            <select name="number_param" aria-label="Level number parameter" value={state.number_param} onChange={(e) => onChange({ ...state, number_param: e.target.value })}>
              <option value="">Find it automatically (a parameter called “level”)</option>
              {params.map((param) => <option key={param.key} value={param.key}>{param.key}{param.examples.length ? ` · e.g. ${param.examples.slice(0, 3).join(', ')}` : ''}</option>)}
            </select>
          </div>
        ) : null}
      </div>
      <p className="mapping-preview help" aria-live="polite">
        {line === null ? <span className="skeleton-line" role="status" aria-label="Checking mapping" /> : line.text ? line.text : line.bits ? (
          <>
            {line.bits.map((bit, i) => <span key={i}>{i ? ' · ' : ''}{bit.strong ? <strong>{bit.text}</strong> : bit.text}</span>)}.
            {line.result?.events ? null : <strong> Nothing matches yet.</strong>}
          </>
        ) : null}
      </p>
      {line?.result?.sample ? (
        <details className="mapping-sample"><summary>Example matching parameters</summary><pre>{JSON.stringify(line.result.sample, null, 2)}</pre></details>
      ) : null}
      <div className="error" role="alert">{error}</div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy}><Ico name="plus" size={14} /> Add mapping</button>
      </div>
    </form>
  );
}
