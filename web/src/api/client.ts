// The browser's request contract (ported from the old app.js `request`): bounded retries for reads only,
// a 60 s timeout, actionable messages per status, and a memory of how long slow reads took.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type RequestOptions = Omit<RequestInit, 'body' | 'headers'> & { body?: BodyInit | null; headers?: Record<string, string> };

/** Only these POST endpoints are reads (they answer a question instead of changing anything). */
export function analyticsRead(path: string, options: RequestOptions = {}): boolean {
  return (options.method || 'GET').toUpperCase() === 'POST' && /\/insights\/(?:funnel|player-groups|journeys(?:\/players)?)$/.test(path.split('?')[0] ?? '');
}

const STATUS_MESSAGES: Record<number, string> = {
  401: 'Your session has expired. Reload the page to sign in again.',
  403: 'You don’t have permission for this action. Contact a workspace admin.',
  429: 'Too many requests. Wait a moment before trying again.',
  500: 'The server couldn’t finish this request. Try again.',
  502: 'The server is temporarily unavailable. Try again shortly.',
  503: 'The server is temporarily unavailable. Try again shortly.',
  504: 'The server took too long. Try fewer days or retry.',
};

/* ─── Request activity: a small subscribable counter for the "loading" indicator in the shell ─── */
let pending = 0;
const activityListeners = new Set<() => void>();
export const requestActivity = {
  get: () => pending,
  subscribe(listener: () => void) { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; },
};
function changeActivity(delta: number) { pending = Math.max(0, pending + delta); activityListeners.forEach((listener) => listener()); }

export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const canRetry = (options.method || 'GET').toUpperCase() === 'GET';
  const readOnly = canRetry || analyticsRead(path, options);
  const timeoutMessage = readOnly ? 'This request took too long. Try a shorter date range or retry.' : 'The request timed out. Check whether the change was saved before trying again.';
  const timeout = AbortSignal.timeout(60000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  changeActivity(1);
  const began = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(path, {
          credentials: 'same-origin',
          ...options,
          signal,
          headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
        });
      } catch (error) {
        if (timeout.aborted) throw new ApiError(timeoutMessage, 408);
        if ((error as Error).name === 'AbortError') throw error;
        throw new ApiError('Couldn’t connect. Check your connection and try again.', 0);
      }
      if (!canRetry || attempt || ![502, 503, 504].includes(response.status)) break;
      const wait = Math.min(5, Math.max(1, Number(response.headers.get('Retry-After')) || 1));
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
    if (!response) throw new ApiError('Couldn’t connect. Check your connection and try again.', 0);
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { detail?: unknown; errors?: Array<{ loc?: string[]; msg: string }> };
      const details = Array.isArray(error.errors) ? error.errors.map((item) => `${(item.loc || []).filter((part) => part !== 'body').join(' · ')}: ${item.msg}`).join('; ') : '';
      throw new ApiError(details || STATUS_MESSAGES[response.status] || (typeof error.detail === 'string' ? error.detail : 'Please check your details and try again.'), response.status);
    }
    if (response.status === 204) return null as T;
    if (readOnly) rememberSlow(path, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - began);
    try { return (await response.json()) as T; }
    catch { throw new ApiError(timeout.aborted ? timeoutMessage : 'The server returned an unreadable response. Reload or try again.', timeout.aborted ? 408 : response.status); }
  } finally { changeActivity(-1); }
}

/* ─── How long a slow read took last time, so the wait can be named ("last time about 6 s") ─── */
export const SLOW_MS = 1500;
const endpointKey = (path: string) => `avn-slow:${(path.split('?')[0] ?? '').replace(/\/games\/[^/]+/, '/games/*')}`;
export function rememberSlow(path: string, ms: number): void {
  if (ms < SLOW_MS) return;
  try { localStorage.setItem(endpointKey(path), String(Math.round(ms))); } catch { /* storage unavailable */ }
}
export function usualWait(path: string): number | null {
  try { return Number(localStorage.getItem(endpointKey(path))) || null; } catch { return null; }
}
/** What to tell someone who has waited this long. Never a percentage: there is no way to know one. */
export function slowLoadMessage(seconds: number, usual: number | null = null): string {
  if (seconds < 2) return '';
  const last = usual ? ` Last time it took about ${Math.max(1, Math.round(usual / 1000))} s.` : '';
  if (seconds < 10) return `Reading your events. The first load takes a few seconds, then this page opens instantly for a while.${last}`;
  if (seconds < 30) return `Still working. This range has a lot of events; fewer days load faster.${last}`;
  return 'This is taking longer than usual. It stops after a minute and lets you try again, or pick fewer days.';
}

export const isAbort = (error: unknown): boolean => (error as Error | null)?.name === 'AbortError';
export const errorMessage = (error: unknown, fallback = 'Something went wrong. Please try again.'): string => (error instanceof Error && error.message) || fallback;
export const errorStatus = (error: unknown): number => (error instanceof ApiError ? error.status : -1);
