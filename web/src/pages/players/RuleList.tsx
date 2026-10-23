// A reusable editor for a list of "an event, optionally with a parameter test" (the old mountRuleList).
// Used on the Players page for "only players who…" conditions and for custom columns, and shaped so any
// other page can reuse it (funnel-like steps, segments, cohorts…).
//
//   <RuleList rules={…} catalog={…} blank={catalog => rule} onChange={rules => …}
//             before={(rule, set) => <select … onChange={e => set({ does: e.target.value })} />} />
//
//   rules    the array being edited (each rule: {event, param, op, value, …}); `onChange` gets the next one
//   catalog  {events: [{name, params: [{key, values}]}]} from /insights/catalog
//   before/  extra controls drawn before / after the event fields; they change the rule through `set(patch)`
//   after    (a number field should pass a number: `set({ min_times: Number(value) || 1 })`)
import { useId, type ReactElement, type ReactNode } from 'react';
import { OPERATORS } from '@/lib/filters';
import type { Catalog, CatalogEvent, EventRule } from '@/lib/types';
import { Ico } from '@/components/icons';

export type RuleSetter<T> = (patch: Partial<T>) => void;
export type RuleListProps<T extends EventRule> = {
  rules: T[];
  catalog: Catalog;
  blank: (catalog: Catalog) => T;
  onChange: (rules: T[]) => void;
  before?: (rule: T, index: number, set: RuleSetter<T>, catalog: Catalog) => ReactNode;
  after?: (rule: T, index: number, set: RuleSetter<T>, catalog: Catalog) => ReactNode;
  addLabel?: string;
  empty?: string;
};

/** The options of a select: the chosen value stays listed even when the catalog no longer has it. */
export function ruleOptions(items: string[], chosen: string, blank?: string): ReactElement[] {
  const list = items.includes(chosen) || !chosen ? items : [chosen, ...items];
  return [
    ...(blank === undefined ? [] : [<option key="" value="">{blank}</option>]),
    ...list.map((item) => <option key={item} value={item}>{item}</option>),
  ];
}

export const paramKeys = (event: CatalogEvent | undefined): string[] => (event?.params || []).map((param) => param.key);

/** The event, parameter, condition and value fields of one rule. */
export function RuleFields<T extends EventRule>({ rule, catalog, set, listId }: { rule: T; catalog: Catalog; set: RuleSetter<T>; listId: string }): ReactElement {
  const event = catalog.events.find((item) => item.name === rule.event);
  const values = event?.params.find((param) => param.key === rule.param)?.values || [];
  const needsValue = rule.param && rule.op !== 'exists';
  return (
    <>
      <select className="rule-event" aria-label="Event" value={rule.event} onChange={(e) => set({ event: e.target.value, param: '', op: 'eq', value: '', of: '' } as Partial<T>)}>
        {ruleOptions(catalog.events.map((item) => item.name), rule.event, rule.event ? undefined : 'Pick an event…')}
      </select>
      <select className="rule-param" aria-label="Only when this parameter…" value={rule.param} onChange={(e) => set({ param: e.target.value, op: 'exists', value: '' } as Partial<T>)}>
        {ruleOptions(paramKeys(event), rule.param, '+ only when a parameter…')}
      </select>
      {rule.param ? (
        <select className="rule-op" aria-label="Condition" value={rule.op || 'eq'} onChange={(e) => set((e.target.value === 'exists' ? { op: 'exists', value: '' } : { op: e.target.value }) as Partial<T>)}>
          {OPERATORS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      ) : null}
      {needsValue ? (
        <>
          <input className="rule-value" aria-label="Value" placeholder="value" value={rule.value || ''} list={listId} onChange={(e) => set({ value: e.target.value } as Partial<T>)} />
          <datalist id={listId}>{values.slice(0, 40).map((value) => <option key={value} value={value} />)}</datalist>
        </>
      ) : null}
    </>
  );
}

export function RuleList<T extends EventRule>({ rules, catalog, blank, onChange, before, after, addLabel = 'Add', empty = '' }: RuleListProps<T>): ReactElement {
  const id = useId();
  const setAt = (index: number): RuleSetter<T> => (patch) => onChange(rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)));
  return (
    <div className="rule-list">
      {rules.length ? rules.map((rule, index) => {
        const set = setAt(index);
        return (
          <div className="rule-row" key={index} data-rule={index}>
            {before?.(rule, index, set, catalog)}
            <RuleFields rule={rule} catalog={catalog} set={set} listId={`${id}-values-${index}`} />
            {after?.(rule, index, set, catalog)}
            <button type="button" className="icon-button rule-remove" aria-label="Remove this rule" title="Remove" onClick={() => onChange(rules.filter((_, position) => position !== index))}><Ico name="close" size={14} /></button>
          </div>
        );
      }) : <p className="help">{empty}</p>}
      <button type="button" className="button small-button" onClick={() => onChange([...rules, blank(catalog)])}><Ico name="plus" size={13} /> {addLabel}</button>
    </div>
  );
}
