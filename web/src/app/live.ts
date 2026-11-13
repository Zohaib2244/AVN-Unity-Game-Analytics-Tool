// What is arriving now, for every game of the workspace: the same light read the sidebar chip uses
// (`health/live`), asked again every 30 seconds while the tab is open, and its "how long ago" counted on the
// screen's own clock in between. One place, so a card, the status page and the sidebar always use the same words.
import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { request } from '@/api/client';
import { readKey } from '@/api/queries';
import { gameURL } from '@/lib/games';
import type { Game, IngestMeterData } from '@/lib/types';
import { meterState, type MeterState } from '@/app/IngestMeter';

export const POLL_MS = 30000;
export type Live = { state: MeterState; age: number | null; data: IngestMeterData | undefined };

/** Seconds since the last event of every game, by game id; `age` is null until the first answer or when nothing was ever received. */
export function useLive(games: Array<Pick<Game, 'id'>>): Map<string, Live> {
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick((count) => count + 1), 5000); return () => clearInterval(timer); }, []);
  const results = useQueries({
    queries: games.map((game) => {
      const path = `${gameURL(game)}/health/live`;
      return { queryKey: readKey(path), queryFn: ({ signal }: { signal: AbortSignal }) => request<IngestMeterData>(path, { signal }), refetchInterval: POLL_MS, staleTime: POLL_MS / 2 };
    }),
  });
  const live = new Map<string, Live>();
  games.forEach((game, index) => {
    const result = results[index];
    const data = result?.data;
    const age = data?.last_event_at ? (Date.parse(data.now) - Date.parse(data.last_event_at)) / 1000 + Math.max(0, (Date.now() - (result?.dataUpdatedAt ?? Date.now())) / 1000) : null;
    live.set(game.id, { state: data ? meterState(age) : 'empty', age, data });
  });
  return live;
}

/** The freshest of several games (a game's Android and iOS versions share one card). */
export function freshest(items: Array<Live | undefined>): Live | undefined {
  const known = items.filter((item): item is Live => !!item?.data);
  if (!known.length) return undefined;
  return known.reduce((best, item) => ((item.age ?? Infinity) < (best.age ?? Infinity) ? item : best));
}
