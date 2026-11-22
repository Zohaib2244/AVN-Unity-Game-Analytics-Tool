import { describe, expect, it } from 'vitest';
import { buildText, mergeLive, paramsText, sender, type LiveEvent } from './model';

const at = (n: number): LiveEvent => ({ cursor: n, event_id: `e${n}`, name: `n${n}`, client_ts: '', server_ts: '', user_id: null, device_id: 'd', session_id: null, app_version: '1', environment: null, params: {} });

describe('mergeLive', () => {
  it('puts the newest first and keeps no event twice', () => {
    const first = mergeLive([], [at(1), at(2)]);
    expect(first.map((item) => item.cursor)).toEqual([2, 1]);
    expect(mergeLive(first, [at(2), at(3)]).map((item) => item.cursor)).toEqual([3, 2, 1]);
  });
  it('drops the oldest past the cap', () => {
    expect(mergeLive([at(2), at(1)], [at(3), at(4)], 3).map((item) => item.cursor)).toEqual([4, 3, 2]);
  });
  it('returns the same list when nothing arrived', () => {
    const shown = [at(1)];
    expect(mergeLive(shown, [])).toBe(shown);
  });
});

describe('words', () => {
  it('writes parameters on one line', () => {
    expect(paramsText({ LEVEL: 3, STATE: 'Failed', DATA: { a: 1 } })).toBe('LEVEL=3 · STATE=Failed · DATA={"a":1}');
  });
  it('names the user before the device', () => {
    expect(sender({ user_id: 'u', device_id: 'd' })).toBe('u');
    expect(sender({ user_id: null, device_id: null })).toBe('—');
  });
});

describe('buildText', () => {
  it('adds the environment only when there is one', () => {
    expect(buildText({ app_version: '2.4.0', environment: null })).toBe('2.4.0');
    expect(buildText({ app_version: '2.4.0', environment: 'editor' })).toBe('2.4.0 · editor');
  });
});
