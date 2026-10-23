import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RememberedDetails, rememberOpen, rememberedOpen } from './Disclosure';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const details = () => screen.getByText('Setup').closest('details')!;

describe('RememberedDetails', () => {
  it('remembers the open state per key and survives a redraw', () => {
    localStorage.setItem('player', JSON.stringify({ setup: false, session: false }));
    const view = render(<RememberedDetails storageKey="player" name="setup" summary="Setup" defaultOpen>body</RememberedDetails>);
    expect(details().open).toBe(false);
    // A toggle is remembered for this name only.
    details().open = true; fireEvent(details(), new Event('toggle'));
    expect(JSON.parse(localStorage.getItem('player')!)).toEqual({ setup: true, session: false });
    // A fold never toggled before opens by default; a remembered one keeps its state across a redraw.
    view.rerender(<><RememberedDetails storageKey="player" name="setup" summary="Setup">body</RememberedDetails><RememberedDetails storageKey="player" name="new-highlight" summary="New" defaultOpen>more</RememberedDetails></>);
    expect(details().open).toBe(true);
    expect(screen.getByText('New').closest('details')!.open).toBe(true);
    // Opened from elsewhere (match navigation): subsequent redraws keep it open.
    rememberOpen('player', 'session', true);
    view.rerender(<RememberedDetails storageKey="player" name="session" summary="Setup">body</RememberedDetails>);
    expect(details().open).toBe(true);
    expect(rememberedOpen('player', 'session', false)).toBe(true);
  });

  it('remounting with another key does not leak into the previous key', () => {
    localStorage.setItem('player', JSON.stringify({ setup: false, session: true }));
    const view = render(<RememberedDetails storageKey="player" name="session" summary="Setup">body</RememberedDetails>);
    expect(details().open).toBe(true);
    view.rerender(<RememberedDetails storageKey="another-event" name="session" summary="Setup" defaultOpen>body</RememberedDetails>);
    details().open = false; fireEvent(details(), new Event('toggle'));
    expect(JSON.parse(localStorage.getItem('another-event')!)).toEqual({ session: false });
    expect(JSON.parse(localStorage.getItem('player')!).session).toBe(true);
  });
});
