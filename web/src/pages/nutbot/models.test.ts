import { effortLevels, pickEffort, pickModel } from './models';
import type { NutBotHarness } from '@/lib/types';

const harness: NutBotHarness = {
  id: 'claude', label: 'Claude', available: true, reason: '', default_model: 'sonnet', cheap_model: null,
  models: ['sonnet', 'haiku'], models_from: 'agent', probe_error: '',
  efforts: { sonnet: [{ value: 'default', name: 'Default' }, { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
};

describe('model and effort choice', () => {
  it('keeps an offered model and drops one the agent no longer offers', () => {
    expect(pickModel(harness, 'haiku')).toBe('haiku');
    expect(pickModel(harness, 'fable')).toBe('sonnet');
    expect(pickModel({ ...harness, default_model: 'gone' }, 'fable')).toBe('sonnet');
    expect(pickModel({ ...harness, models: [] }, 'sonnet')).toBe('');
    expect(pickModel(null, 'sonnet')).toBe('');
  });
  it('lists effort levels per model, without the agent’s own default row', () => {
    expect(effortLevels(harness, 'sonnet').map((level) => level.value)).toEqual(['low', 'high']);
    expect(effortLevels(harness, '')).toHaveLength(2);
    expect(effortLevels(harness, 'haiku')).toEqual([]);
  });
  it('keeps a remembered effort only when the model offers it', () => {
    const levels = effortLevels(harness, 'sonnet');
    expect(pickEffort(levels, 'high')).toBe('high');
    expect(pickEffort(levels, 'max')).toBe('');
    expect(pickEffort([], 'high')).toBe('');
  });
});
