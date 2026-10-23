// The event dictionary import: prepare a file and a prompt for the AI agent, upload the filled file, review
// what it would change, approve it, and undo past imports. Used by the Dictionary page and by the Fill
// Dictionary tab of Event setup. The three steps stay mounted so a review survives a trip to History.
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { request, useRead, write } from '@/api';
import { gameURL } from '@/lib/games';
import { displayDate, number } from '@/lib/format';
import { storeGet, storeSet, copyText } from '@/lib/store';
import type { Game, ImportHistoryItem, ImportOptions, ImportPrepared, ImportUndoResult } from '@/lib/types';
import { QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { useSubmit } from '@/components/forms';
import { Ico, type IcoName } from '@/components/icons';
import { IMPORT_DEFAULTS, coverageChoice, importMerge, readOptions } from './importModel';
import { ImportReview } from './ImportReview';

type Step = 'prepare' | 'upload' | 'history';
const STEPS: Array<[Step, string, IcoName]> = [['prepare', 'Prepare', 'file'], ['upload', 'Upload and review', 'export'], ['history', 'History', 'refresh']];

/** A short left-to-right row of what to do, each with an icon. */
export function SetupFlow({ items }: { items: Array<[IcoName, ReactNode]> }): ReactElement {
  return <ol className="setup-flow">{items.map(([symbol, text], index) => <li key={index}><Ico name={symbol} size={16} /><span>{text}</span></li>)}</ol>;
}

export function ImportFlow({ game }: { game: Game }): ReactElement {
  const [step, setStep] = useState<Step>('prepare');
  return (
    <div className="import-flow">
      <div className="segmented" role="group" aria-label="Import step">
        {STEPS.map(([key, label, symbol]) => (
          <button key={key} type="button" aria-pressed={step === key} onClick={() => setStep(key)}><Ico name={symbol} size={15} /> {label}</button>
        ))}
      </div>
      <div className="import-body">
        <div hidden={step !== 'prepare'}><PrepareStep game={game} onUpload={() => setStep('upload')} /></div>
        <div hidden={step !== 'upload'}><ImportReview game={game} onApplied={() => setStep('history')} /></div>
        {step === 'history' ? <ImportHistory game={game} /> : null}
      </div>
    </div>
  );
}

/** Mirrors the old form: the two coverage cards set the advanced controls they stand for; those stay editable. */
function PrepareStep({ game, onUpload }: { game: Game; onUpload: () => void }): ReactElement {
  const storeKey = `avn-import-options-${game.id}`;
  const url = `${gameURL(game)}/dictionary`;
  const [initial] = useState<ImportOptions>(() => importMerge(IMPORT_DEFAULTS, storeGet(storeKey)));
  const [prepared, setPrepared] = useState<ImportPrepared | null>(null);
  const [choice, setChoice] = useState(() => coverageChoice(initial));
  const [listed, setListed] = useState(initial.scope.events === 'listed');
  const formRef = useRef<HTMLFormElement>(null);

  const sync = (form: HTMLFormElement) => {
    const next = readOptions(new FormData(form));
    setChoice(coverageChoice(next));
    setListed(next.scope.events === 'listed');
  };
  const preset = (value: 'missing' | 'all') => {
    const form = formRef.current;
    if (!form) return;
    const all = value === 'all';
    const set = (name: string, text: string) => { const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`); if (el) el.value = text; };
    set('mode', all ? 'overwrite_all' : 'fill_blanks');
    set('events', all ? 'all' : 'undocumented');
    const max = form.querySelector<HTMLInputElement>('[name="max_overwrites"]');
    if (max) max.value = String(all ? Math.max(500, Number(max.value) || 0) : 25);
    sync(form);
  };

  const { onSubmit, busy, error } = useSubmit(async (_values, form) => {
    const next = readOptions(new FormData(form));
    storeSet(storeKey, next);
    setPrepared(await request<ImportPrepared>(`${url}/import/prepare`, { method: 'POST', body: JSON.stringify({ options: next }) }));
  });

  const card = (value: 'missing' | 'all', title: string, text: string) => (
    <label className="import-choice">
      <input type="radio" name="coverage" value={value} checked={choice === value} onChange={() => preset(value)} />
      <span><strong>{title}</strong><small>{text}</small></span>
    </label>
  );
  const select = (name: string, value: string, choices: Array<[string, string]>) => (
    <select name={name} defaultValue={value}>{choices.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
  );
  const check = (name: string, value: boolean, label: string) => (
    <label className="check-row"><input type="checkbox" name={name} defaultChecked={value} /> {label}</label>
  );
  const o = initial;
  const listedNames = [...o.scope.names, ...o.scope.prefixes.map((prefix) => `${prefix}*`)].join('\n');

  return (
    <>
      <form ref={formRef} id="import-prepare" className="import-form" onSubmit={onSubmit} onChange={(event) => sync(event.currentTarget)}>
        <div className="import-choices" role="radiogroup" aria-label="What should the agent cover?">
          {card('missing', 'Missing only', 'Only what has no description yet')}
          {card('all', 'All events', 'Re-check everything, you approve each change')}
        </div>
        {choice ? null : <p className="help">Custom coverage is set under Advanced settings.</p>}
        <details className="import-advanced"><summary>Advanced settings</summary>
          <fieldset><legend>What may change</legend>
            <div className="field"><label>When a field already has text</label>{select('mode', o.mode, [['fill_blanks', 'Only fill blanks (keep all existing text)'], ['overwrite_ai_drafts', 'Also replace earlier AI drafts nobody confirmed'], ['overwrite_all', 'Replace existing text']])}</div>
            {check('field-description', o.fields.includes('description'), 'Event descriptions')}
            {check('field-params', o.fields.includes('params'), 'Parameter descriptions')}
            <p className="help">Story rules, hidden events and mappings are never touched by an import, and an import never deletes anything.</p>
          </fieldset>
          <fieldset><legend>Which events</legend>
            <div className="field"><label>Cover</label>{select('events', o.scope.events, [['undocumented', 'Events that still need a description'], ['all', 'All events'], ['listed', 'Only the events I list']])}</div>
            <div className="field"><label htmlFor="import-names">Events to list <span className="muted">(one per line; end with * for a prefix)</span></label><textarea id="import-names" name="names" rows={2} defaultValue={listedNames} disabled={!listed} /></div>
            <div className="field-row"><div className="field"><label htmlFor="import-days">Only events sent in the last N days</label><input id="import-days" name="seen_within_days" type="number" min={1} max={3650} defaultValue={o.scope.seen_within_days ?? ''} placeholder="any time" /></div></div>
            {check('include_not_yet_received', o.scope.include_not_yet_received, 'Also add events found in the code that were never received')}
            {check('include_hidden', o.scope.include_hidden, 'Include events hidden from stories')}
          </fieldset>
          <fieldset><legend>How to write</legend>
            <div className="field-row"><div className="field"><label htmlFor="import-language">Language</label><input id="import-language" name="language" maxLength={40} defaultValue={o.style.language} /></div><div className="field"><label>Length</label>{select('tone', o.style.tone, [['one_sentence', 'One short sentence'], ['concise', 'Concise'], ['detailed', 'Detailed']])}</div></div>
            <div className="field-row"><div className="field"><label htmlFor="import-max">Longest description (characters)</label><input id="import-max" name="max_description_chars" type="number" min={20} max={4000} defaultValue={o.style.max_description_chars} /></div><div className="field"><label>Minimum confidence</label>{select('min_confidence', o.min_confidence, [['inferred', 'Inferred or certain'], ['certain', 'Certain only']])}</div></div>
            <div className="field"><label htmlFor="import-context">About the game <span className="muted">(terms and what the game is, so nothing is guessed)</span></label><textarea id="import-context" name="game_context" rows={2} maxLength={2000} defaultValue={o.style.game_context} /></div>
            {check('param_values', o.style.param_values, 'List the values a parameter can take')}
          </fieldset>
          <fieldset><legend>Where to look in the code</legend>
            <div className="field"><label htmlFor="import-include">Only look in <span className="muted">(folders, one per line)</span></label><textarea id="import-include" name="include_paths" rows={2} defaultValue={o.code.include_paths.join('\n')} /></div>
            <div className="field"><label htmlFor="import-exclude">Skip <span className="muted">(folders, one per line)</span></label><textarea id="import-exclude" name="exclude_paths" rows={2} defaultValue={o.code.exclude_paths.join('\n')} /></div>
            <div className="field"><label htmlFor="import-patterns">Your own wrappers around LogEvent <span className="muted">(one per line, e.g. <code>Analytics.Track(</code>)</span></label><textarea id="import-patterns" name="call_patterns" rows={2} defaultValue={o.code.call_patterns.join('\n')} /></div>
          </fieldset>
          <fieldset><legend>Safety</legend>
            {check('require_source', o.require_source, 'Ignore text that names no place in the code')}
            <div className="field-row"><div className="field"><label>Imported text is</label>{select('status', o.status, [['draft', 'A draft until someone confirms it'], ['confirmed', 'Confirmed straight away']])}</div><div className="field"><label htmlFor="import-overwrites">Refuse to replace more than</label><input id="import-overwrites" name="max_overwrites" type="number" min={0} max={100000} defaultValue={o.max_overwrites} /></div></div>
            <div className="field-row"><div className="field"><label>Names that look like an existing event</label>{select('near_duplicates', o.near_duplicates, [['warn', 'Warn'], ['reject', 'Reject']])}</div><div className="field">{check('type_conflicts', o.type_conflicts === 'flag', 'Flag parameters whose type disagrees with the data')}</div></div>
          </fieldset>
        </details>
        <div className="error" role="alert">{error}</div>
        <div className="modal-actions"><button type="submit" className="button primary" disabled={busy}><Ico name="sparkle" size={15} /> Prepare file and prompt</button></div>
      </form>
      <div id="import-prepared">{prepared ? <Prepared prepared={prepared} onUpload={onUpload} /> : null}</div>
    </>
  );
}

function Prepared({ prepared, onUpload }: { prepared: ImportPrepared; onUpload: () => void }): ReactElement {
  const { toast } = useNotify();
  const copy = async () => toast((await copyText(prepared.prompt)) ? 'Prompt copied.' : 'Open "Show the prompt" and copy it by hand.');
  const count = Object.keys(prepared.file.events).length;
  const download = () => {
    const href = URL.createObjectURL(new Blob([JSON.stringify(prepared.file, null, 2)], { type: 'application/json' }));
    const anchor = Object.assign(document.createElement('a'), { href, download: 'avn-events.json' });
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  };
  return (
    <section className="import-prepared">
      <h3 className="event-sub">{number(count)} event{count === 1 ? '' : 's'} in the file</h3>
      <SetupFlow items={[['export', <>Save <code>avn-events.json</code> in your game</>], ['sparkle', 'Run the prompt in your AI agent'], ['file', 'Upload the filled file']]} />
      <div className="modal-actions import-actions">
        <button type="button" className="button" onClick={download}><Ico name="export" size={14} /> Download avn-events.json</button>
        <button type="button" className="button" onClick={() => void copy()}><Ico name="copy" size={14} /> Copy the prompt</button>
        <button type="button" className="button primary" onClick={onUpload}>Upload the filled file <Ico name="arrow" size={14} /></button>
      </div>
      <details className="import-prompt"><summary>Show the prompt</summary><textarea readOnly rows={10} aria-label="Agent prompt" value={prepared.prompt} /></details>
    </section>
  );
}

function ImportHistory({ game }: { game: Game }): ReactElement {
  const url = `${gameURL(game)}/dictionary`;
  const history = useRead<ImportHistoryItem[]>(`${url}/imports`);
  const { toast, toastError } = useNotify();
  const [undoing, setUndoing] = useState('');
  const undo = async (id: string) => {
    setUndoing(id);
    try {
      const result = await write<ImportUndoResult>(`${url}/imports/${id}/undo`, { method: 'POST' });
      toast(`Put back ${number(result.reverted)} text${result.reverted === 1 ? '' : 's'}${result.kept.length ? `; kept ${result.kept.length} someone edited` : ''}.`);
    } catch (problem) { toastError(problem); }
    finally { setUndoing(''); }
  };
  return (
    <QueryRegion query={history} path={`${url}/imports`} skeleton={<Skeleton kind="table" rows={4} columns={4} />}>
      {(list) => list.length ? (
        <div className="table-wrap"><table className="compact-table"><thead><tr><th>When</th><th>Who</th><th>Texts</th><th>Rules</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {list.map((item) => (
            <tr key={item.id}>
              <td className="small">{displayDate(item.created_at)}</td>
              <td className="small">{item.actor}</td>
              <td className="num">{number(item.summary.fields_changed)}</td>
              <td className="small muted">{item.options.mode.replace(/_/g, ' ')} · {item.options.status}</td>
              <td>{item.undone_at ? <span className="pill">Undone</span> : <button type="button" className="button danger-text" disabled={undoing === item.id} onClick={() => void undo(item.id)}>Undo</button>}</td>
            </tr>
          ))}
        </tbody></table></div>
      ) : <p className="help">No imports yet.</p>}
    </QueryRegion>
  );
}
