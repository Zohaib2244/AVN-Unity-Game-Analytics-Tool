// The editor panel: the saved funnels (stored on the server), Save / Save as… / Delete, the steps and the
// options. Deleting asks first; saving a new funnel asks for its name.
import { useState, type ReactElement } from 'react';
import { Button } from '@avn/ui';
import { useRead, write } from '@/api';
import { CollapsiblePanel } from '@/components/Collapsible';
import { ConfirmDialog, DialogShell, useNotify } from '@/components/feedback';
import { Field, FormError, useSubmit } from '@/components/forms';
import type { Dimension } from '@/lib/filters';
import { gameURL } from '@/lib/games';
import type { Catalog, FunnelDraft, FunnelStep, Game, SavedFunnel } from '@/lib/types';
import { addLevelSteps, blankStep, definition, editorNote } from './funnelMath';
import { FunnelOptions, StepEditor } from './StepEditor';

export type FunnelEditorProps = {
  game: Game;
  current: FunnelDraft;
  setCurrent: (update: (draft: FunnelDraft) => FunnelDraft) => void;
  catalog: Catalog;
  breakdown: Dimension | '';
  onBreakdown: (dimension: Dimension | '') => void;
  /** Runs the funnel with this draft (the one being edited, or the one just chosen). */
  onRun: (draft: FunnelDraft) => void;
  /** Changing this remounts the panel so it re-reads its folded state ("Collapse all"). */
  panelsKey: number;
};

