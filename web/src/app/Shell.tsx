// App shell (avn-ux shell.md): grouped sidebar with one sliding highlight, top bar, account menu,
// command palette (Ctrl/Cmd + K), tablet rail and phone tab bar, refresh and auto-refresh, the bell,
// copy link, theme switch, shortcuts (Ctrl /), offline banner, request activity.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { AccountMenu, AppShell, BellButton, CommandPalette, IconButton, MoreSheet, NotificationList, Page, Popover, SearchButton, ShortcutsDialog, Sidebar, SidebarNav, SingleSelect, TabBar, TopBar, Workspace, type CommandItem, type IconName, type NavGroup } from '@avn/ui';
import { freshness, refreshAll, requestActivity } from '@/api';
import { GAME_SECTIONS, PLATFORM_ORDER, ROLE_LABELS, gameGroups, gamePath, iconURL, initials, sameGame, withIcon } from '@/lib/games';
import { platformLabel, relativeTime } from '@/lib/format';
import { copyText } from '@/lib/store';
import { useNotify } from '@/components/feedback';
import { BrandMark } from '@/components/BrandMark';
import { Ico } from '@/components/icons';
import { useSession } from './session';
import { useCurrentGame } from './GameSection';
import { useNutBot } from './nutbot';
import { NutBotHost } from '@/pages/nutbot/NutBot';
import { useTheme } from './theme';
import { GameSwitcher, variantFor } from './GameSwitcher';
import { useBrowserPage } from './browserPage';

const NAV_GROUPS: NavGroup[] = [
  { label: 'Analyze', items: GAME_SECTIONS.slice(0, 4).map(([id, icon, label]) => ({ id, icon: icon as IconName, label })) },
  { label: 'Data', items: GAME_SECTIONS.slice(4, 7).map(([id, icon, label]) => ({ id, icon: icon as IconName, label })) },
  { label: 'Manage', collapsible: true, defaultClosed: true, items: GAME_SECTIONS.slice(7).map(([id, icon, label]) => ({ id, icon: icon as IconName, label })) },
];
const PHONE_TABS = ['overview', 'funnels', 'levels', 'players'];
const AUTO_KEY = 'avn-auto-refresh';

function useActivity(): boolean {
  const pending = useSyncExternalStore(requestActivity.subscribe, requestActivity.get, requestActivity.get);
  const [shown, setShown] = useState(false);
  useEffect(() => { if (!pending) { setShown(false); return; } const timer = setTimeout(() => setShown(true), 250); return () => clearTimeout(timer); }, [pending]);
  return shown;
}

