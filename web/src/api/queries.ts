// Server data through TanStack Query. Reads are shared and reused for 30 s (`staleTime`), an answer seen
// in the last 10 minutes is shown at once while the new one loads (`placeholderData`), and every write
// invalidates affected reads after writes.
import { QueryClient, keepPreviousData, useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { analyticsRead, request, type RequestOptions } from './client';

export const CACHE_MS = 30000;
export const STALE_MS = 10 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: CACHE_MS, gcTime: STALE_MS, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: true },
    mutations: { retry: false },
  },
});

/** Event counts (/health) and exports are always fetched live. */
export const cacheable = (path: string): boolean => !path.includes('/health') && !path.includes('/export');

export function freshnessMs(path: string): number {
  if (!cacheable(path)) return 0;
  return /\/games\/[^/]+\/(?:dictionary|insights\/(?:funnels|group-library))$/.test(path.split('?')[0] ?? '') ? 5 * 60 * 1000 : CACHE_MS;
}

/** Unknown/global mutations retain broad invalidation, including account/access changes. */
export function affectedRead(mutation: string, readPath: string): boolean {
  const changed = mutation.split('?')[0] ?? '';
  const target = readPath.split('?')[0] ?? '';
  const match = changed.match(/^(\/v1\/games\/[^/]+)(\/.*)?$/);
  if (!match) return true;
  const [, game, suffix = ''] = match;
  if (!game || suffix === '/move' || suffix.startsWith('/access')) return true;
  const isolated = suffix.match(/^\/(keys|insights\/(?:funnels|group-library)|nutbot\/chats)(?:\/|$)/);
  if (isolated) return target === '/v1/audit' || target === game + '/' + isolated[1] || target.startsWith(game + '/' + isolated[1] + '/');
  return target === game || target.startsWith(game + '/') || target === '/v1/games' || target === '/v1/audit';
}

export type ReadOptions = { body?: unknown; enabled?: boolean; refetchInterval?: number | false; keepPrevious?: boolean };

export const readKey = (path: string, body?: unknown): unknown[] => (body === undefined ? ['read', path] : ['read', path, body]);

/** A GET (or an analytics POST read when `body` is given), shared through the query cache. */
export function useRead<T>(path: string | null, options: ReadOptions = {}): UseQueryResult<T> {
  const { body, enabled = true, refetchInterval = false, keepPrevious = true } = options;
  const key = readKey(path ?? '', body);
  const queryOptions: UseQueryOptions<T> = {
    queryKey: key,
    enabled: enabled && path !== null,
    refetchInterval,
    staleTime: path ? freshnessMs(path) : CACHE_MS,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    queryFn: ({ signal }) => request<T>(path!, body === undefined ? { signal } : { method: 'POST', body: JSON.stringify(body), signal }),
  };
  return useQuery(queryOptions);
}

/** Fetch outside a component (prefetch on hover, one-off reads); shares the same cache. */
export function read<T>(path: string, body?: unknown): Promise<T> {
  return queryClient.fetchQuery<T>({
    queryKey: readKey(path, body),
    staleTime: freshnessMs(path),
    queryFn: ({ signal }) => request<T>(path, body === undefined ? { signal } : { method: 'POST', body: JSON.stringify(body), signal }),
  });
}

export function prefetch(path: string): Promise<void> {
  return queryClient.prefetchQuery({ queryKey: readKey(path), staleTime: freshnessMs(path), queryFn: ({ signal }) => request(path, { signal }) }).catch(() => {});
}

/** Reconcile affected reads, including uncertain failures that may have committed. */
export async function write<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  if (analyticsRead(path, options)) return request<T>(path, options);
  try { return await request<T>(path, options); }
  finally {
    await queryClient.invalidateQueries({ predicate: (query) => {
      const [kind, readPath] = query.queryKey;
      return kind === 'read' && typeof readPath === 'string' && affectedRead(path, readPath);
    } });
  }
}

export function invalidateAll(): Promise<void> {
  return queryClient.invalidateQueries();
}

/** Refetch everything on screen now (the Refresh button, auto-refresh, coming back online). */
export async function refreshAll(): Promise<void> {
  await queryClient.invalidateQueries({ refetchType: 'active' });
  markFresh();
}

/* ─── Freshness: when the page last got fresh data ─── */
let lastUpdated = Date.now();
const freshListeners = new Set<() => void>();
export const freshness = {
  get: () => lastUpdated,
  subscribe(listener: () => void) { freshListeners.add(listener); return () => { freshListeners.delete(listener); }; },
};
export function markFresh(): void { lastUpdated = Date.now(); freshListeners.forEach((listener) => listener()); }
