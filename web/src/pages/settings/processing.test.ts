// Ported from tests/test_frontend.py::test_analytics_processing_panel_names_every_state_and_what_is_waiting
import { describe, expect, it } from 'vitest';
import { number } from '@/lib/format';
import { PROCESSING_STATES, processingFacts, processingWaiting } from './processing.ts';

describe('analytics processing panel', () => {
  it('names every state with a word and a sentence, never colour alone', () => {
    for (const state of ['running', 'catching_up', 'starting', 'stopping', 'stopped', 'unavailable']) {
      const [, label, explain] = PROCESSING_STATES[state]!;
      expect(label, state).toBeTruthy();
      expect(explain, state).toBeTruthy();
    }
    expect(PROCESSING_STATES.stopped![2]).toMatch(/still collected/);
    expect(PROCESSING_STATES.unavailable![2]).toMatch(/still collected/);
  });

  it('says what is waiting', () => {
    expect(processingWaiting({ pending: {} })).toBe('Nothing');
    expect(processingWaiting({ pending: { facts_remaining: 1200, views_waiting: 2, lag_seconds: 41.6 } })).toBe(
      `${number(1200)} older events to copy or check · 2 answers to bring up to date · oldest prepared answer 42 s old`,
    );
  });

  it('says what each game’s facts are doing', () => {
    expect(processingFacts({ facts: { ready: true } })).toBe('Ready');
    expect(processingFacts({ facts: { ready: false, phase: 'backfill', done: 50, total: 200 } })).toBe('Copying older events · 25% of this step');
  });
});
