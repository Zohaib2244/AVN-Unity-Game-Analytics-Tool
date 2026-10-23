// The rule bar sits above the data and is never folded away: every rule that changes the list is on
// screen, each as a sentence of tokens, with the extra columns as chips.
import type { ReactElement } from 'react';
import { operatorLabel } from '@/lib/filters';
import { number } from '@/lib/format';
import type { EventRule } from '@/lib/types';
import { Ico } from '@/components/icons';
import { metricLabel } from './rules';

export function RuleSentence({ rule }: { rule: EventRule }): ReactElement {
  const never = rule.does === 'didnt';
  return (
    <span className="sent">
      <span className={`tok verb${never ? ' not' : ''}`}>{never ? 'didn’t do' : 'did'}</span>
      <span className="tok">{rule.event}</span>
      {rule.param ? <><span>where</span><span className="tok">{rule.param}</span><span className="tok op">{operatorLabel(rule.op)}</span>{rule.op === 'exists' ? null : <span className="tok val">{rule.value}</span>}</> : null}
      {!never && (rule.min_times || 1) > 1 ? <><span>at least</span><span className="tok val">{rule.min_times}×</span></> : null}
    </span>
  );
}

export function PlayerRuleBar({ conditions, metrics, total, onEdit, onRemoveRule, onRemoveMetric, onClear }: {
  conditions: EventRule[]; metrics: EventRule[]; total: number | null;
  onEdit: () => void; onRemoveRule: (index: number) => void; onRemoveMetric: (index: number) => void; onClear: () => void;
}): ReactElement {
  const used = conditions.map((rule, index) => [rule, index] as const).filter(([rule]) => rule.event);
  const columns = metrics.map((rule, index) => [rule, index] as const).filter(([rule]) => rule.event);
  const players = (count: number) => `player${count === 1 ? '' : 's'}`;
  const extra = columns.length ? (
    <div className="rb-cols"><span className="eyebrow">Extra columns</span>
      {columns.map(([metric, index]) => <span className="chip" key={index}>{metricLabel(metric)}<button type="button" aria-label={`Remove column ${metricLabel(metric)}`} onClick={() => onRemoveMetric(index)}>×</button></span>)}
    </div>
  ) : null;
  if (!used.length) {
    return (
      <section className="rulebar" aria-label="Player rules">
        <div className="rb-empty">
          <span className="rb-ic"><Ico name="funnel" size={15} /></span>
          <b>{total == null ? 'All players' : `All ${number(total)} ${players(total)}`}</b>
          <span className="muted">No rules. Narrow the list by what people did.</span>
          {extra}
          <button type="button" className="btn sm rb-open" onClick={onEdit}>+ Add rule</button>
        </div>
      </section>
    );
  }
  return (
    <section className="rulebar" aria-label="Player rules">
      <div className="rb-h">
        <span className="rb-ic"><Ico name="funnel" size={15} /></span>
        <b className="ttl">Showing players who</b>
        {total == null ? null : <span className="rb-count"><b>{number(total)}</b> {players(total)}</span>}
        <button type="button" className="btn sm ghost" onClick={onClear}>Clear rules</button>
      </div>
      <div className="rb-list">
        {used.map(([rule, index], position) => (
          <div key={index}>
            {position ? <div className="rjoin"><span className="join static">AND</span><span className="dim">players match every rule</span></div> : null}
            <div className="rrow">
              <RuleSentence rule={rule} />
              <span className="ra">
                <button type="button" className="icon-btn" aria-label="Edit rule" onClick={onEdit}><Ico name="edit" size={15} /></button>
                <button type="button" className="icon-btn" aria-label="Remove rule" onClick={() => onRemoveRule(index)}><Ico name="close" size={15} /></button>
              </span>
            </div>
          </div>
        ))}
        <button type="button" className="rb-add" onClick={onEdit}>+ Add rule</button>
        {extra}
      </div>
    </section>
  );
}
