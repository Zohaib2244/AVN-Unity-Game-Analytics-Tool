// Levels at a glance: players remaining by level (the two steepest drops marked) and a heat strip, one cell per level.
// Drawn here rather than with @avn/ui's SurvivalCurve/HeatStrip because those take start counts only: the drop
// shown is the server's start → start drop, small samples are never flagged and the chart sentence names the levels.
// Closed until asked for (it is a lot of picture for something looked at now and then); the choice is remembered per game.
// Pointing at the curve names the nearest level and its players; clicking opens that level.
import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { Ico } from '@/components/icons';
import { number, percent } from '@/lib/format';
import { useStored } from '@/lib/store';
import type { Game, LevelRow } from '@/lib/types';
import { levelCurve } from './levelMath';

/** A dot on every level reads as noise once there are many levels; the line and the hovered level say enough. */
const DOT_LIMIT = 40;

export function LevelViz({ game, levels, onOpen }: { game: Pick<Game, 'id'>; levels: LevelRow[]; onOpen: (level: number) => void }): ReactElement | null {
  const [open, setOpen] = useStored<boolean>(`avn-levels-viz-${game.id}`, false);
  const [near, setNear] = useState<number | null>(null);
  const curve = levelCurve(levels);
  if (!curve) return null;
  const { width, height, left, right, points } = curve;
  const showDots = points.length <= DOT_LIMIT;
  const hovered = near == null ? null : points[near] ?? null;

  const nearest = (event: { currentTarget: SVGSVGElement; clientX: number }): number => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * width;
    return Math.max(0, Math.min(points.length - 1, Math.round(((x - left) / (width - left - right)) * (points.length - 1))));
  };
  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    const move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (move) { event.preventDefault(); setNear((current) => Math.max(0, Math.min(points.length - 1, (current ?? 0) + move))); }
    else if (event.key === 'Enter' && hovered) { event.preventDefault(); onOpen(hovered.level); }
    else if (event.key === 'Escape') setNear(null);
  };

  return (
    <section className={`panel level-viz${open ? '' : ' collapsed'}`}>
      <div className="panel-header">
        <button type="button" className="level-viz-toggle" aria-expanded={open} aria-controls="level-viz-body" onClick={() => setOpen(!open)}>
          <span className="rule-chevron"><Ico name="chevron" size={15} /></span>
          <span className="level-viz-title"><h2>Players remaining by level</h2><p>{open ? `Steep steps are where players stop${curve.steepest.length ? ' · the two steepest are marked' : ''}` : `Curve and heat strip${curve.steepest.length ? ` · steepest drops after level ${curve.steepest.join(' and ')}` : ''} · show`}</p></span>
        </button>
      </div>
      {open ? (
        <div className="panel-body" id="level-viz-body">
          <div className="level-curve-wrap">
            <svg className="level-curve" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={curve.summary} tabIndex={0}
              onPointerMove={(event) => setNear(nearest(event))} onPointerLeave={() => setNear(null)} onBlur={() => setNear(null)} onKeyDown={step}
              onClick={(event) => onOpen(points[nearest(event)]!.level)}>
              {curve.ticks.map((tick) => (
                <g key={tick.value}>
                  <line className="chart-grid" x1={left} x2={width - right} y1={tick.y} y2={tick.y} />
                  <text className="chart-axis" x={left - 6} y={tick.y + 4} textAnchor="end">{number(tick.value)}</text>
                </g>
              ))}
              <path className="curve-area" d={curve.area} />
              <path className="curve-line" d={curve.line} />
              {points.map((point) => (
                <g key={point.level}>
                  {showDots || point.big ? <circle className={`curve-dot${point.big ? ' big' : ''}`} cx={point.x} cy={point.y} r={point.big ? 4.5 : 2.6} /> : null}
                  {point.flag ? <text className="curve-flag" x={(point.x + 7).toFixed(1)} y={(point.y - 7).toFixed(1)}>{point.flag}</text> : null}
                  {point.axis ? <text className="chart-axis" x={point.x} y={height - 7} textAnchor="middle">{point.level}</text> : null}
                </g>
              ))}
              {hovered ? (
                <g className="curve-hover" aria-hidden="true">
                  <line x1={hovered.x} x2={hovered.x} y1={curve.ticks[curve.ticks.length - 1]?.y ?? 0} y2={curve.ticks[0]?.y ?? height} />
                  <circle cx={hovered.x} cy={hovered.y} r={5} />
                </g>
              ) : null}
            </svg>
            {hovered ? (
              <div className={`curve-tip${hovered.x / width > 0.7 ? ' flip' : ''}`} role="status" style={{ left: `${(hovered.x / width) * 100}%`, top: `${(hovered.y / height) * 100}%` }}>
                <strong>Level {hovered.level}</strong>
                <span>{number(hovered.started)} {hovered.started === 1 ? 'player' : 'players'} started</span>
                <span className="muted">{hovered.drop == null ? 'drop: not enough data' : `${percent(hovered.drop)} did not start the next`}</span>
                <span className="muted">Click to open</span>
              </div>
            ) : null}
          </div>
          <div className="lvheat-strip" role="group" aria-label="Drop to the next level, per level">
            {curve.heat.map((cell) => <button key={cell.level} type="button" className={`lvheat h${cell.bucket}`} data-heat-level={cell.level} title={cell.title} onClick={() => onOpen(cell.level)}>{cell.level}</button>)}
          </div>
          <p className="foot-note">Cell colour is the drop to the next level, per level: lighter is low, stronger is high. Open a level to see its players.</p>
        </div>
      ) : null}
    </section>
  );
}
