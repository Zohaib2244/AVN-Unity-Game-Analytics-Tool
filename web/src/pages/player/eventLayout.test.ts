// What a raw event row shows for the standard's events, and what it leaves alone.
import { describe, expect, it } from 'vitest';
import { eventLabel, levelChange, shapeEvent } from './eventLayout';

describe('shapeEvent', () => {
  it('orders the parameters, dims the IDs and sets aside what never changes', () => {
    const shape = shapeEvent({ name: 'LEVEL_ANALYSIS', params: { ATTEMPT_ID: 'abc', STATE: 'Started', LEVEL_NUMBER: 11, SECONDS: 0, SOURCE: 'Next', ATTEMPT: 2, ENVIRONMENT: 'normal' } });
    expect(shape.known).toBe(true);
    expect(shape.state).toBe('Started');
    expect(shape.show.map(([key]) => key)).toEqual(['ATTEMPT', 'SOURCE']);
    expect(shape.link).toEqual([['ATTEMPT_ID', 'abc']]);
    expect(shape.quiet.map(([key]) => key)).toEqual(['ENVIRONMENT', 'SECONDS']);
  });

  it('keeps a parameter the standard does not list, after the listed ones', () => {
    const shape = shapeEvent({ name: 'AD_ANALYSIS', params: { STATE: 'Show', PLACEMENT: 'level_interstitial', FORMAT: 'Interstitial', EXTRA: 'x' } });
    expect(shape.show).toEqual([['FORMAT', 'Interstitial'], ['PLACEMENT', 'level_interstitial'], ['EXTRA', 'x']]);
  });

  it('shows every parameter as sent for an event it does not know', () => {
    const shape = shapeEvent({ name: 'level_complete', params: { level: 3, mode: 'easy' } });
    expect(shape).toEqual({ state: null, show: [['level', 3], ['mode', 'easy']], link: [], quiet: [], known: false });
  });

  it('leaves out a parameter an event did not send', () => {
    const shape = shapeEvent({ name: 'LEVEL_ANALYSIS', params: { STATE: 'Choice', ACTION: 'Next' } });
    expect(shape.show).toEqual([['ACTION', 'Next']]);
    expect(shape.link).toEqual([]);
  });
});

describe('labels and levels', () => {
  it('shortens analysis events', () => {
    expect(eventLabel('LEVEL_ANALYSIS')).toBe('LEVEL');
    expect(eventLabel('session_start')).toBe('session_start');
  });

  it('marks a level only where it changes', () => {
    expect(levelChange(11, undefined)).toBe(11);
    expect(levelChange(11, 11)).toBeNull();
    expect(levelChange(12, 11)).toBe(12);
    expect(levelChange(null, 11)).toBeNull();
  });
});
