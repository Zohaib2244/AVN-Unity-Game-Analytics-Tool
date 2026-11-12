// The Players page's groups: saved groups down the side (shared with the team, per game), and the chip
// bar above the list where a group is built. Each chip opens a small editor; every chip must hold.
import { useRef, useState, type ReactElement } from 'react';
import { Popover, Segmented } from '@avn/ui';
import { useRead, write } from '@/api';
import { useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { OptionList } from '@/components/OptionList';
import { number } from '@/lib/format';
import { gameURL } from '@/lib/games';
import type { Catalog, Game } from '@/lib/types';
import { MENU, RANGE_KINDS, VALUE_KINDS, blankChip, chipReady, chipWords, groupSummary, type Chip, type ChipKind } from './chips';

export type SavedChipGroup = { id: string; name: string; kind: 'players'; definition: { chips: Chip[] }; updated_at: string };
type ChipOptions = Record<'campaign' | 'media_source' | 'ad_format' | 'ad_network' | 'ad_creative', Array<{ value: string; players: number }>>;

export const libraryPath = (game: Pick<Game, 'id'>): string => `${gameURL(game)}/insights/group-library`;

/** The side list: everyone, then each saved group with what it means. */
export function GroupsPanel({ items, selected, unsaved, onSelect, total, onNew }: { items: SavedChipGroup[] | undefined; selected: string | null; unsaved: Chip[]; onSelect: (item: SavedChipGroup | null) => void; total: number | null; onNew: () => void }): ReactElement {
  const everyone = selected == null && !unsaved.length;
  return (
    <aside className="panel groups-side" aria-label="Player groups">
      <div className="panel-header"><h2>Groups</h2><button type="button" className="btn sm" onClick={onNew}><Ico name="plus" size={13} /> New</button></div>
      <button type="button" className={`grp-item${everyone ? ' on' : ''}`} aria-pressed={everyone} onClick={() => onSelect(null)}>
        <span className="grp-name">All players</span>{everyone && total != null ? <span className="grp-n">{number(total)}</span> : null}
      </button>
      {selected == null && unsaved.length ? (
        <div className="grp-item on" aria-current="true"><span className="grp-name">Unsaved group</span>{total != null ? <span className="grp-n">{number(total)}</span> : null}<small>{groupSummary(unsaved)}</small></div>
      ) : null}
      {(items ?? []).map((item) => (
        <button key={item.id} type="button" className={`grp-item${selected === item.id ? ' on' : ''}`} aria-pressed={selected === item.id} onClick={() => onSelect(item)}>
          <span className="grp-name">{item.name}</span>{selected === item.id && total != null ? <span className="grp-n">{number(total)}</span> : null}
          <small>{groupSummary(item.definition.chips)}</small>
        </button>
      ))}
      {items && !items.length ? <p className="small muted grp-empty">No saved groups yet. Add conditions above the list, then Save group.</p> : null}
      <p className="foot-note">Saved groups are shared with everyone who can open this game.</p>
    </aside>
  );
}

/** The bar above the list: the group's name (once saved), its chips, Add, the count and Save. */
export function GroupBar({ game, chips, onChips, saved, catalog, total, onSaved, onDeleted }: {
  game: Game; chips: Chip[]; onChips: (next: Chip[]) => void; saved: SavedChipGroup | null; catalog: Catalog;
  total: number | null; onSaved: (item: SavedChipGroup) => void; onDeleted: () => void;
}): ReactElement {
  const { toast, toastError } = useNotify();
  const options = useRead<ChipOptions>(`${gameURL(game)}/insights/player-chip-options`);
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(saved?.name ?? '');
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const changed = saved ? JSON.stringify(saved.definition.chips) !== JSON.stringify(chips) || name.trim() !== saved.name : chips.length > 0;
  const ready = chips.filter(chipReady);

  const add = (kind: ChipKind, never?: boolean) => {
    setAdding(false);
    onChips([...chips, blankChip(kind, never)]);
    anchor.current = addButton.current;
    setEditing(chips.length);
  };
  const close = () => {
    // A chip left empty when its editor closes is removed: it would mean nothing.
    if (editing != null && chips[editing] && !chipReady(chips[editing]!)) onChips(chips.filter((_, index) => index !== editing));
    setEditing(null);
  };
  const save = async () => {
    const title = name.trim() || window.prompt('Name this group')?.trim() || '';
    if (!title) return;
    setBusy(true);
    try {
      const body = JSON.stringify({ name: title, kind: 'players', definition: { chips: ready } });
      const item = await write<SavedChipGroup>(`${libraryPath(game)}${saved ? `/${saved.id}` : ''}`, { method: saved ? 'PUT' : 'POST', body });
      setName(item.name);
      toast(saved ? `Group “${item.name}” saved.` : `Group “${item.name}” saved for everyone on this game.`);
      onSaved(item);
    } catch (error) { toastError(error); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!saved) return;
    try {
      await write(`${libraryPath(game)}/${saved.id}`, { method: 'DELETE' });
      onDeleted();
      toast(`Group “${saved.name}” deleted.`, { label: 'Undo', run: () => { void write<SavedChipGroup>(`${libraryPath(game)}/${saved.id}/restore`, { method: 'POST' }).then(onSaved).catch(toastError); } });
    } catch (error) { toastError(error); }
  };

  return (
    <div className="panel grp-bar">
      <div className="grp-line">
        {saved || chips.length ? <input className="grp-title" aria-label="Group name" placeholder="Name this group" value={name} onChange={(event) => setName(event.target.value)} /> : <span className="grp-lead">Players who</span>}
        {chips.map((chip, index) => {
          const [verb, value] = chipWords(chip);
          return (
            <span key={index} className={`gchip${editing === index ? ' on' : ''}${chipReady(chip) ? '' : ' empty'}`}>
              <button type="button" className="gchip-open" onClick={(event) => { anchor.current = event.currentTarget; setEditing(index); }}><b>{verb}</b> {value}</button>
              <button type="button" className="gchip-x" aria-label={`Remove “${verb} ${value}”`} onClick={() => onChips(chips.filter((_, at) => at !== index))}><Ico name="close" size={11} /></button>
            </span>
          );
        })}
        <button ref={addButton} type="button" className="btn sm add" aria-haspopup="dialog" aria-expanded={adding} onClick={() => setAdding((open) => !open)}><Ico name="plus" size={13} /> Add</button>
        <span className="grp-count">{total != null ? <><b>{number(total)}</b> {total === 1 ? 'player' : 'players'}</> : null}</span>
      </div>
      {chips.length || saved ? (
        <div className="grp-actions">
          {chips.length ? <button type="button" className="btn sm ghost" onClick={() => onChips(saved ? saved.definition.chips : [])}>{saved ? 'Discard changes' : 'Clear'}</button> : null}
          {saved ? <button type="button" className="btn sm ghost danger-text" onClick={() => void remove()}>Delete group</button> : null}
          <button type="button" className="btn sm primary" disabled={busy || !ready.length || !changed} onClick={() => void save()}>{saved ? 'Save group' : 'Save as group'}</button>
        </div>
      ) : null}
      <Popover position="fixed" open={adding} onClose={() => setAdding(false)} anchor={addButton} width={320} className="chip-menu-pop">
        <div className="pop-scroll chip-menu">
          {MENU.map((group) => (
            <div key={group.heading} className="chip-menu-group">
              <span className="eyebrow">{group.heading}</span>
              <div>{group.items.map((item) => <button key={`${item.kind}-${item.label}`} type="button" onClick={() => add(item.kind, item.never)}>{item.label}</button>)}</div>
            </div>
          ))}
        </div>
      </Popover>
      <Popover position="fixed" open={editing != null && !!chips[editing]} onClose={close} anchor={anchor as React.RefObject<HTMLElement>} width={320} className="chip-edit-pop">
        {editing != null && chips[editing] ? <ChipEditor key={editing} chip={chips[editing]!} options={options.data} catalog={catalog} onChange={(next) => onChips(chips.map((item, index) => (index === editing ? next : item)))} onDone={close} /> : null}
      </Popover>
    </div>
  );
}

const TITLES: Record<ChipKind, string> = {
  campaign: 'Came from these campaigns', media_source: 'Came through these media sources', install_type: 'How they installed', installed: 'Installed between',
  ad_format: 'Saw an ad of this format', ad_network: 'Saw an ad from this network', ad_creative: 'Saw this creative', ad_failed: 'Had an ad fail', earned: 'Earned from ads',
  paid_back: 'Paid back their cost', cost: 'Cost to acquire', highest_level: 'Highest level reached', stopped_on: 'Stopped on level',
  days_active: 'Days they played on', sessions: 'Sessions played', last_seen: 'Last seen', event: 'Did an event',
};
const NOTES: Partial<Record<ChipKind, string>> = {
  earned: 'Ad revenue over everything they ever did, banners included.',
  paid_back: 'Their ad revenue against what their campaign paid per install on their install day. Organic players have no cost.',
  cost: 'Their campaign’s cost per install on their install day.',
  stopped_on: 'The highest level they ever started.',
  ad_failed: 'Leave every format unticked for any format.',
};

function NumberField({ label, value, unit, onChange }: { label: string; value: number | null | undefined; unit: string; onChange: (value: number | null) => void }): ReactElement {
  return (
    <label className="chip-num">{label}{unit === '$' ? <span>$</span> : null}<input type="number" min={0} step="any" value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />{unit === '%' ? <span>%</span> : null}</label>
  );
}

function ChipEditor({ chip, options, catalog, onChange, onDone }: { chip: Chip; options: ChipOptions | undefined; catalog: Catalog; onChange: (next: Chip) => void; onDone: () => void }): ReactElement {
  const source = VALUE_KINDS[chip.kind] ?? (chip.kind === 'ad_failed' ? 'ad_format' : undefined);
  const unit = RANGE_KINDS[chip.kind];
  const [mode, setMode] = useState<'min' | 'max' | 'between'>(chip.min != null && chip.max != null ? 'between' : chip.max != null ? 'max' : 'min');
  const event = catalog.events.find((item) => item.name === chip.event);
  return (
    <>
      <div className="pop-scroll chip-editor">
        <h3>{chip.kind === 'event' && chip.never ? 'Never did an event' : TITLES[chip.kind]}</h3>
        {source ? (
          options ? <OptionList options={(options[source] ?? []).map((item) => ({ value: item.value, label: item.value, count: number(item.players) }))} selected={chip.values ?? []} searchLabel="Search" rows={7} empty="None sent yet" onChange={(values) => onChange({ ...chip, values })} /> : <p className="small muted">Reading what this game sends…</p>
        ) : null}
        {chip.kind === 'install_type' ? <Segmented<'paid' | 'organic' | 'none'> label="Install type" value={chip.value ?? 'paid'} onChange={(value) => onChange({ ...chip, value })} options={[{ value: 'paid', label: 'Paid' }, { value: 'organic', label: 'Organic' }, { value: 'none', label: 'No record' }]} /> : null}
        {chip.kind === 'installed' ? <div className="chip-dates"><label>From<input type="date" value={chip.from ?? ''} onChange={(e) => onChange({ ...chip, from: e.target.value })} /></label><label>To<input type="date" value={chip.to ?? ''} onChange={(e) => onChange({ ...chip, to: e.target.value })} /></label></div> : null}
        {unit != null ? (
          <>
            <Segmented<'min' | 'max' | 'between'> label="Compare" value={mode} onChange={(next) => { setMode(next); onChange({ ...chip, min: next === 'max' ? null : chip.min ?? chip.max ?? 0, max: next === 'min' ? null : chip.max ?? chip.min ?? 0 }); }} options={[{ value: 'min', label: 'at least' }, { value: 'max', label: 'at most' }, { value: 'between', label: 'between' }]} />
            <div className="chip-range">
              {mode !== 'max' ? <NumberField label={mode === 'between' ? 'from' : ''} value={chip.min} unit={unit} onChange={(min) => onChange({ ...chip, min })} /> : null}
              {mode !== 'min' ? <NumberField label={mode === 'between' ? 'to' : ''} value={chip.max} unit={unit} onChange={(max) => onChange({ ...chip, max })} /> : null}
            </div>
          </>
        ) : null}
        {chip.kind === 'stopped_on' ? <NumberField label="Level" value={chip.level} unit="" onChange={(level) => onChange({ ...chip, level: level ?? undefined })} /> : null}
        {chip.kind === 'last_seen' ? (
          <>
            <Segmented<'within' | 'beyond'> label="Last seen" value={chip.more_than_days != null ? 'beyond' : 'within'} onChange={(next) => onChange({ ...chip, within_days: next === 'within' ? chip.more_than_days ?? 7 : null, more_than_days: next === 'beyond' ? chip.within_days ?? 7 : null })} options={[{ value: 'within', label: 'Seen in the last' }, { value: 'beyond', label: 'Not seen for' }]} />
            <NumberField label="Days" value={chip.more_than_days ?? chip.within_days} unit="" onChange={(days) => onChange(chip.more_than_days != null ? { ...chip, more_than_days: days } : { ...chip, within_days: days })} />
          </>
        ) : null}
        {chip.kind === 'event' ? (
          <div className="chip-event">
            <label>Event<select value={chip.event ?? ''} onChange={(e) => onChange({ ...chip, event: e.target.value, param: '', values: [] })}><option value="">Choose…</option>{catalog.events.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
            {event?.params.length ? <label>Parameter (optional)<select value={chip.param ?? ''} onChange={(e) => onChange({ ...chip, param: e.target.value, values: [] })}><option value="">Any</option>{event.params.map((item) => <option key={item.key} value={item.key}>{item.key}</option>)}</select></label> : null}
            {chip.param ? <label>Equal to (comma between values)<input value={(chip.values ?? []).join(', ')} onChange={(e) => onChange({ ...chip, values: e.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label> : null}
            <label className="check-row"><input type="checkbox" checked={!!chip.never} onChange={(e) => onChange({ ...chip, never: e.target.checked })} /> Never did it</label>
          </div>
        ) : null}
        {NOTES[chip.kind] ? <p className="small muted">{NOTES[chip.kind]}</p> : null}
      </div>
      <div className="pop-foot"><span className="small muted">{chipReady(chip) ? '' : 'Pick something to keep this condition.'}</span><button type="button" className="btn primary" onClick={onDone}>Done</button></div>
    </>
  );
}
