// The Players table's one "Columns" menu (same shape as the Levels Display menu): tick the columns to show,
// or add a column worked out from an event. Sorting is by clicking a column heading.
import { useRef, useState, type ReactElement } from 'react';
import { Popover } from '@avn/ui';
import { Ico } from '@/components/icons';
import { OptionList } from '@/components/OptionList';
import { COLUMN_CHOICES } from './rules';

export const defaultColumns = (): string[] => COLUMN_CHOICES.filter((choice) => choice.on).map((choice) => choice.key);
export const DEFAULT_COLUMNS: string[] = defaultColumns();

export function ColumnsMenu({ shown, onChange, custom, onAddCustom }: { shown: string[]; onChange: (next: string[]) => void; custom: number; onAddCustom: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const changed = JSON.stringify([...shown].sort()) !== JSON.stringify(defaultColumns().sort());
  return (
    <>
      <button ref={button} type="button" className="btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Ico name="sliders" size={14} /> Columns {changed || custom ? <span className="count" aria-label="changed from the defaults">{custom ? `+${custom}` : '•'}</span> : null}
      </button>
      <Popover position="fixed" open={open} onClose={() => setOpen(false)} anchor={button} width={320} className="display-pop">
        <div className="pop-scroll display-menu">
          <div className="opt locked"><input type="checkbox" className="cb-in" checked disabled aria-label="Player is always shown" /><span className="ot">Player</span><span className="oc">always</span></div>
          <OptionList rows={8} searchLabel="Search columns" options={COLUMN_CHOICES.map(({ key, label, note }) => ({ value: key, label, count: note }))} selected={shown}
            onChange={(values) => onChange(COLUMN_CHOICES.map((choice) => choice.key).filter((key) => values.includes(key)))} />
        </div>
        <div className="pop-foot">
          <button type="button" className="filter-clear" disabled={!changed} onClick={() => onChange(defaultColumns())}>Reset</button>
          <button type="button" className="btn" onClick={() => { setOpen(false); onAddCustom(); }}><Ico name="plus" size={13} /> Custom column{custom ? ` · ${custom}` : ''}</button>
        </div>
      </Popover>
    </>
  );
}
