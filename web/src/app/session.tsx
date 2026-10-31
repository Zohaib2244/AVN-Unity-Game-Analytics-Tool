// Who is signed in, which workspace is open, and the workspace overview (games and totals).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request } from '@/api/client';
import { CACHE_MS, queryClient } from '@/api/queries';
import { localTimezoneOffset } from '@/lib/format';
import { canManage, variantsOf, workspaceName, workspaceRole } from '@/lib/games';
import type { Game, Me, Overview } from '@/lib/types';

const WS_KEY = 'avn-workspace';
const readSaved = (): string | null => { try { return localStorage.getItem(WS_KEY); } catch { return null; } };

export const overviewURL = (workspace: string | null): string => `/v1/overview?${new URLSearchParams({ ...(workspace ? { workspace } : {}), tz_offset: String(localTimezoneOffset()) })}`;
export const meKey = ['me'];
export const overviewKey = (workspace: string | null) => ['overview', workspace];

type Session = {
  me: Me;
  overview: Overview;
  overviewError: unknown;
  retryOverview: () => void;
  workspace: string | null;
  chooseWorkspace: (id: string | null) => void;
  /** Reload who I am and the overview after a change (new game, moved game, team edits). */
  refresh: () => Promise<void>;
  role: string;
  canManageGames: boolean;
  workspaceName: string;
  /** The Android and iOS versions of a game in this workspace. */
  variantsOf: (game: Pick<Game, 'name'>) => Game[];
};

const SessionContext = createContext<Session | null>(null);

function pickWorkspace(me: Me, preferred: string | null, current: string | null): string | null {
  const ids = me.workspaces.map((item) => item.id);
  return [preferred, current, readSaved()].find((id) => id && ids.includes(id)) || ids[0] || null;
}

/**
 * Opens with account and registry metadata. Expensive workspace totals load separately,
 * so counting events cannot prevent navigation or opening a game.
 */
export function SessionProvider({ children, loading, failed }: { children: ReactNode; loading: ReactNode; failed: (error: unknown, retry: () => void) => ReactNode }): ReactElement {
  const [workspace, setWorkspace] = useState<string | null>(readSaved);
  const me = useQuery({ queryKey: meKey, queryFn: ({ signal }) => request<Me>('/v1/me', { signal }), staleTime: Infinity });
  const chosen = me.data ? pickWorkspace(me.data, null, workspace) : workspace;
  useEffect(() => { if (me.data && chosen !== workspace) setWorkspace(chosen); }, [me.data, chosen, workspace]);
  const bootstrap = useQuery({
    queryKey: ['workspace', chosen],
    queryFn: ({ signal }) => request<Overview>(`${overviewURL(chosen)}&totals=false`, { signal }),
    enabled: !!me.data,
    staleTime: CACHE_MS,
  });
  const overview = useQuery({
    queryKey: overviewKey(chosen),
    queryFn: ({ signal }) => request<Overview>(overviewURL(chosen), { signal }),
    enabled: !!me.data && !!bootstrap.data,
    staleTime: CACHE_MS,
  });
  const data = overview.data ?? bootstrap.data;

  const chooseWorkspace = useCallback((id: string | null) => {
    setWorkspace(id);
    try { if (id) localStorage.setItem(WS_KEY, id); } catch { /* storage unavailable */ }
    void queryClient.invalidateQueries();
  }, []);
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: meKey });
    await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    // Event totals refresh in the background; saving a game must only wait for metadata.
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  }, []);

  const value = useMemo<Session | null>(() => {
    if (!me.data || !data) return null;
    const account = me.data;
    return {
      me: account, overview: data, overviewError: overview.error, retryOverview: () => { void overview.refetch(); }, workspace: chosen, chooseWorkspace, refresh,
      role: workspaceRole(account, chosen), canManageGames: canManage(account, chosen), workspaceName: workspaceName(account.workspaces, chosen),
      variantsOf: (game) => variantsOf(data.games, game),
    };
  }, [me.data, data, overview.error, overview.refetch, chosen, chooseWorkspace, refresh]);

  if (me.isError) return <>{failed(me.error, () => me.refetch())}</>;
  if (bootstrap.isError && !bootstrap.data && !overview.data) return <>{failed(bootstrap.error, () => bootstrap.refetch())}</>;
  if (!value) return <>{loading}</>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}
