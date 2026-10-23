import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteGameDialog } from './GameSettings';

const game = { name: 'Tiny Adventures', bundle_id: 'com.studio.tiny', keys_total: 2, events: 1234 };

describe('DeleteGameDialog', () => {
  it('keeps "Delete game" disabled until the bundle ID is typed, then confirms', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<DeleteGameDialog game={game} open onClose={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByRole('heading', { name: 'Delete Tiny Adventures?' })).toBeInTheDocument();
    expect(screen.getByText(/2 API keys/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Delete game' });
    expect(button).toBeDisabled();
    const input = screen.getByLabelText(/to confirm/);
    await user.type(input, 'com.studio.wrong');
    expect(button).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'com.studio.tiny');
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
