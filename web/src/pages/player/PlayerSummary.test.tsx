// The Player tab's summary: the numbers as given, and plain words where a game sends nothing.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PlayerSummaryData } from '@/lib/types';
import { firstTryShare, levelsPerAd, plain, PlayerSummaryView } from './PlayerSummary';

const base: PlayerSummaryData = {
  player: 'p1', events_counted: 100, partial: false, first_seen: '2026-10-28T10:00:00+00:00', last_seen: '2026-10-30T10:00:00+00:00',
  sessions: { count: 12, active_days: 3, per_day: [['2026-10-28', 5], ['2026-10-29', 4], ['2026-10-30', 3]] },
  ads: { formats: { Interstitial: { shown: 71, closed: 62, failed: 5, rewarded: 0, placements: { level_interstitial: 69 }, reasons: { Timeout: 4 } }, Rewarded: { shown: 22, closed: 19, failed: 2, rewarded: 17, placements: {}, reasons: {} } }, shown: 93, failed: 7, average_seconds_on_screen: 27 },
  levels: { cleared: 622, highest: 875, clears: 622, fails: 42, left: 11, first_try_clears: 585, average_seconds: 20, median_seconds: 15, fastest_seconds: 1, slowest_seconds: 934, average_moves: 23.6, restarts: 23, revives: 28, pace: [[1, 10], [2, 30], [3, 20]], hardest: [{ level: 313, bad_attempts: 6, cleared: true }] },
  economy: { balances: { coins: 6795 }, balance_history: [], earned: { level_reward: 13020 }, spent: { extra_balls: 4750 }, inventory: { bomb: 0, rockets: 1 }, flags: { has_purchased: 0 }, save_level: 665 },
  powerups: { used: { bomb: 11 }, obtained: [{ powerup: 'bomb', source: 'RewardedAd', count: 5 }] },
  screens: { main_menu: 10 }, background: { Ad: 117, Player: 56 }, tutorials: { shown: 0, completed: 0 }, shop_taps: 2, levels_ended_by_kill: 11,
};

describe('PlayerSummaryView', () => {
  it('shows the headline numbers and the ad split by type', () => {
    render(<PlayerSummaryView data={base} />);
    const tiles = document.querySelector('.ps-tiles') as HTMLElement;
    expect(within(tiles).getByText('Levels cleared').parentElement).toHaveTextContent('622');
    expect(within(tiles).getByText('Ads seen').parentElement).toHaveTextContent('93');
    const ads = screen.getByRole('heading', { name: /Ads seen/ }).closest('section')!;
    expect(within(ads).getByText('Interstitial')).toBeInTheDocument();
    expect(within(ads).getByText(/17 of 22 watched to the reward \(77%\)/)).toBeInTheDocument();
    expect(within(ads).getByText('Timeout')).toBeInTheDocument();
  });

  it('says so, in words, when the game sends no ads, levels or economy', () => {
    const empty: PlayerSummaryData = { ...base, ads: { formats: {}, shown: 0, failed: 0, average_seconds_on_screen: null }, levels: { ...base.levels, cleared: 0, highest: null, hardest: [], pace: [] }, economy: { ...base.economy, balances: {}, earned: {}, spent: {}, inventory: {} }, powerups: { used: {}, obtained: [] } };
    render(<PlayerSummaryView data={empty} />);
    expect(screen.getByText('No ads shown to this player.')).toBeInTheDocument();
    expect(screen.getByText('No level events from this player.')).toBeInTheDocument();
    expect(screen.getByText('No economy or powerup events from this player.')).toBeInTheDocument();
  });

  it('warns when only the latest events were counted', () => {
    render(<PlayerSummaryView data={{ ...base, partial: true, events_counted: 120000 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('latest 120,000');
  });
});

describe('helpers', () => {
  it('reads levels per ad and the first-try share', () => {
    expect(levelsPerAd(622, 93)).toBe('1 per 6.7 levels');
    expect(levelsPerAd(0, 5)).toBeNull();
    expect(firstTryShare(585, 622)).toBe('94%');
    expect(firstTryShare(0, 0)).toBe('—');
    expect(plain('level_reward')).toBe('Level reward');
  });
});
