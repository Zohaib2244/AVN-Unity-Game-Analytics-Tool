import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MAX_STEPS } from '@/lib/filters';
import type { Catalog, FunnelStep } from '@/lib/types';
import { blankStep } from './funnelMath';
import { StepEditor } from './StepEditor';

const catalog: Catalog = { events: [{ name: 'level_start', count: 10, params: [{ key: 'level', count: 10, values: ['1', '2'] }] }, { name: 'level_end', count: 5, params: [] }] };
const draw = (steps: FunnelStep[], onChange = vi.fn()) => {
  render(<StepEditor steps={steps} catalog={catalog} onChange={onChange} onClear={() => {}} onLevelSteps={() => {}} onRun={() => {}} />);
  return onChange;
};

describe('StepEditor', () => {
  it('adds a step after the last one, with the same event', () => {
    const onChange = draw([blankStep('level_end')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    expect(onChange).toHaveBeenCalledWith([blankStep('level_end'), blankStep('level_end')]);
  });

  it(`refuses more than MAX_STEPS (${MAX_STEPS}) steps`, () => {
    const full = Array.from({ length: MAX_STEPS }, () => blankStep('level_start'));
    const onChange = draw(full);
    const add = screen.getByRole('button', { name: 'Add step' });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText(/^Step \d+ event$/)).toHaveLength(MAX_STEPS);
  });

  it('allows the last step up to MAX_STEPS', () => {
    const onChange = draw(Array.from({ length: MAX_STEPS - 1 }, () => blankStep('level_start')));
    const add = screen.getByRole('button', { name: 'Add step' });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(onChange.mock.calls[0]![0]).toHaveLength(MAX_STEPS);
  });

  it('resets the condition when the event or parameter changes', () => {
    const onChange = draw([{ ...blankStep('level_start'), param: 'level', op: 'gt', value: '3' }]);
    fireEvent.change(screen.getByLabelText('Step 1 event'), { target: { value: 'level_end' } });
    expect(onChange).toHaveBeenLastCalledWith([blankStep('level_end')]);
    fireEvent.change(screen.getByLabelText('Step 1 parameter'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...blankStep('level_start'), param: '', op: 'eq', value: '' }]);
  });

  it('says what to do when there are no steps', () => {
    draw([]);
    expect(screen.getByText(/No steps yet\. Add one, or use “Level steps…”/)).toBeInTheDocument();
  });
});
