// The highlight setup above a player's timeline (the old "Highlight rules" disclosure and the saved-rules
// library): quick adds, one editor per rule, and the game's saved rules (insights/highlights, shared with the
// team). Active selections stay in this browser; saving a rule is the only thing that reaches the server.
import { useState, type ReactElement } from 'react';
import { errorMessage, useRead, write } from '@/api';
import { HighlightEditor } from '@/components/ConditionEditor';
import { useNotify } from '@/components/feedback';
import { conditionError, describeHighlight, HIGHLIGHT_COLORS } from '@/lib/conditions';
import { number } from '@/lib/format';
import { gameURL } from '@/lib/games';
import type { TimelineHighlight } from '@/lib/player-events';
import type { Game, SavedHighlight } from '@/lib/types';
import { Disclosure, type Disclosures } from './Disclosure';
import { type Catalog, highlightName, HIGHLIGHT_PRESETS, MAX_HIGHLIGHTS, newHighlight, presetHighlight } from './timeline';

export type HighlightSetupProps = {
  game: Game;
  rules: TimelineHighlight[];
  catalog: Catalog;
  /** Matches per rule in the timeline as it is shown (0 for an invalid rule). */
  counts: number[];
  complete: boolean;
  /** The rule added last, which opens for editing; the others stay as remembered. */
  freshRule: number;
  disclosures: Disclosures;
  hidden: boolean;
  /** Replace the rules (the timeline persists them); `fresh` marks the rule to open. */
  commit: (next: TimelineHighlight[], fresh?: number) => void;
};

