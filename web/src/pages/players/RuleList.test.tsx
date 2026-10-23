import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Catalog, EventRule } from '@/lib/types';
import { RuleList } from './RuleList';

const catalog: Catalog = { events: [{ name: 'level_start', count: 10, params: [{ key: 'level', count: 10, values: ['1', '2'] }] }, { name: 'purchase', count: 2, params: [] }] };
function Harness() {
  const [rules, setRules] = useState<EventRule[]>([]);
  return <RuleList rules={rules} catalog={catalog} onChange={setRules} blank={(c) => ({ event: c.events[0]?.name || '', param: '', op: 'eq', value: '' })} addLabel="Add a condition" empty="No conditions yet." />;
}

describe('RuleList', () => {
  it('adds a row, edits it, and removing it clears the list', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText('No conditions yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a condition' }));
    expect(screen.getAllByLabelText('Event')).toHaveLength(1);
    expect(screen.getByLabelText('Event')).toHaveValue('level_start');
    // Picking a parameter shows the condition; "any value" needs no value field.
    await user.selectOptions(screen.getByLabelText('Only when this parameter…'), 'level');
    expect(screen.getByLabelText('Condition')).toHaveValue('exists');
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Condition'), 'gte');
    await user.type(screen.getByLabelText('Value'), '12');
    expect(screen.getByLabelText('Value')).toHaveValue('12');
    // Changing the event resets the parameter test.
    await user.selectOptions(screen.getByLabelText('Event'), 'purchase');
    expect(screen.getByLabelText('Only when this parameter…')).toHaveValue('');
    expect(screen.queryByLabelText('Condition')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a condition' }));
    expect(screen.getAllByLabelText('Event')).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Remove this rule' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Remove this rule' }));
    expect(screen.queryByLabelText('Event')).not.toBeInTheDocument();
    expect(screen.getByText('No conditions yet.')).toBeInTheDocument();
  });
});
