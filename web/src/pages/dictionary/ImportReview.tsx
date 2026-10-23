// Upload and review: the person ticks the texts to import (in the browser); nothing is written until an
// approve button, which first re-reads exactly that selection from the server and checks it is what was shown.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { request, write, errorMessage } from '@/api';
import { gameURL } from '@/lib/games';
import { number } from '@/lib/format';
import type { Game, ImportChange, ImportEntry, ImportOptions, ImportPreview, ImportPrepared, ImportResult } from '@/lib/types';
import { useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { IMPORT_REASONS, allChanges, defaultSelection, flagText, importField, previewDrifted, textKey } from './importModel';

type Busy = '' | 'selected' | 'all';
type UploadedFile = ImportPrepared['file'];

/** The body of every dry run and apply: the file, the rules in force, and the texts left out. */
const bodyOf = (file: UploadedFile, options: ImportOptions | null, extra: Record<string, unknown>) => ({ file, ...(options ? { options } : {}), exclude: [], ...extra });

export function ImportReview({ game, onApplied }: { game: Game; onApplied: () => void }): ReactElement {
  const url = `${gameURL(game)}/dictionary`;
  const { toast } = useNotify();
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [override, setOverride] = useState<ImportOptions | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<Busy>('');
  const [revision, setRevision] = useState(0);

  // One dry run: the server's review of the file under the rules in force.
  const dryRun = async (file: UploadedFile, rules: ImportOptions | null) => {
    const result = await request<ImportPreview>(`${url}/import`, { method: 'POST', body: JSON.stringify(bodyOf(file, rules, {})) });
    setPreview(result);
    setOverride(rules ?? result.options);
    setSelected(defaultSelection(result));
    setRevision((n) => n + 1);
  };

  const onFile = async (file: File) => {
    setError('');
    try {
      const parsed = JSON.parse(await file.text()) as UploadedFile;
      setUploaded(parsed); setOverride(null);
      await dryRun(parsed, null);
    } catch (problem) {
      setUploaded(null); setPreview(null);
      setError(problem instanceof SyntaxError ? 'That file is not valid JSON. Ask the agent to fix it, or re-run it.' : errorMessage(problem));
    }
  };

  const rules = async (patch: Partial<ImportOptions>) => {
    if (!preview || !uploaded) return;
    const next = { ...(override ?? preview.options), ...patch };
    setError('');
    try { await dryRun(uploaded, next); } catch (problem) { setError(errorMessage(problem)); }
  };

  const toggle = (keys: string[], on: boolean) => setSelected((current) => {
    const next = new Set(current);
    keys.forEach((key) => (on ? next.add(key) : next.delete(key)));
    return next;
  });

  // Re-reads exactly the chosen texts from the server, checks they are what was shown, then applies.
  const approve = async (keys: Set<string>, which: Exclude<Busy, ''>) => {
    if (!preview || !uploaded) return;
    setError(''); setBusy(which);
    try {
      const shown = allChanges(preview);
      const left = shown.filter((change) => !keys.has(textKey(change))).map(textKey);
      const check = await request<ImportPreview>(`${url}/import`, { method: 'POST', body: JSON.stringify(bodyOf(uploaded, override, { exclude: left })) });
      if (previewDrifted(shown, check.changes ?? [], keys)) {
        await dryRun(uploaded, override);
        setError('The dictionary changed while you were reviewing, so nothing was saved. The review is up to date; check it and approve again.');
        return;
      }
      if (check.blocked) { setError(check.blocked); return; }
      const result = await write<ImportResult>(`${url}/import`, { method: 'POST', body: JSON.stringify(bodyOf(uploaded, override, { exclude: left, preview: check.preview })) });
      const count = result.summary.fields_changed;
      toast(`Imported ${count} text${count === 1 ? '' : 's'}${override?.status === 'confirmed' ? '.' : '. They are drafts until someone confirms them.'}`);
      setPreview(null); setUploaded(null); setSelected(new Set());
      onApplied();
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(''); }
  };

  return (
    <>
      <div className="field">
        <label htmlFor="import-file">Filled <code>avn-events.json</code></label>
        <input id="import-file" type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); }} />
      </div>
      <div className="error" role="alert" id="import-error">{error}</div>
      <div id="import-review">
        {preview ? (
          <Review
            key={revision} preview={preview} options={override ?? preview.options} selected={selected}
            busy={busy} onRules={(patch) => void rules(patch)} onToggle={toggle}
            onApprove={(keys, which) => void approve(keys, which)}
          />
        ) : null}
      </div>
    </>
  );
}

/** A checkbox that can show the in-between state (some of its texts ticked). */
function Tick({ checked, indeterminate, label, onChange }: { checked: boolean; indeterminate?: boolean; label: string; onChange: (on: boolean) => void }): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = Boolean(indeterminate); }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} aria-label={label} onChange={(event) => onChange(event.target.checked)} />;
}

