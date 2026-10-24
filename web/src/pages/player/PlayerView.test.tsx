import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActiveFilters } from '@/lib/filters';
import type { Game } from '@/lib/types';
import { PlayerViewer } from './PlayerView';

const { navigate, toastError } = vi.hoisted(() => ({ navigate: vi.fn(), toastError: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useLocation: () => ({ pathname: '/games/g1/levels' }), useNavigate: () => navigate }));
vi.mock('@/api', () => ({ useRead: () => ({ data: { sessions: 2, events: 12 }, isFetching: false }) }));
vi.mock('@/components/feedback', () => ({
  useNotify: () => ({ toastError }),
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
    const close = within(dialog).getByRole('button', { name: 'Close ×' });
    expect(close).toHaveFocus();
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
});
