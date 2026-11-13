// A page inside a game: finds the game (switching workspace when it belongs to another one the person
// is a member of), then draws the section. Old section names are redirected.
import { useEffect, type ReactElement } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { request } from '@/api';
import { useSession } from './session';
import { MOVED_SECTIONS, gamePath, isSection, type Section } from '@/lib/games';
import type { Game } from '@/lib/types';
import { Skeleton } from '@/components/feedback';
import { NotFoundPage } from '@/pages/NotFound';
import { GameOverviewPage } from '@/pages/GameOverview';
import { LevelsPage } from '@/pages/Levels';
import { PlayersPage } from '@/pages/Players';
import { SessionsPage } from '@/pages/Sessions';
import { AdsPage } from '@/pages/Ads';
import { AcquisitionPage } from '@/pages/Acquisition';
import { ExportsPage } from '@/pages/Exports';
import { DictionaryPage } from '@/pages/Dictionary';
import { EventSetupPage } from '@/pages/EventSetup';
import { KeysPage } from '@/pages/Keys';
import { GameSettingsPage } from '@/pages/GameSettings';

const PAGES: Record<Section, (props: { game: Game }) => ReactElement> = {
  overview: GameOverviewPage, levels: LevelsPage, players: PlayersPage, sessions: SessionsPage, ads: AdsPage, acquisition: AcquisitionPage, exports: ExportsPage,
  dictionary: DictionaryPage, 'event-setup': EventSetupPage, keys: KeysPage, settings: GameSettingsPage,
};

/** The game and section of the current address, or null outside a game. Used by the shell and pages. */
export function useCurrentGame(): { game: Game | null; section: Section } {
  const { overview } = useSession();
  const params = useParams({ strict: false }) as { gameId?: string; section?: string };
  const raw = params.section || 'overview';
  const section = (MOVED_SECTIONS[raw] || raw) as string;
  const game = params.gameId && params.gameId !== 'new' ? overview.games.find((item) => item.id === params.gameId) || null : null;
  return { game, section: isSection(section) ? section : 'overview' };
}

export function GameSection(): ReactElement {
  const { overview, me, workspace, chooseWorkspace } = useSession();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { gameId?: string; section?: string };
  const query = useSearch({ strict: false }) as Record<string, string>;
  const wanted = params.gameId || '';
  const raw = params.section || 'overview';
  const moved = MOVED_SECTIONS[raw];
  const section = moved || raw;
  // Old workspace pages redirect here with "-" when no game was given: open the first game.
  const game = wanted === '-' ? overview.games[0] || null : overview.games.find((item) => item.id === wanted) || null;
  // Maybe a game of another workspace the person belongs to.
  const elsewhere = useQuery({ queryKey: ['game-elsewhere', wanted], enabled: !game && wanted !== '-' && !!wanted, retry: false, queryFn: ({ signal }) => request<Game>(`/v1/games/${encodeURIComponent(wanted)}`, { signal }).catch(() => null) });
  useEffect(() => {
    if (game && (wanted === '-' || moved)) { void navigate({ to: gamePath(game, section), search: query, replace: true, hash: moved === 'event-setup' ? 'mappings' : undefined }); return; }
    const found = elsewhere.data;
    if (!game && found?.workspace_id && found.workspace_id !== workspace && me.workspaces.some((item) => item.id === found.workspace_id)) chooseWorkspace(found.workspace_id);
  }, [game, wanted, moved, section, elsewhere.data, workspace, me.workspaces, chooseWorkspace, navigate, query]);
  if (!game) {
    if (elsewhere.isFetching || (elsewhere.data?.workspace_id && elsewhere.data.workspace_id !== workspace)) return <Skeleton kind="stats" />;
    return <NotFoundPage />;
  }
  if (!isSection(section)) return <NotFoundPage />;
  const Page = PAGES[section];
  return <Page key={`${game.id}:${section}`} game={game} />;
}
