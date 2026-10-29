import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render as renderPlain, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActiveFilters } from '@/lib/filters';
import type { Game } from '@/lib/types';
import { PlayerPage, PlayerViewer } from './PlayerView';

const render = renderPlain;

const { navigate, toast, toastError } = vi.hoisted(() => ({ navigate: vi.fn(), toast: vi.fn(), toastError: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useLocation: () => ({ pathname: '/games/g1/levels' }), useNavigate: () => navigate }));
vi.mock('@/api', () => ({ useRead: () => ({ data: { sessions: 2, events: 12 }, isFetching: false }) }));
vi.mock('@/components/feedback', () => ({
  useNotify: () => ({ toast, toastError }),
  Skeleton: () => null,
  QueryRegion: ({ children }: { children: (data: { sessions: number; events: number }) => React.ReactNode }) => children({ sessions: 2, events: 12 }),
}));
vi.mock('@/components/DateRange', () => ({ DateRange: () => <span>Player date range</span>, resolveRange: () => ({ from: '2026-10-01', to: '2026-10-24' }) }));
vi.mock('./RawTimeline', () => ({ RawTimeline: () => <p>Player timeline</p> }));
vi.mock('./DeviceInfo', () => ({ PlayerInformation: () => <p>Device information</p> }));

const game: Game = { id: 'g1', name: 'Test game', bundle_id: 'com.test.game', platform: 'android', created_at: '' };
const filters: ActiveFilters = { range: { from: '2026-10-01', to: '2026-10-24' }, timezone: 'utc', hideTest: true, versionMode: 'all', environment: [], app_version: [], build: [], country: [], platform: [] };

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

describe('PlayerViewer', () => {
  it('opens a modal, traps focus, and returns to the player link after Escape', async () => {
    function Page() {
      const [player, setPlayer] = useState<string | null>(null);
      return <><button onClick={() => setPlayer('player-one')}>Open player</button><PlayerViewer game={game} player={player} filters={filters} onClose={() => setPlayer(null)} /></>;
    }
    const user = userEvent.setup();
    render(<Page />);
    const trigger = screen.getByRole('button', { name: 'Open player' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Player details' });
    expect(trigger.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(dialog).toHaveClass('dlg');
    expect(within(dialog).getByText('player-one')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Copy player ID' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Player info' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('browses the original group without losing level URL state, and retains the tabs', async () => {
    const load = vi.fn(async () => ({ id: 'player-two' }));
    const user = userEvent.setup();
    render(<PlayerViewer game={game} player="player-one" filters={filters} browse={{ index: 0, total: 2, load }} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: '‹ Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(load).toHaveBeenCalledWith(1);
    expect(screen.getByText('2 of 2')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next ›' })).toBeDisabled();
    const navigation = navigate.mock.calls[0]![0];
    expect(navigation.to).toBe('/games/g1/levels');
    expect(navigation.resetScroll).toBe(false);
    expect(navigation.search({ level: '12', player: 'player-one' })).toEqual({ level: '12', player: 'player-two' });
    await user.click(screen.getByRole('button', { name: 'Player info' }));
    expect(screen.getByText('Device information')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Raw events' }));
    expect(screen.getByText('Player timeline')).toBeVisible();
  });

  it('starts every opening and every browsed player on Raw events, ignoring old saved tabs', async () => {
    localStorage.setItem('avn-story-view-g1', JSON.stringify('info'));
    const user = userEvent.setup();
    const props = { game, filters, onClose: () => {} };
    const { rerender } = render(<PlayerViewer {...props} player="player-one" />);
    expect(screen.getByRole('button', { name: 'Raw events' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Player info' }));
    rerender(<PlayerViewer {...props} player="player-two" />);
    expect(screen.getByRole('button', { name: 'Raw events' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Event Analysis' }));
    rerender(<PlayerViewer {...props} player={null} />);
    rerender(<PlayerViewer {...props} player="player-two" />);
    expect(screen.getByRole('button', { name: 'Raw events' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('copies the full player ID and keeps the viewer open', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<PlayerViewer game={game} player="player-one" filters={filters} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Copy player ID' }));
    expect(writeText).toHaveBeenCalledWith('player-one');
    expect(toast).toHaveBeenCalledWith('Player ID copied.');
    expect(screen.getByRole('dialog', { name: 'Player details' })).toBeVisible();
  });

  it('has no NutBot in the viewer', () => {
    render(<PlayerViewer game={game} player="player-one" filters={filters} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Ask NutBot' })).toBeNull();
  });

  it('the copy icon turns into a tick and says what was copied', async () => {
    const user = userEvent.setup();
    render(<PlayerViewer game={game} player="player-one" filters={filters} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Copy player ID' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
    expect(toast).toHaveBeenCalledWith('Player ID copied.');
  });
});

describe('PlayerPage', () => {
  it('shows the player in the page with a way back, and browses without a dialog', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const load = vi.fn(async () => ({ id: 'player-two' }));
    render(<PlayerPage game={game} player="player-one" filters={filters} browse={{ index: 0, total: 2, load }} onBack={onBack} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('player-one')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Raw events' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(load).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole('button', { name: '← Players' }));
    expect(onBack).toHaveBeenCalled();
  });
});
