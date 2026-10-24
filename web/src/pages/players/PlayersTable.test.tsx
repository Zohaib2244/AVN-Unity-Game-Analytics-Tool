import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Game, PlayerRow } from '@/lib/types';
import { PlayersTable } from './PlayersTable';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className, onClick }: { children: unknown; className?: string; onClick?: (event: unknown) => void }) => <a href="#player" className={className} onClick={onClick as never}>{children as never}</a>,
}));

const game = { id: 'g', name: 'Game', platform: 'android' } as unknown as Game;
const NO_METRICS: never[] = [];
const row = (player: string): PlayerRow => ({ player, events: 3, sessions: 1, avg_session_seconds: 60, total_play_seconds: 60, first_seen: '2026-10-01T10:00:00Z', last_seen: '2026-10-01T10:05:00Z', platform: 'android', app_version: '1.0', country: null, environment: 'production', has_user_id: false, metrics: [] });

describe('PlayersTable', () => {
  it('keeps its rows in place when the page re-renders with a new onOpen (the drawer opening or closing)', () => {
    const rows = [row('d0000001'), row('d0000002')];
    const draw = (onOpen: () => void) => <PlayersTable game={game} rows={rows} metrics={NO_METRICS} sort="last_seen" order="desc" timezone="utc" onSort={() => {}} onOpen={onOpen} />;
    const { rerender } = render(draw(() => {}));
    const before = screen.getAllByRole('link')[0];
    rerender(draw(() => {}));
    expect(screen.getAllByRole('link')[0]).toBe(before);
  });
  it('calls the newest onOpen with the player and its place in the list', async () => {
    const first = vi.fn(); const second = vi.fn();
    const rows = [row('d0000001'), row('d0000002')];
    const draw = (onOpen: () => void) => <PlayersTable game={game} rows={rows} metrics={NO_METRICS} sort="last_seen" order="desc" timezone="utc" onSort={() => {}} onOpen={onOpen} />;
    const { rerender } = render(draw(first));
    rerender(draw(second));
    await userEvent.setup().click(screen.getAllByRole('link')[1]!);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('d0000002', 1);
  });
});