export function Shell({ children }: { children: ReactNode }): ReactElement {
  const { me, overview, workspace, chooseWorkspace, role, canManageGames, variantsOf } = useSession();
  const { game, section } = useCurrentGame();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const href = useRouterState({ select: (state) => state.location.href });
  const gameIds = useMemo(() => overview.games.map((item) => item.id), [overview.games]);
  useBrowserPage(href, workspace, me.email || me.source, gameIds);
  const { toast } = useNotify();
  const { theme, density, toggleTheme } = useTheme();
  const nutbot = useNutBot();
  const busy = useActivity();
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [bell, setBell] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [refreshMenu, setRefreshMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [auto, setAuto] = useState<number>(() => Number(localStorage.getItem(AUTO_KEY) || 0));
  const bellButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const switchAnchor = useRef<HTMLElement | null>(null);
  const openSwitcher = useCallback((from?: HTMLElement | null) => {
    switchAnchor.current = from ?? document.querySelector<HTMLElement>('.crumbs > span:nth-child(2) > .crumb-link') ?? document.querySelector<HTMLElement>('.game-switch, .m-switch');
    setSwitcher(true);
  }, []);
  const updated = useSyncExternalStore(freshness.subscribe, freshness.get, freshness.get);

  const refresh = useCallback(async () => { setRefreshing(true); try { await refreshAll(); } finally { setRefreshing(false); } }, []);
  const setAutoRefresh = useCallback((minutes: number, announce = true) => {
    setAuto(minutes);
    try { localStorage.setItem(AUTO_KEY, String(minutes)); } catch { /* storage unavailable */ }
    if (announce) toast(minutes ? `Auto-refresh every ${minutes} min` : 'Auto-refresh off', null, 'info', minutes ? 'The page refreshes while this tab is open.' : '');
  }, [toast]);
  useEffect(() => { if (!auto) return; const timer = setInterval(() => { if (!document.hidden) void refresh(); }, auto * 60000); return () => clearInterval(timer); }, [auto, refresh]);
  useEffect(() => {
    const off = () => setOnline(false);
    const on = () => { setOnline(true); void refresh(); toast('Back online', null, 'info', 'The page is refreshing.'); };
    window.addEventListener('offline', off); window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, [refresh, toast]);

  const copyLink = useCallback(async () => { toast((await copyText(location.href)) ? 'Link copied. It opens this same page.' : 'Copy failed: your browser blocked clipboard access.'); }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette(true); }
      else if (mod && event.key === '/') { event.preventDefault(); setShortcuts(true); }
      else if (mod && event.key.toLowerCase() === 'j') { event.preventDefault(); if (nutbot.usable) nutbot.toggle(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [nutbot]);

  const title = game ? (GAME_SECTIONS.find(([key]) => key === section)?.[2] ?? 'Overview') : ({ '/': 'Games', '/games': 'Games', '/games/new': 'Register game', '/team': 'Team', '/workspaces': 'Workspaces', '/status': 'Server status', '/settings': 'Settings' } as Record<string, string>)[pathname] || 'AVN Analytics';
  useEffect(() => { document.title = `${game ? `${title} · ${game.name}` : title} · AVN Analytics`; }, [title, game]);

  const accountItems = useMemo(() => [
    ...(me.can_manage_team ? [{ id: '/workspaces', label: 'Workspaces', icon: 'grid' as IconName }, { id: '/team', label: 'Team', icon: 'team' as IconName }] : []),
    { id: '/status', label: 'Server status', icon: 'pulse' as IconName }, { id: '/settings', label: 'Settings', icon: 'sliders' as IconName }, { id: 'theme', label: 'Light or dark theme', icon: 'eye' as IconName },
  ], [me.can_manage_team]);
  const onAccount = (id: string) => (id === 'theme' ? toggleTheme() : navigate({ to: id }));
  const commands = useMemo<CommandItem[]>(() => [
    ...(game ? NAV_GROUPS.flatMap((group) => group.items.map((item) => ({ id: `page:${item.id}`, group: 'Pages', label: item.label, icon: item.icon, hint: game.name, run: () => navigate({ to: gamePath(game, item.id) }) }))) : []),
    { id: 'page:games', group: 'Pages', label: 'All games', icon: 'grid', run: () => navigate({ to: '/' }) },
    ...accountItems.filter((item) => item.id !== 'theme').map((item) => ({ id: `page:${item.id}`, group: 'Pages', label: item.label, icon: item.icon, run: () => navigate({ to: item.id }) })),
    ...gameGroups(overview.games).map((group) => ({ id: `game:${group.primary.id}`, group: 'Games', label: group.name, icon: 'pad' as IconName, hint: game && sameGame(group.primary, game) ? 'this game' : group.primary.bundle_id, run: () => navigate({ to: gamePath(variantFor(group, game?.platform), game ? section : 'overview') }) })),
    { id: 'act:refresh', group: 'Actions', label: 'Refresh data', icon: 'refresh', run: () => void refresh() },
    { id: 'act:link', group: 'Actions', label: 'Copy link to this view', icon: 'link', run: () => void copyLink() },
    { id: 'act:theme', group: 'Actions', label: 'Switch light or dark theme', icon: 'eye', run: toggleTheme },
    ...(nutbot.usable ? [{ id: 'act:nutbot', group: 'Actions', label: 'Ask NutBot', icon: 'bot' as IconName, run: () => nutbot.setOpen(true) }] : []),
  ], [game, accountItems, overview.games, navigate, refresh, copyLink, toggleTheme, nutbot]);

  const accountName = me.name || (me.email || '').split('@')[0] || 'Administrator';
  const variants = game ? variantsOf(game) : [];
  const missing = game && canManageGames ? PLATFORM_ORDER.filter((platform) => !variants.some((item) => item.platform === platform)) : [];
  const mark = game ? withIcon(variants) : null;
  const workspaceNav: NavGroup[] = [{ label: 'Workspace', items: [{ id: '/', label: 'Games', icon: 'grid' }] }];
  const navActive = game ? section : ['/', '/games', '/games/new'].includes(pathname) ? '/' : null;
  const onNav = (id: string) => navigate({ to: game ? gamePath(game, id) : id });
  const labels = Object.fromEntries(NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item])));
  const tabs = game ? PHONE_TABS.map((key) => labels[key]!) : [{ id: '/', label: 'Games', icon: 'grid' as IconName }, ...accountItems.slice(0, 3).map((item) => ({ ...item, label: item.label.replace('Server status', 'Status') }))];
  const sheetSections = [
    ...(game ? NAV_GROUPS.map((group) => ({ label: group.label, items: group.items.filter((item) => !PHONE_TABS.includes(item.id)) })).filter((group) => group.items.length) : []),
    { label: 'Account', items: accountItems },
  ];

  const sidebar = (
    <Sidebar>
      <Link to="/" className="brand" title="All games"><span className="mark px-mark" aria-hidden="true"><BrandMark size={28} /></span><span className="brand-t">AVN Analytics</span></Link>
      {me.workspaces.length > 1 || me.is_admin ? (
        <div className="ws-switch"><label className="eyebrow" htmlFor="ws-select">Workspace</label>
          <select id="ws-select" value={workspace ?? ''} onChange={(event) => { chooseWorkspace(event.target.value); void navigate({ to: '/' }); }}>{me.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      ) : null}
      {game ? (
        <>
          <button type="button" className="game game-switch" aria-haspopup="listbox" aria-expanded={switcher} title={`${game.name} · ${game.bundle_id}. Switch game`} onClick={(event) => openSwitcher(event.currentTarget)}><span className="g-ic">{mark ? <img src={iconURL(mark)} alt="" width={30} height={30} /> : initials(game.name)}</span><span className="gm"><b>{game.name}</b><small>{game.bundle_id}</small></span><Ico name="chevron" size={14} /></button>
          <div className={`platforms${variants.length + missing.length < 2 ? ' one' : ''}`} role="group" aria-label="Platform">
            {variants.map((item) => <Link key={item.id} to={gamePath(item, section)} className={item.id === game.id ? 'on' : ''} aria-current={item.id === game.id ? 'page' : undefined} title={item.bundle_id}>{platformLabel(item.platform)}{item.archived_at ? ' · paused' : ''}</Link>)}
            {missing.map((platform) => <Link key={platform} className="add" to="/games/new" search={{ name: game.name, bundle_id: game.bundle_id, platform }} title={`Register the ${platformLabel(platform)} version`}>+ {platformLabel(platform)}</Link>)}
          </div>
        </>
      ) : null}
      <SidebarNav groups={game ? NAV_GROUPS : workspaceNav} active={navActive} onSelect={onNav} label={game ? 'Game' : 'Workspace'} />
      <AccountMenu name={accountName} role={`${ROLE_LABELS[role] || role}${me.source === 'lan' ? ' · local network' : ''}`} initial={accountName.slice(0, 1).toUpperCase()} items={accountItems} onSelect={onAccount} />
    </Sidebar>
  );
  const crumbs = game
    ? [{ label: 'Games', onClick: () => navigate({ to: '/' }) }, { label: `${game.name} · ${platformLabel(game.platform)}`, onClick: () => openSwitcher() }, { label: title }]
    : [{ label: 'Workspace' }, { label: title }];

  return (
    <>
      {busy ? <div id="request-activity" role="status" aria-label="Loading data"><span /><span className="sr-only">Loading data…</span></div> : null}
      {!online ? <div id="conn-banner" className="conn-banner" role="alert"><Ico name="shield" size={15} /><span><b>You’re offline.</b> Showing data from {new Date(updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. It refreshes by itself when you’re back.</span></div> : null}
      <AppShell sidebar={sidebar} density={density === 'compact' ? 'compact' : 'comfort'} tabbar={<TabBar items={tabs} active={navActive} onSelect={onNav} moreItems onMore={() => setSheet(true)} />}>
        <Workspace>
          <TopBar crumbs={crumbs} mobileTitle={game ? (
              <button type="button" className="m-switch" aria-haspopup="listbox" aria-expanded={switcher} aria-label={`${title} · ${game.name}. Switch game`} onClick={(event) => openSwitcher(event.currentTarget)}><span className="mark" aria-hidden="true">{mark ? <img src={iconURL(mark)} alt="" width={24} height={24} /> : <BrandMark size={24} />}</span><span className="m-switch-t"><b>{title}</b><small>{game.name} · {platformLabel(game.platform)}</small></span><Ico name="chevron" size={13} /></button>
            ) : <><span className="mark" aria-hidden="true"><BrandMark size={24} /></span><b>{title}</b></>}
            tools={<>
              <SearchButton onClick={() => setPalette(true)} />
              <span className="refresh-wrap"><button ref={refreshButton} type="button" className={`icon-btn${refreshing ? ' spinning' : ''}`} aria-haspopup="menu" aria-expanded={refreshMenu} title="Refresh and auto-refresh" aria-label="Refresh and auto-refresh" onClick={() => setRefreshMenu((open) => !open)}><Ico name="refresh" size={16} />{auto ? <span className="auto-tag">{auto}m</span> : null}</button></span>
              <IconButton icon="link" label="Copy link to this view" onClick={() => void copyLink()} />
              <BellButton ref={bellButton} onClick={() => setBell((open) => !open)} />
              <button type="button" className="icon-btn" title="Switch light/dark theme" aria-label="Switch light/dark theme" onClick={toggleTheme}><Ico name={theme === 'light' ? 'moon' : 'sun'} size={16} /></button>
              {nutbot.usable ? <button type="button" className="btn sm nb-launcher" onClick={nutbot.toggle} aria-pressed={nutbot.open}><Ico name="sparkle" size={14} /> NutBot</button> : null}
            </>} />
          <Page pageKey={pathname}>
            <div id="main">{children}</div>
            <footer className="footnote"><span><Ico name="shield" size={13} /> Your data stays on your server.</span><button type="button" className="fresh" onClick={() => void refresh()} title="Refresh this page"><Ico name="refresh" size={13} /><span>Updated {relativeTime(updated)}</span></button></footer>
          </Page>
        </Workspace>
        <MoreSheet open={sheet} onClose={() => setSheet(false)} sections={sheetSections} onSelect={(id) => (game && labels[id] ? onNav(id) : onAccount(id))} />
        <Popover position="fixed" open={refreshMenu} onClose={() => setRefreshMenu(false)} anchor={refreshButton} width={240}>
          <div className="pop-scroll"><button type="button" className="opt" onClick={() => { setRefreshMenu(false); void refresh(); }}><span className="tick"><Ico name="refresh" size={15} /></span><span className="ot">Refresh now</span><span className="oc">this page</span></button><div className="pop-grp"><span className="eyebrow">Auto-refresh</span></div></div>
          <SingleSelect options={[{ value: '0', label: 'Off' }, { value: '1', label: 'Every minute' }, { value: '5', label: 'Every 5 minutes' }, { value: '15', label: 'Every 15 minutes' }]} value={String(auto)} onChange={(value) => { setRefreshMenu(false); setAutoRefresh(Number(value)); }} />
        </Popover>
        <GameSwitcher open={switcher} onClose={() => setSwitcher(false)} anchor={switchAnchor} games={overview.games} current={game} onPick={(next) => navigate({ to: gamePath(next, section) })} onAll={() => navigate({ to: '/' })} onRegister={canManageGames ? () => navigate({ to: '/games/new' }) : undefined} />
        <Popover position="fixed" open={bell} onClose={() => setBell(false)} anchor={bellButton} width={360}><NotificationList onClose={() => setBell(false)} /></Popover>
        <CommandPalette open={palette} onClose={() => setPalette(false)} items={commands} onAsk={nutbot.usable ? (text) => nutbot.ask(text) : undefined} />
        <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
        <NutBotHost />
      </AppShell>
      <span hidden data-href={href} />
    </>
  );
}
