// The highlight setup above a player's timeline: a chooser of ready-made highlights grouped by what they mark
// (levels, ads, other), then the old "Highlight rules" disclosure with one editor per rule and the game's saved
// rules (insights/highlights, shared with the team). Active selections stay in this browser; saving a rule is
// the only thing that reaches the server.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { errorMessage, useRead, write } from '@/api';
import { DialogShell, Popover } from '@avn/ui';
import { HighlightEditor } from '@/components/ConditionEditor';
import { useNotify } from '@/components/feedback';
import { conditionError, describeHighlight, HIGHLIGHT_COLORS } from '@/lib/conditions';
import { number } from '@/lib/format';
import { gameURL } from '@/lib/games';
import type { TimelineHighlight } from '@/lib/player-events';
import type { Game, JourneyEvent, SavedHighlight } from '@/lib/types';
import { Disclosure, type Disclosures } from './Disclosure';
import { Ico } from '@/components/icons';
import { type Catalog, highlightName, HIGHLIGHT_PRESETS, MAX_HIGHLIGHTS, narrowedHighlight, newHighlight, pickableParams, picksSummary, presetHighlight } from './timeline';

const GROUPS = ['Levels', 'Ads', 'Other'];
const SHOWN_VALUES = 12;
const pickedCount = (picks: Record<string, string[]> | undefined): number => Object.values(picks ?? {}).reduce((sum, list) => sum + list.length, 0);
const MOST_PICKS = 50; // what one condition group may hold

/** Narrow one ready-made highlight: tick values of any of its parameters. Nothing ticked marks them all. */
function ValuePicker({ events, base, rule, onChange }: { events: JourneyEvent[]; base: TimelineHighlight; rule: TimelineHighlight; onChange: (picks: Record<string, string[]>) => void }): ReactElement {
  const picks = useMemo(() => rule.picks ?? {}, [rule.picks]);
  const params = useMemo(() => pickableParams(events, base, picks), [events, base, picks]);
  const [wide, setWide] = useState<string[]>([]);
  if (!params.length) return <p className="hl-values help">Nothing to narrow: every {rule.label.toLowerCase()} of this player looks the same.</p>;
  const toggle = (key: string, value: string) => {
    const mine = picks[key] ?? [];
    onChange({ ...picks, [key]: mine.includes(value) ? mine.filter((item) => item !== value) : [...mine, value] });
  };
  return (
    <div className={`hl-values highlight-${rule.color}`} role="group" aria-label={`Narrow ${rule.label}`}>
      <p className="help hl-values-help">Tick the values to mark. Nothing ticked marks them all.</p>
      {params.map(({ key, values }) => {
        const mine = picks[key] ?? [];
        const open = wide.includes(key);
        const shown = open ? values : values.filter((item, index) => index < SHOWN_VALUES || mine.includes(item.value));
        return (
          <div key={key} className="hl-value-row">
            <code>{key}</code>
            <div className="hl-value-list">
              {shown.map(({ value, count }) => {
                const on = mine.includes(value);
                return <button key={value} type="button" className="hl-value" aria-pressed={on} disabled={!on && mine.length >= MOST_PICKS} onClick={() => toggle(key, value)}>{value}<span className="hl-count">{number(count)}</span></button>;
              })}
              {shown.length < values.length ? <button type="button" className="hl-value more" onClick={() => setWide([...wide, key])}>+{number(values.length - shown.length)} more</button> : null}
            </div>
          </div>
        );
      })}
      {rule.picks ? <button type="button" className="button small-button hl-values-clear" onClick={() => onChange({})}>Clear values</button> : null}
    </div>
  );
}

