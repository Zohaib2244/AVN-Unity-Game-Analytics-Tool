// Live events: keeping the newest events across polls (pure, so it can be tested without a browser).

export type LiveEvent = {
  cursor: number; event_id: string; name: string; client_ts: string; server_ts: string;
  user_id: string | null; device_id: string | null; session_id: string | null; app_version: string | null; environment: string | null;
  params: Record<string, unknown>;
};
export type LivePage = { events: LiveEvent[]; cursor: number; scanned_from: number | null };

/** How many events the page keeps in memory; older ones drop off the bottom. */
export const KEEP = 200;
/** How often the page asks for new events while it is visible and not paused. */
export const POLL_MS = 2000;

/** Newest first, no event twice, at most `keep`. `incoming` arrives oldest first, as the server sends it. */
export function mergeLive(shown: LiveEvent[], incoming: LiveEvent[], keep = KEEP): LiveEvent[] {
  if (!incoming.length) return shown;
  const seen = new Set(shown.map((item) => item.event_id));
  const fresh = incoming.filter((item) => !seen.has(item.event_id)).reverse();
  return [...fresh, ...shown].slice(0, keep);
}

/** Parameters as one line: `KEY=value · KEY=value`, objects as JSON. */
export function paramsText(params: Record<string, unknown>): string {
  return Object.entries(params).map(([key, value]) => `${key}=${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`).join(' · ');
}

/** Who sent it: the user ID when there is one, else the device ID. */
export const sender = (item: Pick<LiveEvent, 'user_id' | 'device_id'>): string => item.user_id || item.device_id || '—';

/** The build an event came from, with its environment when the game names one: `2.4.0 · editor`. */
export const buildText = (item: Pick<LiveEvent, 'app_version' | 'environment'>): string => `${item.app_version ?? '—'}${item.environment ? ` · ${item.environment}` : ''}`;
