// The sidebar's ingest meter: its state words and colours, and the panel it opens.
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Game, IngestMeterData } from '@/lib/types';
import { ago, IngestMeter, meterState, size } from './IngestMeter';

const game: Game = { id: 'g1', name: 'Sand Smash', bundle_id: 'com.sand', platform: 'android', created_at: '' };
const NOW = '2026-11-03T12:00:00.000000+00:00';
const hours = Array.from({ length: 24 }, (_, index) => ({ hour: `2026-11-03T${String(index).padStart(2, '0')}`, events: index * 10 }));
const base: IngestMeterData = { now: NOW, last_event_at: '2026-11-03T11:59:56.000000+00:00', recent_minutes: 5, recent_events: 190, per_minute: 38, players_now: 112, events_24h: 12480, hourly: hours, versions: [{ version: '0.0.4', events: 91 }, { version: '0.0.3', events: 9 }], stored_bytes: 2.1e9 };
let data: IngestMeterData | undefined = base;
vi.mock('@/api', () => ({ useRead: () => ({ data, dataUpdatedAt: Date.now() }) }));

afterEach(() => { cleanup(); data = base; });

describe('meter state', () => {
  it('is live until 5 minutes without an event, quiet until 30, then stale', () => {
    expect(meterState(4)).toBe('live');
    expect(meterState(299)).toBe('live');
    expect(meterState(300)).toBe('quiet');
    expect(meterState(1799)).toBe('quiet');
    expect(meterState(1800)).toBe('stale');
    expect(meterState(null)).toBe('empty');
  });
  it('words ages and sizes plainly', () => {
    expect(ago(4)).toBe('4s ago');
    expect(ago(8 * 60)).toBe('8 min ago');
    expect(ago(2 * 3600)).toBe('2 h ago');
    expect(ago(3 * 86400)).toBe('3 d ago');
    expect(size(2.1e9)).toBe('2.1 GB');
    expect(size(812e6)).toBe('812 MB');
    expect(size(40_000)).toBe('40 KB');
  });
});

describe('IngestMeter', () => {
  it('shows one quiet line: live, the rate and the age', () => {
    render(<IngestMeter game={game} />);
    const chip = screen.getByRole('button', { name: /Live/ });
    expect(chip).toHaveTextContent('38/min');
    expect(chip).toHaveTextContent('4s ago');
    expect(chip).toHaveClass('live');
  });

  it('goes amber when quiet and red when nothing has arrived for a while, with no rate', () => {
    data = { ...base, last_event_at: '2026-11-03T11:52:00.000000+00:00', per_minute: 0 };
    const { unmount } = render(<IngestMeter game={game} />);
    expect(screen.getByRole('button', { name: /Quiet/ })).toHaveClass('quiet');
    expect(screen.queryByText(/\/min/)).toBeNull();
    unmount();
    data = { ...base, last_event_at: '2026-11-03T10:00:00.000000+00:00', per_minute: 0 };
    render(<IngestMeter game={game} />);
    expect(screen.getByRole('button', { name: /Nothing arriving/ })).toHaveClass('stale');
  });

  it('says so when a game has never received an event', () => {
    data = { ...base, last_event_at: null, per_minute: 0, events_24h: 0 };
    render(<IngestMeter game={game} />);
    expect(screen.getByRole('button', { name: /No events yet/ })).toHaveClass('empty');
  });

  it('opens a panel with the day, the players, the versions and the size, and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<IngestMeter game={game} />);
    await user.click(screen.getByRole('button', { name: /Live/ }));
    const panel = screen.getByRole('dialog', { name: /Ingest for Sand Smash/ });
    expect(within(panel).getByText('12,480')).toBeInTheDocument();
    expect(within(panel).getByText('112')).toBeInTheDocument();
    expect(within(panel).getByText('0.0.4 · 91%, 0.0.3 · 9%')).toBeInTheDocument();
    expect(within(panel).getByText('2.1 GB')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
