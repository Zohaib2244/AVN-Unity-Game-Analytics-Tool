// Who's playing, by one dimension: value, share bar, players, share. A click on a value filters to it.
import type { ReactElement } from 'react';
import { dimensionText, number, percent } from '@/lib/format';
import { DIMENSION_LABELS, type Dimension } from '@/lib/filters';
import type { OverviewBreakdownRow } from '@/lib/types';
import { breakdownShares } from './maths';

export function BreakdownTable({ dimension, rows, total, chosen, onToggle }: { dimension: Dimension; rows: OverviewBreakdownRow[]; total: number; chosen: string[]; onToggle: (dimension: Dimension, value: string) => void }): ReactElement {
  if (!rows.length) return <p className="help panel-body">No data.</p>;
  return (
    <table className="breakdown">
      <thead><tr><th>{DIMENSION_LABELS[dimension]}</th><th><span className="sr-only">Share bar</span></th><th className="num">Players</th><th className="num">Share</th></tr></thead>
      <tbody>
        {breakdownShares(rows, total).map((row) => {
          const picked = chosen.includes(row.value);
          return (
            <tr key={row.value} className={picked ? 'chosen' : ''}>
              <td><button type="button" className="link-button" title={picked ? 'Remove this filter' : 'Show only this'} onClick={() => onToggle(dimension, row.value)}>{dimensionText(dimension, row.value)}</button></td>
              <td className="breakdown-bar"><span style={{ width: `${row.width}%` }} /></td>
              <td className="num">{number(row.players)}</td>
              <td className="num muted">{row.share === null ? '—' : percent(row.share)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
