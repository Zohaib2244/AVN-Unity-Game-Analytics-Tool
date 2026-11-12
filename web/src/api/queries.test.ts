import { afterEach, expect, it, vi } from 'vitest';
import { affectedRead, freshnessMs, queryClient, read, readKey, write } from './queries';

afterEach(() => { queryClient.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps unrelated games fresh but invalidates derived data after mapping edits', () => {
  expect(affectedRead('/v1/games/a/dictionary/start/mappings', '/v1/games/a/insights/summary?days=30')).toBe(true);
  expect(affectedRead('/v1/games/a/dictionary/start/mappings', '/v1/games/b/insights/summary')).toBe(false);
  expect(affectedRead('/v1/workspaces/w/analytics-thresholds', '/v1/games/b/insights/summary')).toBe(true);
});

it('refreshes saved funnels without recalculating dashboard data', async () => {
  const saved = '/v1/games/a/insights/funnels';
  const summary = '/v1/games/a/insights/summary';
  queryClient.setQueryData(readKey(saved), []);
  queryClient.setQueryData(readKey(summary), { players: 10 });
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
  await write(saved + '/one', { method: 'PUT', body: '{}' });
  expect(queryClient.getQueryState(readKey(saved))?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(readKey(summary))?.isInvalidated).toBe(false);
});

it('reconciles uncertain write failures without invalidating other games', async () => {
  const a = '/v1/games/a/dictionary';
  const b = '/v1/games/b/dictionary';
  queryClient.setQueryData(readKey(a), []);
  queryClient.setQueryData(readKey(b), []);
  vi.stubGlobal('fetch', async () => { throw new Error('connection lost'); });
  await expect(write(a, { method: 'PUT' })).rejects.toThrow();
  expect(queryClient.getQueryState(readKey(a))?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(readKey(b))?.isInvalidated).toBe(false);
});

it('keeps configuration longer while counts remain live and analytics stay short lived', () => {
  expect(freshnessMs('/v1/games/a/dictionary')).toBe(300000);
  expect(freshnessMs('/v1/games/a/insights/summary')).toBe(30000);
  expect(freshnessMs('/v1/games/a/health')).toBe(0);
});

it('refreshes player group counts after save, deletion and Undo', () => {
  for (const suffix of ['', '/one', '/one/restore']) {
    expect(affectedRead(`/v1/games/a/insights/group-library${suffix}`, '/v1/games/a/insights/player-group-counts?start=2026-10-01')).toBe(true);
    expect(affectedRead(`/v1/games/a/insights/group-library${suffix}`, '/v1/games/b/insights/player-group-counts')).toBe(false);
  }
});

it('polls a pending view until ready without caching its pending response as data', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Preparing this view…' }), { status: 202, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ levels: [1] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const path = '/v1/games/a/insights/levels';
  const pending = read(path);
  await vi.advanceTimersByTimeAsync(0);
  expect(queryClient.getQueryData(readKey(path))).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual({ levels: [1] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('cancels preparation polling when its query is cancelled', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(async () => new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const path = '/v1/games/a/insights/levels';
  const pending = read(path).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  await queryClient.cancelQueries({ queryKey: readKey(path) });
  await pending;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(1);
});
