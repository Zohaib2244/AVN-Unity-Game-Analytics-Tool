// "How it ended": the endings counted by cause, and how they ended under the one picked.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { LevelCause } from '@/lib/types';
import { LastActions } from './LevelDrill';

const causes: LevelCause[] = [
  { key: 'interstitial ad', label: 'Interstitial ad', players: 45, left: 20, endings: [{ key: 'seen:around', label: 'Last seen around the ad (during or after)', players: 25 }, { key: 'left:during', label: 'Left during', players: 12 }, { key: 'left:failed', label: 'Left after failed to show', players: 8 }] },
  { key: 'in the level', label: 'In the level', players: 5, left: 5, endings: [{ key: 'left', label: 'Left', players: 5 }] },
];
const actions = [{ text: 'Left during interstitial ad', players: 12 }];

describe('LastActions', () => {
  it('lists one chip per cause with its count, and no breakdown until one is picked', () => {
    render(<LastActions level={11} group="left" lastActions={actions} causes={causes} lastAction={null} />);
    expect(screen.getByRole('button', { name: /Interstitial ad/ })).toHaveTextContent('45');
    expect(screen.getByRole('button', { name: /In the level/ })).toHaveTextContent('5');
    expect(screen.queryByText(/Last seen around the ad/)).toBeNull();
  });

  it('shows how the picked cause ended, says how many told us, and passes picks on', async () => {
    const onCause = vi.fn(); const onEnding = vi.fn();
    const user = userEvent.setup();
    render(<LastActions level={11} group="left" lastActions={actions} causes={causes} lastAction={null} cause="interstitial ad" ending={null} onCause={onCause} onEnding={onEnding} />);
    const endings = screen.getByRole('group', { name: /endings went/ });
    expect(within(endings).getByText('20 of 45 told us how it ended')).toBeInTheDocument();
    await user.click(within(endings).getByRole('button', { name: /Left during/ }));
    expect(onEnding).toHaveBeenCalledWith('left:during');
    await user.click(screen.getByRole('button', { name: /Interstitial ad/ }));
    expect(onCause).toHaveBeenCalledWith(null);
  });

  it('falls back to each exact last action when the server sends no causes, and hides for players who carried on', () => {
    const { rerender } = render(<LastActions level={11} group="left" lastActions={actions} lastAction={null} />);
    expect(screen.getByRole('button', { name: /Left during interstitial ad/ })).toBeInTheDocument();
    rerender(<LastActions level={11} group="straight_on" lastActions={actions} causes={causes} lastAction={null} />);
    expect(screen.queryByRole('group')).toBeNull();
  });
});
