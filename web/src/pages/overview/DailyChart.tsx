// Bars per day: one value a day, a dotted grid at 0, half and the peak, and a tooltip naming the day and its
// value. softFrom fades the days that can still change; marker draws one labelled line on a day.
import { useRef, useState, type ReactElement } from 'react';
import { number, prettyDay, shortDay } from '@/lib/format';
import type { DayRange } from '@/lib/filters';
import type { OverviewDay, OverviewMeasure } from '@/lib/types';
import { CHART, chartGeometry, dailySeries, type DayPoint } from './maths';

type DayChartProps = { series: DayPoint[]; label: string; tip: string; format?: (value: number) => string; softFrom?: string; marker?: { day: string; label: string } };

export function DayChart({ series, label, tip: unit, format = number, softFrom, marker }: DayChartProps): ReactElement {
  const { width, height, left, bottom } = CHART;
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
  const marked = marker ? bars.find((bar) => bar.day === marker.day) : undefined;
  return (
    <div ref={box} className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} onPointerLeave={() => setTip(null)}>
        {ticks.map((value) => <g key={value}><line className="chart-grid" x1={left} x2={width} y1={y(value)} y2={y(value)} /><text className="chart-axis" x={left - 6} y={y(value) + 4} textAnchor="end">{format(value)}</text></g>)}
        {bars.map((bar) => <rect key={bar.day} className={`chart-bar${softFrom && bar.day >= softFrom ? ' soft' : ''}`} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={bar.rx} />)}
        {bars.map((bar) => (bar.labelled ? <text key={bar.day} className="chart-axis" x={bar.labelX} y={height - 6} textAnchor="middle">{shortDay(bar.day)}</text> : null))}
        {marked && marker ? <g><line className="chart-marker" x1={marked.hitX} x2={marked.hitX} y1={0} y2={height - bottom} /><text className="chart-marker-label" x={marked.hitX + 5} y={11}>{marker.label}</text></g> : null}
        {bars.map((bar) => <rect key={bar.day} className={`chart-hit${tip?.day === bar.day ? ' on' : ''}`} x={bar.hitX} y={0} width={step} height={height - bottom} onPointerEnter={(event) => show(event, bar)} />)}
      </svg>
      <div ref={tipBox} className="chart-tip" hidden={!tip} style={{ left: tip ? `${tip.left}px` : undefined }}>
        {tip ? <><strong>{prettyDay(tip.day)}</strong><span>{format(tip.value)} {unit}</span></> : null}
      </div>
    </div>
  );
}

export function DailyChart({ days, range, measure }: { days: OverviewDay[]; range: Pick<DayRange, 'from' | 'to'>; measure: OverviewMeasure }): ReactElement {
  return <DayChart series={dailySeries(days, range, measure)} label={`${measure} per day`} tip={measure} />;
}
