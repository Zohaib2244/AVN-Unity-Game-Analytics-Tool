// One condition vocabulary for raw-event highlights and server-side activity counts. The matcher mirrors
// the server's SQL (tests/test_conditions.py runs both over the same events), so this file uses only
// erasable TypeScript syntax and no other imports: Node runs it as-is.

export type ConditionOp = 'eq' | 'ne' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'missing';
export type Condition = { field: 'event' | 'param'; param: string; op: ConditionOp | string; value: string };
export type ConditionGroup = { match: 'all' | 'any'; conditions: ConditionNode[] };
export type ConditionNode = Condition | ConditionGroup;
export type ConditionEvent = { name: string; params?: Record<string, unknown> | null };
export type HighlightRule = { enabled?: boolean; conditions: ConditionGroup; name?: string; color?: string };

export const CONDITION_OPS: Array<[string, string]> = [['eq', 'equals'], ['ne', 'does not equal'], ['contains', 'contains'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['exists', 'exists'], ['missing', 'is missing']];
export const HIGHLIGHT_COLORS: Array<[string, string]> = [['orange', 'Orange'], ['cyan', 'Cyan'], ['green', 'Green'], ['pink', 'Pink'], ['violet', 'Violet'], ['gold', 'Gold']];
export const isGroup = (node: ConditionNode): node is ConditionGroup => 'conditions' in node && Array.isArray((node as ConditionGroup).conditions);
export const conditionGroup = (conditions: ConditionNode[] = []): ConditionGroup => ({ match: 'all', conditions });
export const eventCondition = (name?: string): Condition => ({ field: 'event', param: '', op: 'eq', value: name || '' });
export const paramCondition = (key?: string): Condition => ({ field: 'param', param: key || '', op: 'eq', value: '' });
export const conditionNumber = (value: unknown): number => (/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(String(value).trim()) && Number.isFinite(Number(value)) ? Number(value) : NaN);

export function conditionError(node: ConditionNode, depth = 1): string {
  if (isGroup(node)) {
    if (depth > 6) return 'Use at most 6 levels of condition groups.';
    if (node.conditions.length > 50) return 'Use at most 50 conditions in one group.';
    if (!node.conditions.length) return 'Add a condition or remove the empty group.';
    return node.conditions.map((child) => conditionError(child, depth + 1)).find(Boolean) || '';
  }
  if (node.field === 'param' && !node.param) return 'Choose a parameter.';
  if (node.field === 'event' && !node.value) return 'Choose an event name.';
  if (['gt', 'gte', 'lt', 'lte'].includes(node.op) && !Number.isFinite(conditionNumber(node.value))) return 'Compare with a finite number.';
  return '';
}

export function eventMatchesCondition(event: ConditionEvent, node: ConditionNode): boolean {
  if (isGroup(node)) return node.conditions.length > 0 && (node.match === 'all' ? node.conditions.every((child) => eventMatchesCondition(event, child)) : node.conditions.some((child) => eventMatchesCondition(event, child)));
  const params = event.params || {};
  const exists = Object.hasOwn(params, node.param);
  const actual: unknown = node.field === 'event' ? event.name : params[node.param];
  if (node.op === 'exists') return exists;
  if (node.op === 'missing') return !exists;
  if (actual == null) return false;
  const value = node.value;
  const equal = String(actual) === value || (typeof actual === 'number' && actual === conditionNumber(value));
  if (node.op === 'eq') return equal;
  if (node.op === 'ne') return !equal;
  // SQLite lower() folds ASCII; use the same semantics for server/client agreement.
  const fold = (text: unknown) => String(text).replace(/[A-Z]/g, (char) => char.toLowerCase());
  if (node.op === 'contains') return fold(actual).includes(fold(value));
  let numeric: unknown = actual;
  if (typeof actual === 'string') { try { numeric = JSON.parse(actual.trim()); } catch { return false; } }
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return false;
  const target = conditionNumber(value);
  const results: Record<string, boolean> = { gt: numeric > target, gte: numeric >= target, lt: numeric < target, lte: numeric <= target };
  return results[node.op] || false;
}

export function matchingConditionParams(event: ConditionEvent, node: ConditionNode): string[] {
  if (!eventMatchesCondition(event, node)) return [];
  return isGroup(node) ? node.conditions.flatMap((child) => matchingConditionParams(event, child)) : node.field === 'param' ? [node.param] : [];
}

export const highlightMatches = (event: ConditionEvent, rule: HighlightRule): boolean => rule.enabled !== false && !conditionError(rule.conditions) && eventMatchesCondition(event, rule.conditions);
export const highlightMatchIndices = (events: ConditionEvent[], rules: HighlightRule[], selected: string = 'all'): number[] => events.flatMap((event, index) => (rules.some((rule, ruleIndex) => (selected === 'all' || String(ruleIndex) === selected) && highlightMatches(event, rule)) ? [index] : []));
export function highlightNavigationIndex(indices: number[], current: number, next = true): number {
  if (!indices.length) return -1;
  return next ? (indices.find((index) => index > current) ?? indices[0]!) : ([...indices].reverse().find((index) => index < current) ?? indices[indices.length - 1]!);
}

/** Most highlights are one event, optionally narrowed by a few parameters. */
export function simpleHighlightTree(tree: ConditionGroup): boolean {
  const first = tree.conditions[0];
  return tree.match === 'all' && Array.isArray(tree.conditions) && !!first && !isGroup(first) && first.field === 'event' && first.op === 'eq' && tree.conditions.slice(1).every((test) => !isGroup(test) && test.field === 'param');
}

export function describeHighlight(tree: ConditionNode): string {
  if (isGroup(tree)) return '(' + tree.conditions.map(describeHighlight).join(tree.match === 'any' ? ' OR ' : ' AND ') + ')';
  const field = tree.field === 'event' ? 'Event' : tree.param || 'Choose a parameter';
  const op = CONDITION_OPS.find(([key]) => key === tree.op)?.[1] || tree.op;
  return `${field} ${op}${['exists', 'missing'].includes(tree.op) ? '' : ` “${tree.value}”`}`;
}
