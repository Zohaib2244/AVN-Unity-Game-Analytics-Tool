// The add / edit dialog for an event in the AVN events standard: a name, what it tracks, and one or more states
// with their parameters. Names are forced to UPPER_SNAKE as the person types, as the old editor did.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { write } from '@/api';
import { DialogShell, useNotify } from '@/components/feedback';
import { useSubmit } from '@/components/forms';
import { Ico } from '@/components/icons';
import type { CustomEvent, UnlistedEvent } from '@/lib/types';
import { blankParam, blankState, customBody, editorModel, noSpaces, prefillModel, upperSnake, type EditorModel, type EditorParam, type EditorState } from './customEvents';

export type EditorTarget = { existing?: CustomEvent | null; prefill?: UnlistedEvent | null };

export function CustomEventDialog({ target, onClose }: { target: EditorTarget; onClose: () => void }): ReactElement {
  const { existing = null, prefill = null } = target;
  const locked = Boolean(existing || prefill);
  const [model, setModel] = useState<EditorModel>(() => (prefill ? prefillModel(prefill) : editorModel(existing)));
  const formRef = useRef<HTMLFormElement>(null);
  // Where the cursor goes after a change (a new state or parameter), as the old editor did.
  const focusId = useRef<string | null>(locked ? 'state-0' : 'name');
  const { toast } = useNotify();

  useEffect(() => {
    if (!focusId.current) return;
    formRef.current?.querySelector<HTMLElement>(`[data-id="${focusId.current}"]`)?.focus();
    focusId.current = null;
  });

  const editState = (s: number, change: (state: EditorState) => EditorState) => setModel((m) => ({ ...m, states: m.states.map((st, i) => (i === s ? change(st) : st)) }));
  const editParam = (s: number, p: number, change: (param: EditorParam) => EditorParam) => editState(s, (st) => ({ ...st, params: st.params.map((pr, i) => (i === p ? change(pr) : pr)) }));

  const addState = () => { focusId.current = `state-${model.states.length}`; setModel((m) => ({ ...m, states: [...m.states, blankState()] })); };
  const removeState = (s: number) => setModel((m) => ({ ...m, states: m.states.filter((_, i) => i !== s) }));
  const addParam = (s: number) => {
    focusId.current = `key-${s}-${model.states[s]?.params.length ?? 0}`;
    editState(s, (st) => ({ ...st, params: [...st.params, blankParam()] }));
  };
  const removeParam = (s: number, p: number) => editState(s, (st) => ({ ...st, params: st.params.filter((_, i) => i !== p) }));

  const { onSubmit, busy, error } = useSubmit(async () => {
    if (!model.name) throw new Error('Give the event a name.');
    await write(`/v1/events-standard/custom/${encodeURIComponent(model.name)}`, { method: 'PUT', body: JSON.stringify(customBody(model)) });
    toast(`${model.name} added to the standard.`);
    onClose();
  });

  const field = (label: string, input: ReactElement, wide = false) => <div className={`field ${wide ? 'wide' : ''}`}><label>{label}{input}</label></div>;

  const paramRow = (param: EditorParam, s: number, p: number): ReactElement => (
    <div className="custom-param" role="group" aria-label={`Parameter ${p + 1}`} key={p}>
      <input data-id={`key-${s}-${p}`} value={param.key} placeholder="KEY" aria-label="Parameter key" autoComplete="off" onChange={(e) => editParam(s, p, (pr) => ({ ...pr, key: upperSnake(e.target.value) }))} />
      <select aria-label="Type" value={param.type} onChange={(e) => editParam(s, p, (pr) => ({ ...pr, type: e.target.value }))}>
        {['string', 'int', 'float'].map((type) => <option key={type} value={type}>{type}</option>)}
      </select>
      <label className="check-row"><input type="checkbox" checked={param.required} onChange={(e) => editParam(s, p, (pr) => ({ ...pr, required: e.target.checked }))} /> Required</label>
      <input value={param.values} placeholder="Values: A, B, C" aria-label="Allowed values, comma separated" autoComplete="off" onChange={(e) => editParam(s, p, (pr) => ({ ...pr, values: e.target.value }))} />
      <input value={param.note} placeholder="Note" aria-label="Note" maxLength={200} autoComplete="off" onChange={(e) => editParam(s, p, (pr) => ({ ...pr, note: e.target.value }))} />
      <button type="button" className="icon-button" aria-label="Remove parameter" title="Remove" onClick={() => removeParam(s, p)}><Ico name="close" size={14} /></button>
    </div>
  );

  const stateBox = (state: EditorState, s: number): ReactElement => (
    <fieldset className="custom-state" key={s}>
      <legend>State {s + 1}</legend>
      <div className="custom-state-head">
        {field('Name', <input data-id={`state-${s}`} value={state.name} placeholder="Opened" autoComplete="off" onChange={(e) => editState(s, (st) => ({ ...st, name: noSpaces(e.target.value) }))} />)}
        {field('When is it sent?', <input value={state.trigger} maxLength={300} placeholder="The shop screen appears" autoComplete="off" onChange={(e) => editState(s, (st) => ({ ...st, trigger: e.target.value }))} />, true)}
        {model.states.length > 1 ? <button type="button" className="icon-button" aria-label={`Remove state ${s + 1}`} title="Remove state" onClick={() => removeState(s)}><Ico name="close" size={14} /></button> : null}
      </div>
      {state.params.map((param, p) => paramRow(param, s, p))}
      <button type="button" className="button" onClick={() => addParam(s)}><Ico name="plus" size={14} /> Parameter</button>
    </fieldset>
  );

  return (
    <DialogShell open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={existing ? `Edit ${existing.name}` : prefill ? `Add ${prefill.name} to the standard` : 'Add an AVN event'}>
      <div className="custom-event-dialog">
        <form ref={formRef} id="custom-form" className="custom-form" onSubmit={onSubmit}>
          <div className="player-dialog-head">
            <span />
            <button type="button" className="button" aria-label="Close" onClick={onClose}>Close ×</button>
          </div>
          <div id="custom-body">
            <div className="custom-top">
              {field('Event name', <input data-id="name" value={model.name} placeholder="SHOP" maxLength={40} readOnly={locked} autoComplete="off" onChange={(e) => setModel((m) => ({ ...m, name: upperSnake(e.target.value) }))} />)}
              {field('What does it track?', <input value={model.purpose} maxLength={300} placeholder="The player opens the shop" autoComplete="off" onChange={(e) => setModel((m) => ({ ...m, purpose: e.target.value }))} />, true)}
            </div>
            {model.states.map((state, s) => stateBox(state, s))}
            <button type="button" className="button" onClick={addState}><Ico name="plus" size={14} /> State</button>
          </div>
          <div className="error" role="alert">{error}</div>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="button primary" disabled={busy}><Ico name="check" size={14} /> Save event</button>
          </div>
        </form>
      </div>
    </DialogShell>
  );
}
