import { afterEach, expect, it, vi } from 'vitest';
import { affectedRead, freshnessMs, queryClient, readKey, write } from './queries';

afterEach(() => { queryClient.clear(); vi.unstubAllGlobals(); });

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