export function FunnelEditor({ game, current, setCurrent, catalog, breakdown, onBreakdown, onRun, panelsKey }: FunnelEditorProps): ReactElement {
  const { toast, toastError } = useNotify();
  const savedQuery = useRead<SavedFunnel[]>(`${gameURL(game)}/insights/funnels`);
  const saved = savedQuery.data ?? [];
  const [dialog, setDialog] = useState<'levels' | 'name' | 'delete' | null>(null);
  const close = () => setDialog(null);

  const setSteps = (steps: FunnelStep[]) => setCurrent((draft) => ({ ...draft, steps }));
  const change = (next: FunnelDraft) => { setCurrent(() => next); onRun(next); };

  const save = async () => {
    if (!current.id) { setDialog('name'); return; }
    const body = definition(current);
    if (body.steps.length < 2) { toast('A funnel needs at least two steps.'); return; }
    try { await write(`${gameURL(game)}/insights/funnels/${current.id}`, { method: 'PUT', body: JSON.stringify(body) }); toast('Funnel saved.'); }
    catch (error) { toastError(error); }
  };
  const chooseSaved = (id: string) => {
    const chosen = saved.find((item) => item.id === id);
    change(chosen
      ? { id: chosen.id, name: chosen.name, steps: chosen.steps.map((step) => ({ ...blankStep(), ...step })), scope: chosen.scope, window_hours: chosen.window_hours }
      : { ...current, id: null, name: '' });
  };

  return (
    <>
      <CollapsiblePanel key={panelsKey} game={game} name="editor" className="section-spacing" note={editorNote(current.steps)}
        header={<div className="saved-row"><select id="saved-funnel" aria-label="Saved funnels" value={current.id || ''} onChange={(e) => chooseSaved(e.target.value)}>
          <option value="">{current.id ? 'New funnel' : current.name ? `${current.name} (unsaved)` : 'New funnel (unsaved)'}</option>
          {saved.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></div>}
        actions={<div className="quiet-actions">
          <button className="button small-button" type="button" onClick={save}>{current.id ? 'Save' : 'Save…'}</button>
          <button className="button small-button" type="button" onClick={() => setDialog('name')}>Save as…</button>
          {current.id ? <button className="button small-button danger-text" type="button" onClick={() => setDialog('delete')}>Delete</button> : null}
        </div>}>
        <div className="panel-body">
          <StepEditor steps={current.steps} catalog={catalog} onChange={setSteps} onClear={() => change({ ...current, steps: [] })} onLevelSteps={() => setDialog('levels')} onRun={() => onRun(current)} />
          <FunnelOptions scope={current.scope || 'player'} windowHours={current.window_hours} breakdown={breakdown}
            onScope={(scope) => change({ ...current, scope })} onWindow={(window_hours) => change({ ...current, window_hours })}
            onBreakdown={(dimension) => { onBreakdown(dimension); onRun(current); }} />
        </div>
      </CollapsiblePanel>
      <LevelStepsDialog open={dialog === 'levels'} onClose={close} catalog={catalog} steps={current.steps} onAdd={(steps) => change({ ...current, steps })} />
      <SaveFunnelDialog open={dialog === 'name'} onClose={close} game={game} current={current} onSaved={(created) => { setCurrent((draft) => ({ ...draft, id: created.id, name: created.name })); toast('Funnel saved.'); }} />
      <ConfirmDialog open={dialog === 'delete'} onClose={close} title={`Delete “${current.name}”?`} message="Only the saved steps are removed. No event data is affected." label="Delete funnel" danger
        onConfirm={async () => {
          await write(`${gameURL(game)}/insights/funnels/${current.id}`, { method: 'DELETE' });
          setCurrent((draft) => ({ ...draft, id: null, name: '' }));
          toast('Funnel deleted.');
        }} />
    </>
  );
}

/** "Level steps…": one step per level and key, in order. */
function LevelStepsDialog({ open, onClose, catalog, steps, onAdd }: { open: boolean; onClose: () => void; catalog: Catalog; steps: FunnelStep[]; onAdd: (steps: FunnelStep[]) => void }): ReactElement {
  const [event, setEvent] = useState('');
  const chosen = event || catalog.events[0]?.name || '';
  const suggested = catalog.events.find((item) => item.name === chosen)?.params.map((param) => param.key).slice(0, 3).join(', ') || 'Started, Completed';
  const { onSubmit, busy, error } = useSubmit((values) => {
    onAdd(addLevelSteps(steps, { event: values.event || chosen, keys: values.keys || '', from: values.from || '', to: values.to || '', replace: values.replace === 'on' }));
    onClose();
  });
  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Add level steps">
      <form id="levels-form" onSubmit={onSubmit}>
        <p>Adds one step per level and key, in order. For example keys <code>Started, Completed</code> for levels 1–5 make 10 steps.</p>
        <Field label="Event" htmlFor="series-event"><select id="series-event" name="event" value={chosen} onChange={(e) => setEvent(e.target.value)}>{catalog.events.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></Field>
        <Field label="Parameter keys, in order" htmlFor="series-keys"><input id="series-keys" name="keys" placeholder={suggested} required /></Field>
        <div className="field-row">
          <Field label="From level" htmlFor="series-from"><input id="series-from" name="from" type="number" min={0} defaultValue={1} required /></Field>
          <Field label="To level" htmlFor="series-to"><input id="series-to" name="to" type="number" min={0} defaultValue={5} required /></Field>
        </div>
        <label className="check-row"><input type="checkbox" name="replace" defaultChecked /> Replace the current steps</label>
        <FormError error={error} />
        <div className="modal-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy} loadingLabel="Adding…">Add steps</Button></div>
      </form>
    </DialogShell>
  );
}

/** "Save as…" (and Save for a funnel without a name yet): asks for the name, then creates it on the server. */
function SaveFunnelDialog({ open, onClose, game, current, onSaved }: { open: boolean; onClose: () => void; game: Game; current: FunnelDraft; onSaved: (created: SavedFunnel) => void }): ReactElement {
  const { onSubmit, busy, error } = useSubmit(async (values) => {
    const body = { ...definition(current), name: values.name || '' };
    if (body.steps.length < 2) throw new Error('A funnel needs at least two steps.');
    const created = await write<SavedFunnel>(`${gameURL(game)}/insights/funnels`, { method: 'POST', body: JSON.stringify(body) });
    onSaved(created);
    onClose();
  });
  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Save funnel">
      <form id="name-form" onSubmit={onSubmit}>
        <p>Saved funnels are stored on the server, so they’re there on every device you use.</p>
        <Field label="Name" htmlFor="funnel-name"><input id="funnel-name" name="name" required maxLength={80} defaultValue={current.name || ''} placeholder="e.g. Levels 1–5" /></Field>
        <FormError error={error} />
        <div className="modal-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy} loadingLabel="Saving…">Save</Button></div>
      </form>
    </DialogShell>
  );
}
