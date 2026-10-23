// The browser request contract (was tests/test_frontend.py): bounded retries for reads, never for writes,
// actionable messages per status, unreadable success is an error, and slow loads are remembered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request, rememberSlow, slowLoadMessage, usualWait } from './client';

const response = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => '5' }, json: async () => body }) as unknown as Response;

describe('request', () => {
  let calls: Array<{ path: string; options: RequestInit }>;
  let replies: Response[];
  beforeEach(() => {
    calls = []; replies = [];
    vi.stubGlobal('fetch', async (path: string, options: RequestInit) => { calls.push({ path, options }); return replies.shift(); });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 0 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout);
  });
  afterEach(() => vi.restoreAllMocks());

  it('retries a read once on 502/503/504 and never replays a write', async () => {
    replies = [response(503), response(200, { players: 3 })];
    expect(await request('/insights/players')).toEqual({ players: 3 });
    expect(calls).toHaveLength(2);
    calls = []; replies = [response(503, { detail: 'Storage temporarily unavailable' }), response(503)];
    await expect(request('/insights/players')).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(2);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      calls = []; replies = [response(503, { detail: 'Storage temporarily unavailable' })];
      await expect(request('/dictionary', { method })).rejects.toMatchObject({ status: 503 });
      expect(calls).toHaveLength(1);
    }
    calls = []; replies = [response(403, { detail: 'Forbidden' })];
    await expect(request('/games')).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });

  it('names connection failures and passes cancellations through', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await expect(request('/games')).rejects.toMatchObject({ status: 0, message: expect.stringContaining('connection') });
    vi.stubGlobal('fetch', async () => { throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); });
    await expect(request('/games')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives every error a next step and does not trust an unreadable success', async () => {
    for (const [status, expected] of [[401, /sign in/], [403, /permission/], [429, /Wait/], [500, /server/]] as const) {
      vi.stubGlobal('fetch', async () => ({ ok: false, status, json: async () => ({}) }));
      await expect(request('/read')).rejects.toMatchObject({ status, message: expect.stringMatching(expected) });
    }
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, json: async () => ({ detail: 'Invalid request', errors: [{ loc: ['body', 'last_level'], msg: 'Must be at least 1' }] }) }));
    await expect(request('/read')).rejects.toThrow(/last_level: Must be at least 1/);
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('HTML'); } }));
    await expect(request('/read')).rejects.toThrow(/unreadable response/);
    expect(new ApiError('x', 418)).toBeInstanceOf(Error);
  });
});

describe('slow loads', () => {
  it('remembers how long a slow read took and says what is happening', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key), clear: () => store.clear() });
    rememberSlow('/v1/games/abc/insights/levels?start=1', 40);
    expect(usualWait('/v1/games/zzz/insights/levels')).toBeNull();
    rememberSlow('/v1/games/abc/insights/levels?start=1', 6200);
    expect(usualWait('/v1/games/zzz/insights/levels?end=2')).toBe(6200); // any game, any query
    expect(usualWait('/v1/games/abc/insights/summary')).toBeNull();
    expect(slowLoadMessage(1)).toBe('');
    expect(slowLoadMessage(2)).toMatch(/Reading your events.*opens instantly/);
    expect(slowLoadMessage(2)).not.toMatch(/Last time/);
    expect(slowLoadMessage(3, 6200)).toMatch(/Last time it took about 6 s\./);
    expect(slowLoadMessage(12)).toMatch(/Still working.*fewer days/);
    expect(slowLoadMessage(45)).toMatch(/longer than usual.*stops after a minute/);
    for (const seconds of [2, 12, 45]) expect(slowLoadMessage(seconds, 6200)).not.toMatch(/%/);
  });
});
