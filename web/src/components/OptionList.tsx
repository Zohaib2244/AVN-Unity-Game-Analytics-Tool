// A searchable list of checkbox rows: the one list the Filters menu and the Levels Display menu share.
// Its height is a whole number of rows (it snaps to them), so no row is ever cut off at the top or bottom.
// A row can be "out": ticked to leave something out (struck through), as in "everything except".
import { useMemo, useState, type ReactElement } from 'react';
import { Ico } from './icons';

export type OptionItem = { value: string; label: string; count?: number | string; hint?: string; disabled?: boolean; /** A small warning tag after the label (the hint says why). */ flag?: string };

export function OptionList({ options, selected, onChange, out = false, searchLabel, rows = 6, empty = 'Nothing matches' }: {
  options: OptionItem[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** Ticks mean "leave out": struck through and in the warning colour. */
  out?: boolean;
  /** Shows a search box with this label when there is more than a screenful. */
  searchLabel?: string;
  rows?: number;
  empty?: string;
}): ReactElement {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => { const q = query.trim().toLowerCase(); return q ? options.filter((item) => item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q)) : options; }, [options, query]);
  const toggle = (value: string, on: boolean) => onChange(on ? [...selected, value] : selected.filter((item) => item !== value));
  return (
    <div className="option-list-wrap" style={{ '--rows': Math.min(rows, Math.max(shown.length, 1)) } as React.CSSProperties}>
      {searchLabel && options.length > rows ? (
        <label className="option-search"><Ico name="search" size={14} /><input type="search" value={query} placeholder={searchLabel} aria-label={searchLabel} onChange={(event) => setQuery(event.target.value)} /></label>
      ) : null}
      <div className="option-list" role="group">
        {shown.length ? shown.map((item) => {
          const on = selected.includes(item.value);
          return (
            <label key={item.value} className={`opt${out && on ? ' out' : ''}`} title={item.hint}>
              <input type="checkbox" className="cb-in" checked={on} disabled={item.disabled} onChange={(event) => toggle(item.value, event.target.checked)} />
              <span className="ot">{item.label}{item.flag ? <span className="opt-flag">{item.flag}</span> : null}</span>
              {item.count != null ? <span className="oc">{item.count}</span> : null}
            </label>
          );
        }) : <p className="option-empty">{empty}</p>}
      </div>
    </div>
  );
}
