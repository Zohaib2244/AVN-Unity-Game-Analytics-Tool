// A tiny per-day line (events of one name, players per day…) for dense tables. The scale starts at 0
// and the last point is marked, so two rows compare at a glance.
import type { ReactElement } from 'react';

export const SPARK_WIDTH = 90;
export const SPARK_HEIGHT = 22;

/** The polyline points for `values`, scaled to the sparkline box (x left to right, y from 0 at the bottom). */
export function sparkPoints(values: number[], width = SPARK_WIDTH, height = SPARK_HEIGHT): Array<[number, number]> {
  const peak = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((value, index) => [index * step, height - 2 - ((height - 4) * value) / peak]);
}

export function Sparkline({ values, label }: { values: number[]; label: string }): ReactElement {
  const points = sparkPoints(values);
  const last = points[points.length - 1] || [0, SPARK_HEIGHT - 2];
  return (
    <svg className="spark" viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} role="img" aria-label={label}>
      <polyline points={points.map((point) => point.map((n) => n.toFixed(1)).join(',')).join(' ')} />
      <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r={2} />
    </svg>
  );
}
