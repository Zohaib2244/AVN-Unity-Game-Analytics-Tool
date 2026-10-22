// One condition vocabulary for raw-event highlights and server-side activity counts.
const CONDITION_OPS = [['eq', 'equals'], ['ne', 'does not equal'], ['contains', 'contains'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['exists', 'exists'], ['missing', 'is missing']];
const HIGHLIGHT_COLORS = [['orange', 'Orange'], ['cyan', 'Cyan'], ['green', 'Green'], ['pink', 'Pink'], ['violet', 'Violet'], ['gold', 'Gold']];
const conditionGroup = (conditions = []) => ({match: 'all', conditions});
const eventCondition = name => ({field: 'event', param: '', op: 'eq', value: name || ''});
const paramCondition = key => ({field: 'param', param: key || '', op: 'eq', value: ''});
const conditionNumber = value => /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(String(value).trim()) && Number.isFinite(Number(value)) ? Number(value) : NaN;

function conditionError(node, depth = 1) {
  if (node.conditions) {
    if (depth > 6) return 'Use at most 6 levels of condition groups.';
    if (node.conditions.length > 50) return 'Use at most 50 conditions in one group.';
    if (!node.conditions.length) return 'Add a condition or remove the empty group.';
    return node.conditions.map(child => conditionError(child, depth + 1)).find(Boolean) || '';
  }
  if (node.field === 'param' && !node.param) return 'Choose a parameter.';
  if (node.field === 'event' && !node.value) return 'Choose an event name.';
  if (['gt', 'gte', 'lt', 'lte'].includes(node.op) && !Number.isFinite(conditionNumber(node.value))) return 'Compare with a finite number.';
  return '';
}

function eventMatchesCondition(event, node) {
  if (node.conditions) return node.conditions.length > 0 && (node.match === 'all' ? node.conditions.every(child => eventMatchesCondition(event, child)) : node.conditions.some(child => eventMatchesCondition(event, child)));
  const exists = Object.hasOwn(event.params || {}, node.param);
  const actual = node.field === 'event' ? event.name : event.params?.[node.param];
  if (node.op === 'exists') return exists;
  if (node.op === 'missing') return !exists;
  if (actual == null) return false;
  const value = node.value;
  const equal = String(actual) === value || (typeof actual === 'number' && actual === conditionNumber(value));
  if (node.op === 'eq') return equal;
  if (node.op === 'ne') return !equal;
  // SQLite lower() folds ASCII; use the same semantics for server/client agreement.
  const fold = text => String(text).replace(/[A-Z]/g, char => char.toLowerCase());
  if (node.op === 'contains') return fold(actual).includes(fold(value));
  let numeric = actual;
  if (typeof actual === 'string') { try { numeric = JSON.parse(actual.trim()); } catch { return false; } }
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return false;
  const target = conditionNumber(value);
  return {gt: numeric > target, gte: numeric >= target, lt: numeric < target, lte: numeric <= target}[node.op] || false;
}

function matchingConditionParams(event, node) {
  if (!eventMatchesCondition(event, node)) return [];
  return node.conditions ? node.conditions.flatMap(child => matchingConditionParams(event, child)) : node.field === 'param' ? [node.param] : [];
}

const highlightMatches = (event, rule) => rule.enabled !== false && !conditionError(rule.conditions) && eventMatchesCondition(event, rule.conditions);
const highlightMatchIndices = (events, rules, selected = 'all') => events.flatMap((event, index) => rules.some((rule, ruleIndex) => (selected === 'all' || String(ruleIndex) === selected) && highlightMatches(event, rule)) ? [index] : []);
function highlightNavigationIndex(indices, current, next = true) {
  if (!indices.length) return -1;
  return next ? indices.find(index => index > current) ?? indices[0] : [...indices].reverse().find(index => index < current) ?? indices.at(-1);
}

function simpleHighlightTree(tree) {
  return tree.match === 'all' && Array.isArray(tree.conditions) && tree.conditions[0]?.field === 'event' && tree.conditions[0].op === 'eq' && tree.conditions.slice(1).every(test => !test.conditions && test.field === 'param');
}

function describeHighlight(tree) {
  if (tree.conditions) return '(' + tree.conditions.map(describeHighlight).join(tree.match === 'any' ? ' OR ' : ' AND ') + ')';
  const field = tree.field === 'event' ? 'Event' : tree.param || 'Choose a parameter';
  const op = CONDITION_OPS.find(([key]) => key === tree.op)?.[1] || tree.op;
  return `${field} ${op}${['exists', 'missing'].includes(tree.op) ? '' : ` “${tree.value}”`}`;
}

// Most highlights are one event, optionally narrowed by a few parameters. Keep grouping optional.
function mountHighlightEditor({container, tree, catalog, onChange}) {
  let advanced = !simpleHighlightTree(tree);
  const id = `simple-highlight-${++conditionEditorId}`;
  const draw = () => {
    const simple = simpleHighlightTree(tree);
    container.innerHTML = `<div class="highlight-editor-mode"><span class="small muted">${advanced ? 'Advanced: combine conditions with AND / OR groups.' : 'Choose an event, then add details to narrow it down.'}</span><button type="button" class="button small-button" data-highlight-advanced ${advanced && !simple ? 'disabled title="This rule uses groups. Keep the advanced editor to preserve them."' : ''}>${advanced ? 'Simple editor' : 'Advanced groups'}</button></div><div data-highlight-fields></div>`;
    const fields = container.querySelector('[data-highlight-fields]');
    if (advanced) {mountConditionEditor({container: fields, tree, catalog, onChange}); return;}
    const event = tree.conditions[0];
    const events = catalog().events || [];
    const params = events.find(item => item.name === event.value)?.params || [];
    fields.innerHTML = `<label>Event name<input data-simple-event value="${escapeHTML(event.value)}" list="${id}-events" maxlength="200"><datalist id="${id}-events">${events.map(item => `<option value="${escapeHTML(item.name)}">`).join('')}</datalist></label>
      ${tree.conditions.length > 1 ? '<p class="help">Only highlight calls where all these details match:</p>' : '<p class="help">Every call of this event will be highlighted. Add a parameter to pick a type, action or level.</p>'}
      ${tree.conditions.slice(1).map((test, index) => {
        const values = params.find(param => param.key === test.param)?.values || [];
        const keys = [...new Set([test.param, ...params.map(param => param.key)].filter(Boolean))];
        return `<div class="simple-highlight-row" data-simple-test="${index + 1}"><label>Parameter<select data-simple-field="param"><option value="">Choose a parameter…</option>${keys.map(key => `<option value="${escapeHTML(key)}" ${key === test.param ? 'selected' : ''}>${escapeHTML(key)}</option>`).join('')}</select></label><label>Comparison<select data-simple-field="op">${CONDITION_OPS.map(([key, label]) => `<option value="${key}" ${key === test.op ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${!['exists', 'missing'].includes(test.op) ? `<label>Value<input data-simple-field="value" value="${escapeHTML(test.value)}" list="${id}-${index}-values" maxlength="200"><datalist id="${id}-${index}-values">${values.map(value => `<option value="${escapeHTML(value)}">`).join('')}</datalist></label>` : ''}<button type="button" class="button small-button" data-simple-remove>Remove detail</button></div>`;
      }).join('')}<button type="button" class="button small-button" data-simple-add ${tree.conditions.length >= 50 ? 'disabled' : ''}>+ Add parameter</button>`;
    fields.addEventListener('change', event => {
      if (event.target.hasAttribute('data-simple-event')) {tree.conditions[0].value = event.target.value; draw(); container.querySelector('[data-simple-event]')?.focus(); onChange(); return;}
      const field = event.target.dataset.simpleField;
      if (!field) return;
      const index = event.target.closest('[data-simple-test]').dataset.simpleTest;
      const test = tree.conditions[Number(index)];
      test[field] = event.target.value;
      if (field === 'param') test.value = String(params.find(param => param.key === test.param)?.values?.[0] ?? '');
      if (['exists', 'missing'].includes(test.op)) test.value = '';
      if (field !== 'value') {draw(); container.querySelector(`[data-simple-test="${index}"] [data-simple-field="${field}"]`)?.focus();}
      onChange();
    });
    fields.addEventListener('click', event => {
      if (event.target.closest('[data-simple-add]') && tree.conditions.length < 50) {
        tree.conditions.push(paramCondition('')); draw(); onChange();
      }
      const remove = event.target.closest('[data-simple-remove]');
      if (remove) {tree.conditions.splice(Number(remove.closest('[data-simple-test]').dataset.simpleTest), 1); draw(); onChange();}
    });
  };
  container.addEventListener('click', event => {if (event.target.closest('[data-highlight-advanced]')) {advanced = !advanced; draw();}});
  draw();
}

let conditionEditorId = 0;
function mountConditionEditor({container, tree, catalog = () => ({events: []}), onChange = () => {}}) {
  const id = `condition-${++conditionEditorId}`;
  const locate = path => path ? path.split('.').reduce((node, part) => node.conditions[Number(part)], tree) : tree;
  const render = (node, path = '', depth = 1) => {
    if (node.conditions) return `<fieldset class="condition-group" data-condition-path="${path}"><legend>Match <select data-condition-field="match" aria-label="Group match"><option value="all" ${node.match === 'all' ? 'selected' : ''}>all (AND)</option><option value="any" ${node.match === 'any' ? 'selected' : ''}>any (OR)</option></select> of these conditions</legend>
      ${node.conditions.map((child, index) => render(child, path ? `${path}.${index}` : String(index), depth + 1)).join('')}
      <div class="condition-actions"><button type="button" class="button small-button" data-condition-add="test">+ Condition</button>${depth < 6 ? '<button type="button" class="button small-button" data-condition-add="group">+ Group</button>' : ''}${path ? '<button type="button" class="button small-button" data-condition-remove>Remove group</button>' : ''}</div></fieldset>`;
    const events = catalog().events || [];
    const params = [...new Set(events.flatMap(event => event.params.map(param => param.key)))].sort();
    const values = [...new Set(events.flatMap(event => event.params.filter(param => param.key === node.param).flatMap(param => param.values || [])))];
    const listId = `${id}-${path.replaceAll('.', '-')}`;
    const ops = node.field === 'event' ? CONDITION_OPS.slice(0, 3) : CONDITION_OPS;
    return `<div class="condition-row" data-condition-path="${path}">
      <label>Field<select data-condition-field="field"><option value="event" ${node.field === 'event' ? 'selected' : ''}>Event name</option><option value="param" ${node.field === 'param' ? 'selected' : ''}>Parameter</option></select></label>
      ${node.field === 'param' ? `<label>Parameter<input data-condition-field="param" value="${escapeHTML(node.param)}" list="${listId}-params" maxlength="80"><datalist id="${listId}-params">${params.map(key => `<option value="${escapeHTML(key)}">`).join('')}</datalist></label>` : ''}
      <label>Comparison<select data-condition-field="op">${ops.map(([key, label]) => `<option value="${key}" ${key === node.op ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      ${!['exists', 'missing'].includes(node.op) ? `<label>${node.field === 'event' ? 'Event' : 'Value'}<input data-condition-field="value" value="${escapeHTML(node.value)}" list="${listId}-values" maxlength="200"><datalist id="${listId}-values">${(node.field === 'event' ? events.map(event => event.name) : values).slice(0, 100).map(value => `<option value="${escapeHTML(value)}">`).join('')}</datalist></label>` : ''}
      <button type="button" class="icon-button" data-condition-remove aria-label="Remove condition">${icon('close', 14)}</button></div>`;
  };
  const draw = () => { container.innerHTML = render(tree); };
  container.addEventListener('change', event => {
    const field = event.target.dataset.conditionField;
    if (!field) return;
    const node = locate(event.target.closest('[data-condition-path]').dataset.conditionPath);
    node[field] = event.target.value;
    if (field === 'field') Object.assign(node, node.field === 'event' ? eventCondition('') : paramCondition(''));
    if (['exists', 'missing'].includes(node.op)) node.value = '';
    if (field === 'param') {
      const values = [...new Set((catalog().events || []).flatMap(event => event.params.filter(param => param.key === node.param).flatMap(param => param.values || [])))];
      const list = event.target.closest('.condition-row').querySelector('datalist[id$="-values"]');
      if (list) list.innerHTML = values.slice(0, 100).map(value => `<option value="${escapeHTML(value)}">`).join('');
    }
    if (['field', 'op'].includes(field)) {
      const path = event.target.closest('[data-condition-path]').dataset.conditionPath;
      draw(); container.querySelector(`[data-condition-path="${path}"] [data-condition-field="${field}"]`)?.focus();
    }
    onChange();
  });
  container.addEventListener('click', event => {
    const button = event.target.closest('[data-condition-add], [data-condition-remove]');
    if (!button) return;
    const path = button.closest('[data-condition-path]').dataset.conditionPath;
    if (button.hasAttribute('data-condition-remove')) {
      const parts = path.split('.'); const index = Number(parts.pop());
      locate(parts.join('.')).conditions.splice(index, 1);
    } else {
      const count = node => 1 + (node.conditions || []).reduce((sum, child) => sum + count(child), 0);
      if (count(tree) >= 98) { toast('Use at most 100 conditions and groups.'); return; }
      if (locate(path).conditions.length >= 50) {toast('Use at most 50 conditions in one group.'); return;}
      locate(path).conditions.push(button.dataset.conditionAdd === 'group' ? conditionGroup([paramCondition('')]) : paramCondition(''));
    }
    draw(); onChange();
  });
  draw();
  return {redraw: draw};
}
