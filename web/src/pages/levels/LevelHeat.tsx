// In a cell the player count sits before the percentage, so the percentages line up down the column.
// One percentage of the level table (the drop to the next level, or failers who quit), drawn against its threshold:
// plain at or under it; over it, tinted and hotter the further over, with a ↓ so colour is never the only cue.
// The colour is the theme's own warning → bad blend (see .heat in styles/app.css), so every palette follows.
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { percentFixed as percent } from '@/lib/format';
import { barScale, heatOf, showCount, type CountsShown, type DropStyle } from './levelDisplay';

export function HeatValue({ value, threshold, style, counts, count, title }: { value: number; threshold: number; style: DropStyle; counts: CountsShown; count: ReactNode; title: string; icon?: boolean }): ReactElement {
  const { over, heat, points } = heatOf(value, threshold);
  const shown = showCount(counts, over);
  const vars = { '--h': heat } as CSSProperties;
  const tip = `${title}${over ? ` · ${points} points over the ${threshold}% flag` : ''}`;
  // The count keeps its place in every cell (empty when not shown), so the percentages line up down the column.
  const visible = counts === 'always' || shown || counts === 'hover';
  const number = <span className={`heat-n${counts === 'hover' ? ' on-hover' : ''}${visible ? '' : ' none'}`} aria-hidden={visible ? undefined : true}>{visible ? count : null}</span>;
  if (style === 'bar') {
    const scale = barScale(threshold) / 100;
    const at = (percentage: number) => Math.min(1, Math.max(0, percentage * scale));
    return (
      <span className={`heat heat-bar${over ? ' over' : ''}`} style={vars} title={tip}>
        <span className="heat-p">{percent(value)}</span>
        <span className="hb-track" aria-hidden="true">
          <span className="hb-fill" style={{ '--w': at(Math.min(value, threshold)) } as CSSProperties} />
          {over ? <span className="hb-over" style={{ '--l': at(threshold), '--w': at(value) - at(threshold) } as CSSProperties} /> : null}
          <span className="hb-tick" style={{ '--l': at(threshold) } as CSSProperties} />
        </span>
        {number}
      </span>
    );
  }
  return (
    <span className={`heat heat-cell${over ? ' over' : ''}`} style={vars} title={tip}>
      {number}
      <span className="heat-p">{percent(value)}</span>
    </span>
  );
}