export function HighlightSetup({ game, rules, catalog, counts, complete, freshRule, disclosures, hidden, commit }: HighlightSetupProps): ReactElement {
  const { toast, toastError } = useNotify();
  const base = `${gameURL(game)}/insights/highlights`;
  const [loaded, setLoaded] = useState(false);
  const saved = useRead<SavedHighlight[]>(base, { enabled: loaded });
  const list = saved.data ?? [];
  const [selected, setSelected] = useState('');
  const selectedId = list.some((item) => item.id === selected) ? selected : '';
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const patch = (index: number, change: Partial<TimelineHighlight>) => commit(rules.map((rule, position) => (position === index ? { ...rule, ...change } : rule)));
  const add = () => {
    if (rules.length >= MAX_HIGHLIGHTS) return;
    commit([...rules, newHighlight(rules.length, catalog.events[0]?.name)], rules.length);
    disclosures.set('highlight-setup', true);
  };
  const addPreset = (preset: (typeof HIGHLIGHT_PRESETS)[number]) => {
    if (rules.some((rule) => rule.label === preset[1])) { toast(`You already have a ${preset[1]} highlight.`); return; }
    if (rules.length >= MAX_HIGHLIGHTS) { toast('Use at most 20 highlights.'); return; }
    commit([...rules, presetHighlight(preset, catalog.events.map((event) => event.name))]);
  };

  const browse = () => { if (loaded) void saved.refetch(); else setLoaded(true); setMessage(''); };
  const save = async (index: number, asCopy: boolean) => {
    if (busy) { toast('Wait for the current saved-rule request to finish.'); return; }
    const rule = rules[index]!;
    const problem = conditionError(rule.conditions);
    if (problem || !rule.label.trim()) { toast(problem || 'Give this highlight a name first.'); return; }
    setBusy(true); setMessage('Saving rule…');
    try {
      const id = asCopy ? null : rule.savedId;
      const result = await write<SavedHighlight>(id ? `${base}/${id}` : base, { method: id ? 'PUT' : 'POST', body: JSON.stringify({ name: rule.label.trim(), color: rule.color, conditions: rule.conditions }) });
      commit(rules.map((item, position) => (position === index ? { ...item, savedId: result.id } : item)));
      setSelected(result.id);
      setMessage(`Saved “${result.name}”.`);
      toast(`Saved “${result.name}”.`);
    } catch (error) { setMessage(errorMessage(error)); toastError(error); }
    finally { setBusy(false); }
  };
  const useSaved = () => {
    const item = list.find((entry) => entry.id === selectedId);
    if (!item) return;
    const existing = rules.findIndex((rule) => rule.savedId === item.id);
    if (existing >= 0) { commit(rules.map((rule, position) => (position === existing ? { ...rule, enabled: true } : rule)), existing); return; }
    if (rules.length >= MAX_HIGHLIGHTS) { toast('Use at most 20 highlights.'); return; }
    commit([...rules, { label: item.name, color: item.color, enabled: true, savedId: item.id, conditions: structuredClone(item.conditions) }], rules.length);
  };
  const remove = async () => {
    if (busy) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy(true); setMessage('');
    try {
      await write(`${base}/${selectedId}`, { method: 'DELETE' });
      setConfirmDelete(false); setSelected('');
      setMessage('Saved rule deleted. Active highlights are unchanged.');
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };

  const status = message || (saved.isError ? errorMessage(saved.error) : '');
  return (
    <>
      <div className="highlight-actions panel-body" hidden={hidden}>
        <div className="highlight-add-row">
          <button type="button" className="button small-button" id="highlight-add" disabled={rules.length >= MAX_HIGHLIGHTS} onClick={add}>+ Highlight</button>
          <span className="small muted">Quick:</span>
          {HIGHLIGHT_PRESETS.map((preset) => <button key={preset[0]} type="button" className="button small-button" onClick={() => addPreset(preset)}>+ {preset[1]}</button>)}
        </div>
      </div>
      <Disclosure name="highlight-setup" disclosures={disclosures} className="panel-body highlight-setup" hidden={hidden} summary={<>Highlight rules <span className="small muted">{number(rules.length)} highlights</span></>}>
        <div className="highlight-setup-body">
          <p className="help">1. Choose an event. 2. Add parameters if you want a specific type or action. 3. Save the rule to reuse it. For example: AD_ANALYSIS with AD_TYPE = interstitial and STAGE = shown. Use the parameter names and values your game actually sends.</p>
          <div className="highlight-library">
            <div className="highlight-library-head"><strong>Saved rules</strong><button type="button" className="button small-button" disabled={busy} onClick={browse}>{busy ? 'Working…' : loaded ? 'Refresh saved rules' : 'Browse saved rules'}</button></div>
            <p className="help">Save a named rule below, then reuse it for any player. Saved rules belong to this game and are shared with its team. Your active selections stay in this browser.</p>
            {loaded ? (
              <>
                <div className="highlight-library-controls">
                  <label>Choose a saved rule<select value={selectedId} disabled={busy} onChange={(event) => { setSelected(event.target.value); setConfirmDelete(false); }}><option value="">Choose a rule…</option>{list.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                  <button type="button" className="button small-button" disabled={busy || !selectedId} onClick={useSaved}>Use rule</button>
                  <button type="button" className="button small-button" disabled={busy || !selectedId} onClick={() => void remove()}>{confirmDelete ? 'Confirm delete saved rule' : 'Delete saved rule'}</button>
                </div>
                {!list.length ? <p className="help">No saved rules yet. Create a highlight and choose Save rule.</p> : null}
              </>
            ) : null}
            <p className="small muted" role="status">{status}</p>
          </div>
          <div id="highlight-rules">
            {rules.map((rule, index) => {
              const problem = conditionError(rule.conditions);
              const count = counts[index] ?? 0;
              return (
                <Disclosure key={index} name={`highlight-${index}`} disclosures={disclosures} defaultOpen={index === freshRule} className={`highlight-rule highlight-${rule.color}`} summary={<><span className="highlight-dot" aria-hidden="true" /> {highlightName(rule, index)} <span className="small muted">{`${rule.enabled === false ? 'Off · ' : ''}${number(count)} matches${complete ? '' : ' so far'}`}</span></>}>
                  <div className="highlight-settings">
                    <label>Name<input value={rule.label} maxLength={80} onChange={(event) => patch(index, { label: event.target.value })} /></label>
                    <label>Color<select value={rule.color} onChange={(event) => patch(index, { color: event.target.value })}>{HIGHLIGHT_COLORS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
                    <label className="check-row"><input type="checkbox" checked={rule.enabled !== false} onChange={(event) => patch(index, { enabled: event.target.checked })} /> Enabled</label>
                    <button type="button" className="button small-button" onClick={() => void save(index, false)}>{rule.savedId ? 'Update saved rule' : 'Save rule'}</button>
                    {rule.savedId ? <button type="button" className="button small-button" onClick={() => void save(index, true)}>Save as new rule</button> : null}
                    <button type="button" className="button small-button" onClick={() => commit(rules.filter((_, position) => position !== index))}>Remove from timeline</button>
                  </div>
                  <p className="highlight-rule-preview help">Highlights when {describeHighlight(rule.conditions)}.</p>
                  <HighlightEditor tree={rule.conditions} catalog={catalog} onChange={(tree) => patch(index, { conditions: tree })} />
                  {problem ? <p className="error" role="alert">{problem}</p> : null}
                </Disclosure>
              );
            })}
          </div>
        </div>
      </Disclosure>
    </>
  );
}
