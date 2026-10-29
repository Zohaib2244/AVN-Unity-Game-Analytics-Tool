// Players remaining by level, in the Levels summary dialog: the line draws in once, the two steepest drops are
// labelled and every level over the drop flag has an amber dot.
// Drawn here rather than with @avn/ui's SurvivalCurve because that takes start counts only: the drop shown is the
// server's start → start drop, small samples are never flagged and the chart sentence names the levels.
// Pointing at the curve names the nearest level and its players; clicking opens that level.
// Zoom: drag across the curve to look at those levels only, or step in and out; Reset shows every level again.
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { motion } from 'motion/react';
import { number, percent } from '@/lib/format';
import { EASE } from '@/lib/motion';
import type { LevelRow } from '@/lib/types';
import { heatOf } from './levelDisplay';
import { levelCurve, zoomedLevels, zoomWindow, type LevelWindow } from './levelMath';

/** A dot on every level reads as noise once there are many levels; the line and the hovered level say enough. */
const DOT_LIMIT = 40;

export function LevelViz({ levels, dropFlag, onOpen }: { levels: LevelRow[]; dropFlag: number; onOpen: (level: number) => void }): ReactElement | null {
  const [near, setNear] = useState<number | null>(null);
  const [window, setWindow] = useState<LevelWindow | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; x: number } | null>(null);
  const dragged = useRef(false);
  const shown = zoomedLevels(levels, window);
  const curve = levelCurve(shown);
  if (!curve) return null;
  const { width, height, left, right, points } = curve;
  const showDots = points.length <= DOT_LIMIT;
  const hovered = near == null ? null : points[near] ?? null;

  const nearest = (event: { currentTarget: SVGSVGElement; clientX: number }): number => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * width;
    return Math.max(0, Math.min(points.length - 1, Math.round(((x - left) / (width - left - right)) * (points.length - 1))));
  };
  const zoomTo = (next: LevelWindow | null) => { setWindow(next); setNear(null); setDrag(null); };
  const begin = (event: PointerEvent<SVGSVGElement>) => { const index = nearest(event); dragged.current = false; setDrag({ from: index, to: index, x: event.clientX }); };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const index = nearest(event);
    setNear(index);
    if (drag && event.buttons) setDrag({ ...drag, to: index });
  };
  const finish = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
    setDrag(null);
    if (Math.abs(event.clientX - drag.x) > 8 && b - a >= 2) { dragged.current = true; zoomTo({ from: points[a]!.level, to: points[b]!.level }); }
  };
  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    const move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (move) { event.preventDefault(); setNear((current) => Math.max(0, Math.min(points.length - 1, (current ?? 0) + move))); }
    else if (event.key === 'Enter' && hovered) { event.preventDefault(); onOpen(hovered.level); }
    else if (event.key === 'Escape') setNear(null);
  };

  return (
    <div className="level-curve-wrap">
      <div className="curve-tools" role="group" aria-label="Zoom the chart">
        <span className="small muted">{window ? `Levels ${points[0]!.level}–${points[points.length - 1]!.level}` : `All ${number(levels.length)} levels · drag across the chart to zoom`}</span>
        <button type="button" className="btn sm" aria-label="Zoom in" disabled={points.length < 6} onClick={() => zoomTo(zoomWindow(levels, points[0]!.level, points[points.length - 1]!.level, 'in'))}>+</button>
        <button type="button" className="btn sm" aria-label="Zoom out" disabled={!window} onClick={() => zoomTo(zoomWindow(levels, points[0]!.level, points[points.length - 1]!.level, 'out'))}>−</button>
        {window ? <button type="button" className="btn sm" onClick={() => zoomTo(null)}>Reset zoom</button> : null}
      </div>
      <svg className="level-curve" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={curve.summary} tabIndex={0}
        onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerLeave={() => { setNear(null); setDrag(null); }} onBlur={() => setNear(null)} onKeyDown={step}
        onClick={(event) => { if (dragged.current) { dragged.current = false; return; } onOpen(points[nearest(event)]!.level); }}>
        {drag && drag.from !== drag.to ? <rect className="curve-select" x={points[Math.min(drag.from, drag.to)]!.x} width={points[Math.max(drag.from, drag.to)]!.x - points[Math.min(drag.from, drag.to)]!.x} y={0} height={height} /> : null}
        {curve.ticks.map((tick) => (
          <g key={tick.value}>
            <line className="chart-grid" x1={left} x2={width - right} y1={tick.y} y2={tick.y} />
            <text className="chart-axis" x={left - 6} y={tick.y + 4} textAnchor="end">{number(tick.value)}</text>
          </g>
        ))}
        <motion.path className="curve-area" d={curve.area} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...EASE, duration: 0.6, delay: 0.25 }} />
        <motion.path className="curve-line" d={curve.line} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8, ease: [0.2, 0.8, 0.2, 1] }} />
        {points.map((point, index) => {
          const flagged = heatOf(point.drop, dropFlag).over;
          return (
            <g key={point.level}>
              {showDots || point.big || flagged ? <motion.circle className={`curve-dot${point.big ? ' big' : ''}${flagged ? ' flagged' : ''}`} cx={point.x} cy={point.y} r={point.big ? 4.5 : flagged ? 3.6 : 2.6} initial={{ opacity: 0, scale: 0 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...EASE, delay: 0.5 + Math.min(index, 30) * 0.012 }} style={{ transformBox: 'fill-box', transformOrigin: 'center' }} /> : null}
              {point.flag ? <text className="curve-flag" x={(point.x + 7).toFixed(1)} y={(point.y - 7).toFixed(1)}>{point.flag}</text> : null}
              {point.axis ? <text className="chart-axis" x={point.x} y={height - 7} textAnchor="middle">{point.level}</text> : null}
            </g>
          );
        })}
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
  );
}
