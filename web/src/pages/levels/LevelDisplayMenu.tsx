// The "Display" menu of the level table: columns, heat cell or bar, when player counts show, and the flag
// thresholds. It is the Filters menu's parts (Popover, option rows, Segmented), not a menu of its own.
import { useRef, useState, type ReactElement } from 'react';
import { Popover, Segmented } from '@avn/ui';
import { Ico } from '@/components/icons';
import { OptionList } from '@/components/OptionList';
import { DEFAULT_DISPLAY, FLAG_RANGE, LEVEL_COLUMNS, type CountsShown, type DropStyle, type LevelColumn, type LevelDisplay } from './levelDisplay';

function Flag({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }): ReactElement {
  return (
    <label className="display-flag">
      <span className="display-flag-head"><span>{label}</span><b>{value}%</b></span>
      <input type="range" min={min} max={max} value={value} aria-label={`Flag ${label.toLowerCase()} above`} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function LevelDisplayMenu({ display, onChange }: { display: LevelDisplay; onChange: (next: LevelDisplay) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const chosen = LEVEL_COLUMNS.filter(({ key }) => display.columns[key]).map(({ key }) => key);
  const changed = JSON.stringify(display) !== JSON.stringify(DEFAULT_DISPLAY);
  return (
    <>
      <button ref={button} type="button" className="btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Ico name="sliders" size={14} /> Display {changed ? <span className="count" aria-label="changed from the defaults">•</span> : null}
      </button>
      <Popover position="fixed" open={open} onClose={() => setOpen(false)} anchor={button} width={320} className="display-pop">
        <div className="pop-scroll display-menu">
          <div className="pop-grp"><span className="eyebrow">Columns</span></div>
          <div className="opt locked"><input type="checkbox" className="cb-in" checked disabled aria-label="Level is always shown" /><span className="ot">Level</span><span className="oc">always</span></div>
          <OptionList rows={LEVEL_COLUMNS.length} options={LEVEL_COLUMNS.map(({ key, label, note }) => ({ value: key, label, count: note }))} selected={chosen}
            onChange={(values) => onChange({ ...display, columns: Object.fromEntries(LEVEL_COLUMNS.map(({ key }) => [key, values.includes(key)])) as Record<LevelColumn, boolean> })} />
          <div className="pop-grp"><span className="eyebrow">Drop and quit as</span></div>
          <Segmented<DropStyle> label="Drop and quit style" value={display.style} onChange={(style) => onChange({ ...display, style })} options={[{ value: 'cell', label: 'Heat cell' }, { value: 'bar', label: 'Bar' }]} />
          <div className="pop-grp"><span className="eyebrow">Player counts</span></div>
          <Segmented<CountsShown> label="When player counts show" value={display.counts} onChange={(counts) => onChange({ ...display, counts })} options={[{ value: 'flag', label: 'Flagged' }, { value: 'hover', label: 'On hover' }, { value: 'always', label: 'Always' }]} />
          <div className="pop-grp"><span className="eyebrow">Flag above</span></div>
          <Flag label="Drop to next level" value={display.dropFlag} min={FLAG_RANGE.drop.min} max={FLAG_RANGE.drop.max} onChange={(dropFlag) => onChange({ ...display, dropFlag })} />
          {display.columns.failquit ? <Flag label="Failed → quit" value={display.quitFlag} min={FLAG_RANGE.quit.min} max={FLAG_RANGE.quit.max} onChange={(quitFlag) => onChange({ ...display, quitFlag })} /> : null}
        </div>
        <div className="pop-foot">
          <button type="button" className="filter-clear" disabled={!changed} onClick={() => onChange(DEFAULT_DISPLAY)}>Reset</button>
          <button type="button" className="btn primary" onClick={() => setOpen(false)}>Done</button>
        </div>
      </Popover>
    </>
  );
}
