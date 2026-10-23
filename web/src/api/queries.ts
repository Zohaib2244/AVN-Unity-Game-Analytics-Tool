// Server data through TanStack Query. Reads are shared and reused for 30 s (`staleTime`), an answer seen
// in the last 10 minutes is shown at once while the new one loads (`placeholderData`), and every write
// clears everything (`write()`), so an answer is never older than the last change.
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
    staleTime: path && !cacheable(path) ? 0 : CACHE_MS,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    queryFn: ({ signal }) => request<T>(path!, body === undefined ? { signal } : { method: 'POST', body: JSON.stringify(body), signal }),
  };
  return useQuery(queryOptions);
}

/** Fetch outside a component (prefetch on hover, one-off reads); shares the same cache. */
export function read<T>(path: string, body?: unknown): Promise<T> {
  return queryClient.fetchQuery<T>({
    queryKey: readKey(path, body),
    staleTime: cacheable(path) ? CACHE_MS : 0,
    queryFn: ({ signal }) => request<T>(path, body === undefined ? { signal } : { method: 'POST', body: JSON.stringify(body), signal }),
  });
}

export function prefetch(path: string): Promise<void> {
  return queryClient.prefetchQuery({ queryKey: readKey(path), staleTime: CACHE_MS, queryFn: ({ signal }) => request(path, { signal }) }).catch(() => {});
}

/** A write: runs the request, then forgets every cached read so pages refetch. */
export async function write<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  if (analyticsRead(path, options)) return request<T>(path, options);
  try { return await request<T>(path, options); }
  finally { await invalidateAll(); }
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
