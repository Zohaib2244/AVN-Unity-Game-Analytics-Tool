// Date range control: quick presets (Today, Last 7/30/90 days…) and a calendar for any From–To days.
// The compact variant is one row (preset menu, the days, ‹ › steps) for dashboards; the full variant
// shows every preset as a segment (forms, settings).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Calendar, Popover, SingleSelect } from '@avn/ui';
import { addDays, dateToDay, dayToDate, daysBetween, monthEnd, monthStart, shiftMonth, shortDay, today } from '@/lib/format';
import type { DayRange } from '@/lib/filters';
import { Ico } from './icons';

export const PRESETS: Array<[string, string, () => [string, string]]> = [
  ['today', 'Today', () => [today(), today()]],
  ['yesterday', 'Yesterday', () => [addDays(today(), -1), addDays(today(), -1)]],
  ['7', 'Last 7 days', () => [addDays(today(), -6), today()]],
  ['30', 'Last 30 days', () => [addDays(today(), -29), today()]],
  ['90', 'Last 90 days', () => [addDays(today(), -89), today()]],
  ['month', 'This month', () => [monthStart(today()), today()]],
  ['lastmonth', 'Last month', () => { const first = shiftMonth(today(), -1); return [first, monthEnd(first)]; }],
];
export const presetLabel = (preset: string | undefined): string => (preset === 'custom' || !preset ? 'Custom days' : PRESETS.find(([key]) => key === preset)?.[1] || 'Custom days');

/** The range a preset or saved range resolves to. */
export function resolveRange(initialPreset = '7', initialRange: DayRange | null = null): DayRange {
  const preset = PRESETS.find(([key]) => key === initialPreset);
  if (preset && initialPreset !== 'custom') { const [from, to] = preset[2](); return { from, to, preset: initialPreset }; }
  if (initialRange) return { from: initialRange.from, to: initialRange.to, preset: 'custom' };
  const [from, to] = PRESETS[2]![2](); return { from, to, preset: '7' };
}

export const rangeText = (range: DayRange): string => (range.from === range.to ? shortDay(range.from) : `${shortDay(range.from)} – ${shortDay(range.to)}`);

export function DateRange({ value, onChange, compact = false, label = 'Date range' }: { value: DayRange; onChange: (range: DayRange) => void; compact?: boolean; label?: string }): ReactElement {
  const [menu, setMenu] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const daysButton = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const closeCalendar = useCallback(() => setCalendar(false), []);
  useEffect(() => { if (!calendar) return; const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') e.stopPropagation(); }; document.addEventListener('keydown', onKey, true); return () => document.removeEventListener('keydown', onKey, true); }, [calendar]);

  const choose = (key: string) => {
    if (key === 'custom') { setCalendar(true); return; }
    const preset = PRESETS.find(([name]) => name === key); if (!preset) return;
    const [from, to] = preset[2](); onChange({ from, to, preset: key });
  };
  const step = (direction: number) => { const span = daysBetween(value.from, value.to) + 1; onChange({ from: addDays(value.from, direction * span), to: addDays(value.to, direction * span), preset: 'custom' }); };
  const options = useMemo(() => [
    ...PRESETS.map(([key, text, range]) => { const [from, to] = range(); return { value: key, label: text, hint: from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}` }; }),
    { value: 'custom', label: 'Custom range…' },
  ], []);
  const calendarValue = { start: dayToDate(value.from), end: dayToDate(value.to) };
  const picker = (
    <Popover open={calendar} onClose={closeCalendar} anchor={daysButton} width={300} className="range-pop">
      <Calendar value={calendarValue} onChange={(range) => { onChange({ from: dateToDay(range.start), to: dateToDay(range.end), preset: 'custom' }); }} />
      <div className="pop-foot"><span className="muted small">{rangeText(value)}</span><button type="button" className="btn sm" onClick={closeCalendar}>Done</button></div>
    </Popover>
  );
  if (compact) {
    return (
      <div className="range range-compact">
        <button ref={menuButton} type="button" className="select" aria-haspopup="listbox" aria-expanded={menu} aria-label={label} onClick={() => setMenu((open) => !open)}><span>{presetLabel(value.preset)}</span><Ico name="chevron" size={12} /></button>
        <button type="button" className="range-nav" onClick={() => step(-1)} aria-label="Previous range">‹</button>
        <button ref={daysButton} type="button" className="range-input" aria-label="Selected days" aria-haspopup="dialog" aria-expanded={calendar} onClick={() => setCalendar((open) => !open)}>{rangeText(value)}</button>
        <button type="button" className="range-nav" onClick={() => step(1)} aria-label="Next range">›</button>
        <Popover open={menu} onClose={closeMenu} anchor={menuButton} width={280}>
          <SingleSelect options={options} value={value.preset || 'custom'} onChange={(key) => { closeMenu(); choose(key); }} />
        </Popover>
        {picker}
      </div>
    );
  }
  return (
    <div className="range">
      <div className="range-modes" role="group" aria-label="Quick ranges">
        {PRESETS.map(([key, text]) => <button key={key} type="button" aria-pressed={value.preset === key} onClick={() => choose(key)}>{text}</button>)}
        <button type="button" aria-pressed={value.preset === 'custom'} onClick={() => choose('custom')}>Custom</button>
      </div>
      <div className="range-body">
        <button type="button" className="range-nav" onClick={() => step(-1)} aria-label="Previous range">‹</button>
        <label>Selected days<button ref={daysButton} type="button" className="range-input" aria-haspopup="dialog" aria-expanded={calendar} onClick={() => setCalendar((open) => !open)}>{rangeText(value)}</button></label>
        <button type="button" className="range-nav" onClick={() => step(1)} aria-label="Next range">›</button>
      </div>
      {picker}
    </div>
  );
}
