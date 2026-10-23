// Levels at a glance: players remaining by level (the two steepest drops marked) and a heat strip, one cell per level.
// Drawn here rather than with @avn/ui's SurvivalCurve/HeatStrip because those take start counts only: the drop
// shown is the server's start → start drop, small samples are never flagged and the chart sentence names the levels.
import type { ReactElement } from 'react';
import { number } from '@/lib/format';
import type { LevelRow } from '@/lib/types';
import { levelCurve } from './levelMath';

export function LevelViz({ levels, onOpen }: { levels: LevelRow[]; onOpen: (level: number) => void }): ReactElement | null {
  const curve = levelCurve(levels);
  if (!curve) return null;
  const { width, height, left, right } = curve;
  return (
    <section className="panel level-viz">
      <div className="panel-header"><div><h2>Players remaining by level</h2><p>Steep steps are where players stop{curve.steepest.length ? ' · the two steepest are marked' : ''}</p></div></div>
      <div className="panel-body">
        <svg className="level-curve" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={curve.summary}>
          {curve.ticks.map((tick) => (
            <g key={tick.value}>
              <line className="chart-grid" x1={left} x2={width - right} y1={tick.y} y2={tick.y} />
              <text className="chart-axis" x={left - 6} y={tick.y + 4} textAnchor="end">{number(tick.value)}</text>
            </g>
          ))}
          <path className="curve-area" d={curve.area} />
          <path className="curve-line" d={curve.line} />
          {curve.points.map((point) => (
            <g key={point.level}>
              <circle className={`curve-dot${point.big ? ' big' : ''}`} cx={point.x} cy={point.y} r={point.big ? 4.5 : 2.6} />
              {point.flag ? <text className="curve-flag" x={(point.x + 7).toFixed(1)} y={(point.y - 7).toFixed(1)}>{point.flag}</text> : null}
              {point.axis ? <text className="chart-axis" x={point.x} y={height - 7} textAnchor="middle">{point.level}</text> : null}
            </g>
          ))}
        </svg>
        <div className="lvheat-strip" role="group" aria-label="Drop to the next level, per level">
          {curve.heat.map((cell) => <button key={cell.level} type="button" className={`lvheat h${cell.bucket}`} data-heat-level={cell.level} title={cell.title} onClick={() => onOpen(cell.level)}>{cell.level}</button>)}
        </div>
        <p className="foot-note">Cell colour is the drop to the next level, per level: lighter is low, stronger is high. Open a level to see its players.</p>
      </div>
    </section>
  );
}