function Review({ preview, options, selected, busy, onRules, onToggle, onApprove }: {
  preview: ImportPreview; options: ImportOptions; selected: Set<string>; busy: Busy;
  onRules: (patch: Partial<ImportOptions>) => void; onToggle: (keys: string[], on: boolean) => void;
  onApprove: (keys: Set<string>, which: Exclude<Busy, ''>) => void;
}): ReactElement {
  const changes = allChanges(preview);
  const total = changes.length;
  const rows = preview.events.filter((entry) => entry.changes.length || entry.rejected.length || entry.flags.length || entry.status === 'out_of_scope' || entry.skipped.some((item) => item.reason !== 'no_proposal'));
  const why = (entry: ImportEntry): string[] => [...entry.skipped, ...entry.rejected].map((item) => `${item.field === '*' ? '' : `${importField(item.field)}: `}${IMPORT_REASONS[item.reason] || item.reason}`);
  const extra = [preview.summary.skipped ? `${number(preview.summary.skipped)} events left out by the rules` : '', preview.summary.flags ? `${number(preview.summary.flags)} to look at` : ''].filter(Boolean).join(' · ');
  const names = (count: number, word: string) => `${number(count)} ${word}${count === 1 ? '' : 's'}`;
  const allKeys = new Set(changes.map(textKey));
  const pickedAll = total > 0 && selected.size === total;
  const someOf = selected.size > 0 && selected.size < total;

  const changeRow = (change: ImportChange) => {
    const key = textKey(change);
    return (
      <li key={key}>
        <label className="import-text">
          <input type="checkbox" checked={selected.has(key)} onChange={(event) => onToggle([key], event.target.checked)} aria-label={`Import ${importField(change.field)} of ${change.name}`} />
          <span>
            <span className="small muted">{importField(change.field)}</span> {change.before ? <><del>{change.before}</del> → </> : null}<ins>{change.after}</ins>
            {change.kind === 'fill' ? null : <> <span className={`pill ${change.kind === 'overwrite_draft' ? '' : 'bad'}`}>{change.kind === 'overwrite_draft' ? 'replaces a draft' : 'replaces text'}</span></>}
          </span>
        </label>
      </li>
    );
  };

  const reasonCells = (entry: ImportEntry): ReactNode[] => {
    const cells: ReactNode[] = [
      ...why(entry).map((text, i) => <span key={`w${i}`} className="muted">{text}</span>),
      ...entry.flags.map((flag, i) => <span key={`f${i}`} className="pill bad">{flagText(flag)}</span>),
    ];
    return cells.flatMap((cell, i) => (i ? [<br key={`b${i}`} />, cell] : [cell]));
  };

  return (
    <section className="import-review">
      <div className="import-rules">
        <span className="small muted">Rules in this file</span>{' '}
        <select name="o-mode" value={options.mode} onChange={(event) => onRules({ mode: event.target.value })}>
          <option value="fill_blanks">Only fill blanks</option><option value="overwrite_ai_drafts">Replace AI drafts too</option><option value="overwrite_all">Replace existing text</option>
        </select>{' '}
        <select name="o-status" value={options.status} onChange={(event) => onRules({ status: event.target.value })}>
          <option value="draft">Land as drafts</option><option value="confirmed">Land as confirmed</option>
        </select>{' '}
        <label className="inline-field">Max replaced <input name="o-max" type="number" min={0} defaultValue={options.max_overwrites} onBlur={(event) => onRules({ max_overwrites: Math.max(0, Number(event.target.value) || 0) })} /></label>
      </div>
      {preview.blocked ? <p className="event-warning"><Ico name="pulse" size={15} /><span>{preview.blocked}</span></p> : null}
      {preview.unresolved.length ? (
        <details><summary>{names(preview.unresolved.length, 'name')} the agent could not resolve</summary>
          <ul className="import-list">{preview.unresolved.map((item, i) => <li key={i}><code>{item.source}</code> {item.note}</li>)}</ul>
        </details>
      ) : null}
      {preview.not_found_in_code.length ? (
        <details><summary>{names(preview.not_found_in_code.length, 'event')} not found in the code</summary>
          <p className="small">{preview.not_found_in_code.map((name, i) => <span key={name}>{i ? ' ' : ''}<code>{name}</code></span>)}</p>
        </details>
      ) : null}
      {total ? (
        <div className="import-approve">
          <label className="check-row">
            <Tick checked={pickedAll} indeterminate={someOf} label="Select all" onChange={(on) => onToggle([...allKeys], on)} /> Select all
          </label>
          <span className="import-count" aria-live="polite">{number(selected.size)} of {number(total)} texts selected</span>
          <span className="spacer" />
          <button type="button" className="button" data-import-selected disabled={busy !== '' || selected.size === 0 || selected.size === total} onClick={() => onApprove(new Set(selected), 'selected')}>
            {busy === 'selected' ? 'Importing…' : `Approve selected${selected.size && selected.size < total ? ` ${number(selected.size)}` : ''}`}
          </button>
          <button type="button" className="button primary" disabled={busy !== '' || Boolean(preview.blocked)} onClick={() => onApprove(allKeys, 'all')}>
            {busy === 'all' ? 'Importing…' : `Approve all ${number(total)}`}
          </button>
        </div>
      ) : null}
      {extra ? <p className="help">{extra}</p> : null}
      {total ? (
        <div className="table-wrap"><table className="compact-table import-table">
          <thead><tr><th>Event</th><th>Text the agent wrote</th><th>Notes</th></tr></thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.name}>
                <td>
                  {entry.changes.length ? (
                    <label className="import-text">
                      <Tick checked={entry.changes.every((c) => selected.has(textKey(c)))} indeterminate={entry.changes.some((c) => selected.has(textKey(c))) && !entry.changes.every((c) => selected.has(textKey(c)))} label={`Import all texts of ${entry.name}`} onChange={(on) => onToggle(entry.changes.map(textKey), on)} />
                      <code>{entry.name}</code>
                    </label>
                  ) : <code>{entry.name}</code>}
                  {entry.origin === 'code' ? <> <span className="pill" title="Not received yet; found in the code">new</span></> : null}
                </td>
                <td>{entry.changes.length ? <ul className="import-list">{entry.changes.map(changeRow)}</ul> : <span className="muted small">—</span>}</td>
                <td className="small">{reasonCells(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <p className="help">Nothing in this file would change the dictionary.</p>}
    </section>
  );
}