export type HighlightSetupProps = {
  game: Game;
  rules: TimelineHighlight[];
  catalog: Catalog;
  /** The player's events, for the values a ready-made highlight can be narrowed by. */
  events: JourneyEvent[];
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

export function HighlightSetup({ game, rules, catalog, events, counts, complete, freshRule, disclosures, hidden, commit }: HighlightSetupProps): ReactElement {
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
  // A ready-made highlight is on while a rule carries its name; picking it again takes it off.
  const offered = HIGHLIGHT_PRESETS.flatMap((preset) => { const rule = presetHighlight(preset, catalog); return rule ? [{ preset, rule }] : []; });
  const togglePreset = (preset: (typeof HIGHLIGHT_PRESETS)[number], rule: TimelineHighlight) => {
    const at = rules.findIndex((item) => item.label === preset.label);
    if (at >= 0) { commit(rules.filter((_, position) => position !== at)); return; }
    if (rules.length >= MAX_HIGHLIGHTS) { toast('Use at most 20 highlights.'); return; }
    commit([...rules, rule]);
  };

  // A ready-made highlight remembered from before it could tell ads apart still marks every ad.
  useEffect(() => {
    if (!complete) return;
    const updated = rules.map((item) => {
      const base = offered.find(({ preset }) => preset.label === item.label)?.rule;
      return base && !item.savedId && item.conditions.conditions.length < base.conditions.conditions.length ? { ...item, conditions: base.conditions } : item;
    });
    if (updated.some((item, position) => item !== rules[position])) commit(updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the player's events are all in
  }, [complete, catalog]);

  const [narrowing, setNarrowing] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const rulesOpen = disclosures.isOpen('highlight-setup', false);
  const narrow = (at: number, base: TimelineHighlight, picks: Record<string, string[]>) => {
    const { conditions, picks: kept } = narrowedHighlight(base, picks);
    commit(rules.map((item, position) => (position === at ? { ...item, conditions, picks: kept } : item)));
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
  if (hidden) return <></>;
  const active = rules.filter((rule) => rule.enabled !== false).length;
  return (
    <>
      <button ref={menuButton} type="button" className="button small-button hl-open" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
        <Ico name="sliders" size={14} /> Highlights{active ? <span className="small muted"> · {number(active)} on</span> : null}
      </button>
      <Popover position="fixed" open={menuOpen} onClose={() => setMenuOpen(false)} anchor={menuButton} width={420} className="hl-pop">
        <div className="pop-scroll hl-picker" role="group" aria-label="Highlights">
          <div className="hl-picker-head">
            {complete ? null : <span className="small muted">Loading the timeline…</span>}
            <button type="button" className="button small-button" id="highlight-add" disabled={rules.length >= MAX_HIGHLIGHTS} onClick={() => { add(); setMenuOpen(false); }}>+ Custom rule</button>
            <button type="button" className="button small-button" aria-pressed={rulesOpen} onClick={() => { disclosures.set('highlight-setup', !rulesOpen); setMenuOpen(false); }}>{rulesOpen ? 'Hide rules' : `Edit rules · ${number(rules.length)}`}</button>
          </div>
          {offered.length ? GROUPS.map((group) => {
            const items = offered.filter(({ preset }) => preset.group === group);
            return items.length ? (
              <div className="hl-group" key={group}>
                <span className="hl-group-name">{group}</span>
                <div className="hl-chips">
                  {items.map(({ preset, rule }) => {
                    const at = rules.findIndex((item) => item.label === preset.label);
                    const on = at >= 0;
                    const picked = on ? picksSummary(rules[at]!.picks) : '';
                    return (
                      <span key={preset.key} className="hl-chip-pair">
                        <button type="button" className={`hl-chip highlight-${preset.color}${on ? ' on' : ''}`} aria-pressed={on} onClick={() => togglePreset(preset, rule)}>
                          <span className="highlight-dot" aria-hidden="true" />{preset.label}
                          {picked ? <span className="hl-picked">{picked}</span> : null}
                          {on ? <span className="hl-count">{number(counts[at] ?? 0)}</span> : null}
                        </button>
                        {on ? <button type="button" className={`hl-values-toggle${pickedCount(rules[at]!.picks) ? ' set' : ''}`} aria-haspopup="dialog" aria-label={`Choose values for ${preset.label}${pickedCount(rules[at]!.picks) ? `, ${pickedCount(rules[at]!.picks)} chosen` : ''}`} onClick={() => { setNarrowing(preset.key); setMenuOpen(false); }}>…</button> : null}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null;
          }) : <p className="help">{complete ? 'No ready-made highlight fits this player.' : 'Loading the timeline…'}</p>}
        </div>
      </Popover>
      {offered.map(({ preset, rule }) => {
        const at = rules.findIndex((item) => item.label === preset.label);
        return narrowing === preset.key && at >= 0 ? (
          <DialogShell key={preset.key} open onOpenChange={(next) => { if (!next) setNarrowing(''); }} title={`${preset.label}: values`} className="hl-values-dialog">
            <ValuePicker events={events} base={rule} rule={rules[at]!} onChange={(picks) => narrow(at, rule, picks)} />
          </DialogShell>
        ) : null;
      })}
      {rulesOpen ? (
        <div className="highlight-setup panel-body hl-rules">
          <div className="highlight-setup-body">
          <p className="help">1. Choose an event. 2. Add parameters if you want a specific type or action. 3. Save the rule to reuse it. For example: AD_ANALYSIS with FORMAT = Interstitial and STATE = Show. Use the parameter names and values your game actually sends.</p>
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
                  <HighlightEditor tree={rule.conditions} catalog={catalog} onChange={(tree) => patch(index, { conditions: tree, picks: undefined })} />
                  {problem ? <p className="error" role="alert">{problem}</p> : null}
                </Disclosure>
              );
            })}
          </div>
        </div>
        </div>
      ) : null}
    </>
  );
}
