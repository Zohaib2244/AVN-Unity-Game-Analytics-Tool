// Editors for condition trees (raw-event highlights and activity rules): a simple editor for "one event,
// optionally narrowed by parameters" and an advanced editor with AND / OR groups. Trees are edited
// immutably: `onChange(nextTree)` receives a new tree each time.
import { useId, useState, type ReactElement } from 'react';
import { CONDITION_OPS, conditionGroup, eventCondition, isGroup, paramCondition, simpleHighlightTree, type Condition, type ConditionGroup, type ConditionNode } from '@/lib/conditions';
import { useNotify } from './feedback';
import { Ico } from './icons';

export type CatalogParam = { key: string; values?: string[] };
export type CatalogEvent = { name: string; params: CatalogParam[] };
export type Catalog = { events: CatalogEvent[] };

const locate = (tree: ConditionGroup, path: string): ConditionNode => (path ? path.split('.').reduce<ConditionNode>((node, part) => (node as ConditionGroup).conditions[Number(part)]!, tree) : tree);
/** A copy of `tree` with the node at `path` replaced by `fn(node)` (null removes it). */
function update(tree: ConditionGroup, path: string, fn: (node: ConditionNode) => ConditionNode | null): ConditionGroup {
  const parts = path ? path.split('.').map(Number) : [];
  const walk = (node: ConditionNode, depth: number): ConditionNode | null => {
    if (depth === parts.length) return fn(node);
    const group = node as ConditionGroup;
    const index = parts[depth]!;
    const conditions = group.conditions.flatMap((child, i) => { if (i !== index) return [child]; const next = walk(child, depth + 1); return next ? [next] : []; });
    return { ...group, conditions };
  };
  return walk(tree, 0) as ConditionGroup;
}
const countNodes = (node: ConditionNode): number => 1 + (isGroup(node) ? node.conditions.reduce((sum, child) => sum + countNodes(child), 0) : 0);
const paramValues = (catalog: Catalog, key: string): string[] => [...new Set(catalog.events.flatMap((event) => event.params.filter((param) => param.key === key).flatMap((param) => param.values || [])))];

