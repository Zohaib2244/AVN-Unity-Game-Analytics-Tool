// Activity per day: bars for one measure (players, sessions or events), a dotted grid at 0, half and
// the peak, and a tooltip naming the day and its value. The old SVG chart as a component.
import { useRef, useState, type ReactElement } from 'react';
import { number, prettyDay } from '@/lib/format';
import type { DayRange } from '@/lib/filters';
import type { OverviewDay, OverviewMeasure } from '@/lib/types';
import { CHART, chartGeometry, dailySeries } from './maths';

export function DailyChart({ days, range, measure }: { days: OverviewDay[]; range: Pick<DayRange, 'from' | 'to'>; measure: OverviewMeasure }): ReactElement {
  const { width, height, left, bottom } = CHART;
  const series = dailySeries(days, range, measure);
  const { y, ticks, step, bars } = chartGeometry(series);
  const box = useRef<HTMLDivElement>(null);
  const tipBox = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ day: string; value: number; left: number } | null>(null);
  const show = (event: React.PointerEvent<SVGRectElement>, bar: (typeof bars)[number]) => {
    const container = box.current?.getBoundingClientRect();
    const mark = event.currentTarget.getBoundingClientRect();
    const tipWidth = tipBox.current?.offsetWidth || 0;
    const leftPx = container ? Math.min(container.width - tipWidth, Math.max(0, mark.left - container.left + mark.width / 2 - tipWidth / 2)) : 0;
    setTip({ day: bar.day, value: bar.value, left: leftPx });
  };
  return (
    <div ref={box} className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${measure} per day`} onPointerLeave={() => setTip(null)}>
        {ticks.map((value) => <g key={value}><line className="chart-grid" x1={left} x2={width} y1={y(value)} y2={y(value)} /><text className="chart-axis" x={left - 6} y={y(value) + 4} textAnchor="end">{number(value)}</text></g>)}
        {bars.map((bar) => <rect key={bar.day} className="chart-bar" x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={bar.rx} />)}
        {bars.map((bar) => (bar.labelled ? <text key={bar.day} className="chart-axis" x={bar.labelX} y={height - 6} textAnchor="middle">{bar.day.slice(5)}</text> : null))}
        {bars.map((bar) => <rect key={bar.day} className={`chart-hit${tip?.day === bar.day ? ' on' : ''}`} x={bar.hitX} y={0} width={step} height={height - bottom} onPointerEnter={(event) => show(event, bar)} />)}
      </svg>
      <div ref={tipBox} className="chart-tip" hidden={!tip} style={{ left: tip ? `${tip.left}px` : undefined }}>
        {tip ? <><strong>{prettyDay(tip.day)}</strong><span>{number(tip.value)} {measure}</span></> : null}
      </div>
    </div>
  );
}
