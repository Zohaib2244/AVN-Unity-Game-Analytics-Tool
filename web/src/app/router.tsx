// Routes (TanStack Router, code-based). Filters, ranges and views live in search params where a page
// supports "copy link to this view"; everything else is remembered per game in localStorage.
import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Shell } from './Shell';
import { GameSection } from './GameSection';
import { HomePage } from '@/pages/Home';
import { NewGamePage } from '@/pages/NewGame';
import { TeamPage, WorkspacesPage } from '@/pages/Team';
import { StatusPage } from '@/pages/Status';
import { SettingsPage } from '@/pages/Settings';
import { NotFoundPage } from '@/pages/NotFound';
import { LEGACY_PAGES } from '@/lib/games';

export type Search = Record<string, string>;
const search = (raw: Record<string, unknown>): Search => Object.fromEntries(Object.entries(raw).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));

const rootRoute = createRootRoute({ component: () => <Shell><Outlet /></Shell>, notFoundComponent: NotFoundPage, validateSearch: search });
const home = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });
const games = createRoute({ getParentRoute: () => rootRoute, path: '/games', component: HomePage });
const newGame = createRoute({ getParentRoute: () => rootRoute, path: '/games/new', component: NewGamePage, validateSearch: search });
const gameHome = createRoute({ getParentRoute: () => rootRoute, path: '/games/$gameId', component: GameSection, validateSearch: search });
const gameSection = createRoute({ getParentRoute: () => rootRoute, path: '/games/$gameId/$section', component: GameSection, validateSearch: search });
const team = createRoute({ getParentRoute: () => rootRoute, path: '/team', component: TeamPage });
const workspaces = createRoute({ getParentRoute: () => rootRoute, path: '/workspaces', component: WorkspacesPage });
const status = createRoute({ getParentRoute: () => rootRoute, path: '/status', component: StatusPage, validateSearch: search });
const settings = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });
// Old workspace-level pages (/keys?game=…) open inside the game now; the redirect is finished in GameSection
// once the games are known, so here they only keep their query.
const legacy = LEGACY_PAGES.map((path) => createRoute({ getParentRoute: () => rootRoute, path, validateSearch: search, beforeLoad: ({ search: query }) => { throw redirect({ to: '/games/$gameId/$section', params: { gameId: query.game || '-', section: path.slice(1) }, search: Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'game')) }); } }));

const routeTree = rootRoute.addChildren([home, games, newGame, gameHome, gameSection, team, workspaces, status, settings, ...legacy]);
export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