export function ConditionEditor({ tree, onChange, catalog = { events: [] } }: { tree: ConditionGroup; onChange: (tree: ConditionGroup) => void; catalog?: Catalog }): ReactElement {
  const id = useId();
  const { toast } = useNotify();
  const paramKeys = [...new Set(catalog.events.flatMap((event) => event.params.map((param) => param.key)))].sort();
  const setField = (path: string, field: keyof Condition, value: string) => onChange(update(tree, path, (node) => {
    const next = { ...(node as Condition), [field]: value } as Condition;
    if (field === 'field') return next.field === 'event' ? eventCondition('') : paramCondition('');
    if (['exists', 'missing'].includes(next.op)) next.value = '';
    return next;
  }));
  const add = (path: string, kind: 'test' | 'group') => {
    if (countNodes(tree) >= 98) { toast('Use at most 100 conditions and groups.'); return; }
    if ((locate(tree, path) as ConditionGroup).conditions.length >= 50) { toast('Use at most 50 conditions in one group.'); return; }
    onChange(update(tree, path, (node) => ({ ...(node as ConditionGroup), conditions: [...(node as ConditionGroup).conditions, kind === 'group' ? conditionGroup([paramCondition('')]) : paramCondition('')] })));
  };
  const remove = (path: string) => onChange(update(tree, path, () => null));
  const render = (node: ConditionNode, path = '', depth = 1): ReactElement => {
    if (isGroup(node)) {
      return (
        <fieldset className="condition-group" key={path || 'root'}>
          <legend>Match <select aria-label="Group match" value={node.match} onChange={(e) => onChange(update(tree, path, (n) => ({ ...(n as ConditionGroup), match: e.target.value as 'all' | 'any' })))}><option value="all">all (AND)</option><option value="any">any (OR)</option></select> of these conditions</legend>
          {node.conditions.map((child, index) => render(child, path ? `${path}.${index}` : String(index), depth + 1))}
          <div className="condition-actions">
            <button type="button" className="button small-button" onClick={() => add(path, 'test')}>+ Condition</button>
            {depth < 6 ? <button type="button" className="button small-button" onClick={() => add(path, 'group')}>+ Group</button> : null}
            {path ? <button type="button" className="button small-button" onClick={() => remove(path)}>Remove group</button> : null}
          </div>
        </fieldset>
      );
    }
    const listId = `${id}-${path.replaceAll('.', '-')}`;
    const ops = node.field === 'event' ? CONDITION_OPS.slice(0, 3) : CONDITION_OPS;
    const values = node.field === 'event' ? catalog.events.map((event) => event.name) : paramValues(catalog, node.param);
    return (
      <div className="condition-row" key={path}>
        <label>Field<select value={node.field} onChange={(e) => setField(path, 'field', e.target.value)}><option value="event">Event name</option><option value="param">Parameter</option></select></label>
        {node.field === 'param' ? <label>Parameter<input value={node.param} list={`${listId}-params`} maxLength={80} onChange={(e) => setField(path, 'param', e.target.value)} /><datalist id={`${listId}-params`}>{paramKeys.map((key) => <option key={key} value={key} />)}</datalist></label> : null}
        <label>Comparison<select value={node.op} onChange={(e) => setField(path, 'op', e.target.value)}>{ops.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {!['exists', 'missing'].includes(node.op) ? <label>{node.field === 'event' ? 'Event' : 'Value'}<input value={node.value} list={`${listId}-values`} maxLength={200} onChange={(e) => setField(path, 'value', e.target.value)} /><datalist id={`${listId}-values`}>{values.slice(0, 100).map((value) => <option key={value} value={value} />)}</datalist></label> : null}
        <button type="button" className="icon-button" aria-label="Remove condition" onClick={() => remove(path)}><Ico name="close" size={14} /></button>
      </div>
    );
  };
  return <div className="condition-editor">{render(tree)}</div>;
}

/** Most highlights are one event, optionally narrowed by a few parameters. Grouping stays optional. */
export function HighlightEditor({ tree, onChange, catalog = { events: [] } }: { tree: ConditionGroup; onChange: (tree: ConditionGroup) => void; catalog?: Catalog }): ReactElement {
  const id = useId();
  const simple = simpleHighlightTree(tree);
  const [advanced, setAdvanced] = useState(!simple);
  if (advanced) {
    return (
      <>
        <div className="highlight-editor-mode"><span className="small muted">Advanced: combine conditions with AND / OR groups.</span><button type="button" className="button small-button" disabled={!simple} title={simple ? undefined : 'This rule uses groups. Keep the advanced editor to preserve them.'} onClick={() => setAdvanced(false)}>Simple editor</button></div>
        <ConditionEditor tree={tree} onChange={onChange} catalog={catalog} />
      </>
    );
  }
  const event = tree.conditions[0] as Condition;
  const params = catalog.events.find((item) => item.name === event.value)?.params || [];
  const tests = tree.conditions.slice(1) as Condition[];
  const setTest = (index: number, patch: Partial<Condition>) => onChange({ ...tree, conditions: tree.conditions.map((node, i) => {
    if (i !== index + 1) return node;
    const next = { ...(node as Condition), ...patch };
    if (patch.param !== undefined) next.value = String(params.find((param) => param.key === next.param)?.values?.[0] ?? '');
    if (['exists', 'missing'].includes(next.op)) next.value = '';
    return next;
  }) });
  return (
    <>
      <div className="highlight-editor-mode"><span className="small muted">Choose an event, then add details to narrow it down.</span><button type="button" className="button small-button" onClick={() => setAdvanced(true)}>Advanced groups</button></div>
      <label>Event name<input value={event.value} list={`${id}-events`} maxLength={200} onChange={(e) => onChange({ ...tree, conditions: [{ ...event, value: e.target.value }, ...tests] })} /><datalist id={`${id}-events`}>{catalog.events.map((item) => <option key={item.name} value={item.name} />)}</datalist></label>
      {tests.length ? <p className="help">Only highlight calls where all these details match:</p> : <p className="help">Every call of this event will be highlighted. Add a parameter to pick a type, action or level.</p>}
      {tests.map((test, index) => {
        const values = params.find((param) => param.key === test.param)?.values || [];
        const keys = [...new Set([test.param, ...params.map((param) => param.key)].filter(Boolean))];
        return (
          <div className="simple-highlight-row" key={index}>
            <label>Parameter<select value={test.param} onChange={(e) => setTest(index, { param: e.target.value })}><option value="">Choose a parameter…</option>{keys.map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
            <label>Comparison<select value={test.op} onChange={(e) => setTest(index, { op: e.target.value })}>{CONDITION_OPS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            {!['exists', 'missing'].includes(test.op) ? <label>Value<input value={test.value} list={`${id}-${index}-values`} maxLength={200} onChange={(e) => setTest(index, { value: e.target.value })} /><datalist id={`${id}-${index}-values`}>{values.map((value) => <option key={value} value={value} />)}</datalist></label> : null}
            <button type="button" className="button small-button" onClick={() => onChange({ ...tree, conditions: tree.conditions.filter((_, i) => i !== index + 1) })}>Remove detail</button>
          </div>
        );
      })}
      <button type="button" className="button small-button" disabled={tree.conditions.length >= 50} onClick={() => onChange({ ...tree, conditions: [...tree.conditions, paramCondition('')] })}>+ Add parameter</button>
    </>
  );
}
